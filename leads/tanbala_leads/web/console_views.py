"""Ответы API консоли (contract/CONSOLE_API.md, раздел 2): из строк базы в JSON с именами в camelCase.

Подписи и правила те же, что у старых страниц (views.py, labels.py). Время — ISO 8601 в UTC. Чужие тексты (сайты,
2ГИС, модель, WhatsApp) отдаются строкой как данные; тексты ошибок (runs.error, companies.last_error,
test_sends.error) — через format.redact. Только чтение: справку brief и отметку «писал в WhatsApp» здесь не зовём.
"""

import math
from datetime import date, datetime, timezone
from typing import Any

import psycopg

from tanbala_leads import contact_policy, llm, pipeline
from tanbala_leads.steps import qualify
from tanbala_leads.steps.collect import CITIES
from tanbala_leads.steps.send import MAX_TEST_SENDS_PER_DAY
from tanbala_leads.web import console_queries as cq
from tanbala_leads.web.actions import WHATSAPP_DRAFT_MESSAGE
from tanbala_leads.web import queries as q
from tanbala_leads.web import views
from tanbala_leads.web.format import (
    Cost,
    estimate_first_run_usd,
    estimate_per_company_usd,
    format_cost,
    parse_pains,
    redact,
)
from tanbala_leads.web.labels import (
    BLOCK_REASONS,
    BLOCKED_MESSAGE,
    COMPANY_STATUSES,
    CONSOLE_COMPANIES_PER_PAGE,
    CONSOLE_LETTERS_PER_PAGE,
    DEFAULT_CITY,
    DEFAULT_MAX_COMPANIES,
    FIT_LABELS,
    FIT_STATUSES,
    HISTORY_PER_PAGE,
    LETTER_FILTERS,
    NO_EMAIL_STATUS,
    QUICK_QUERIES,
    REJECTED_TEST_TEXT,
    RESEARCH_PER_PAGE,
    RESEARCH_REASONS,
    RESEARCH_STATUSES,
    RUN_FILTER_CHOICES,
    RUNS_PER_PAGE,
    SITE_TEXT_PREVIEW_CHARS,
    STATUS_CARDS,
    TEST_NOT_SENDABLE_TEXT,
    TEST_OFF_TEXT,
    TEST_SENDS_SHOWN,
)


# Номер страницы для OFFSET: дальше этого любая страница пустая, а OFFSET не выйдет за bigint.
MAX_OFFSET_PAGE = 10**9


def iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds") if value else None


def usd(value: float) -> float:
    return round(value, 6)


def city_name(code: str | None) -> str | None:
    return CITIES.get(code, code) if code else code


def page_json(items: list[Any], total: int, page: int, size: int, **extra: Any) -> dict[str, Any]:
    """Ответ списка: страница за последней — пустой items с верными total и pages."""
    return {"items": items, "total": total, "page": page, "pages": max(1, math.ceil(total / size)),
            "pageSize": size, **extra}


def cost_json(cost: Cost) -> dict[str, Any]:
    return {"usd": usd(cost.usd), "tokens": cost.tokens, "unpricedTokens": cost.unpriced_tokens}


# ---------- запуски ----------


