// Заглушки остальных экранов (только `npm run dev`). Формы — как в contract/CONSOLE_API.md («Реализация почты/бота»)
// и console/docs/API.md. Компании и люди выдуманы.
import { CHATS, homeFixture } from './fixtures';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (ms: number): string => new Date(ms).toISOString();

function page<T>(items: readonly T[], pageNo: number, pageSize: number) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return { items: items.slice((pageNo - 1) * pageSize, pageNo * pageSize), total, page: pageNo, pages, pageSize };
}

export function chatsFixture(now: number, q: URLSearchParams) {
  const home = homeFixture(now);
  const waiting = new Map(home.attention.waiting.map((w) => [w.chatId, w.waitingSince]));
  const rows = CHATS.map((c, i) => ({
    id: c.id, name: c.name, phone: c.phone, phoneHidden: c.phone === null, status: c.status, statusBy: c.statusBy, statusLabel: c.statusLabel,
    level: c.level, levelLabel: c.level, lastMessageAt: iso(now - (i + 1) * 13 * MIN),
    lastMessage: { author: i % 2 ? 'bot' : 'client', kind: c.id === 23 ? 'text' : 'text', text: home.attention.waiting.find((w) => w.chatId === c.id)?.lastText ?? 'Спасибо, жду расчёт' },
    openHandoff: home.attention.handoffs.find((h) => h.chatId === c.id) ?? null,
    company: c.companyName ? { state: c.id === 19 ? 'candidate' : 'confirmed', id: 300 + c.id, name: c.companyName } : null,
    waitingSince: waiting.get(c.id) ?? null,
  }));
  const filtered = rows.filter((r) => (!q.get('status') || r.status === q.get('status')) && (!q.get('level') || r.level === q.get('level')) && (q.get('waiting') !== '1' || r.waitingSince !== null) && (!q.get('q') || (r.name ?? '').toLowerCase().includes((q.get('q') ?? '').toLowerCase())));
  return page(filtered, Number(q.get('page') ?? 1), 30);
}

export function notificationsFixture(now: number, q: URLSearchParams) {
  const items = [
    { id: 61, at: iso(now - 16 * MIN), updatedAt: iso(now - 16 * MIN), kind: 'handoff', kindLabel: 'передача чата', status: 'sent', statusLabel: 'отправлено', attempts: 1, chatId: 12, chatName: 'Айгерим Сапарова', text: 'Передача чата: Айгерим Сапарова, горячий клиент. Компания: ТОО «Алматы Логистик Хаб».' },
    { id: 58, at: iso(now - 41 * MIN), updatedAt: iso(now - 20 * MIN), kind: 'handoff', kindLabel: 'передача чата', status: 'failed', statusLabel: 'сбой отправки', attempts: 5, chatId: 19, chatName: 'Ержан Бекмуханов', text: 'Передача чата: Ержан Бекмуханов, попросил человека. Компания не определена.' },
    { id: 52, at: iso(now - 187 * MIN), updatedAt: iso(now - 187 * MIN), kind: 'handoff', kindLabel: 'передача чата', status: 'sent', statusLabel: 'отправлено', attempts: 1, chatId: 27, chatName: 'Асель Нурланова', text: 'Передача чата: Асель Нурланова, горячий клиент. Компания: ТОО «Казпромтара».' },
    { id: 40, at: iso(now - 2 * DAY), updatedAt: iso(now - 2 * DAY), kind: 'backlog', kindLabel: 'чаты за время простоя', status: 'sent', statusLabel: 'отправлено', attempts: 1, chatId: null, chatName: null, text: 'За время простоя написали 2 клиента.' },
  ].filter((n) => !q.get('status') || n.status === q.get('status'));
  return page(items, Number(q.get('page') ?? 1), 30);
}

const STATUS_LABELS: Record<string, string> = { new: 'Найдена', crawled: 'Сайт обойдён', qualified: 'Подходит', rejected: 'Не подходит', verified: 'Почта проверена', drafted: 'Письмо готово', approved: 'Одобрено', sent: 'Отправлено', replied: 'Ответили' };

