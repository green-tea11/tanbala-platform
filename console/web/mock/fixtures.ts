// Данные-заглушки для разработки интерфейса (только `npm run dev` без CONSOLE_PROXY, в сборку не попадают).
// Форма — как у /api консоли (console/docs/API.md) и приложений (contract/CONSOLE_API.md). Люди и компании выдуманы,
// время отсчитывается от момента запроса, суммы складываются из частей.

const MIN = 60_000;
const HOUR = 60 * MIN;
const ALMATY_OFFSET = 5 * HOUR;

const iso = (ms: number): string => new Date(ms).toISOString();
const ago = (now: number, minutes: number): string => iso(now - minutes * MIN);

/** Начало суток по Алматы (UTC+5), в мс UTC. */
function almatyDayStart(now: number): number {
  const local = now + ALMATY_OFFSET;
  return local - (local % (24 * HOUR)) - ALMATY_OFFSET;
}

function almatyDay(now: number): string {
  return new Date(now + ALMATY_OFFSET).toISOString().slice(0, 10);
}

// ---- люди и чаты ----

interface MockChat {
  readonly id: number;
  readonly name: string | null;
  readonly phone: string | null;
  readonly status: 'bot' | 'manager';
  readonly statusBy: string;
  readonly statusLabel: string;
  readonly level: 'cold' | 'warm' | 'hot';
  readonly companyName: string | null;
}

const LEVEL_LABELS = { cold: 'холодный', warm: 'тёплый', hot: 'горячий' } as const;

export const CHATS: readonly MockChat[] = [
  { id: 12, name: 'Айгерим Сапарова', phone: '77015550112', status: 'manager', statusBy: 'bot', statusLabel: 'Ведёт менеджер (передал бот)', level: 'hot', companyName: 'ТОО «Алматы Логистик Хаб»' },
  { id: 19, name: 'Ержан Бекмуханов', phone: '77027770419', status: 'manager', statusBy: 'bot', statusLabel: 'Ведёт менеджер (передал бот)', level: 'warm', companyName: 'ТОО «Шымкент Агро Склад»' },
  { id: 23, name: 'Дмитрий Ким', phone: null, status: 'bot', statusBy: 'bot', statusLabel: 'Ведёт бот', level: 'warm', companyName: null },
  { id: 27, name: 'Асель Нурланова', phone: '77073330527', status: 'manager', statusBy: 'panel', statusLabel: 'Ведёт менеджер (ответил из панели)', level: 'hot', companyName: 'ТОО «Казпромтара»' },
  { id: 31, name: 'Марат Жумабаев', phone: '77011230931', status: 'bot', statusBy: 'bot', statusLabel: 'Ведёт бот', level: 'hot', companyName: 'ИП «Жумабаев М.»' },
];

// ---- главная ----