def run_json(conn: psycopg.Connection, row: dict[str, Any], cost: Cost, pending_total: int) -> dict[str, Any]:
    """Те же поля, что /api/runs/{id} (views.run_json), в camelCase; этапы со счётчиками, как на странице."""
    view = views.run_view(row, cost, letters_pending=q.count_pending_letters(conn, row["id"]),
                          pending_total=pending_total)
    return {
        "id": row["id"], "city": row["city"], "cityName": city_name(row["city"]), "query": row["query"],
        "industries": view["industries"], "maxCompanies": row["max_companies"],
        "status": row["status"], "statusLabel": view["status_label"], "statusTone": view["status_tone"],
        "stage": row["stage"], "stageLabel": view["stage_label"], "stageDetail": row["stage_detail"],
        "found": row["found"], "newCompanies": row["new_companies"], "crawled": row["crawled"],
        "qualified": row["qualified"], "rejected": row["rejected"], "verified": row["verified"],
        "noEmail": row["no_email"], "drafted": row["drafted"], "errors": row["errors"], "error": view["error"],
        "createdAt": iso(row["created_at"]), "startedAt": iso(row["started_at"]), "finishedAt": iso(row["finished_at"]),
        "cost": {**cost_json(cost), "priced": cost.priced, "text": format_cost(cost)},
        "stages": [{"code": stage["code"], "label": stage["label"], "state": stage["state"],
                    "stateLabel": stage["state_label"], "hint": stage["hint"],
                    "counters": [{"field": c["field"], "label": c["label"], "value": c["value"]}
                                 for c in stage["counters"]]} for stage in view["stages"]],
        "finished": view["finished"], "lettersPending": view["letters_pending"],
        "pendingTotal": view["pending_total"], "showReview": view["show_review"],
    }


def run_by_id(conn: psycopg.Connection, run_id: int) -> dict[str, Any] | None:
    row = q.fetch_run(conn, run_id)
    return _run(conn, row) if row else None


def active_run(conn: psycopg.Connection) -> dict[str, Any] | None:
    row = q.fetch_active_run(conn)
    return _run(conn, row) if row else None


def _run(conn: psycopg.Connection, row: dict[str, Any]) -> dict[str, Any]:
    cost = q.fetch_run_costs(conn, [row["id"]]).get(row["id"], Cost())
    return run_json(conn, row, cost, q.count_pending_letters(conn))


def runs(conn: psycopg.Connection, page: int) -> dict[str, Any]:
    rows, total = cq.runs_page(conn, page, RUNS_PER_PAGE)
    costs = q.fetch_run_costs(conn, [row["id"] for row in rows])
    pending = q.count_pending_letters(conn)
    return page_json([run_json(conn, row, costs.get(row["id"], Cost()), pending) for row in rows],
                     total, page, RUNS_PER_PAGE)


def run_ref(row: dict[str, Any]) -> dict[str, Any]:
    return {"id": row["id"], "city": row["city"], "cityName": city_name(row["city"]), "query": row["query"],
            "createdAt": iso(row["created_at"])}


def search_options() -> dict[str, Any]:
    limits = views.search_limits()
    return {
        "cities": [{"code": code, "name": name} for code, name in CITIES.items()],
        "quickQueries": list(QUICK_QUERIES),
        "limits": {"maxQueries": limits["max_queries"], "maxQueryLength": limits["max_query_length"],
                   "maxQueryTextLength": pipeline.MAX_QUERY_TEXT_LENGTH, "maxPerIndustry": limits["max_per"],
                   "maxTotal": limits["max_total"]},
        "defaults": {"city": DEFAULT_CITY, "count": DEFAULT_MAX_COMPANIES},
        "usdPerCompany": usd(estimate_per_company_usd()), "usdFirstRun": usd(estimate_first_run_usd()),
    }


# ---------- сводка и расход ----------


def research_job_json(row: dict[str, Any]) -> dict[str, Any]:
    return {"id": row["id"], "name": row["name"], "city": row["city"], "cityName": city_name(row["city"]),
            "domain": row["domain"], "status": row["status"],
            "statusLabel": RESEARCH_STATUSES.get(row["status"], row["status"]), "reason": row["reason"],
            "reasonLabel": RESEARCH_REASONS.get(row["reason"], row["reason"]) if row["reason"] else None,
            "companyId": row["company_id"], "createdAt": iso(row["created_at"]), "startedAt": iso(row["started_at"]),
            "finishedAt": iso(row["finished_at"])}