const COMPANY_NAMES = ['ТОО «Алматы Логистик Хаб»', 'ТОО «Степь Склад»', 'ТОО «Казпромтара»', 'ТОО «Шымкент Агро Склад»', 'ТОО «Евразия Трейд Логистикс Восточный Терминал»', 'ИП «Жумабаев М.»', 'ТОО «Нур Пак»', 'ТОО «Мега Сервис Алматы»'];

export function companiesFixture(now: number, q: URLSearchParams) {
  const items = COMPANY_NAMES.map((name, i) => ({
    id: [345, 101, 118, 412, 87, 331, 77, 60][i] ?? i, name, rubric: ['Складские услуги', 'Складские услуги', 'Тара и упаковка', 'Склады', 'Грузоперевозки', 'Магазины одежды', 'Упаковочные материалы', 'Сервисные центры'][i] ?? null,
    city: 'almaty', cityName: i === 3 ? 'Шымкент' : 'Алматы', searchQuery: ['склад', 'склад', 'оборотная тара', null, 'логистика', 'магазин одежды', 'оборотная тара', 'склад'][i] ?? null,
    status: i === 0 ? 'approved' : i < 3 ? 'drafted' : i === 4 ? 'rejected' : 'qualified', statusLabel: i === 0 ? 'Одобрено' : i < 3 ? 'Письмо готово' : i === 4 ? 'Не подходит' : 'Подходит', statusTone: 'neutral', hadError: i === 6,
    fit: i === 4 ? 'no' : 'yes', fitLabel: i === 4 ? 'не подходит' : i === 5 ? 'возможно' : 'подходит', score: [86, 82, 78, 71, 34, 58, 66, 74][i] ?? null, segment: 'Склад, логистика, дистрибуция',
    contact: i === 3 ? null : { email: ['info@alhub.kz', 'info@step-sklad.kz', 'sales@kazpromtara.kz', '', 'office@eurasia-trade-logistics-terminal.kz', 'mzhumabaev@mail.ru', 'zakaz@nurpak.kz', 'info@megaservice.kz'][i], verifyResult: 'safe', verifyLabel: i === 4 ? 'Рискованная' : 'Существует', isCatchAll: i === 4, isRole: i !== 5 },
    draft: i < 3 ? { id: [41, 42, 43][i], subject: ['Инвентаризация 12 000 паллетомест за часы, а не за дни', 'Пересчёт склада без остановки отгрузок', 'Сколько ящиков возвращается от клиентов'][i], reviewStatus: i === 0 ? 'approved' : 'pending', reviewLabel: i === 0 ? 'Одобрено' : 'Ждёт проверки', checksTotal: 10, checksFailed: i === 1 ? 1 : 0 } : null,
    requestedVia: i === 3 ? 'whatsapp' : null, whatsappContactedAt: i === 0 || i === 2 ? iso(now - 3 * 60 * MIN) : null, blocked: i === 7, createdAt: iso(now - (9 - i) * DAY),
  }));
  // Фильтры как у почты: статус, отрасль, признаки, поиск по названию или рубрике; порядок.
  const text = (q.get('q') ?? '').toLowerCase();
  const filtered = items
    .filter((c) => !q.get('status') || c.status === q.get('status'))
    .filter((c) => !q.get('query') || c.searchQuery === q.get('query'))
    .filter((c) => q.get('via') !== 'whatsapp' || c.requestedVia === 'whatsapp')
    .filter((c) => q.get('via') !== 'regular' || c.requestedVia === null)
    .filter((c) => q.get('wa') !== '1' || c.whatsappContactedAt !== null)
    .filter((c) => q.get('blocked') !== '1' || c.blocked)
    .filter((c) => q.get('letter') !== '1' || c.draft !== null)
    .filter((c) => !text || c.name.toLowerCase().includes(text) || (c.rubric ?? '').toLowerCase().includes(text))
    .sort((a, b) => (q.get('sort') === 'score' ? (b.score ?? -1) - (a.score ?? -1) : q.get('sort') === 'letter' ? Number(b.draft !== null) - Number(a.draft !== null) : 0));
  return {
    ...page(filtered, Number(q.get('page') ?? 1), 50),
    facets: {
      // Числа считаются из тех же компаний, что в списке (как у почты: из базы), а не вписаны вручную.
      cards: [{ code: 'all', label: 'Все', count: items.length }, ...(['drafted', 'approved', 'rejected'] as const).map((code) => ({ code, label: STATUS_LABELS[code], count: items.filter((c) => c.status === code).length }))],
      statuses: Object.entries(STATUS_LABELS).map(([code, label]) => ({ code, label, count: items.filter((c) => c.status === code).length })),
      industries: [...new Set(items.map((c) => c.searchQuery).filter((x): x is string => x !== null))].map((query) => ({ query, count: items.filter((c) => c.searchQuery === query).length })),
      runs: [{ id: 4, city: 'almaty', cityName: 'Алматы', query: 'склад, логистика, оборотная тара', createdAt: iso(now - 11 * MIN) }, { id: 3, city: 'almaty', cityName: 'Алматы', query: 'магазин одежды', createdAt: iso(now - 3 * DAY) }],
      run: null,
    },
  };
}

