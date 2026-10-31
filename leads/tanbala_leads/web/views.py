"""Данные для шаблонов и /api/runs: из строк базы в то, что показывает страница."""

import math
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

from tanbala_leads import contact_policy, pipeline
from tanbala_leads.steps.collect import CITIES
from tanbala_leads.web import queries as q
from tanbala_leads.web.format import (
    Cost,
    companies_url,
    display_url,
    estimate_first_run_usd,
    estimate_per_company_usd,
    fmt_int,
    industries,
    format_approx_usd,
    format_cost,
    format_run_estimate,
    format_usd,
    letters_url,
    parse_checks,
    parse_id,
    parse_pains,
    redact,
    safe_href,
    split_letter,
    tel_href,
    toggle_industry,
)
from tanbala_leads.web.labels import (
    BLOCK_REASONS,
    BLOCKED_LABEL,
    COMPANIES_PER_PAGE,
    COMPANY_SEARCH_MAX_LENGTH,
    COMPANY_STATUSES,
    NO_EMAIL_STATUS,
    DEFAULT_CITY,
    DEFAULT_LETTER_FILTER,
    DEFAULT_MAX_COMPANIES,
    FINISHED_RUN_STATUSES,
    FIT_LABELS,
    FIT_STATUSES,
    HISTORY_DIRECTIONS,
    HISTORY_KINDS,
    HISTORY_PER_PAGE,
    HISTORY_SOURCES,
    LETTER_FILTERS,
    MAX_BODY_LENGTH,
    MAX_SUBJECT_LENGTH,
    QUICK_QUERIES,
    RECENT_RUNS,
    REVIEW_STATUSES,
    RUN_FILTER_CHOICES,
    RUN_STATUSES,
    SITE_TEXT_PREVIEW_CHARS,
    STAGE_ALIASES,
    STAGE_HINTS,
    STAGE_STATE_LABELS,
    STAGES,
    STATUS_CARDS,
    TEST_SEND_STATUSES,
    TEST_SENDS_SHOWN,
    VERIFY_RESULTS,
)

LETTER_FILTER_CODES = tuple(code for code, _, _ in LETTER_FILTERS)


# ---------- запуски ----------


def stage_index(stage: str | None) -> int | None:
    for index, (code, label, _) in enumerate(STAGES):
        if stage in (code, label):
            return index
    return STAGE_ALIASES.get(stage or "")


def stage_states(status: str, stage: str | None) -> list[str]:
    """Состояние каждого этапа: done, current, failed или pending. Сбой без известного этапа: на первом."""
    if status == "done":
        return ["done"] * len(STAGES)
    current = stage_index(stage)
    if current is None:
        current = -1 if status == "queued" else 0
    states = []
    for index in range(len(STAGES)):
        if index < current:
            states.append("done")
        elif index == current:
            states.append("failed" if status == "failed" else "current")
        else:
            states.append("pending")
    return states


def cost_json(cost: Cost) -> dict[str, Any]:
    return {"tokens": cost.tokens, "usd": round(cost.usd, 6), "priced": cost.priced, "text": format_cost(cost)}


def run_json(row: dict[str, Any], cost: Cost, *, letters_pending: int = 0, pending_total: int = 0) -> dict[str, Any]:
    """Строка runs для /api/runs: поля, расход, подписи и письма на проверку. Страница строится из того же."""
    label, tone = RUN_STATUSES.get(row["status"], (row["status"], "neutral"))
    states = stage_states(row["status"], row["stage"])
    finished = row["status"] in FINISHED_RUN_STATUSES
    return {
        **row,
        "error": redact(row["error"]),
        "cost": cost_json(cost),
        "status_label": label,
        "status_tone": tone,
        "stage_label": next((name for code, name, _ in STAGES if row["stage"] in (code, name)), row["stage"]),
        "stages": [{"code": code, "label": name, "state": state, "state_label": STAGE_STATE_LABELS[state],
                    "hint": stage_hint(code, state, row.get("stage_detail"))}
                   for (code, name, _), state in zip(STAGES, states, strict=True)],
        "industries": industries(row.get("query") or ""),
        "finished": finished,
        # Письма этого запуска, которые ждут проверки, и все ждущие (для значка вкладки «Письма»).
        "letters_pending": letters_pending,
        "pending_total": pending_total,
        "show_review": letters_pending > 0 and (finished or row["drafted"] > 0),
    }