def summary(conn: psycopg.Connection, *, test_to: str | None, budget_usd: float | None,
            research_per_day: int | None) -> dict[str, Any]:
    """Главная: тестовый режим, бюджет (тот же расчёт, что проверка при запуске), итоги без компаний из WhatsApp."""
    stats = cq.overview(conn, FIT_STATUSES)
    total = q.fetch_total_cost(conn)
    today = pipeline.spent_today_usd(conn)
    return {
        "testMode": {"testAddress": test_to},
        "budget": {"dailyUsd": budget_usd, "spentTodayUsd": usd(today),
                   "over": budget_usd is not None and today >= budget_usd},
        "spend": {"totalUsd": usd(total.usd), "totalTokens": total.tokens, "unpricedTokens": total.unpriced_tokens},
        "overview": {"companiesFound": stats["companies"], "companiesFit": stats["fit"],
                     "avgScoreFit": int(stats["avg_score"]) if stats["avg_score"] is not None else None,
                     "lettersPending": stats["pending"], "lettersApproved": stats["approved"],
                     "whatsappCompanies": stats["whatsapp"]},
        "activeRun": active_run(conn),
        "research": {"today": cq.research_today(conn), "perDay": research_per_day,
                     "active": [research_job_json(row) for row in cq.active_research_jobs(conn)]},
        "testSends": {"today": cq.test_sends_today(conn), "perDay": MAX_TEST_SENDS_PER_DAY},
    }


def spend(conn: psycopg.Connection, start: date, end: date) -> dict[str, Any]:
    rows = [{"day": row["day"], "model": row["model"], "task": row["task"], "calls": row["calls"],
             "input": row["input"], "output": row["output"], "cacheRead": row["cache_read"],
             "cacheWrite": row["cache_write"]} for row in cq.spend_rows(conn, start, end)]
    prices = {model: {"input": price["input"], "output": price["output"], "cacheRead": price["cache_read"],
                      "cacheWrite": price["cache_write"]} for model, price in llm.MODEL_PRICES_USD_PER_MTOK.items()}
    return {"from": start.isoformat(), "to": end.isoformat(), "rows": rows, "prices": prices,
            "pricesAsOf": llm.MODEL_PRICES_AS_OF}


# ---------- компании ----------