export function companyFixture(now: number, id: number) {
  const list = companiesFixture(now, new URLSearchParams()).items;
  const row = list.find((c) => c.id === id);
  if (!row) return null;
  return {
    company: {
      company: { id: row.id, name: row.name, rubric: row.rubric, city: 'almaty', cityName: row.cityName, address: 'Алматы, ул. Бокейханова, 510', phones: ['+7 727 330 41 15', '+7 701 220 18 40'], website: 'https://alhub.kz', websiteDomain: 'alhub.kz', sourceUrl: 'https://2gis.kz/almaty/firm/70000001034512', branchesCount: 2, status: row.status, statusLabel: row.statusLabel, statusTone: 'neutral', lastError: row.hadError ? 'Почта не найдена ни в 2ГИС, ни на сайте' : null, requestedVia: row.requestedVia, whatsappContactedAt: row.whatsappContactedAt, runId: 4, searchQuery: row.searchQuery, createdAt: row.createdAt },
      qualification: { fit: row.fit, fitLabel: row.fitLabel, score: row.score, segment: row.segment, reason: 'Ответственное хранение на 12 000 паллетомест, инвентаризация раз в квартал силами персонала, приёмка до 40 машин в сутки.', model: 'claude-haiku-5-5', createdAt: row.createdAt },
      pains: [
        { pain: 'Инвентаризация занимает дни и отрывает людей', evidence: 'Плановая инвентаризация проводится ежеквартально силами персонала склада', source: 'site', sourceLabel: 'сайт', verified: true },
        { pain: 'Пересорт и потери при приёмке', evidence: 'Приёмка до 40 автомашин в сутки', source: '2gis', sourceLabel: '2ГИС', verified: true },
      ],
      contacts: row.contact ? [{ id: 1, email: row.contact.email, sourcePage: 'https://alhub.kz/kontakty', verifyResult: 'safe', verifyLabel: row.contact.verifyLabel, isCatchAll: row.contact.isCatchAll, isRole: row.contact.isRole, verifiedAt: null }] : [],
      draft: row.draft ? { id: row.draft.id, subject: row.draft.subject, reviewLabel: row.draft.reviewLabel, approvedBy: row.draft.reviewStatus === 'approved' ? 'owner' : null, approvedAt: row.draft.reviewStatus === 'approved' ? iso(now - 8 * DAY) : null } : null,
      history: id === 345 ? [{ id: 88, occurredAt: iso(now - 7 * DAY), email: 'info@alhub.kz', direction: 'out', whatLabel: 'отправлено, первое письмо', source: 'import', sourceLabel: 'импорт', subject: null, note: 'импорт прошлых писем', draftId: null }] : [],
      blocked: row.blocked,
      testSends: id === 345 ? [{ id: 3, sentTo: 'owner@example.kz', status: 'sent', statusLabel: 'отправлено', ok: true, error: null, createdAt: iso(now - 8 * DAY) }] : [],
      siteText: { text: 'ТОО «Алматы Логистик Хаб» — ответственное хранение, 12 000 паллетомест, склад класса А площадью 5 000 м². Плановая инвентаризация проводится ежеквартально силами персонала склада. Приёмка до 40 автомашин в сутки.', length: 212, truncated: false },
      cost: { usd: 0.0041, tokens: 41200, unpricedTokens: 0 },
    },
    chats: { items: id === 345 ? [{ chatId: 12, companyId: 345, name: 'Айгерим Сапарова', phone: '77015550112', status: 'manager', level: 'hot', confirmedAt: iso(now - 40 * MIN), firstClientMessageAt: iso(now - 58 * MIN), lastMessageAt: iso(now - 14 * MIN) }] : [], total: id === 345 ? 1 : 0, truncated: false },
  };
}

