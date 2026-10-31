// Поддельный внутренний API почтового проекта (только режим SIM_FAKE=1). Отвечает по контракту
// deploy/contract/INTERNAL_API.md: GET /internal/lookup, GET /internal/companies/{id}/brief, POST /internal/research,
// GET /internal/research/{job_id}. Справочник компаний ниже вымышленный, кроме Kusto (как в живом чате 7669).
import { randomUUID } from 'node:crypto';

/** Компании справочника. names: полные названия (совпадение 0.95), prefixes: первое слово (0.85, как почта с 31.10). */
const BASE_COMPANIES = [
  {
    id: 15,
    name: 'Kusto Logistics Management, компания',
    city: 'Алматы',
    rubric: 'Складское хранение, Международные грузоперевозки',
    segment: 'Логистика и склады',
    names: ['kusto logistics management', 'kusto logistics', 'кусто логистикс менеджмент'],
    prefixes: ['kusto', 'кусто'],
    pains: [
      {
        pain: 'Цифры в 1С не сходятся с тем, что на полках',
        evidence: 'Складское хранение, грузоперевозки',
        source: '2gis',
      },
    ],
  },
  {
    id: 21,
    name: 'Склад Сервис Астана, ТОО',
    city: 'Астана',
    rubric: 'Складские услуги, Ответственное хранение',
    segment: 'Склады',
    names: ['склад сервис астана', 'склад сервис'],
    prefixes: [],
    emailed: true,
    emailedAt: '2026-10-20T09:00:00Z',
    emailSubject: 'Учёт на складе без пересчётов',
    pains: [
      { pain: 'Долгая ручная инвентаризация', evidence: 'Ответственное хранение', source: '2gis' },
      { pain: 'Пересортица при отгрузке', evidence: null, source: 'site' },
    ],
  },
  {
    id: 31,
    name: 'Альфа Трейд, ТОО',
    city: 'Алматы',
    rubric: 'Оптовая торговля',
    segment: 'Опт',
    names: ['альфа трейд'],
    prefixes: [],
    // Для проверки шага б (поиск по номеру): SIM_PHONE=77000000066 в режиме подделок.
    phones: ['77000000066'],
    pains: [{ pain: 'Остатки в учёте расходятся с фактом', evidence: null, source: '2gis' }],
  },
];

/** Что находит проверка новой компании (research): только эти названия, остальное not_in_2gis. */
const RESEARCH_FINDS = [
  {
    id: 44,
    name: 'Kusto Fashion, магазин одежды',
    city: 'Астана',
    rubric: 'Магазины одежды',
    segment: 'Розница',
    names: ['kusto fashion', 'кусто фэшн'],
    prefixes: [],
    pains: [{ pain: 'Долгий пересчёт товара в зале', evidence: null, source: '2gis' }],
  },
];

/** Формы собственности: \b в JS не видит кириллицу, поэтому слова отсекаются после разбиения по пробелам. */
const OWNERSHIP = new Set(['тоо', 'ооо', 'ип', 'ао', 'зао', 'llp', 'ltd', 'llc', 'компания', 'фирма']);