def run_view(row: dict[str, Any], cost: Cost, **letters: int) -> dict[str, Any]:
    view = run_json(row, cost, **letters)
    stages = [
        {**stage,
         "counters": [{"field": field, "label": text, "value": row[field]} for field, text in counters]}
        for stage, (_, _, counters) in zip(view["stages"], STAGES, strict=True)
    ]
    return {**view, "stages": stages, "city_name": CITIES.get(row["city"], row["city"]), "cost": cost,
            "cost_text": format_cost(cost), "companies_url": companies_url(run_id=row["id"]),
            "letters_url": letters_url(run_id=row["id"]), "letters_all_url": letters_url(status="all", run_id=row["id"])}


def stage_hint(code: str, state: str, detail: str | None) -> str:
    """Подпись этапа; пока идёт поиск в 2ГИС по нескольким отраслям, какая сейчас: «логистика (2 из 3)»."""
    if code == STAGES[0][0] and state == "current" and detail:
        return f"ищем: {detail}"
    return STAGE_HINTS[code]


def search_form(city: str = DEFAULT_CITY, query: str = "", max_companies: str | int = DEFAULT_MAX_COMPANIES) -> dict:
    return {"city": city if city in CITIES else DEFAULT_CITY, "query": query[: pipeline.MAX_QUERY_TEXT_LENGTH],
            "max_companies": str(max_companies)[:4]}


def search_limits() -> dict[str, Any]:
    """Лимиты и цены для живой строки под кнопкой: те же, что проверяет pipeline.create_run."""
    return {"max_queries": pipeline.MAX_QUERIES, "max_query_length": pipeline.MAX_QUERY_LENGTH,
            "max_total": pipeline.MAX_TOTAL_COMPANIES, "max_per": pipeline.MAX_COMPANIES_LIMIT,
            "per_company_usd": round(estimate_per_company_usd(), 6), "first_run_usd": round(estimate_first_run_usd(), 6)}


def overview_view(conn, *, budget_usd: float | None) -> dict[str, Any]:
    """Сводка для руководства над формой поиска: итоги, средняя оценка, расход всего и за сегодня."""
    stats = q.fetch_overview(conn, FIT_STATUSES)
    total = q.fetch_total_cost(conn)
    today = pipeline.spent_today_usd(conn)
    share = min(1.0, today / budget_usd) if budget_usd else None
    return {
        **stats, "avg_score": int(stats["avg_score"]) if stats["avg_score"] is not None else None,
        # В ячейке только доллары; токены моделей без цены отдельной строкой, чтобы число не разъезжалось.
        "cost_total": f"≈ {format_usd(total.usd)}" if total.tokens else "$0", "cost_today": format_usd(today),
        "unpriced_tokens": total.unpriced_tokens,
        "budget": format_usd(budget_usd) if budget_usd else None,
        # Доля дневного лимита для полоски: ширина в SVG-атрибуте, без инлайнового стиля (CSP).
        "budget_share": round(share * 100, 1) if share is not None else None,
        "budget_over": bool(budget_usd and today >= budget_usd),
    }


