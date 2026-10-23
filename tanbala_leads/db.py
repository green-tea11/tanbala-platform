"""Схема PostgreSQL и миграции.

Создать или обновить таблицы одной командой: `python -m tanbala_leads.db`.
Миграции только добавляются в конец MIGRATIONS, применённые не меняются.

Главные правила документа о Tanbala (раздел 13) база держит сама, не только код:
первое письмо компании и на адрес уходит один раз, тем, кто в do_not_contact, не пишем.
"""

import sys

import psycopg

from tanbala_leads.settings import SettingsError, load_settings

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
-- Почта в нижнем регистре, ровно одна @, точка в домене, без пробелов.
CREATE DOMAIN email_address AS text
    CHECK (VALUE = lower(VALUE) AND VALUE ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$');

-- Голый домен: sklad.kz, без схемы, www, пути и заглавных букв. Кириллические домены в punycode.
CREATE DOMAIN host_name AS text
    CHECK (VALUE ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?[.])+[a-z0-9]([a-z0-9-]*[a-z0-9])?$' AND VALUE !~ '^www[.]');

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- Одна строка на компанию. Дубли отсекаются по сайту (website_domain) и телефонам.
-- website_domain заполняется только для своего домена компании: соцсети и конструкторы сайтов сюда не пишутся.
-- Телефоны дедуплицирует код: у сетей бывает один номер на разные филиалы.
CREATE TABLE companies (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            text NOT NULL,
    city            text,
    rubric          text,
    address         text,
    phones          text[] NOT NULL DEFAULT '{}',
    website         text,
    website_domain  host_name,
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

-- Все найденные почты и результат Reacher. Один адрес может быть у нескольких компаний (филиалы сети).
CREATE TABLE contacts (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     bigint NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
    email          email_address NOT NULL,
    source_page    text,
    verify_result  text CHECK (verify_result IN ('safe', 'risky', 'invalid', 'unknown')),
    verify_raw     jsonb,
    is_catch_all   boolean,
    is_role        boolean NOT NULL DEFAULT false,
    verified_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, email),
    UNIQUE (id, company_id)
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

-- Черновики писем, одобрение и результат. Контакт обязан принадлежать той же компании.
CREATE TABLE drafts (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     bigint NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
    contact_id     bigint NOT NULL,
    kind           text NOT NULL DEFAULT 'first_email' CHECK (kind IN ('first_email', 'reply')),
    subject        text NOT NULL,
    body           text NOT NULL,
    model          text,
    check_result   jsonb,
    review_status  text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
    approved_by    text,
    approved_at    timestamptz,
    sent_at        timestamptz,
    -- Значения появятся вместе с модулем разбора ответов.
    reply_status   text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (contact_id, company_id) REFERENCES contacts (id, company_id) ON DELETE CASCADE,
    CHECK ((review_status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
    CHECK (sent_at IS NULL OR review_status = 'approved')
);
CREATE INDEX drafts_contact_idx ON drafts (contact_id, company_id);
CREATE INDEX drafts_pending_idx ON drafts (created_at) WHERE review_status = 'pending';
-- Не больше одного живого черновика первого письма на компанию. После отклонения можно написать новый.
CREATE UNIQUE INDEX drafts_first_email_active_uq ON drafts (company_id)
    WHERE kind = 'first_email' AND review_status <> 'rejected';
CREATE TRIGGER drafts_updated_at BEFORE UPDATE ON drafts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Кому и когда писали, и входящие ответы. Строку out пишем до отправки письма:
-- повторная отправка упрётся в уникальные индексы ниже.
-- Компанию с историей удалить нельзя, иначе после повторного парсинга она получит новый id
-- и проверка «этой компании уже писали» её пропустит.
CREATE TABLE contact_history (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   bigint REFERENCES companies (id) ON DELETE RESTRICT,
    email        email_address NOT NULL,
    domain       text GENERATED ALWAYS AS (split_part(email, '@', 2)) STORED,
    direction    text NOT NULL CHECK (direction IN ('out', 'in')),
    kind         text NOT NULL DEFAULT 'first_email' CHECK (kind IN ('first_email', 'reply')),
    draft_id     bigint REFERENCES drafts (id) ON DELETE SET NULL,
    subject      text,
    note         text,
    occurred_at  timestamptz NOT NULL DEFAULT now()
);
-- Первое письмо на адрес и первое письмо компании: по одному разу.
CREATE UNIQUE INDEX contact_history_first_email_uq ON contact_history (email)
    WHERE direction = 'out' AND kind = 'first_email';
CREATE UNIQUE INDEX contact_history_first_company_uq ON contact_history (company_id)
    WHERE direction = 'out' AND kind = 'first_email' AND company_id IS NOT NULL;
CREATE INDEX contact_history_email_idx ON contact_history (email);
CREATE INDEX contact_history_domain_idx ON contact_history (domain);
CREATE INDEX contact_history_company_idx ON contact_history (company_id);
CREATE INDEX contact_history_draft_idx ON contact_history (draft_id);

-- Кому больше не пишем: отказ, жалоба, ручная блокировка. В строке ровно одна цель:
-- адрес, домен (вместе с поддоменами) или компания. Компанию из списка удалить нельзя.
-- Домены бесплатной почты (gmail.com, mail.ru) сюда не пишем: заблокируем всех.
CREATE TABLE do_not_contact (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email       email_address,
    domain      host_name,
    company_id  bigint REFERENCES companies (id) ON DELETE RESTRICT,
    reason      text NOT NULL CHECK (reason IN ('refused', 'complaint', 'bounce', 'manual')),
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(email, domain, company_id) = 1)
);
CREATE UNIQUE INDEX do_not_contact_email_uq ON do_not_contact (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX do_not_contact_domain_uq ON do_not_contact (domain) WHERE domain IS NOT NULL;
CREATE UNIQUE INDEX do_not_contact_company_uq ON do_not_contact (company_id) WHERE company_id IS NOT NULL;

-- Последний рубеж: исходящее письмо тому, кто в do_not_contact, в историю не записать.
-- Домен берём из email: генерируемая колонка domain в BEFORE-триггере ещё не вычислена.
CREATE FUNCTION forbid_blocked_send() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    email_domain text := split_part(NEW.email, '@', 2);
BEGIN
    IF NEW.direction = 'out' AND EXISTS (
        SELECT 1 FROM do_not_contact d
        WHERE d.email = NEW.email
           OR d.domain = email_domain
           OR right(email_domain, length(d.domain) + 1) = '.' || d.domain
           OR d.company_id = NEW.company_id
    ) THEN
        RAISE EXCEPTION 'Адрес % в списке do_not_contact', NEW.email USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER contact_history_forbid_blocked BEFORE INSERT OR UPDATE ON contact_history
    FOR EACH ROW EXECUTE FUNCTION forbid_blocked_send();
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
        conn.execute("SET LOCAL lock_timeout = '10s'")
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (MIGRATION_LOCK_ID,))
        conn.execute(CREATE_MIGRATIONS_TABLE)
        applied = {version for (version,) in conn.execute("SELECT version FROM schema_migrations")}
        for version, name, sql in MIGRATIONS:
            if version in applied:
                continue
            # Без параметров: тогда psycopg не разбирает % в тексте SQL и выполняет все операторы сразу.
            conn.execute(sql)
            conn.execute("INSERT INTO schema_migrations (version, name) VALUES (%s, %s)", (version, name))
            applied_now.append(version)
    return applied_now


def main() -> int:
    try:
        dsn = load_settings().require("database_url")
    except SettingsError as exc:
        print(exc, file=sys.stderr)
        return 1
    with connect(dsn) as conn:
        applied = migrate(conn)
    print(f"Применены миграции: {applied}" if applied else "Схема актуальна, миграций нет.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