export function normalizeName(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[«»"'`“”„.,!?()]/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word !== '' && !OWNERSHIP.has(word))
    .join(' ');
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function candidateOf(company, matchBy, score) {
  return {
    id: company.id,
    name: company.name,
    city: company.city ?? null,
    rubric: company.rubric ?? null,
    match_by: matchBy,
    match_score: score,
    emailed: company.emailed === true,
  };
}

function briefOf(company) {
  return {
    id: company.id,
    name: company.name,
    city: company.city ?? null,
    rubric: company.rubric ?? null,
    segment: company.segment ?? null,
    fit: 'yes',
    fit_score: 80,
    reason: 'Справка симулятора',
    pains: company.pains ?? [],
    emailed: company.emailed === true,
    emailed_at: company.emailedAt ?? null,
    email_subject: company.emailSubject ?? null,
  };
}

function nameScore(company, query) {
  const key = normalizeName(query);
  if (key === '') return 0;
  if (company.names.some((name) => normalizeName(name) === key)) return 0.95;
  if ((company.prefixes ?? []).includes(key)) return 0.85;
  return 0;
}

/**
 * Поддельная почта. extraCompanies: компании из сценария (поле fake.companies), в том же виде, что BASE_COMPANIES.
 * researchMs: через сколько мс после запуска проверка заканчивается.
 */
export function createFakeLeads({ extraCompanies = [], researchFinds = [], researchMs }) {
  const companies = [...BASE_COMPANIES, ...extraCompanies];
  const findable = [...RESEARCH_FINDS, ...researchFinds];
  const all = [...companies, ...findable];
  const jobs = new Map();
  /** Компании, которые проверка уже «добавила» в базу почты: дальше их находит и lookup. */
  const added = [];

  const known = () => [...companies, ...added];

  function lookup(url) {
    const name = url.searchParams.get('name');
    const phone = url.searchParams.get('phone');
    const domain = url.searchParams.get('domain');
    if (phone !== null) {
      const found = known().filter((company) => (company.phones ?? []).includes(phone));
      return json(200, { candidates: found.map((company) => candidateOf(company, 'phone', 1)) });
    }
    if (domain !== null) {
      const found = known().filter((company) => (company.domains ?? []).includes(domain));
      return json(200, { candidates: found.map((company) => candidateOf(company, 'domain', 1)) });
    }
    if (name !== null) {
      const scored = known()
        .map((company) => ({ company, score: nameScore(company, name) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      return json(200, { candidates: scored.map((item) => candidateOf(item.company, 'name', item.score)) });
    }
    return json(400, { detail: 'нужен один параметр' });
  }

  function startResearch(body) {
    if (body === null || typeof body.name !== 'string' || body.name.trim() === '') {
      return json(400, { detail: 'нет названия' });
    }
    const names = [body.name, ...(Array.isArray(body.aliases) ? body.aliases : [])];
    const existing = known().find((company) => names.some((name) => nameScore(company, name) >= 0.95));
    if (existing !== undefined) return json(200, { status: 'done', company_id: existing.id });
    const jobId = randomUUID();
    const found = findable.find((company) => names.some((name) => nameScore(company, name) >= 0.95));
    jobs.set(jobId, { startedAt: Date.now(), found: found ?? null });
    return json(202, { job_id: jobId });
  }

  function researchStatus(jobId) {
    const job = jobs.get(jobId);
    if (job === undefined) return json(200, { status: 'not_found' });
    if (Date.now() - job.startedAt < researchMs) return json(200, { status: 'running' });
    if (job.found === null) return json(200, { status: 'failed', reason: 'not_in_2gis' });
    if (!added.includes(job.found)) added.push(job.found);
    return json(200, { status: 'done', brief: briefOf(job.found) });
  }

  function brief(idText) {
    const id = Number(idText);
    const company = all.find((item) => item.id === id);
    return company === undefined ? json(404, { detail: 'нет такой компании' }) : json(200, briefOf(company));
  }

  return {
    /** Ответ на запрос бота; токен проверяется только на наличие (значение не читается и никуда не пишется). */
    handle(method, url, body, headers) {
      if (!headers.has('x-internal-token')) return json(401, { detail: 'нет токена' });
      const path = url.pathname;
      if (method === 'GET' && path === '/internal/lookup') return lookup(url);
      if (method === 'POST' && path === '/internal/research') return startResearch(body);
      const status = /^\/internal\/research\/([A-Za-z0-9-]+)$/u.exec(path);
      if (method === 'GET' && status !== null) return researchStatus(status[1]);
      const briefMatch = /^\/internal\/companies\/(\d+)\/brief$/u.exec(path);
      if (method === 'GET' && briefMatch !== null) return brief(briefMatch[1]);
      return json(404, { detail: 'нет такого адреса' });
    },
  };
}