def search_context(conn, *, form: dict, run_id: int | None, message: str | None,
                   pending_total: int, budget_usd: float | None = None) -> dict[str, Any]:
    active = q.fetch_active_run(conn)
    recent = q.fetch_recent_runs(conn, RECENT_RUNS)
    shown = (q.fetch_run(conn, run_id) if run_id is not None else None) or active or (recent[0] if recent else None)
    costs = q.fetch_run_costs(conn, sorted({row["id"] for row in recent} | ({shown["id"]} if shown else set())))
    limit = pipeline.MAX_COMPANIES_LIMIT
    chosen = industries(form["query"])
    chips = [{"label": item, "pressed": item.casefold() in {query.casefold() for query in chosen},
              "url": "/?" + urlencode({"q": toggle_industry(form["query"], item)})} for item in QUICK_QUERIES]
    run = None
    if shown:
        run = run_view(shown, costs.get(shown["id"], Cost()), pending_total=pending_total,
                       letters_pending=q.count_pending_letters(conn, shown["id"]))
    return {
        "title": "Поиск", "nav": "search", "cities": CITIES, "form": form, "message": message,
        "chips": chips, "max_limit": limit, "max_query_length": pipeline.MAX_QUERY_TEXT_LENGTH,
        "limits": search_limits(),
        "usd_per_company": format_approx_usd(estimate_per_company_usd()),
        "usd_first_run": format_approx_usd(estimate_first_run_usd()),
        "run_estimate": format_run_estimate(len(chosen), parse_id(form["max_companies"]) or DEFAULT_MAX_COMPANIES),
        "run": run,
        "active_run": run_view(active, Cost()) if active else None,
        "history": [run_view(row, costs.get(row["id"], Cost())) for row in recent],
        "stage_legend": [{"code": code, "label": label, "hint": STAGE_HINTS[code]} for code, label, _ in STAGES],
        "overview": overview_view(conn, budget_usd=budget_usd),
    }


# ---------- компании ----------


def checks_summary(check_result: Any) -> dict[str, int]:
    checks = parse_checks(check_result)
    return {"checks_total": len(checks), "checks_failed": sum(1 for check in checks if not check["passed"])}


def review_view(review_status: str) -> dict[str, str]:
    label, tone = REVIEW_STATUSES.get(review_status, (review_status, "neutral"))
    return {"review_label": label, "review_tone": tone}


def contact_view(row: dict[str, Any]) -> dict[str, Any]:
    label, tone = VERIFY_RESULTS.get(row.get("verify_result"), (str(row.get("verify_result")), "neutral"))
    flags = []
    if row.get("is_catch_all"):
        flags.append("принимает любые адреса")
    if row.get("is_role"):
        flags.append("общий ящик")
    return {**row, "verify_label": label, "verify_tone": tone, "flags": flags,
            "source_href": safe_href(row.get("source_page"))}


def display_status(status: str, qualified: bool) -> str:
    """Статус для показа, как queries.DISPLAY_STATUS_SQL: rejected без оценки — «Нет почты», а не «Не подходит»."""
    return NO_EMAIL_STATUS if status == "rejected" and not qualified else status


def company_row_view(row: dict[str, Any]) -> dict[str, Any]:
    status = display_status(row["status"], row.get("fit") is not None)
    label, tone = COMPANY_STATUSES.get(status, (status, "neutral"))
    draft = None
    if row.get("draft_id") is not None:
        draft = {"id": row["draft_id"], "subject": row["subject"], "review_status": row["review_status"],
                 "url": letters_url(row["draft_id"]), **review_view(row["review_status"]),
                 **checks_summary(row["check_result"])}
    url = f"/companies/{row['id']}"
    return {
        **row, "status": status, "status_label": label, "status_tone": tone,
        "city_name": CITIES.get(row["city"], row["city"]),
        # «Нет почты» — итог отбора, а не сбой: last_error там только причина.
        "had_error": row["last_error"] is not None and status != NO_EMAIL_STATUS,
        "fit_label": FIT_LABELS.get(row.get("fit"), row.get("fit")),
        "contact": contact_view(row) if row.get("email") else None, "draft": draft, "url": url,
        # Статус «Письмо готово» ведёт к письму: туда владелец и нажимал.
        "status_url": draft["url"] if draft else url,
    }


