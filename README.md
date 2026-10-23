# Tanbala: поиск клиентов для RFID

Каждый день: таблица казахстанских компаний, которым может быть нужен RFID, с проверенной почтой, причиной и черновиком письма. Письмо уходит только после одобрения человеком.

ТЗ: [docs/TZ.md](docs/TZ.md). Знания агента: [knowledge/tanbala-agent.md](knowledge/tanbala-agent.md), этот файл не правим. Установка: [docs/SETUP.md](docs/SETUP.md).

## Структура

```
config/models.yaml          модель и max_tokens для каждой задачи
docs/                       ТЗ и установка
knowledge/tanbala-agent.md  документ владельца о Tanbala
scripts/                    служебные проверки окружения
tanbala_leads/
  cli.py                    python -m tanbala_leads <команда>
  settings.py               переменные окружения и .env
  db.py                     схема Postgres и миграции
  llm.py                    вызовы Claude: модель из конфига, кэш, лог токенов
  knowledge.py              чтение документа о Tanbala
  checks.py                 проверки письма кодом, без API
  contact_policy.py         история писем и список «не писать»
  steps/
    collect.py              1. 2ГИС → companies (new)
    crawl.py                2. сайт → contacts (crawled)
    qualify.py              3. квалификация (qualified / rejected)
    verify.py               4. Reacher (verified)
    draft.py                5. черновик письма (drafted)
    review.py               6. проверка черновика: код, потом модель
    approve.py              7. одобрение человеком (approved)
    send.py                 8. отправка, сейчас только --dry-run (sent)
    replies.py              ответы клиентов (replied)
tests/
  fixtures/                 сохранённые ответы API
```