def contact_json(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row or not row.get("email"):
        return None
    view = views.contact_view(row)
    return {"email": row["email"], "verifyResult": row.get("verify_result"), "verifyLabel": view["verify_label"],
            "isCatchAll": row.get("is_catch_all"), "isRole": row.get("is_role")}


def pains_json(raw: Any) -> list[dict[str, Any]]:
    return [{"pain": pain["label"], "evidence": pain["evidence"], "source": pain["source"],
             "sourceLabel": pain["source_label"], "verified": pain["verified"]} for pain in parse_pains(raw)]


def status_json(status: str) -> dict[str, str]:
    label, tone = COMPANY_STATUSES.get(status, (status, "neutral"))
    return {"status": status, "statusLabel": label, "statusTone": tone}


def company_row_json(row: dict[str, Any]) -> dict[str, Any]:
    status = views.display_status(row["status"], row["fit"] is not None)
    draft = None
    if row["draft_id"] is not None:
        checks = views.checks_summary(row["check_result"])
        draft = {"id": row["draft_id"], "subject": row["subject"], "reviewStatus": row["review_status"],
                 "reviewLabel": views.review_view(row["review_status"])["review_label"],
                 "checksTotal": checks["checks_total"], "checksFailed": checks["checks_failed"]}
    return {
        "id": row["id"], "name": row["name"], "rubric": row["rubric"], "city": row["city"],
        "cityName": city_name(row["city"]), "searchQuery": row["search_query"], **status_json(status),
        # «Нет почты» — итог отбора, а не сбой: last_error там только причина.
        "hadError": row["last_error"] is not None and status != NO_EMAIL_STATUS,
        "fit": row["fit"], "fitLabel": FIT_LABELS.get(row["fit"]),
        "score": row["score"], "segment": row["segment"], "contact": contact_json(row), "draft": draft,
        "requestedVia": row["requested_via"], "whatsappContactedAt": iso(row["whatsapp_contacted_at"]),
        "blocked": bool(row["blocked"]), "createdAt": iso(row["created_at"]),
    }


def companies(conn: psycopg.Connection, filters: cq.CompanyFilters) -> dict[str, Any]:
    """Список компаний по 50 и фасеты: числа у каждого фильтра считаются при остальных фильтрах."""
    counts = cq.company_status_counts(conn, filters)
    total_all = sum(counts.values())
    total = counts.get(filters.status, 0) if filters.status else total_all
    size = CONSOLE_COMPANIES_PER_PAGE
    rows = cq.companies_page(conn, filters, size) if (filters.page - 1) * size < total else []
    run = q.fetch_run(conn, filters.run_id) if filters.run_id is not None else None
    facets = {
        "cards": [{"code": code or "all", "label": label, "count": total_all if not code else counts.get(code, 0)}
                  for code, label in STATUS_CARDS],
        "statuses": [{"code": code, "label": label, "count": counts.get(code, 0)}
                     for code, (label, _) in COMPANY_STATUSES.items()],
        "industries": [{"query": row["query"], "count": row["n"]} for row in cq.company_industry_counts(conn, filters)],
        "runs": [run_ref(row) for row in q.fetch_recent_runs(conn, RUN_FILTER_CHOICES)],
        "run": run_ref(run) if run else None,
    }
    return page_json([company_row_json(row) for row in rows], total, filters.page, size, facets=facets)


def history_json(row: dict[str, Any]) -> dict[str, Any]:
    view = views.history_row_view(row)
    out = {"id": row["id"], "occurredAt": iso(row["occurred_at"]), "email": row["email"],
           "direction": row["direction"], "directionLabel": view["direction_label"], "kind": row["kind"],
           "kindLabel": view["kind_label"], "whatLabel": view["what_label"], "source": row["source"],
           "sourceLabel": view["source_label"], "subject": row["subject"], "note": row["note"],
           "draftId": row["draft_id"]}
    if "company_name" in row:
        out.update(companyId=row["company_id"], companyName=row["company_name"])
    return out


def test_sends_json(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"id": row["id"], "sentTo": row["sent_to"], "status": row["status"], "statusLabel": row["status_label"],
             "ok": row["ok"], "error": row["error"], "createdAt": iso(row["created_at"])}
            for row in views.test_sends_view(rows)]


def company_card(conn: psycopg.Connection, company_id: int, *, test_to: str | None) -> dict[str, Any] | None:
    """Всё, что показывает старая карточка компании. Последнее письмо — как GET /letters/{id}."""
    company = q.fetch_company(conn, company_id)
    if company is None:
        return None
    qualification = q.fetch_qualification(conn, company_id)
    draft = q.fetch_latest_draft(conn, company_id)
    letter = letter_json(conn, q.fetch_letter(conn, draft["id"]), test_to=test_to) if draft else None
    blocked = bool(company["blocked"]) or bool(letter and letter["blocked"])
    site_text = company["site_text"] or ""
    return {
        "company": {
            "id": company["id"], "name": company["name"], "rubric": company["rubric"], "city": company["city"],
            "cityName": city_name(company["city"]), "address": company["address"],
            "phones": list(company["phones"] or []), "website": company["website"],
            "websiteDomain": company["website_domain"], "sourceUrl": company["source_url"],
            "branchesCount": company["branches_count"],
            **status_json(views.display_status(company["status"], qualification is not None)),
            "lastError": redact(company["last_error"]), "requestedVia": company["requested_via"],
            "whatsappContactedAt": iso(company["whatsapp_contacted_at"]), "runId": company["run_id"],
            "searchQuery": company["search_query"], "createdAt": iso(company["created_at"]),
        },
        "qualification": ({"fit": qualification["fit"], "fitLabel": FIT_LABELS.get(qualification["fit"]),
                           "score": qualification["score"], "segment": qualification["segment"],
                           "reason": qualification["reason"], "model": qualification["model"],
                           "cardOnly": qualify.card_only(company),
                           "createdAt": iso(qualification["created_at"])} if qualification else None),
        "pains": pains_json(qualification["pains"]) if qualification else [],
        "contacts": [{"id": row["id"], "email": row["email"], "sourcePage": row["source_page"],
                      **{key: value for key, value in contact_json(row).items() if key != "email"},
                      "verifiedAt": iso(row["verified_at"])} for row in q.fetch_contacts(conn, company_id)],
        "draft": letter,
        "history": [history_json(row) for row in contact_policy.history_for_company(conn, company_id)],
        "blocked": blocked,
        "testSends": letter["testSends"] if letter else [],
        "siteText": {"text": site_text[:SITE_TEXT_PREVIEW_CHARS], "length": len(site_text),
                     "truncated": len(site_text) > SITE_TEXT_PREVIEW_CHARS},
        "cost": cost_json(q.fetch_company_cost(conn, company_id)),
    }