@dataclass(frozen=True)
class CompanyFilters:
    run_id: int | None
    status: str | None
    q: str
    page: int
    query: str | None = None  # отрасль: companies.search_query, точное совпадение


def companies_context(conn, filters: CompanyFilters) -> dict[str, Any]:
    counts = q.fetch_status_counts(conn, filters.run_id, filters.q, filters.query)
    total_all = sum(counts.values())
    total = counts.get(filters.status, 0) if filters.status else total_all
    pages = max(1, math.ceil(total / COMPANIES_PER_PAGE))
    page = min(filters.page, pages)
    rows = q.fetch_companies(conn, filters.run_id, filters.status, filters.q, page, filters.query)

    def url(status: str | None = filters.status, page_number: int | None = None) -> str:
        return companies_url(filters.run_id, status, filters.q, page_number, filters.query)

    first = (page - 1) * COMPANIES_PER_PAGE + 1 if rows else 0
    run = q.fetch_run(conn, filters.run_id) if filters.run_id is not None else None
    cards = [{"label": label, "count": total_all if not code else counts.get(code, 0),
              "url": url(code or None), "selected": (filters.status or "") == code}
             for code, label in STATUS_CARDS]
    statuses = [{"code": code, "label": label, "count": counts.get(code, 0)}
                for code, (label, _) in COMPANY_STATUSES.items()]
    return {
        "title": "Компании", "nav": "companies", "filters": filters, "rows": [company_row_view(r) for r in rows],
        "cards": cards, "statuses": statuses, "total": total, "first": first, "last": first + len(rows) - 1,
        "page": page, "pages": pages,
        "prev_url": url(page_number=page - 1) if page > 1 else None,
        "next_url": url(page_number=page + 1) if page < pages else None,
        "industries": q.fetch_industry_counts(conn, filters.run_id, filters.q, filters.status),
        "run": run_view(run, Cost()) if run else None,
        "run_choices": [run_view(r, Cost()) for r in q.fetch_recent_runs(conn, RUN_FILTER_CHOICES)],
        "clear_url": "/companies", "max_query_length": COMPANY_SEARCH_MAX_LENGTH,
    }


def letter_view(draft: dict[str, Any], *, blocked: bool = False) -> dict[str, Any]:
    """Письмо для страницы: заметки отдельно от текста клиенту, непройденные проверки первыми.

    blocked: компания или адрес в списке «не писать»; одобрить нельзя, отклонить и править можно.
    """
    notes, lines = split_letter(draft["body"])
    checks = sorted(parse_checks(draft["check_result"]), key=lambda check: check["passed"])
    editable = draft["sent_at"] is None and draft["review_status"] != "rejected"
    approvable = editable and draft["review_status"] != "approved"
    return {
        **draft, **review_view(draft["review_status"]), "notes": notes, "lines": lines, "checks": checks,
        "checks_failed": sum(1 for check in checks if not check["passed"]),
        "can_approve": approvable and not blocked, "approve_blocked": approvable and blocked,
        "can_reject": editable, "can_edit": editable, "blocked": blocked,
        # Тест уходит только владельцу; отклонённое письмо не отправляется даже в тест.
        "can_send_test": draft["sent_at"] is None and draft["review_status"] in ("pending", "approved"),
    }


def test_sends_view(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{**row, "status_label": TEST_SEND_STATUSES.get(row["status"], (row["status"], "neutral"))[0],
             "ok": row["status"] == "sent", "error": redact(row["error"])} for row in rows]


def history_row_view(row: dict[str, Any]) -> dict[str, Any]:
    direction = HISTORY_DIRECTIONS.get(row["direction"], row["direction"])
    kind = HISTORY_KINDS.get(row["kind"], row["kind"])
    # Входящее — это всегда ответ клиента: «ответ, ответ» не пишем.
    what = direction if row["direction"] == "in" else f"{direction}, {kind}"
    return {**row, "direction_label": direction, "kind_label": kind, "what_label": what,
            "source_label": HISTORY_SOURCES.get(row["source"], row["source"])}


