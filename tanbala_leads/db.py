"""Схема PostgreSQL и миграции.

Создать или обновить таблицы одной командой: `python -m tanbala_leads.db`.
Миграции только добавляются в конец MIGRATIONS, применённые не меняются.
"""

import os
import sys

import psycopg
from dotenv import load_dotenv

# Любое число, одно на проект: не даёт двум процессам мигрировать одновременно.
MIGRATION_LOCK_ID = 7_420_250_740

CREATE_MIGRATIONS_TABLE = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    integer PRIMARY KEY,
    name       text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
)
"""

SCHEMA_V1 = """
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- Одна строка на компанию. Дубли отсекаются по сайту (website_domain) и телефонам.
-- website_domain заполняется только для своего домена компании: соцсети и конструкторы сайтов сюда не пишутся.
CREATE TABLE companies (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            text NOT NULL,
    city            text,
    rubric          text,
    address         text,
    phones          text[] NOT NULL DEFAULT '{}',
    website         text,
    website_domain  text CHECK (website_domain = lower(website_domain)),
    source          text NOT NULL DEFAULT '2gis',
    source_id       text,
    source_url      text,
    branches_count  integer CHECK (branches_count >= 0),
    raw             jsonb,
    site_text       text,
    status          text NOT NULL DEFAULT 'new' CHECK (status IN (
                        'new', 'crawled', 'qualified', 'rejected', 'verified',
                        'drafted', 'approved', 'sent', 'replied')),
    last_error      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_source_uq ON companies (source, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX companies_website_domain_uq ON companies (website_domain) WHERE website_domain IS NOT NULL;
CREATE INDEX companies_phones_idx ON companies USING gin (phones);
CREATE INDEX companies_status_idx ON companies (status);
CREATE TRIGGER companies_updated_at BEFORE UPDATE ON companies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Все найденные почты и результат Reacher.
CREATE TABLE contacts (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     bigint NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
    email          text NOT NULL CHECK (email = lower(email) AND email LIKE '_%@_%'),
    source_page    text,
    verify_result  text CHECK (verify_result IN ('safe', 'risky', 'invalid', 'unknown')),
    verify_raw     jsonb,
    is_catch_all   boolean,
    is_role        boolean NOT NULL DEFAULT false,
    verified_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, email)
);
CREATE INDEX contacts_email_idx ON contacts (email);

-- Ответы квалификации. Повторный прогон добавляет строку, актуальна последняя.
CREATE TABLE qualifications (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id  bigint NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
    fit         text NOT NULL CHECK (fit IN ('yes', 'no', 'maybe')),
    score       smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
    reason      text NOT NULL,
    segment     text,
    model       text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qualifications_company_idx ON qualifications (company_id, created_at DESC);

-- Черновики писем, одобрение и результат.
CREATE TABLE drafts (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     bigint NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
    contact_id     bigint NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
    kind           text NOT NULL DEFAULT 'first_email' CHECK (kind IN ('first_email', 'reply')),
    subject        text NOT NULL,
    body           text NOT NULL,
    model          text,
    check_result   jsonb,
    review_status  text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
    approved_by    text,
    approved_at    timestamptz,
    sent_at        timestamptz,
    reply_status   text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CHECK ((review_status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
    CHECK (sent_at IS NULL OR review_status = 'approved')
);
CREATE INDEX drafts_company_idx ON drafts (company_id);
CREATE INDEX drafts_contact_idx ON drafts (contact_id);
CREATE INDEX drafts_pending_idx ON drafts (created_at) WHERE review_status = 'pending';
-- Первое письмо компании уходит один раз.
CREATE UNIQUE INDEX drafts_first_email_sent_uq ON drafts (company_id)
    WHERE kind = 'first_email' AND sent_at IS NOT NULL;
CREATE TRIGGER drafts_updated_at BEFORE UPDATE ON drafts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Кому и когда писали. Переживает удаление компании: по ней проверяем «уже писали».
CREATE TABLE contact_history (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   bigint REFERENCES companies (id) ON DELETE SET NULL,
    email        text NOT NULL CHECK (email = lower(email) AND email LIKE '_%@_%'),
    domain       text GENERATED ALWAYS AS (split_part(email, '@', 2)) STORED,
    direction    text NOT NULL CHECK (direction IN ('out', 'in')),
    draft_id     bigint REFERENCES drafts (id) ON DELETE SET NULL,
    subject      text,
    note         text,
    occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_history_email_idx ON contact_history (email);
CREATE INDEX contact_history_domain_idx ON contact_history (domain);
CREATE INDEX contact_history_company_idx ON contact_history (company_id);
CREATE INDEX contact_history_draft_idx ON contact_history (draft_id);

-- Кому больше не пишем: отказ, жалоба, ручная блокировка. Цель: адрес, домен или компания.
-- Компанию из этого списка удалить нельзя, иначе блокировка потеряется.
CREATE TABLE do_not_contact (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email       text CHECK (email = lower(email) AND email LIKE '_%@_%'),
    domain      text CHECK (domain = lower(domain)),
    company_id  bigint REFERENCES companies (id) ON DELETE RESTRICT,
    reason      text NOT NULL CHECK (reason IN ('refused', 'complaint', 'bounce', 'manual')),
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(email, domain, company_id) >= 1)
);
CREATE UNIQUE INDEX do_not_contact_email_uq ON do_not_contact (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX do_not_contact_domain_uq ON do_not_contact (domain) WHERE domain IS NOT NULL;
CREATE INDEX do_not_contact_company_idx ON do_not_contact (company_id) WHERE company_id IS NOT NULL;
"""

MIGRATIONS: tuple[tuple[int, str, str], ...] = (
    (1, "init", SCHEMA_V1),
)


def connect(dsn: str) -> psycopg.Connection:
    """Открыть соединение с Postgres в режиме autocommit. Транзакции открываются явно."""
    return psycopg.connect(dsn, autocommit=True)


def migrate(conn: psycopg.Connection) -> list[int]:
    """Применить недостающие миграции в одной транзакции. Вернуть номера применённых."""
    applied_now: list[int] = []
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (MIGRATION_LOCK_ID,))
        conn.execute(CREATE_MIGRATIONS_TABLE)
        applied = {version for (version,) in conn.execute("SELECT version FROM schema_migrations")}
        for version, name, sql in MIGRATIONS:
            if version in applied:
                continue
            conn.execute(sql)
            conn.execute("INSERT INTO schema_migrations (version, name) VALUES (%s, %s)", (version, name))
            applied_now.append(version)
    return applied_now


def main() -> int:
    load_dotenv()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL не задан. Скопируйте .env.example в .env и заполните.", file=sys.stderr)
        return 1
    with connect(dsn) as conn:
        applied = migrate(conn)
    print(f"Применены миграции: {applied}" if applied else "Схема актуальна, миграций нет.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
