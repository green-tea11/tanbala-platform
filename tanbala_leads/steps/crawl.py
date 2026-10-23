"""Шаг 2. Почты и текст с сайта компании через crawl4ai (sites.py). Результат: contacts, статус crawled."""

from collections.abc import Callable

import psycopg

from tanbala_leads.sites import SiteCrawl, is_role_address


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


def crawl_company(conn: psycopg.Connection, company_id: int, crawl: Callable[[str], SiteCrawl]) -> int:
    """Обойти сайт компании и сохранить результат. Без сайта компания тоже считается обойдённой."""
    website = conn.execute("SELECT website FROM companies WHERE id = %s", (company_id,)).fetchone()[0]
    if not website:
        conn.execute("UPDATE companies SET status = 'crawled' WHERE id = %s", (company_id,))
        return 0
    return save_crawl(conn, company_id, crawl(website))