def company_context(conn, company_id: int) -> dict[str, Any] | None:
    company = q.fetch_company(conn, company_id)
    if company is None:
        return None
    qualification = q.fetch_qualification(conn, company_id)
    draft = q.fetch_latest_draft(conn, company_id)
    blocked = bool(company["blocked"]) or bool(draft and q.letter_blocked(conn, draft["id"]))
    status = display_status(company["status"], qualification is not None)
    label, tone = COMPANY_STATUSES.get(status, (status, "neutral"))
    site_text = company["site_text"] or ""
    website_href = safe_href(company["website"])
    return {
        "title": company["name"], "nav": "companies",
        "company": {**company, "status": status, "status_label": label, "status_tone": tone,
                    "last_error": redact(company["last_error"]),
                    "city_name": CITIES.get(company["city"], company["city"]),
                    "website_href": website_href,
                    "website_text": display_url(website_href) if website_href else company["website"],
                    "source_href": safe_href(company["source_url"]),
                    "phones": [{"text": p, "href": tel_href(p)} for p in company["phones"] or []]},
        "qualification": ({**qualification, "fit_label": FIT_LABELS.get(qualification["fit"], qualification["fit"]),
                           "pains": parse_pains(qualification["pains"])} if qualification else None),
        "blocked": blocked, "blocked_label": BLOCKED_LABEL,
        "history": [history_row_view(row) for row in contact_policy.history_for_company(conn, company_id)],
        "contacts": [contact_view(c) for c in q.fetch_contacts(conn, company_id)],
        "draft": ({**letter_view(draft, blocked=blocked), "queue_url": letters_url(draft["id"]),
                   "test_sends": test_sends_view(q.fetch_test_sends(conn, draft["id"], TEST_SENDS_SHOWN)),
                   "self_url": f"/companies/{company_id}#letter", "edit_url": f"/companies/{company_id}?edit=1#letter"}
                  if draft else None),
        "site_text": site_text[:SITE_TEXT_PREVIEW_CHARS], "site_text_length": len(site_text),
        "site_text_truncated": len(site_text) > SITE_TEXT_PREVIEW_CHARS,
        "company_cost": format_cost(q.fetch_company_cost(conn, company_id)),
        "run_url": companies_url(run_id=company["run_id"]) if company["run_id"] else None,
    }


# ---------- очередь писем ----------


def letter_filter(value: str | None, review_status: str | None = None) -> str:
    """Фильтр из адреса; без него у открытого письма свой: одобренное откроется среди одобренных."""
    if value in LETTER_FILTER_CODES:
        return value
    return review_status if review_status in LETTER_FILTER_CODES else DEFAULT_LETTER_FILTER


def letters_context(conn, *, filter_code: str, run_id: int | None, selected: dict[str, Any] | None) -> dict[str, Any]:
    counts = q.fetch_letter_counts(conn, run_id)
    totals = {code: (counts.get(review, 0) if review else sum(counts.values())) for code, _, review in LETTER_FILTERS}
    rows = q.fetch_letters(conn, filter_code, run_id)
    if selected is None and rows:
        selected = q.fetch_letter(conn, rows[0]["id"])
    selected_id = selected["id"] if selected else None
    items = [{**row, **review_view(row["review_status"]), **checks_summary(row["check_result"]),
              "blocked_label": BLOCKED_LABEL,
              "url": letters_url(row["id"], status=filter_code, run_id=run_id), "selected": row["id"] == selected_id}
             for row in rows]
    run = q.fetch_run(conn, run_id) if run_id is not None else None
    return {
        "title": "Письма", "nav": "letters", "filter_code": filter_code, "run_id": run_id,
        "filters": [{"code": code, "label": label, "count": totals[code], "selected": code == filter_code,
                     "url": letters_url(status=code, run_id=run_id)} for code, label, _ in LETTER_FILTERS],
        "items": items, "shown_count": len(items), "filter_total": totals[filter_code],
        "letter": ({**selected_letter_view(selected, filter_code, run_id),
                    "test_sends": test_sends_view(q.fetch_test_sends(conn, selected["id"], TEST_SENDS_SHOWN))}
                   if selected else None),
        "run": run_view(run, Cost()) if run else None,
        "clear_run_url": letters_url(status=filter_code),
    }


