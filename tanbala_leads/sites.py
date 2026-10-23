"""Сайт компании: свой домен, почты, страницы контактов и текст для квалификации. Обход через crawl4ai."""

import asyncio
import html
import ipaddress
import re
import socket
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import SplitResult, unquote, urldefrag, urljoin, urlsplit

import tanbala_leads  # noqa: F401  задаёт пути crawl4ai внутри проекта до его импорта
from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig, DefaultMarkdownGenerator

MAX_PAGE_TEXT_CHARS = 3000
MAX_SITE_TEXT_CHARS = 6000
MAX_HTML_CHARS = 5_000_000  # почты ищем в первых 5 млн символов страницы
MAX_ERROR_CHARS = 300
SITE_TIMEOUT_S = 45.0  # на весь сайт вместе со страницами контактов
RENDER_DELAY_S = 1.0  # дать скриптам дорисовать страницу

# Не свой сайт компании: соцсети, мессенджеры, карты, площадки, сокращатели ссылок, визитки-ссылки.
SOCIAL_DOMAINS = frozenset("""
    instagram.com facebook.com fb.com fb.me wa.me wa.link api.whatsapp.com whatsapp.com t.me telegram.me
    telegram.org tiktok.com youtube.com youtu.be vk.com vk.ru vk.cc ok.ru linkedin.com twitter.com x.com
    threads.net pinterest.com 2gis.kz 2gis.ru 2gis.com link.2gis.ru linktr.ee taplink.cc taplink.ws google.com
    google.kz goo.gl g.page yandex.kz yandex.ru olx.kz kaspi.kz satu.kz hh.kz hh.ru krisha.kz kolesa.kz
    bit.ly clck.ru mail.ru
""".split())
JUNK_EMAIL_DOMAINS = frozenset("""
    example.com example.org example.net example.kz test.com domain.com email.com yourdomain.com site.com
    mysite.com sentry.io wixpress.com sentry-next.wixpress.com
""".split())
# Что после @ означает файл (logo@2x.png), а не почту, и служебные зоны.
BAD_EMAIL_TLDS = frozenset("""
    png jpg jpeg gif webp svg ico bmp avif tif tiff css js mjs map json woff woff2 ttf otf eot mp4 webm mp3 pdf
    php html htm txt xml local localdomain localhost lan internal test example invalid
""".split())
ROLE_LOCALS = frozenset("""
    info sales sale office admin administrator support help hello contact contacts mail email post pochta zakaz
    zakazy order orders reception priem priemnaya secretary sekretar kanc buh buhgalter buhgalteria accounting
    finance billing hr kadry job jobs career careers resume marketing pr press media service servis manager team
    general feedback client clients tender zakupki snab supply opt shop store booking noreply webmaster postmaster
""".split())
FILE_SUFFIXES = tuple(f".{ext}" for ext in "pdf jpg jpeg png gif webp svg doc docx xls xlsx pptx zip rar mp4".split())
# Порядок важен: контакты, потом «о нас», потом реквизиты.
PAGE_PATTERNS = (
    re.compile(r"contact|kontakt|контакт|байланыс|bajlanys|baylanys|bailanys"),
    re.compile(r"about|o-nas|o_nas|\bonas\b|\bо\s+нас\b|о\s+компании|\bкомпания\b|company|o-kompanii|kompaniya"
               r"|біз\s+туралы|biz-turaly"),
    re.compile(r"rekvizit|реквизит"),
)
SKIPPED_RESOURCES = frozenset({"image", "media", "font"})  # текста и почт в них нет, а грузятся долго
BLOCKED_NETWORKS = (ipaddress.ip_network("100.64.0.0/10"), ipaddress.ip_network("fc00::/7"))

