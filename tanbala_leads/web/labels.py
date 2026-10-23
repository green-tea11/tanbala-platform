"""Подписи, статусы, лимиты и оценка расхода для веб-интерфейса. Только данные, без логики."""

REVIEWER = "владелец"

DEFAULT_CITY = "almaty"
DEFAULT_MAX_COMPANIES = 5
QUICK_QUERIES = ("склад", "логистика", "производство", "магазин одежды", "оборотная тара", "строительная компания")
POLL_INTERVAL_MS = 2000
COMPANIES_PER_PAGE = 50
LETTERS_IN_LIST = 100
RECENT_RUNS = 20
RUN_FILTER_CHOICES = 50
SITE_TEXT_PREVIEW_CHARS = 20_000
MAX_SUBJECT_LENGTH = 200
MAX_BODY_LENGTH = 10_000
MAX_ID_DIGITS = 18
MAX_DB_ID = 2**63 - 1  # bigint: больший id даже не отправляем в базу
MAX_FORM_BYTES = 256 * 1024  # правка письма до 10 000 символов кириллицы в urlencoded
MAX_UPLOAD_BYTES = 1024 * 1024  # файл со списком адресов для «Кому писали»
HISTORY_PER_PAGE = 50
IMPORT_INVALID_SHOWN = 20  # сколько нераспознанных строк показать после импорта

# Оценка расхода по первому настоящему запуску 23.10.2026: 1 компания, 3 вызова Claude Haiku за $0,0055.
# Токены одного вызова (вход, выход, чтение документа о Tanbala из кэша). Повтор письма бывает не всегда,
# в оценке он есть: лучше чуть больше, чем меньше.
ESTIMATE_MODEL = "claude-haiku-5-5"
ESTIMATE_CALLS_PER_COMPANY = (
    (3_300, 150, 10_100),   # квалификация
    (3_500, 2_250, 9_500),  # черновик письма
    (3_900, 1_500, 9_500),  # повтор черновика, если проверки не прошли
)
# Документ о Tanbala пишется в кэш один раз на задачу и живёт 5 минут: это и есть доплата первого запуска.
ESTIMATE_CACHE_WRITE_TOKENS = 10_100 + 9_500

TOKEN_FORMS = ("токен", "токена", "токенов")
COMPANY_FORMS = ("компанию", "компании", "компаний")
LETTER_FORMS = ("письмо", "письма", "писем")