export function lettersFixture(now: number, q: URLSearchParams) {
  const status = q.get('status') ?? 'pending';
  const all = companiesFixture(now, new URLSearchParams()).items.filter((c) => c.draft).map((c) => ({
    id: c.draft?.id ?? 0, companyId: c.id, companyName: c.name, kind: 'first_email', subject: c.draft?.subject ?? '', reviewStatus: c.draft?.reviewStatus ?? 'pending', reviewLabel: c.draft?.reviewLabel ?? '', checksTotal: 10, checksFailed: c.draft?.checksFailed ?? 0, score: c.score, verifiedPains: 2, searchQuery: c.searchQuery, blocked: c.blocked, createdAt: c.createdAt, updatedAt: c.createdAt, sentAt: null,
  }));
  const items = all.filter((l) => status === 'all' || l.reviewStatus === status);
  return { ...page(items, Number(q.get('page') ?? 1), 100), status, filters: [{ code: 'pending', label: 'Ждут проверки', count: all.filter((l) => l.reviewStatus === 'pending').length }, { code: 'approved', label: 'Одобрены', count: all.filter((l) => l.reviewStatus === 'approved').length }, { code: 'rejected', label: 'Отклонены', count: 0 }, { code: 'all', label: 'Все', count: all.length }], run: null };
}

export function letterFixture(now: number, id: number) {
  const row = lettersFixture(now, new URLSearchParams('status=all')).items.find((l) => l.id === id);
  if (!row) return null;
  const company = companyFixture(now, row.companyId)?.company;
  if (!company) return null;
  return {
    id: row.id, companyId: row.companyId, kind: 'first_email', subject: row.subject,
    body: `[Проверить: число паллетомест с сайта]\nЗдравствуйте!\n\nУвидели, что у вас ответственное хранение на 12 000 паллетомест и инвентаризация силами персонала раз в квартал. Мы ставим RFID-метки на паллеты и ридеры на ворота: пересчёт идёт часами, а не днями, и склад не останавливается.\n\nЕсли интересно, напишите в WhatsApp, покажем расчёт для вашего склада.\n\nАрман, Tanbala`,
    notes: [{ kind: 'Проверить', text: 'число паллетомест с сайта' }],
    textLines: [{ text: 'Здравствуйте!', note: false }, { text: '', note: false }, { text: 'Увидели, что у вас ответственное хранение на 12 000 паллетомест и инвентаризация силами персонала раз в квартал. Мы ставим RFID-метки на паллеты и ридеры на ворота: пересчёт идёт часами, а не днями, и склад не останавливается.', note: false }, { text: '', note: false }, { text: 'Если интересно, напишите в WhatsApp, покажем расчёт для вашего склада.', note: false }, { text: '', note: false }, { text: 'Арман, Tanbala', note: false }],
    model: 'claude-haiku-5-5', createdAt: row.createdAt, updatedAt: row.createdAt, sentAt: null, reviewStatus: row.reviewStatus, reviewLabel: row.reviewLabel,
    approvedBy: row.reviewStatus === 'approved' ? 'owner' : null, approvedAt: row.reviewStatus === 'approved' ? iso(now - 8 * DAY) : null,
    checks: [{ code: 'dashes', label: 'Тире', passed: true, details: [] }, { code: 'prices', label: 'Цены', passed: true, details: [] }, { code: 'length', label: 'Длина', passed: row.checksFailed === 0, details: row.checksFailed ? ['длиннее 120 слов'] : [] }, { code: 'signature', label: 'Подпись', passed: true, details: [] }, { code: 'whatsapp', label: 'Только наш номер WhatsApp', passed: true, details: [] }],
    checksTotal: 5, checksFailed: row.checksFailed,
    contact: company.contacts[0] ?? null, testAddress: 'owner@example.kz',
    canApprove: row.reviewStatus === 'pending' && !row.blocked, approveBlocked: row.blocked, approveBlockedReason: row.blocked ? 'Компания в списке «не писать»: одобрить нельзя.' : null,
    canReject: row.reviewStatus !== 'rejected', canEdit: row.reviewStatus !== 'rejected', canSendTest: true, sendTestBlockedReason: null, blocked: row.blocked,
    testSends: company.testSends,
    company: { id: company.company.id, name: company.company.name, rubric: company.company.rubric, city: 'almaty', cityName: company.company.cityName, fit: 'yes', fitLabel: company.qualification.fitLabel, score: company.qualification.score, segment: company.qualification.segment, reason: company.qualification.reason, pains: company.pains, sourceUrl: company.company.sourceUrl, whatsappContactedAt: company.company.whatsappContactedAt, requestedVia: company.company.requestedVia, searchQuery: company.company.searchQuery },
  };
}