def selected_letter_view(row: dict[str, Any], filter_code: str, run_id: int | None) -> dict[str, Any]:
    contact = contact_view({"email": row["to_email"], "verify_result": row["verify_result"],
                            "is_catch_all": row["is_catch_all"], "is_role": row["is_role"]})
    return {
        **letter_view(row, blocked=bool(row["blocked"])), "contact": contact if row["to_email"] else None,
        "pains": parse_pains(row["pains"]), "blocked_label": BLOCKED_LABEL,
        "fit_label": FIT_LABELS.get(row["fit"], row["fit"]), "city_name": CITIES.get(row["city"], row["city"]),
        "company_url": f"/companies/{row['company_id']}", "source_href": safe_href(row["source_url"]),
        "self_url": letters_url(row["id"], status=filter_code, run_id=run_id),
        "edit_url": letters_url(row["id"], status=filter_code, run_id=run_id, edit=True),
    }


def validate_draft_edit(subject: str, body: str) -> tuple[str, str, str | None]:
    """Тема и текст после правки: CRLF → LF, пустое и слишком длинное не пускаем."""
    subject = " ".join(subject.split())
    body = body.replace("\r\n", "\n").replace("\r", "\n").strip("\n")
    if not subject or not body.strip():
        return subject, body, "Тема и текст письма не должны быть пустыми."
    if len(subject) > MAX_SUBJECT_LENGTH or len(body) > MAX_BODY_LENGTH:
        return subject, body, f"Тема до {MAX_SUBJECT_LENGTH} символов, текст до {fmt_int(MAX_BODY_LENGTH)} символов."
    return subject, body, None


def history_url(history_page: int, blocked_page: int) -> str:
    params = {"history_page": history_page, "blocked_page": blocked_page}
    query = "&".join(f"{key}={value}" for key, value in params.items() if value > 1)
    return "/history" + (f"?{query}" if query else "")


def pager_view(total: int, page: int, url_for) -> dict[str, Any]:
    pages = max(1, math.ceil(total / HISTORY_PER_PAGE))
    page = min(page, pages)
    return {"page": page, "pages": pages, "total": total,
            "prev_url": url_for(page - 1) if page > 1 else None, "next_url": url_for(page + 1) if page < pages else None}


def history_context(conn, *, history_page: int, blocked_page: int, result: dict | None = None,
                    form_text: dict | None = None) -> dict[str, Any]:
    """Вкладка «Кому писали»: две формы импорта, история писем и список «не писать», по 50 строк."""
    history, history_total = q.fetch_history_page(conn, history_page, HISTORY_PER_PAGE)
    blocked, blocked_total = q.fetch_blocked_page(conn, blocked_page, HISTORY_PER_PAGE)
    return {
        "title": "Кому писали", "nav": "history", "result": result, "form_text": form_text or {},
        "history": [history_row_view(row) for row in history],
        "history_pager": pager_view(history_total, history_page, lambda n: history_url(n, blocked_page)),
        "blocked": [{**row, "reason_label": BLOCK_REASONS.get(row["reason"], row["reason"]),
                     "company_url": f"/companies/{row['company_id']}" if row["company_id"] else None}
                    for row in blocked],
        "blocked_pager": pager_view(blocked_total, blocked_page, lambda n: history_url(history_page, n)),
    }
