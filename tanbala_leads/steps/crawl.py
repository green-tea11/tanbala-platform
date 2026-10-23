"""Шаг 2. Почты и текст с сайта компании через crawl4ai. Результат: contacts, статус crawled."""


def find_contact_pages(site_url: str) -> list[str]:
    """Найти страницы «контакты», «о нас» на сайте.

    TODO: главная + ссылки с ключевыми словами, как в skill find-emails.
    """
    raise NotImplementedError


def extract_emails(html: str) -> set[str]:
    """Достать почты из HTML страницы.

    TODO: regex, mailto:, простая деобфускация, без AI.
    """
    raise NotImplementedError


def crawl_company(conn, company_id: int) -> int:
    """Обойти сайт компании, сохранить почты и текст сайта. Вернуть число найденных почт.

    TODO: crawl4ai, пометка ролевых адресов (info@, sales@).
    """
    raise NotImplementedError