export function searchOptionsFixture() {
  return {
    cities: [['almaty', 'Алматы'], ['astana', 'Астана'], ['shymkent', 'Шымкент'], ['karaganda', 'Караганда'], ['aktobe', 'Актобе'], ['atyrau', 'Атырау'], ['pavlodar', 'Павлодар'], ['ust_kamenogorsk', 'Усть-Каменогорск']].map(([code, name]) => ({ code, name })),
    quickQueries: ['склад', 'логистика', 'производство', 'магазин одежды', 'оборотная тара', 'строительная компания'],
    limits: { maxQueries: 10, maxQueryLength: 60, maxQueryTextLength: 620, maxPerIndustry: 20, maxTotal: 60 },
    defaults: { city: 'almaty', count: 5 }, usdPerCompany: 0.003311, usdFirstRun: 0.00245,
  };
}

export function runsFixture(now: number) {
  const active = homeFixture(now).leadsSummary.activeRun;
  const runActive = { ...active, createdAt: active.startedAt, finished: false, lettersPending: 0, pendingTotal: 5, showReview: false, error: null, cost: { usd: 0.012, tokens: 9800, unpricedTokens: 0, priced: true, text: '≈ $0.01' }, finishedAt: null };
  const done = { ...runActive, id: 3, query: 'магазин одежды', industries: ['магазин одежды'], status: 'done', statusLabel: 'Готово', stage: 'Готово', stageLabel: 'Готово', stageDetail: null, found: 10, newCompanies: 8, crawled: 8, qualified: 3, drafted: 2, errors: 1, finished: true, lettersPending: 2, createdAt: iso(now - 3 * DAY), startedAt: iso(now - 3 * DAY), finishedAt: iso(now - 3 * DAY + 15 * MIN), cost: { usd: 0.031, tokens: 38300, unpricedTokens: 0, priced: true, text: '≈ $0.03' }, stages: active.stages.map((s) => ({ ...s, state: 'done', stateLabel: 'готово' })) };
  return { active: runActive, list: page([runActive, done], 1, 20) };
}

export function researchFixture(now: number) {
  return page([
    { id: '3f2c9e0a-8b1d-4c55-9a7e-2d1f00c4b812', name: 'Шымкент Агро Склад', city: 'shymkent', cityName: 'Шымкент', domain: null, status: 'running', statusLabel: 'Идёт', reason: null, reasonLabel: null, companyId: null, createdAt: iso(now - 37 * MIN), startedAt: iso(now - 36 * MIN), finishedAt: null },
    { id: '1a', name: 'Рахат', city: 'almaty', cityName: 'Алматы', domain: 'rahat.kz', status: 'done', statusLabel: 'Готово', reason: null, reasonLabel: null, companyId: 118, createdAt: iso(now - 2 * DAY), startedAt: iso(now - 2 * DAY), finishedAt: iso(now - 2 * DAY + MIN) },
    { id: '1b', name: 'Склад на Райымбека', city: 'almaty', cityName: 'Алматы', domain: null, status: 'failed', statusLabel: 'Не удалось', reason: 'not_in_2gis', reasonLabel: 'В 2ГИС не нашлась', companyId: null, createdAt: iso(now - 3 * DAY), startedAt: iso(now - 3 * DAY), finishedAt: iso(now - 3 * DAY + 2 * MIN) },
  ], 1, 50);
}