# Коды этапов в runs.stage, их названия и счётчики из строки runs.
STAGES: tuple[tuple[str, str, tuple[tuple[str, str], ...]], ...] = (
    ("collect", "Поиск в 2ГИС", (("found", "найдено"), ("new_companies", "новых"))),
    ("crawl", "Сайты", (("crawled", "обойдено"),)),
    ("qualify", "Квалификация", (("qualified", "подходят"), ("rejected", "не подходят"))),
    ("verify", "Проверка почт", (("verified", "проверено"),)),
    ("draft", "Письма", (("drafted", "писем"),)),
)
# Пайплайн пишет в runs.stage русские названия этапов, «Подготовка» и «Готово»; коды тоже понимаем.
STAGE_ALIASES = {"Подготовка": 0}
STAGE_STATE_LABELS = {"done": "готово", "current": "идёт", "failed": "ошибка", "pending": "ждёт"}
STAGE_HINTS = {
    "collect": "компании по запросу",
    "crawl": "почты и текст с сайта",
    "qualify": "Claude Haiku: нужен ли им RFID",
    "verify": "существует ли почта",
    "draft": "черновик первого письма",
}
RUN_STATUSES = {
    "queued": ("В очереди", "neutral"),
    "running": ("Идёт", "accent"),
    "done": ("Готово", "pos"),
    "failed": ("Ошибка", "neg"),
}
FINISHED_RUN_STATUSES = frozenset({"done", "failed"})
COMPANY_STATUSES = {
    "new": ("Найдена", "neutral"),
    "crawled": ("Сайт обойдён", "neutral"),
    "qualified": ("Подходит", "neutral"),
    "rejected": ("Не подходит", "muted"),
    "verified": ("Почта проверена", "neutral"),
    "drafted": ("Письмо готово", "accent"),
    "approved": ("Одобрено", "pos"),
    "sent": ("Отправлено", "pos"),
    "replied": ("Ответили", "pos"),
}
STATUS_CARDS = (("", "Все"), ("drafted", "Письмо готово"), ("approved", "Одобрено"), ("rejected", "Не подходит"))
VERIFY_RESULTS = {
    "safe": ("Существует", "pos"),
    "risky": ("Рискованная", "warn"),
    "invalid": ("Не существует", "neg"),
    "unknown": ("Не удалось проверить", "neutral"),
    None: ("Не проверена", "neutral"),
}
FIT_LABELS = {"yes": "подходит", "maybe": "возможно", "no": "не подходит"}
REVIEW_STATUSES = {
    "pending": ("Ждёт проверки", "accent"),
    "approved": ("Одобрено", "pos"),
    "rejected": ("Отклонено", "muted"),
}
# Фильтры очереди писем: код в адресе, подпись, review_status или None для «Все».
LETTER_FILTERS = (
    ("pending", "Ждут проверки", "pending"),
    ("approved", "Одобрены", "approved"),
    ("rejected", "Отклонены", "rejected"),
    ("all", "Все", None),
)
DEFAULT_LETTER_FILTER = "pending"
CHECK_LABELS = {
    "dashes": "Тире",
    "prices": "Цены",
    "stop_words": "Стоп-слова",
    "links": "Ссылки",
    "length": "Длина",
    "signature": "Подпись",
    "notes": "Заметки только в начале",
    "jargon": "Жаргон",
    "style": "Стиль",
    "contacts": "Только наш номер WhatsApp",
}
PAIN_SOURCES = {"2gis": "2ГИС", "site": "сайт", "vacancies": "вакансии"}
# Статусы компании после квалификации «подходит»: для сводки на странице поиска.
FIT_STATUSES = ("qualified", "verified", "drafted", "approved", "sent", "replied")
HISTORY_DIRECTIONS = {"out": "отправлено", "in": "ответ"}
HISTORY_KINDS = {"first_email": "первое письмо", "reply": "ответ"}
HISTORY_SOURCES = {"pipeline": "система", "import": "импорт", "manual": "вручную"}
BLOCK_REASONS = {"refused": "отказ", "complaint": "жалоба", "bounce": "не доставлено", "manual": "вручную"}
IMPORT_KINDS = {"written": False, "refused": True}  # форма → import_contacts(refused=…)
# Строки-заголовки в CSV, которые не считаем ошибкой.
# Названия колонок CSV: строка только из них считается заголовком и пропускается.
IMPORT_HEADERS = frozenset({
    "email", "e-mail", "почта", "адрес", "адреса", "domain", "домен", "сайт", "name", "имя", "название",
    "компания", "company", "организация", "телефон", "phone", "дата", "date", "комментарий", "comment",
})
BLOCKED_LABEL = "В списке «не писать»"
BLOCKED_MESSAGE = "Компания в списке «не писать»: письмо нельзя одобрить."
DONE_MESSAGES = {
    "approved": "Письмо одобрено. Отправка писем пока выключена.",
    "rejected": "Письмо отклонено. Компания вернулась к статусу «Почта проверена».",
    "saved": "Изменения сохранены, проверки пройдены заново.",
    "blocked": "Готово: компания и её домен в списке «не писать». Письма им не уйдут.",
}
ERROR_MESSAGES = {
    400: "Неверный запрос.",
    403: "Форма устарела или пришла не с этой страницы. Обновите страницу и повторите.",
    404: "Такой страницы нет.",
    405: "Так эту страницу открыть нельзя.",
    409: "Действие сейчас невозможно.",
    413: "Слишком большой запрос.",
}
DB_ERROR_MESSAGE = "База данных недоступна или вернула ошибку. Проверьте, что Docker запущен, и обновите страницу."