export function homeFixture(now: number) {
  const dayStart = almatyDayStart(now);
  const waitingAiger = 14;
  const waitingErzhan = 38;
  const waitingDmitry = 9;

  const waiting = [
    { chatId: 19, name: 'Ержан Бекмуханов', phone: '77027770419', status: 'manager', group: 'manager', waitingSince: ago(now, waitingErzhan), lastClientAt: ago(now, waitingErzhan), complaint: false, companyName: 'ТОО «Шымкент Агро Склад»', lastText: 'Можно поговорить с живым человеком? Хочу обсудить склад в Шымкенте' },
    { chatId: 12, name: 'Айгерим Сапарова', phone: '77015550112', status: 'manager', group: 'manager', waitingSince: ago(now, waitingAiger), lastClientAt: ago(now, waitingAiger), complaint: false, companyName: 'ТОО «Алматы Логистик Хаб»', lastText: 'Хорошо, жду. Удобно созвониться после 15:00' },
    { chatId: 23, name: 'Дмитрий Ким', phone: null, status: 'bot', group: 'bot', waitingSince: ago(now, waitingDmitry), lastClientAt: ago(now, waitingDmitry), complaint: false, companyName: null, lastText: 'А метки выдержат мороз? У нас холодильный склад, −25' },
  ];

  const handoffs = [
    { id: 7, chatId: 12, name: 'Айгерим Сапарова', phone: '77015550112', reason: 'hot', reasonLabel: 'горячий клиент', level: 'hot', levelLabel: 'горячий', openedAt: ago(now, 16), notification: { status: 'sent', statusLabel: 'отправлено', attempts: 1 }, seen: false },
    { id: 9, chatId: 19, name: 'Ержан Бекмуханов', phone: '77027770419', reason: 'asked_human', reasonLabel: 'попросил человека', level: 'warm', levelLabel: 'тёплый', openedAt: ago(now, 41), notification: { status: 'failed', statusLabel: 'сбой отправки', attempts: 5 }, seen: true },
    { id: 11, chatId: 27, name: 'Асель Нурланова', phone: '77073330527', reason: 'hot', reasonLabel: 'горячий клиент', level: 'hot', levelLabel: 'горячий', openedAt: ago(now, 187), notification: { status: 'sent', statusLabel: 'отправлено', attempts: 1 }, seen: true },
  ];

  const hot = [
    { chatId: 12, name: 'Айгерим Сапарова', phone: '77015550112', status: 'manager', levelReason: 'Согласилась, что инвентаризация — проблема, второй раз спросила цену', levelUpdatedAt: ago(now, 17), lastMessageAt: ago(now, waitingAiger) },
    { chatId: 31, name: 'Марат Жумабаев', phone: '77011230931', status: 'bot', levelReason: 'Спросил сроки внедрения на два магазина', levelUpdatedAt: ago(now, 52), lastMessageAt: ago(now, 50) },
    { chatId: 27, name: 'Асель Нурланова', phone: '77073330527', status: 'manager', levelReason: 'Готова к встрече, нужен расчёт на 3 000 ящиков', levelUpdatedAt: ago(now, 190), lastMessageAt: ago(now, 95) },
  ];

  // Расход: деньги складываются из частей, бюджет почты — её же расчёт.
  const leadsToday = 0.12;
  const botToday = 0.31;
  const leadsMonth = 1.04;
  const botMonth = 4.86;
  const budget = 1.0;
  const activeRunStart = now - 11 * MIN;

  return {
    generatedAt: iso(now),
    mode: {
      bot: { code: 'test', text: 'Закрытый режим: бот отвечает только номерам из списка (8)' },
      leads: { code: 'test_address', text: 'Тестовые письма только на owner@example.kz', testAddress: 'owner@example.kz' },
      lettersNote: 'Компаниям письма не отправляются.',
    },
    botStatus: {
      whatsapp: { enabled: true, state: 'open', since: iso(dayStart - 2 * HOUR) },
      testMode: true, allowlistSize: 8, managerConfigured: true, companyFeature: true, llmConfigured: true,
      apiCalls: { today: 37, dailyLimit: 500, perChatLimit: 100 },
      research24h: { count: 1, limit: 10 }, pairingAttempts24h: 0, linkedAt: iso(now - 30 * HOUR), workingSince: null, historyIncomplete: false,
    },
    attention: {
      handoffs,
      hot,
      waiting,
      backlog: { pending: 0 },
      newHandoffs: handoffs.filter((h) => !h.seen).length,
      counts: {
        handoffs: { total: handoffs.length, truncated: false },
        hot: { total: hot.length, truncated: false },
        waiting: { total: waiting.length, truncated: false, staleExcluded: 0 },
      },
    },
    leadsSummary: {
      testMode: { testAddress: 'owner@example.kz' },
      budget: { dailyUsd: budget, spentTodayUsd: leadsToday, over: false },
      spend: { totalUsd: 2.41, totalTokens: 1_284_000, unpricedTokens: 0 },
      overview: { companiesFound: 7, companiesFit: 6, avgScoreFit: 75, lettersPending: 2, lettersApproved: 1, whatsappCompanies: 1 },
      activeRun: {
        id: 4, city: 'almaty', cityName: 'Алматы', query: 'склад, логистика, оборотная тара',
        industries: ['склад', 'логистика', 'оборотная тара'], maxCompanies: 5, status: 'running', statusLabel: 'Идёт',
        stage: 'crawl', stageLabel: 'Сайты', stageDetail: 'сайт 6 из 11', found: 15, newCompanies: 11, crawled: 6,
        qualified: 0, rejected: 0, verified: 0, drafted: 0, errors: 0, startedAt: iso(activeRunStart),
        stages: [
          { code: 'collect', label: 'Поиск в 2ГИС', state: 'done', stateLabel: 'готово', counters: [{ field: 'found', label: 'найдено', value: 15 }, { field: 'new_companies', label: 'новых', value: 11 }] },
          { code: 'crawl', label: 'Сайты', state: 'running', stateLabel: 'идёт', counters: [{ field: 'crawled', label: 'обойдено', value: 6 }] },
          { code: 'qualify', label: 'Квалификация', state: 'waiting', stateLabel: 'ждёт', counters: [] },
          { code: 'verify', label: 'Проверка почт', state: 'waiting', stateLabel: 'ждёт', counters: [] },
          { code: 'draft', label: 'Письма', state: 'waiting', stateLabel: 'ждёт', counters: [] },
        ],
      },
      research: {
        today: 1, perDay: 20,
        active: [{ id: '3f2c9e0a-8b1d-4c55-9a7e-2d1f00c4b812', name: 'Шымкент Агро Склад', city: 'shymkent', cityName: 'Шымкент', status: 'running', createdAt: ago(now, 37), startedAt: ago(now, 36) }],
      },
      testSends: { today: 1, perDay: 30 },
    },
    spend: {
      day: almatyDay(now),
      monthFrom: `${almatyDay(now).slice(0, 8)}01`,
      pricesAsOf: '2026-10-06',
      bot: {
        today: { usd: botToday, tokens: 214_300, unpricedTokens: 0, calls: 37, notCountedCalls: 2 },
        month: { usd: botMonth, tokens: 3_410_900, unpricedTokens: 0, calls: 604, notCountedCalls: 31 },
      },
      leads: {
        today: { usd: leadsToday, tokens: 168_400, unpricedTokens: 0, calls: 11, notCountedCalls: 0 },
        month: { usd: leadsMonth, tokens: 1_115_600, unpricedTokens: 0, calls: 96, notCountedCalls: 0 },
      },
      leadsBudget: { dailyUsd: budget, spentTodayUsd: leadsToday, leftUsd: Math.round((budget - leadsToday) * 100) / 100, over: false },
      botCalls: { today: 37, dailyLimit: 500, left: 463 },
    },
    afterLetter: {
      items: [
        { chatId: 12, companyId: 345, chatName: 'Айгерим Сапарова', companyName: 'ТОО «Алматы Логистик Хаб»', firstLetterAt: iso(now - 7 * 24 * HOUR), firstClientMessageAt: ago(now, 58), daysAfter: 7, seen: false },
        { chatId: 27, companyId: 118, chatName: 'Асель Нурланова', companyName: 'ТОО «Казпромтара»', firstLetterAt: iso(now - 12 * 24 * HOUR), firstClientMessageAt: iso(now - 4 * HOUR), daysAfter: 12, seen: true },
      ],
      total: 2, newCount: 1, linksTruncated: false,
      note: 'Настоящих отправок писем пока нет: здесь только импортированные письма, их дата — день импорта.',
    },
  };
}