DOMAIN_RE = re.compile(r"^([a-z0-9]([a-z0-9-]*[a-z0-9])?[.])+[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
EMAIL_RE = re.compile(r"(?<![a-z0-9._%+-])[a-z0-9][a-z0-9._%+-]*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+"
                      r"(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})(?![a-z0-9-])", re.IGNORECASE | re.ASCII)
PG_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+[.][^@\s]+$")
MAILTO_RE = re.compile(r"mailto:([^\s\"'<>()\[\]]+)", re.IGNORECASE)
AT_RE = re.compile(r"\s*[\[({]\s*(?:at|собака|@)\s*[\])}]\s*", re.IGNORECASE)
DOT_RE = re.compile(r"\s*[\[({]\s*(?:dot|точка|\.)\s*[\])}]\s*", re.IGNORECASE)
JSON_ESCAPE_RE = re.compile(r"\\u00(?:3c|3e|22|27)", re.IGNORECASE)

Resolver = Callable[..., list]
Links = tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class PageText:
    url: str
    text: str


@dataclass(frozen=True)
class SiteCrawl:
    start_url: str
    pages: tuple[PageText, ...] = ()
    emails: frozenset[str] = frozenset()
    error: str | None = None

    @property
    def text(self) -> str:
        """Текст сайта для Claude: главная первой, всего не больше MAX_SITE_TEXT_CHARS."""
        return _combine(self.pages, MAX_SITE_TEXT_CHARS)


def normalize_domain(url: str) -> str | None:
    """Свой домен компании из ссылки: pel.kz. None для пустых, IP, соцсетей и неверных адресов."""
    parts = _split(_with_scheme(url, "http"))
    host = _ascii_host(parts.hostname) if parts else None
    if host is None:
        return None
    host = host.removeprefix("www.")
    return host if DOMAIN_RE.match(host) and not _in_domains(host, SOCIAL_DOMAINS) else None


def is_public_url(url: str, resolver: Resolver = socket.getaddrinfo) -> bool:
    """Можно ли идти по ссылке: http(s), порт 80/443, имя домена, все адреса в DNS публичные.

    Рядом на 127.0.0.1 работают Postgres и Reacher, поэтому локальные и частные адреса закрыты.
    """
    parts = _split((url or "").strip())
    try:
        port = parts.port if parts else None
    except ValueError:
        return False
    host = _ascii_host(parts.hostname) if parts else None
    if host is None or port not in (None, 80, 443) or host == "localhost" or host.endswith(".localhost"):
        return False
    try:
        infos = resolver(host, port or (443 if parts.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except (OSError, UnicodeError, ValueError):
        return False
    return bool(infos) and all(_is_global_ip(info[4][0]) for info in infos)


def _with_scheme(url: str, scheme: str) -> str:
    text = (url or "").strip()
    if text.startswith("//"):
        return f"{scheme}:{text}"
    return text if "://" in text else f"{scheme}://{text}"


def _split(url: str) -> SplitResult | None:
    """Разобрать http(s)-ссылку. Ссылки с логином (user@host) отбрасываем: так прячут чужой хост."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or "@" in parts.netloc or not parts.hostname:
        return None
    return parts


def _ascii_host(host: str) -> str | None:
    """Хост в нижнем регистре и punycode, без точки в конце.

    None для неверных имён и IP: у IPv4 зона из цифр, в IPv6 есть двоеточие, оба не проходят DOMAIN_RE.
    """
    try:
        host = host.strip().rstrip(".").lower().encode("idna").decode("ascii")
    except UnicodeError:
        return None
    if len(host) > 253 or not DOMAIN_RE.match(host) or host.rsplit(".", 1)[-1].isdigit():
        return None
    return host


def _is_global_ip(text: object) -> bool:
    """Адрес из getaddrinfo публичный: не локальный, не частный, не CGNAT, не ULA, не multicast."""
    try:
        ip = ipaddress.ip_address(str(text).split("%", 1)[0])
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    special = (ip.is_private, ip.is_loopback, ip.is_link_local, ip.is_multicast, ip.is_reserved, ip.is_unspecified)
    return ip.is_global and not any(special) and not any(ip in net for net in BLOCKED_NETWORKS)


def _in_domains(host: str, domains: frozenset[str]) -> bool:
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def extract_emails(text: str) -> set[str]:
    """Почты из HTML или markdown: обычные, mailto:, [at]/(dot), HTML-сущности. В нижнем регистре, без мусора."""
    decoded = html.unescape((text or "")[:MAX_HTML_CHARS].replace("\\u0040", "@"))
    decoded = DOT_RE.sub(".", AT_RE.sub("@", JSON_ESCAPE_RE.sub(" ", decoded)))
    mailto = "\n".join(unquote(value) for value in MAILTO_RE.findall(decoded))
    found = (match.lower() for match in EMAIL_RE.findall(decoded + "\n" + mailto))
    return {email for email in found if _is_real_email(email)}


def is_role_address(email: str) -> bool:
    """Общий ящик (info@, sales@, buh@), а не человек. Учитывает info.almaty@, sales2@, info+site@."""
    local, at, _ = (email or "").lower().partition("@")
    if not at:
        return False
    local = local.split("+", 1)[0]
    first = re.split(r"[._-]", local, maxsplit=1)[0].rstrip("0123456789")
    return re.sub(r"[._-]", "", local) in ROLE_LOCALS or first in ROLE_LOCALS


def _is_real_email(email: str) -> bool:
    local, _, domain = email.rpartition("@")
    if len(email) > 254 or len(local) > 64 or ".." in email or local.endswith("."):
        return False
    if domain.rsplit(".", 1)[-1] in BAD_EMAIL_TLDS or _in_domains(domain, JUNK_EMAIL_DOMAINS):
        return False
    return all(len(label) <= 63 for label in domain.split(".")) and bool(PG_EMAIL_RE.match(email))


def pick_contact_pages(base_url: str, links: list[tuple[str, str]], limit: int = 3) -> list[str]:
    """Ссылки с главной (href, текст) → до limit адресов «Контакты», «О нас», «Реквизиты» этого же сайта.

    Сначала по одной странице каждого вида, потом остальные по очереди: /kz/contacts не вытеснит «О нас».
    """
    base_url = _with_scheme(base_url, "https")
    site = _page_key(base_url)[0]
    if not site or limit <= 0:
        return []
    seen = {_page_key(base_url)}
    groups: tuple[list[str], ...] = ([], [], [])
    for href, text in links:
        url = _absolute(base_url, href)
        key = _page_key(url) if url else None
        if key is None or key in seen or not (key[0] == site or key[0].endswith("." + site)):
            continue
        tier = _page_tier(url, text)
        if tier is not None:
            seen.add(key)
            groups[tier].append(url)
    longest = max(len(group) for group in groups)
    return [group[i] for i in range(longest) for group in groups if i < len(group)][:limit]


def _absolute(base_url: str, href: str) -> str | None:
    href = (href or "").strip()
    if not href or href.startswith("#"):
        return None
    try:
        url = urldefrag(urljoin(base_url, href)).url
    except ValueError:
        return None
    parts = _split(url)
    return url if parts and not parts.path.lower().endswith(FILE_SUFFIXES) else None


def _page_key(url: str) -> tuple[str, str, str]:
    """Ключ страницы без схемы, www и косой черты в конце: http://www.pel.kz/a/ и https://pel.kz/a совпадают."""
    parts = _split(url)
    host = _ascii_host(parts.hostname) if parts else None
    if host is None:
        return ("", "", "")
    return (host.removeprefix("www."), parts.path.rstrip("/"), parts.query)


def _page_tier(url: str, text: str) -> int | None:
    parts = urlsplit(url)
    haystack = f"{unquote(parts.path)}?{unquote(parts.query)} {' '.join((text or '').split())}".lower()
    return next((tier for tier, pattern in enumerate(PAGE_PATTERNS) if pattern.search(haystack)), None)


def _combine(pages: tuple[PageText, ...], limit: int) -> str:
    """Склеить страницы под заголовком-адресом. Короткие целиком, длинным поровну оставшегося места."""
    filled = [page for page in pages if page.text]
    headers = [f"[{page.url}]\n" for page in filled]
    budget = max(limit - sum(map(len, headers)) - 2 * max(len(filled) - 1, 0), 0)
    shares = [0] * len(filled)
    order = sorted(range(len(filled)), key=lambda index: len(filled[index].text))
    for done, index in enumerate(order):
        shares[index] = min(len(filled[index].text), budget // (len(order) - done))
        budget -= shares[index]
    return "\n\n".join(head + _cut(page.text, size) for head, page, size in zip(headers, filled, shares, strict=True))


def _cut(text: str, limit: int) -> str:
    """Обрезать до limit символов по границе слова, с многоточием."""
    if len(text) <= limit:
        return text
    if limit <= 0:
        return ""
    cut = text[: limit - 1]
    space = max(cut.rfind("\n"), cut.rfind(" "))
    return (cut[:space] if space > limit // 2 else cut).rstrip() + "…"


def _short(message: object) -> str:
    """Ошибка crawl4ai в одну строку, без куска исходника, который он прикладывает."""
    text = str(message).split("Code context:", 1)[0]
    return " ".join(text.split())[:MAX_ERROR_CHARS]


async def crawl_site(url: str, *, max_pages: int = 4, page_timeout_ms: int = 20_000,
                     crawler_factory: Callable[[], Any] | None = None,
                     resolver: Resolver = socket.getaddrinfo) -> SiteCrawl:
    """Обойти главную и до max_pages - 1 страниц контактов. Ожидаемые сбои не бросает, а пишет в error.

    crawler_factory для тестов: объект с async with и arun(url, config=...), как AsyncWebCrawler.
    """
    start = _with_scheme(url, "https")
    if not await _is_public(start, resolver):
        return SiteCrawl(start_url=start, error="адрес не публичный или не открывается")
    if normalize_domain(start) is None:
        return SiteCrawl(start_url=start, error="соцсеть или каталог, а не сайт компании")
    config = _run_config(page_timeout_ms)
    deadline = asyncio.get_running_loop().time() + SITE_TIMEOUT_S
    # 2ГИС даёт ссылки с http://, а переход http → https внутри браузера crawl4ai принимает за пустую
    # страницу. Поэтому сначала https, и только если он не открылся, исходный http.
    candidates = [start]
    if start.startswith("http://"):
        candidates = ["https://" + start.removeprefix("http://"), start]
    try:
        async with (crawler_factory or _default_crawler)() as crawler:
            for candidate in candidates:
                home = await _fetch(crawler, candidate, config, deadline, resolver)
                if not isinstance(home, str):
                    start = candidate
                    break
            if isinstance(home, str):
                return SiteCrawl(start_url=start, error=f"главная страница: {home}")
            if normalize_domain(home[0].url) is None:
                return SiteCrawl(start_url=start, error="сайт переадресует на соцсеть или каталог")
            fetched = [home]
            for page_url in pick_contact_pages(home[0].url, list(home[2]), limit=max(max_pages - 1, 0)):
                page = await _fetch(crawler, page_url, config, deadline, resolver)
                fetched += [] if isinstance(page, str) else [page]
    except Exception as exc:  # запуск и закрытие браузера: любая ошибка crawl4ai или Playwright = сбой сайта
        return SiteCrawl(start_url=start, error=f"crawl4ai: {_short(exc)}")
    emails = frozenset().union(*(emails for _, emails, _ in fetched))
    return SiteCrawl(start_url=start, pages=tuple(page for page, _, _ in fetched), emails=emails)


async def _fetch(crawler: Any, url: str, config: Any, deadline: float,
                 resolver: Resolver) -> tuple[PageText, frozenset[str], Links] | str:
    """Загрузить одну страницу: (текст, почты, ссылки). Вместо исключения вернуть текст ошибки."""
    remaining = deadline - asyncio.get_running_loop().time()
    if remaining <= 0:
        return "время на сайт вышло"
    if not await _is_public(url, resolver):
        return "адрес не публичный"
    try:
        result = await asyncio.wait_for(crawler.arun(url, config=config), remaining)
    except TimeoutError:
        return "время на сайт вышло"
    except Exception as exc:  # crawl4ai почти всё ловит сам, но сбой браузера может долететь сюда
        return _short(exc)
    if not getattr(result, "success", False):
        return f"не загрузилась: {_short(getattr(result, 'error_message', None) or 'нет ответа')}"
    final_url = getattr(result, "redirected_url", None) or url
    if final_url != url and not await _is_public(final_url, resolver):
        return "переадресация на непубличный адрес"
    markdown = _markdown(getattr(result, "markdown", None))
    emails = extract_emails(getattr(result, "html", "") or "") | extract_emails(markdown)
    return PageText(url=final_url, text=_cut(markdown, MAX_PAGE_TEXT_CHARS)), frozenset(emails), _links(result)


async def _is_public(url: str, resolver: Resolver) -> bool:
    return await asyncio.to_thread(is_public_url, url, resolver)


def _markdown(markdown: Any) -> str:
    """Markdown crawl4ai (fit_markdown, если есть фильтр, иначе raw_markdown) без лишних пустых строк."""
    if markdown is None:
        return ""
    text = getattr(markdown, "fit_markdown", None) or getattr(markdown, "raw_markdown", None) or str(markdown)
    lines = "\n".join(line.rstrip() for line in text.splitlines())
    return re.sub(r"\n{3,}", "\n\n", lines).strip()


def _links(result: Any) -> Links:
    links = getattr(result, "links", None) or {}
    items = [item for kind in ("internal", "external") for item in links.get(kind, []) if isinstance(item, dict)]
    return tuple((str(item.get("href") or ""), str(item.get("text") or "")) for item in items)


def _run_config(page_timeout_ms: int) -> CrawlerRunConfig:
    """Без кэша, снимков, PDF и загрузок. Markdown без ссылок и картинок: его читает Claude."""
    markdown = DefaultMarkdownGenerator(options={"ignore_links": True, "ignore_images": True})
    return CrawlerRunConfig(cache_mode=CacheMode.BYPASS, page_timeout=page_timeout_ms, verbose=False,
                            delay_before_return_html=RENDER_DELAY_S, markdown_generator=markdown)


def _default_crawler() -> AsyncWebCrawler:
    """Один браузер без окна на весь сайт. Каждая его страница проходит через _guard_page."""
    crawler = AsyncWebCrawler(config=BrowserConfig(headless=True, verbose=False))
    crawler.crawler_strategy.set_hook("on_page_context_created", _guard_page)
    return crawler


async def _guard_page(page: Any, **_kwargs: Any) -> Any:
    """Хук crawl4ai: все запросы страницы (скрипты, fetch, iframe) идут через _guard_request."""
    await page.route("**/*", _guard_request)
    return page


async def _guard_request(route: Any) -> None:
    """Не грузить картинки, шрифты, видео и ничего с локальных и частных адресов."""
    request = route.request
    if request.resource_type in SKIPPED_RESOURCES or not await asyncio.to_thread(is_public_url, request.url):
        await route.abort()
    else:
        await route.fallback()