def digest(conn: psycopg.Connection, ids: list[int]) -> dict[str, Any]:
    """Компании по списку id в порядке запроса; нет компании — нет её в items."""
    found = {row["id"]: row for row in cq.digest(conn, ids)}
    return {"items": [{
        "id": row["id"], "name": row["name"], "city": row["city"], "cityName": city_name(row["city"]),
        "rubric": row["rubric"], "fit": row["fit"], "score": row["score"], "segment": row["segment"],
        "status": row["status"], "requestedVia": row["requested_via"],
        "whatsappContactedAt": iso(row["whatsapp_contacted_at"]), "blocked": bool(row["blocked"]),
        "emailed": row["first_at"] is not None, "firstLetterAt": iso(row["first_at"]),
        "lastLetterAt": iso(row["last_at"]),
    } for company_id in ids if (row := found.get(company_id))]}


# ---------- письма ----------


def letter_json(conn: psycopg.Connection, row: dict[str, Any], *, test_to: str | None) -> dict[str, Any]:
    """Письмо целиком: заметки для проверяющего отдельно (как split_letter), проверки, кнопки и их причины."""
    view = views.letter_view(row, blocked=bool(row["blocked"]))
    can_send_test = view["can_send_test"] and test_to is not None
    reason = None
    if test_to is None:
        reason = TEST_OFF_TEXT + "."
    elif row["review_status"] == "rejected":
        reason = REJECTED_TEST_TEXT
    elif not can_send_test:
        reason = TEST_NOT_SENDABLE_TEXT
    contact = {"email": row["to_email"], "verify_result": row["verify_result"], "is_catch_all": row["is_catch_all"],
               "is_role": row["is_role"]}
    # Одобрить нельзя из-за «не писать» (как в старой странице) или потому, что компания из WhatsApp (триггер базы).
    approvable = view["can_approve"] or view["approve_blocked"]
    whatsapp = row["requested_via"] is not None
    approve_reason = BLOCKED_MESSAGE if view["blocked"] else WHATSAPP_DRAFT_MESSAGE if whatsapp else None
    return {
        "id": row["id"], "companyId": row["company_id"], "kind": row["kind"], "subject": row["subject"],
        "body": row["body"], "notes": view["notes"], "textLines": view["lines"], "model": row["model"],
        "createdAt": iso(row["created_at"]), "updatedAt": iso(row["updated_at"]), "sentAt": iso(row["sent_at"]),
        "reviewStatus": row["review_status"], "reviewLabel": view["review_label"], "approvedBy": row["approved_by"],
        "approvedAt": iso(row["approved_at"]),
        "checks": [{"code": check["name"], "label": check["label"], "passed": check["passed"],
                    "details": check["details"]} for check in view["checks"]],
        "checksTotal": len(view["checks"]), "checksFailed": view["checks_failed"],
        "contact": contact_json(contact), "testAddress": test_to,
        "canApprove": view["can_approve"] and not whatsapp,
        "approveBlocked": approvable and approve_reason is not None,
        "approveBlockedReason": approve_reason if approvable else None, "canReject": view["can_reject"],
        "canEdit": view["can_edit"], "canSendTest": can_send_test, "sendTestBlockedReason": reason,
        "blocked": view["blocked"],
        "testSends": test_sends_json(q.fetch_test_sends(conn, row["id"], TEST_SENDS_SHOWN)),
        "company": {
            "id": row["company_id"], "name": row["company_name"], "rubric": row["rubric"], "city": row["city"],
            "cityName": city_name(row["city"]), "fit": row["fit"], "fitLabel": FIT_LABELS.get(row["fit"]),
            "score": row["score"], "segment": row["segment"], "reason": row["reason"],
            "pains": pains_json(row["pains"]), "sourceUrl": row["source_url"],
            "whatsappContactedAt": iso(row["whatsapp_contacted_at"]), "requestedVia": row["requested_via"],
            "searchQuery": row["search_query"],
        },
    }