// ---- карточка клиента ----

const PROFILE_12 = [
  ['business', 'Бизнес', 'Склад ответственного хранения', false],
  ['items', 'Вещи', 'паллеты с товаром клиентов', false],
  ['packaging', 'В чём лежат', 'паллеты, часть в коробах', false],
  ['material', 'Материал', null, false],
  ['city', 'Город', 'Алматы', false],
  ['premises', 'Помещение', 'склад класса А', false],
  ['area', 'Площадь', '5 000 м²', false],
  ['itemCount', 'Число вещей', 'около 12 000 паллетомест', false],
  ['turnover', 'Как часто движутся', 'до 40 машин в день', false],
  ['scope', 'Что отмечать', null, false],
  ['currentTracking', 'Учёт сейчас', '1С и пересчёт вручную', false],
  ['problem', 'Что мешает', 'инвентаризация 3 дня, пересорт при приёмке', false],
  ['oneC', '1С', '1С:Управление торговлей', true],
  ['specifics', 'Особенности', null, false],
] as const;

export function clientFixture(now: number, chatId: number) {
  const chat = CHATS.find((c) => c.id === chatId);
  if (chat === undefined) return null;
  const t = (minutesAgo: number): string => ago(now, minutesAgo);
  const messages =
    chatId === 12
      ? [
          { id: 201, author: 'client', authorLabel: 'Клиент', kind: 'text', text: 'Здравствуйте! У нас склад ответственного хранения, хотим понять, подойдёт ли RFID', at: t(58) },
          { id: 202, author: 'bot', authorLabel: 'Бот', kind: 'text', text: 'Здравствуйте! Подскажите, что хранится на складе и сколько примерно мест?', at: t(57) },
          { id: 203, author: 'client', authorLabel: 'Клиент', kind: 'text', text: 'Паллеты, около 12 тысяч мест, 5 000 м². Инвентаризация занимает три дня, весь склад стоит', at: t(51) },
          { id: 204, author: 'bot', authorLabel: 'Бот', kind: 'text', text: 'Понимаю. На похожих складах метки на паллетах и ридеры на воротах сокращают пересчёт до нескольких часов: вход и выход отмечаются сами. Учёт у вас в 1С?', at: t(50) },
          { id: 205, author: 'client', authorLabel: 'Клиент', kind: 'voice', text: 'Да, 1С Управление торговлей. Ещё бывает пересорт при приёмке, машины разгружаем быстро и путаем позиции', at: t(44) },
          { id: 206, author: 'bot', authorLabel: 'Бот', kind: 'text', text: 'С 1С мы связываем учёт напрямую. А сколько машин в день вы принимаете?', at: t(43) },
          { id: 207, author: 'client', authorLabel: 'Клиент', kind: 'text', text: 'До 40. Сколько это будет стоить?', at: t(31) },
          { id: 208, author: 'bot', authorLabel: 'Бот', kind: 'text', text: 'Цена зависит от объёма и задачи. Что для вас важнее сначала: инвентаризация или приёмка?', at: t(30) },
          { id: 209, author: 'client', authorLabel: 'Клиент', kind: 'text', text: 'Обе. Но хотя бы порядок цен? На 12 тысяч мест', at: t(17) },
          { id: 210, author: 'bot', authorLabel: 'Бот', kind: 'text', text: 'Цена сильно зависит от объёма. Уточню у коллеги и вернусь к вам.', at: t(16) },
          { id: 211, author: 'client', authorLabel: 'Клиент', kind: 'text', text: 'Хорошо, жду. Удобно созвониться после 15:00', at: t(14) },
        ]
      : [
          { id: 301, author: 'client', authorLabel: 'Клиент', kind: 'text', text: 'Добрый день', at: t(60) },
          { id: 302, author: 'bot', authorLabel: 'Бот', kind: 'text', text: 'Здравствуйте! Расскажите, что хотите учитывать?', at: t(59) },
          { id: 303, author: 'client', authorLabel: 'Клиент', kind: 'other', text: null, at: t(40) },
        ];

  const fields = (chatId === 12 ? PROFILE_12 : PROFILE_12.map(([k, l]) => [k, l, null, false] as const)).map(
    ([key, label, value, inferred]) => ({ key, label, value, inferred }),
  );

  const confirmed12 = {
    id: 345,
    name: 'ТОО «Алматы Логистик Хаб»',
    city: 'Алматы',
    rubric: 'Складские услуги',
    emailed: true,
    pains: [
      { pain: 'Инвентаризация занимает дни и отрывает людей', evidence: 'Плановая инвентаризация проводится ежеквартально силами персонала склада', source: 'site', sourceLabel: 'сайт' },
      { pain: 'Пересорт и потери при приёмке', evidence: 'Приёмка до 40 автомашин в сутки', source: '2gis', sourceLabel: '2ГИС' },
    ],
  };

  const card = {
    chat: {
      id: chat.id, name: chat.name, phone: chat.phone, phoneHidden: chat.phone === null, status: chat.status,
      statusBy: chat.statusBy, statusLabel: chat.statusLabel, statusChangedAt: t(16), level: chat.level,
      levelLabel: LEVEL_LABELS[chat.level], createdAt: t(58), priceAsks: chatId === 12 ? 2 : 0, refusedAnswers: false, handedOff: chat.status === 'manager',
    },
    profile: {
      fields,
      problemAgreed: chatId === 12,
      levelReason: chatId === 12 ? 'Согласилась, что инвентаризация — проблема, второй раз спросила цену' : null,
      updatedAt: t(17),
    },
    note: null,
    openHandoff: chatId === 12 ? { reason: 'hot', reasonLabel: 'горячий клиент', level: 'hot', levelLabel: 'горячий', openedAt: t(16) } : null,
    handoffs: chatId === 12 ? [{ id: 7, reason: 'hot', reasonLabel: 'горячий клиент', level: 'hot', levelLabel: 'горячий', openedAt: t(16), resolvedAt: null }] : [],
    lastNotification:
      chatId === 12
        ? { id: 55, at: t(16), updatedAt: t(16), kind: 'handoff', kindLabel: 'передача чата', status: 'sent', statusLabel: 'отправлено', attempts: 1, chatId: 12, text: 'Передача чата: Айгерим Сапарова, горячий клиент. Компания: ТОО «Алматы Логистик Хаб».' }
        : null,
    company:
      chatId === 12
        ? { state: 'confirmed', stateLabel: 'подтверждена клиентом', candidate: null, confirmed: confirmed12, research: null, confirmedPains: ['инвентаризация занимает три дня', 'пересорт при приёмке'], statedName: 'Алматы Логистик Хаб' }
        : { state: 'unknown', stateLabel: 'не определена', candidate: null, confirmed: null, research: null, confirmedPains: [], statedName: null },
    rejected: {
      items:
        chatId === 12
          ? [{ at: t(30), attempt: 1, source: 'review', sourceLabel: 'проверка вторым вызовом', draft: 'Ориентир — от 3 млн тенге за склад такого размера, точнее посчитает специалист.', remarks: ['называет цену, которой нет в заметке', 'обещание без подтверждения'] }]
          : [],
      total: chatId === 12 ? 1 : 0,
    },
    messages: { items: messages, earlierBefore: null },
  };

  const company =
    chatId === 12
      ? {
          id: 345,
          confirmed: true,
          label: 'подтверждена клиентом',
          leads: {
            company: {
              id: 345, name: 'ТОО «Алматы Логистик Хаб»', rubric: 'Складские услуги', city: 'almaty', cityName: 'Алматы',
              address: 'Алматы, ул. Бокейханова, 510', phones: ['+7 727 330 41 15'], website: 'https://alhub.kz', websiteDomain: 'alhub.kz',
              sourceUrl: 'https://2gis.kz/almaty/firm/70000001034512', branchesCount: 2, status: 'approved', statusLabel: 'Одобрено',
              statusTone: 'pos', lastError: null, requestedVia: null, whatsappContactedAt: t(40), runId: 2, searchQuery: 'склад', createdAt: iso(now - 9 * 24 * HOUR),
            },
            qualification: { fit: 'yes', fitLabel: 'подходит', score: 86, segment: 'Склад, логистика, дистрибуция', reason: 'Ответственное хранение на 12 000 паллетомест, инвентаризация раз в квартал силами персонала, приёмка до 40 машин в сутки.', model: 'claude-haiku-5-5', createdAt: iso(now - 9 * 24 * HOUR) },
            pains: [
              { pain: 'Инвентаризация занимает дни и отрывает людей', evidence: 'Плановая инвентаризация проводится ежеквартально силами персонала склада', source: 'site', sourceLabel: 'сайт', verified: true },
              { pain: 'Пересорт и потери при приёмке', evidence: 'Приёмка до 40 автомашин в сутки', source: '2gis', sourceLabel: '2ГИС', verified: true },
            ],
            draft: { id: 41, subject: 'Инвентаризация 12 000 паллетомест за часы, а не за дни', reviewLabel: 'Одобрено', approvedBy: 'owner', approvedAt: iso(now - 8 * 24 * HOUR) },
            history: [
              { id: 88, occurredAt: iso(now - 7 * 24 * HOUR), email: 'info@alhub.kz', direction: 'out', whatLabel: 'отправлено, первое письмо', source: 'import', sourceLabel: 'импорт', subject: null, note: 'импорт прошлых писем', draftId: null },
            ],
            blocked: false,
          },
        }
      : null;

  return { chat: card, company };
}