export function historyFixture(now: number) {
  return page([
    { id: 88, occurredAt: iso(now - 7 * DAY), email: 'info@alhub.kz', direction: 'out', directionLabel: 'отправлено', kind: 'first_email', kindLabel: 'первое письмо', whatLabel: 'отправлено, первое письмо', source: 'import', sourceLabel: 'импорт', subject: null, note: 'импорт прошлых писем', draftId: null, companyId: 345, companyName: 'ТОО «Алматы Логистик Хаб»' },
    { id: 87, occurredAt: iso(now - 12 * DAY), email: 'sales@kazpromtara.kz', direction: 'out', directionLabel: 'отправлено', kind: 'first_email', kindLabel: 'первое письмо', whatLabel: 'отправлено, первое письмо', source: 'import', sourceLabel: 'импорт', subject: null, note: 'импорт прошлых писем', draftId: null, companyId: 118, companyName: 'ТОО «Казпромтара»' },
  ], 1, 50);
}

export function blockedFixture(now: number) {
  return page([
    { id: 5, email: null, domain: 'megaservice.kz', companyId: 60, companyName: 'ТОО «Мега Сервис Алматы»', reason: 'manual', reasonLabel: 'вручную', note: null, createdAt: iso(now - 5 * DAY) },
    { id: 4, email: 'no-reply@example.kz', domain: null, companyId: null, companyName: null, reason: 'refused', reasonLabel: 'отказ', note: 'импорт', createdAt: iso(now - 9 * DAY) },
  ], 1, 50);
}

export function systemFixtures(now: number) {
  const home = homeFixture(now);
  const day = (offset: number): string => new Date(now - offset * DAY + 5 * 60 * MIN).toISOString().slice(0, 10);
  const days = (values: readonly number[]) => values.map((usd, i) => ({ day: day(i), usd, tokens: Math.round(usd * 700_000), unpricedTokens: 0, calls: Math.round(usd * 120), notCountedCalls: 0 }));
  const sumOf = (values: readonly number[]) => ({ usd: Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100, tokens: 0, unpricedTokens: 0, calls: 0, notCountedCalls: 0 });
  const bot = [0.31, 0.42, 0.18, 0.27, 0.05];
  const leads = [0.12, 0.0, 0.31, 0.04, 0.0];
  return {
    status: { botStatus: home.botStatus, leadsSummary: home.leadsSummary },
    spend: { from: day(4), to: day(0), pricesAsOf: '2026-10-06', bot: { days: days(bot), total: sumOf(bot) }, leads: { days: days(leads), total: sumOf(leads) } },
    audit: page([
      { id: 9, at: iso(now - 5 * MIN), actor: 'owner', action: 'chat_reply', target: 'chat:27', outcome: 'sent', ip: '95.56.12.4' },
      { id: 8, at: iso(now - 50 * MIN), actor: 'owner', action: 'letter_approve', target: 'draft:41', outcome: 'approved', ip: '95.56.12.4' },
      { id: 7, at: iso(now - 70 * MIN), actor: 'неизвестное имя', action: 'login_failed', target: null, outcome: 'invalid_credentials', ip: '185.12.4.77' },
      { id: 6, at: iso(now - 2 * 60 * MIN), actor: 'owner', action: 'login', target: null, outcome: 'ok', ip: '95.56.12.4' },
    ], 1, 50),
    users: { items: [{ name: 'owner', role: 'owner', active: true, createdAt: iso(now - 2 * DAY), updatedAt: iso(now - 2 * DAY), sessions: 2 }, { name: 'aliya', role: 'manager', active: true, createdAt: iso(now - DAY), updatedAt: iso(now - DAY), sessions: 1 }] },
    sessions: { items: [{ id: 3, user: 'owner', role: 'owner', device: 'Chrome, Windows', ip: '95.56.12.4', createdAt: iso(now - 2 * DAY), lastSeenAt: iso(now), current: true }, { id: 4, user: 'owner', role: 'owner', device: 'Safari, iPhone', ip: '37.99.40.11', createdAt: iso(now - DAY), lastSeenAt: iso(now - 3 * 60 * MIN), current: false }, { id: 5, user: 'aliya', role: 'manager', device: 'Chrome, Android', ip: '2.135.7.80', createdAt: iso(now - DAY), lastSeenAt: iso(now - 40 * MIN), current: false }] },
  };
}