def letter(conn: psycopg.Connection, draft_id: int, *, test_to: str | None) -> dict[str, Any] | None:
    row = q.fetch_letter(conn, draft_id)
    return letter_json(conn, row, test_to=test_to) if row else None


def letters(conn: psycopg.Connection, filter_code: str, run_id: int | None, page: int) -> dict[str, Any]:
    """Очередь писем по 100 в прежнем порядке (queries.LETTER_ORDER) и фильтры с числами при выбранном запуске."""
    counts = q.fetch_letter_counts(conn, run_id)
    totals = {code: (counts.get(review, 0) if review else sum(counts.values())) for code, _, review in LETTER_FILTERS}
    size = CONSOLE_LETTERS_PER_PAGE
    total = totals[filter_code]
    rows = q.fetch_letters(conn, filter_code, run_id, limit=size, offset=(page - 1) * size) \
        if (page - 1) * size < total else []
    run = q.fetch_run(conn, run_id) if run_id is not None else None
    items = []
    for row in rows:
        checks = views.checks_summary(row["check_result"])
        items.append({
            "id": row["id"], "companyId": row["company_id"], "companyName": row["company_name"], "kind": row["kind"],
            "subject": row["subject"], "reviewStatus": row["review_status"],
            "reviewLabel": views.review_view(row["review_status"])["review_label"],
            "checksTotal": checks["checks_total"], "checksFailed": checks["checks_failed"], "score": row["score"],
            "verifiedPains": row["verified_pains"], "searchQuery": row["search_query"], "blocked": bool(row["blocked"]),
            "createdAt": iso(row["created_at"]), "updatedAt": iso(row["updated_at"]), "sentAt": iso(row["sent_at"]),
        })
    return page_json(items, total, page, size, status=filter_code,
                     filters=[{"code": code, "label": label, "count": totals[code]}
                              for code, label, _ in LETTER_FILTERS],
                     run=run_ref(run) if run else None)


# ---------- кому писали и проверки из WhatsApp ----------


def history(conn: psycopg.Connection, page: int) -> dict[str, Any]:
    rows, total = q.fetch_history_page(conn, min(page, MAX_OFFSET_PAGE), HISTORY_PER_PAGE)
    return page_json([history_json(row) for row in rows], total, page, HISTORY_PER_PAGE)


def blocked(conn: psycopg.Connection, page: int) -> dict[str, Any]:
    rows, total = q.fetch_blocked_page(conn, min(page, MAX_OFFSET_PAGE), HISTORY_PER_PAGE)
    return page_json([{"id": row["id"], "email": row["email"], "domain": row["domain"],
                       "companyId": row["company_id"], "companyName": row["company_name"], "reason": row["reason"],
                       "reasonLabel": BLOCK_REASONS.get(row["reason"], row["reason"]), "note": row["note"],
                       "createdAt": iso(row["created_at"])} for row in rows], total, page, HISTORY_PER_PAGE)


def research_jobs(conn: psycopg.Connection, status: str | None, page: int) -> dict[str, Any]:
    rows, total = cq.research_jobs_page(conn, status, page, RESEARCH_PER_PAGE)
    return page_json([research_job_json(row) for row in rows], total, page, RESEARCH_PER_PAGE)
