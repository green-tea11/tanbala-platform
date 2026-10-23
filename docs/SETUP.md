# Установка и окружение

Проверено: 23.10.2026.

## Машина разработки

| Компонент | Версия | Статус |
| --- | --- | --- |
| ОС | Windows 11 Pro 10.0.26200, x64, 15.7 ГБ RAM | есть |
| Python | 3.11.0 (`C:\Users\bogda\AppData\Local\Programs\Python\Python311`) | есть |
| pip | 25.2 | есть |
| Docker | Docker Desktop 28.1.1, Compose v2.35.1, WSL2 | есть, движок нужно запускать вручную |
| Chrome | 155.0.8059.85 | есть, нужен parser-2gis |
| Git | 2.50.0 | есть |

Docker Desktop не стартует сам вместе с Windows. Перед работой запустите его или включите автозапуск в настройках.

## Python-окружения

Окружений два: parser-2gis требует `pydantic<2`, а crawl4ai требует `pydantic>=2.10`, в одном окружении они не ставятся.

| Окружение | Что внутри | Как ставить |
| --- | --- | --- |
| `.venv` | проект, crawl4ai 0.9.5, anthropic 2.1, psycopg 3.3, python-dotenv, pyyaml, pytest | см. ниже |
| `.venv-2gis` | parser-2gis 1.2.1 (pydantic 1.10) | см. ниже, вызывается из проекта как CLI |

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"
.venv/Scripts/crawl4ai-setup      # ставит Chromium для Playwright
.venv/Scripts/crawl4ai-doctor     # проверка: «Crawling test passed»

python -m venv .venv-2gis
.venv-2gis/Scripts/python -m pip install -r requirements-2gis.txt
.venv-2gis/Scripts/parser-2gis --version
```

parser-2gis сам находит Chrome в `C:\Program Files\Google\Chrome\Application\chrome.exe`. Если не нашёл, путь задаётся флагом `--chrome.binary_path`. Без флагов `-i`, `-o`, `-f` он не запускается.

Тесты: `.venv/Scripts/python -m pytest`. Платные тесты (маркер `paid`) по умолчанию не запускаются.

## Сервисы Docker

```bash
cp .env.example .env               # заполнить пароли и секреты
docker compose up -d               # Postgres 17 и Reacher 0.11.10, порты только на 127.0.0.1
.venv/Scripts/python -m tanbala_leads.db   # создать таблицы, повторный запуск безопасен
curl http://127.0.0.1:8080/version # Reacher: {"version":"0.11.10"}
```

## Порт 25

`python scripts/check_port25.py` подключается к MX-серверам Gmail и mail.ru и читает приветствие 220, писем не отправляет.

23.10.2026 на машине разработки: **открыт** (с хоста и из контейнера Reacher). На VPS проверить заново: многие хостинги закрывают исходящий 25.

## Документы

- `docs/TZ.md`: копия обзорного ТЗ «VenMart — AI-поиск клиентов для RFID».
- `knowledge/tanbala-agent.md`: копия `Каталог информации Tanbala/07 Агент для писем/о-нас-для-агента.md`. Документ владельца, не править. Если ТЗ ему противоречит, прав он.
