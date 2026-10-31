"""Шаг 2. Почты и текст с сайта компании через crawl4ai (sites.py). Результат: contacts, статус crawled."""

from collections.abc import Callable

import psycopg

from tanbala_leads import browsers
from tanbala_leads.sites import SiteCrawl, is_role_address


class SiteUnavailable(RuntimeError):
    """Сайт временно не открылся, а почты у компании нет: она остаётся new, следующий запуск обойдёт сайт снова."""


def save_crawl(conn: psycopg.Connection, company_id: int, site: SiteCrawl) -> int:
    """Сохранить почты и текст сайта, статус crawled. Вернуть число новых почт."""
    added = 0
    with conn.transaction():
        for email in sorted(site.emails):
            try:
                with conn.transaction():
                    row = conn.execute(
                        "INSERT INTO contacts (company_id, email, source_page, is_role) VALUES (%s, %s, %s, %s)"
                        " ON CONFLICT DO NOTHING RETURNING id",
                        (company_id, email, site.start_url, is_role_address(email)),
                    ).fetchone()
            except psycopg.errors.CheckViolation:
                continue
            added += row is not None
        conn.execute(
            "UPDATE companies SET site_text = %s, status = 'crawled', last_error = %s WHERE id = %s",
            (site.text or None, site.error, company_id),
        )
    return added


def crawl_company(conn: psycopg.Connection, company_id: int, crawl: Callable[[str], SiteCrawl], *,
                  max_attempts: int = 1) -> int:
    """Обойти сайт компании и сохранить результат. Без сайта компания тоже считается обойдённой.

    max_attempts: сколько раз пробовать сайт, который не открылся временно (время вышло, сбой браузера), если почты
    у компании нет и в 2ГИС. Пока попытки есть, компания остаётся new (SiteUnavailable), а не уходит в «Нет почты»
    навсегда (ревью 01.11.2026). 1 — как раньше: сайт не открылся, дальше по карточке 2ГИС.
    """
    website = conn.execute("SELECT website FROM companies WHERE id = %s", (company_id,)).fetchone()[0]
    if not website:
        conn.execute("UPDATE companies SET status = 'crawled' WHERE id = %s", (company_id,))
        return 0
    try:
        site = crawl(website)
    except browsers.BrowserBusy:
        raise  # сайт не обходили вовсе
    except Exception as exc:
        retry = _keep_for_retry(conn, company_id, max_attempts, f"обход сайта упал: {type(exc).__name__}")
        if retry:
            raise SiteUnavailable(retry) from exc
        raise
    if site.retryable and not site.emails:
        retry = _keep_for_retry(conn, company_id, max_attempts, site.error or "")
        if retry:
            raise SiteUnavailable(retry)
    return save_crawl(conn, company_id, site)


def _keep_for_retry(conn: psycopg.Connection, company_id: int, max_attempts: int, error: str) -> str | None:
    """Оставить компанию new до следующего запуска, если почты у неё нет и попытка не последняя.

    Вернуть текст для last_error или None (обход считается сделанным, дальше как обычно). Считает попытки.
    """
    failures, status, has_contacts = conn.execute(
        "SELECT site_failures, status, EXISTS (SELECT 1 FROM contacts WHERE company_id = c.id) FROM companies c"
        " WHERE id = %s", (company_id,)).fetchone()
    attempt = failures + 1
    if status != "new" or has_contacts or attempt >= max_attempts:
        return None
    message = (f"Сайт не открылся ({error}), почты в 2ГИС нет: попробуем в следующий запуск"
               f" (попытка {attempt} из {max_attempts})")
    conn.execute("UPDATE companies SET site_failures = %s, last_error = %s WHERE id = %s",
                 (attempt, message, company_id))
    return message
