// Файлы вывода: transcript.md (диалог, ход бота, состояние после хода), log.md (строки pino и запросы к почте по
// ходам), prompts.md (что получал агент в каждом вызове Claude), summary.json (числа для оценки расхода).
import { createHash } from 'node:crypto';

const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;
const LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const ORIGIN_TEXT = {
  bot_reply: 'ответ',
  handoff_notice: 'фраза передачи',
  voice_notice: 'фраза про голосовое',
  manager_notify: 'уведомление',
  panel: 'из панели',
};
/** Строки лога, которые идут в «Ход бота» транскрипта (остальные только в log.md). */
const KEY_LOG =
  /(проверк|Черновик|черновик|кандидат|компан|Передача|передаётся|передан|Оценка интереса|лимит|олосов|Клиент|безопасный|рано|Сбой|сбой|не удал|не получен|Бот промолчал|Ответ отправлен|Ответ не отправлен|Отправлена фраза|Чат передан|остался без ответа)/u;

export function almaty(ms) {
  return new Date(ms + ALMATY_OFFSET_MS).toISOString().slice(11, 23);
}

export function almatyDate(ms) {
  return `${new Date(ms + ALMATY_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ')} (Алматы)`;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} с`;
}

function fence(lang, text) {
  return `\`\`\`\`${lang}\n${text}\n\`\`\`\``;
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function quote(text) {
  return String(text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function short(value, max = 160) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Маскировка секретов во всём выводе: значения из окружения и похожее на ключи. */
export function createMask(secrets) {
  const values = [...new Set(secrets)].filter((value) => value.length >= 6).sort((a, b) => b.length - a.length);
  return (text) => {
    let masked = String(text);
    for (const value of values) masked = masked.split(value).join('***');
    return masked.replace(/sk-(ant|or)-[A-Za-z0-9_-]{8,}/gu, 'sk-$1-***');
  };
}

// Сводка одного вызова Claude для ленты хода.

function llmSummary(event) {
  const head = `Claude ${event.purpose} #${event.id} (${event.model}) ${seconds(event.ms ?? 0)}`;
  if (event.error !== undefined) return `${head} · исключение ${event.error}`;
  const result = event.result;
  if (result === undefined) return `${head} · не закончился`;
  if (!result.ok) return `${head} · сбой ${result.failure}${result.scope ? ` (${result.scope})` : ''}`;
  // Ответ модели как его разобрал адаптер (схема вызова), до нормализации агентом.
  const value = result.value;
  switch (event.purpose) {
    case 'reply': {
      const question = value.companyQuestion && value.companyQuestion !== 'none' ? ` · вопрос о компании ${value.companyQuestion}` : '';
      const facts = Array.isArray(value.usedFacts) && value.usedFacts.length > 0 ? ` · ${value.usedFacts.join(',')}` : '';
      return `${head} · ${value.outcome} · этап ${value.stage}${question}${value.aboutPrice ? ' · о цене' : ''}${facts}`;
    }
    case 'review':
      return `${head} · ${value.ok ? 'пропустила' : `не пропустила, замечаний ${value.problems.length}`}`;
    case 'interest': {
      const parts = [`уровень ${value.level}`];
      if (value.companyName) parts.push(`компания «${value.companyName}»${value.companyCity ? `, ${value.companyCity}` : ''}`);
      if (value.companyAnswer && value.companyAnswer !== 'none') parts.push(`ответ на «Вы из X?» ${value.companyAnswer}`);
      if (value.priceAsked) parts.push('спросил цену');
      if (value.refused) parts.push('уходит от вопросов');
      if (value.problemAgreed) parts.push('задача понятна');
      return `${head} · ${parts.join(' · ')}`;
    }
    default:
      return `${head} · ${short(value)}`;
  }
}

function leadsSummary(event) {
  const who = event.origin === 'sim' ? 'симулятор → почта' : 'почта';
  if (event.error !== undefined) return `${who} ${event.method} ${event.path} · ${event.error} · ${event.ms} мс`;
  const response = event.response;
  let detail = '';
  if (Array.isArray(response?.candidates)) {
    detail = response.candidates.length === 0
      ? 'кандидатов нет'
      : response.candidates.map((item) => `${item.name} (${item.match_by} ${item.match_score})`).join('; ');
  } else if (response?.status !== undefined) {
    detail = `status ${response.status}${response.reason ? ` ${response.reason}` : ''}${response.brief?.name ? ` · ${response.brief.name}` : ''}${response.company_id ? ` · company_id ${response.company_id}` : ''}`;
  } else if (response?.job_id !== undefined) {
    detail = 'задача в очереди';
  } else if (response?.name !== undefined) {
    detail = `справка: ${response.name}, болей ${response.pains?.length ?? 0}`;
  }
  const body = event.request === null || event.request === undefined ? '' : ` ${short(event.request, 200)}`;
  return `${who} ${event.method} ${event.path}${body} → ${event.status} · ${detail} · ${event.ms} мс`;
}

function logLine(event) {
  const ctx = Object.keys(event.ctx).length === 0 ? '' : ` ${JSON.stringify(event.ctx)}`;
  return `${LEVELS[event.level] ?? event.level} · ${event.msg ?? ''}${ctx}`;
}

/** Строка ленты «Ход бота» или null, если событие туда не идёт. */
function timelineLine(event) {
  switch (event.type) {
    case 'log':
      return event.level >= 40 || KEY_LOG.test(event.msg ?? '') ? logLine(event) : null;
    case 'llm':
      return llmSummary(event);
    case 'leads':
      return leadsSummary(event);
    case 'voice':
      return `расшифровка (подделка OpenRouter): ${event.transcript === null ? 'отказ 503' : `«${event.transcript}»`}`;
    case 'classified':
      return event.event === 'client' ? null : `приём WhatsApp: ${event.event}${event.reason ? ` (${event.reason})` : ''}`;
    case 'note':
      return event.text;
    case 'skippedTyping':
      return `пауза «печатает» ${seconds(event.ms)} пропущена (SIM_TYPING=skip)`;
    default:
      return null;
  }
}

function dialogLine(event, typingSince) {
  const at = `\`${almaty(event.at)}\``;
  switch (event.type) {
    case 'client': {
      if (event.kind === 'text') return `${at} **Клиент:** ${event.text}`;
      if (event.kind === 'voice') {
        const said = event.transcript === null ? 'расшифровки нет, OpenRouter ответит отказом' : `в расшифровке «${event.transcript}»`;
        return `${at} **Клиент:** 🎤 голосовое ${event.seconds ?? '?'} с (${said})`;
      }
      return `${at} **Клиент:** [${event.other}]`;
    }
    case 'out': {
      const who = event.to === 'client' ? 'Бот → клиенту' : event.to === 'manager' ? 'Бот → менеджеру' : 'Бот → ?';
      const origin = ORIGIN_TEXT[event.origin] ?? event.origin ?? '?';
      if (event.to === 'manager' || event.text.includes('\n')) return `${at} **${who}** (${origin}):\n\n${quote(event.text)}\n`;
      return `${at} **${who}** (${origin}): ${event.text}`;
    }
    case 'read':
      return `${at} _прочитано: ${event.count}_`;
    case 'typing':
      return event.on ? null : `${at} _печатал ${seconds(event.at - (typingSince ?? event.at))}_`;
    default:
      return null;
  }
}

function turnTitle(turn) {
  if (typeof turn.text === 'string') return 'клиент пишет';
  if (turn.voice === true) return 'клиент шлёт голосовое';
  if (turn.other !== undefined) return `клиент шлёт ${turn.other}`;
  if (turn.waitForResearchMs !== undefined) return `ждём проверку новой компании (до ${seconds(turn.waitForResearchMs)})`;
  if (turn.pauseMs !== undefined) return `пауза ${seconds(turn.pauseMs)}`;
  return 'комментарий';
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] ?? 0) + 1;
  return counts;
}

function countsText(counts) {
  const entries = Object.entries(counts);
  return entries.length === 0 ? '0' : entries.map(([name, n]) => `${name} ${n}`).join(', ');
}

function stateBlock(snapshot, seenNotificationIds) {
  if (snapshot.chat === null) return `Чата в базе нет.\n\napi_usage:\n${fence('json', json(snapshot.apiUsage))}`;
  const freshNotifications = snapshot.notifications.filter((item) => !seenNotificationIds.has(item.id));
  for (const item of snapshot.notifications) seenNotificationIds.add(item.id);
  const openHandoffs = snapshot.handoffs.filter((item) => item.open);
  const parts = [
    `**chats:**\n${fence('json', json(snapshot.chat))}`,
    `**chat_companies.state:**\n${fence('json', json(snapshot.company))}`,
    `**client_profiles:**\n${fence('json', json(snapshot.profile))}`,
    `**handoffs** (всего ${snapshot.handoffs.length}, открытых ${openHandoffs.length}):\n${fence('json', json(snapshot.handoffs))}`,
    `**manager_notifications** (всего ${snapshot.notifications.length}, новые за ход ${freshNotifications.length}):\n${fence('json', json(freshNotifications))}`,
    `**api_usage:**\n${fence('json', json(snapshot.apiUsage))}`,
    `**messages** (по автору, виду, отвечено):\n${fence('json', json(snapshot.messages))}`,
  ];
  if (snapshot.rejectedDrafts.length > 0) {
    parts.push(`**rejected_drafts за ход:**\n${fence('json', json(snapshot.rejectedDrafts))}`);
  }
  return parts.join('\n\n');
}

/** Ходы с событиями: события до первого хода (запуск) идут в ход 0. */
function groupByTurn(events) {
  const turns = new Map();
  for (const event of events) {
    if (!turns.has(event.turn)) turns.set(event.turn, []);
    turns.get(event.turn).push(event);
  }
  return turns;
}

export function renderTranscript({ meta, scenario, events, turnResults }) {
  const lines = [
    `# Симуляция: ${meta.scenarioName}`,
    '',
    `- Режим: ${meta.fake ? 'подделки (SIM_FAKE=1): поддельный Claude SDK, поддельная почта, сеть запрещена' : meta.blockNet ? 'настоящий, но сеть запрещена (SIM_BLOCK_NET=1): вызовы Claude и почты падают' : 'настоящий Claude и настоящая почта (EMAIL_API_URL)'}`,
    `- Бот: ${meta.botRoot} (dist), запуск ${almatyDate(meta.startedAt)}, длительность ${seconds(meta.durationMs)}`,
    `- Клиент: ${meta.phone}${scenario.pushName ? `, имя профиля «${scenario.pushName}»` : ''}, профиль ${scenario.profile?.kind ?? 'personal'}`,
    `- Настройки: модели ${JSON.stringify(meta.models)}, определение компании ${meta.companyApi ? 'включено' : 'выключено'}, расшифровка голосовых ${meta.voice ? 'включена (OpenRouter подделан)' : 'выключена'}, менеджер ${meta.manager}, паузы ×${meta.timeScale}, «печатает» ${meta.typingSkip ? 'пропускается' : 'настоящее'}`,
    `- Итог: вызовов Claude ${meta.totals.llmCalls} (${countsText(meta.totals.llmByPurpose)}), запросов к почте ${meta.totals.leadsCalls}, сообщений бота клиенту ${meta.totals.toClient}, менеджеру ${meta.totals.toManager}${meta.fake || meta.blockNet ? `, заблокировано запросов наружу ${meta.network.blockedFetch}, TCP ${meta.network.blockedSockets}` : ''}, попыток слушать порт ${meta.network.blockedListen}`,
    '- WhatsApp поддельный (Baileys не запускается, сессия не читается), база временная. Строка лога «Веб-панель запущена» печатается, но порт не открывается: швы startPanel и startConsoleApi пустые, listen запрещён.',
    ...(meta.failure ? [`- **Сбой симулятора:** ${meta.failure}`] : []),
    ...(meta.timedOutTurns > 0 ? [`- **Ходов без конца ожидания (таймаут):** ${meta.timedOutTurns}`] : []),
    '',
  ];
  if (scenario.description) lines.push(`> ${scenario.description}`, '');
  const turns = groupByTurn(events);
  const seenNotificationIds = new Set();
  for (const [index, list] of turns) {
    const result = turnResults.get(index);
    const turn = result?.turn ?? null;
    lines.push(index === 0 ? '## Запуск' : `## Ход ${index} · ${turnTitle(turn ?? {})}`, '');
    if (turn?.comment) lines.push(`_${turn.comment}_`, '');
    let typingSince = null;
    const dialog = [];
    for (const event of list) {
      if (event.type === 'typing' && event.on) typingSince = event.at;
      const line = dialogLine(event, typingSince);
      if (line !== null) dialog.push(line);
    }
    if (dialog.length > 0) lines.push(dialog.join('  \n'), '');
    const timeline = list
      .map((event) => ({ event, line: timelineLine(event) }))
      .filter((item) => item.line !== null)
      .map((item) => `- \`${almaty(item.event.at)}\` ${item.line}`);
    if (timeline.length > 0) lines.push('**Ход бота:**', '', ...timeline, '');
    if (result !== undefined && index > 0) {
      const llm = list.filter((event) => event.type === 'llm');
      const wait = result.wait;
      lines.push(
        `**Итог хода:** ${wait ? `${wait.ok ? 'ждали' : 'НЕ дождались, вышли по таймауту'} ${seconds(wait.waitedMs)}${wait.status ? ` · проверка: ${wait.status}` : ''}` : 'бота не ждали'}` +
          ` · вызовов Claude ${llm.length} (${countsText(countBy(llm, 'purpose'))})` +
          ` · запросов к почте ${list.filter((event) => event.type === 'leads').length}`,
        '',
      );
    }
    const state = list.find((event) => event.type === 'state');
    if (state !== undefined) {
      lines.push(index === 0 ? '### Состояние после запуска' : `### Состояние после хода ${index}`, '', stateBlock(state.snapshot, seenNotificationIds), '');
    }
  }
  return lines.join('\n');
}

export function renderLog({ meta, events, turnResults }) {
  const lines = [`# Лог бота: ${meta.scenarioName}`, '', 'Строки pino по ходам (без time, pid, hostname), запросы к почте с телами, расшифровки.', ''];
  for (const [index, list] of groupByTurn(events)) {
    const turn = turnResults.get(index)?.turn;
    lines.push(index === 0 ? '## Запуск' : `## Ход ${index} · ${turnTitle(turn ?? {})}`, '');
    for (const event of list) {
      const at = almaty(event.at);
      if (event.type === 'log') lines.push(`${at} ${logLine(event)}`);
      if (event.type === 'leads') {
        lines.push(`${at} ${leadsSummary(event)}`);
        if (event.response !== undefined) lines.push(fence('json', json(event.response)));
      }
      if (event.type === 'llm') lines.push(`${at} ${llmSummary(event)}`);
      if (event.type === 'voice') lines.push(`${at} ${timelineLine(event)}`);
      if (event.type === 'note') lines.push(`${at} [симулятор] ${event.text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function renderPrompts({ meta, events, schemas }) {
  const blocks = new Map();
  const lines = [
    `# Что получал агент: ${meta.scenarioName}`,
    '',
    'Каждый вызов Claude: блоки system (по ссылке, тексты целиком в конце файла), все реплики запроса целиком и ответ.',
    'В последней реплике user лежат данные вызова: строки об этапе, блок о компании, выжимка, замечания проверки.',
    '',
  ];
  for (const event of events.filter((item) => item.type === 'llm')) {
    const refs = event.system.map((block) => {
      const hash = createHash('sha256').update(block.text).digest('hex').slice(0, 10);
      if (!blocks.has(hash)) blocks.set(hash, { name: `S${blocks.size + 1}`, text: block.text, cache: block.cache, firstCall: event.id });
      const known = blocks.get(hash);
      return `${known.name}${block.cache ? ' (кэш)' : ''} ${block.text.length} зн.`;
    });
    const status = event.error ? `исключение ${event.error}` : event.result?.ok ? 'ok' : `сбой ${event.result?.failure}`;
    lines.push(
      `## Вызов ${event.id} · ход ${event.turn} · ${event.purpose} · ${event.model} · ${seconds(event.ms ?? 0)} · ${status}`,
      '',
      `\`${almaty(event.at)}\` system: ${refs.join(' + ')} · реплик ${event.turns.length} · max_tokens ${event.maxTokens}${event.imageBytes ? ` · картинка ${event.imageBytes} байт` : ''}`,
      '',
    );
    event.turns.forEach((turn, index) => {
      lines.push(`### ${index + 1}. ${turn.role}`, '', fence('text', turn.text), '');
    });
    lines.push('### Ответ (после разбора адаптером)', '', fence('json', json(event.result ?? event.error ?? null)), '', '---', '');
  }
  lines.push('# Блоки system', '');
  for (const block of blocks.values()) {
    lines.push(`## ${block.name} · ${block.cache ? 'с точкой кэша' : 'без кэша'} · ${block.text.length} знаков · впервые в вызове ${block.firstCall}`, '', fence('text', block.text), '');
  }
  if (schemas.size > 0) {
    lines.push('# Схемы ответа (описания полей тоже идут модели)', '');
    for (const [purpose, schema] of schemas) lines.push(`## ${purpose}`, '', fence('json', json(schema)), '');
  }
  return lines.join('\n');
}

export function totalsOf(events, tokenLines) {
  const llm = events.filter((event) => event.type === 'llm');
  const tokens = {};
  for (const line of tokenLines) {
    const key = `${line.provider}:${line.purpose}`;
    const sum = tokens[key] ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    tokens[key] = {
      calls: sum.calls + 1,
      input: sum.input + (line.input ?? 0),
      output: sum.output + (line.output ?? 0),
      cacheRead: sum.cacheRead + (line.cacheRead ?? 0),
      cacheWrite: sum.cacheWrite + (line.cacheWrite ?? 0),
    };
  }
  const out = events.filter((event) => event.type === 'out');
  return {
    llmCalls: llm.length,
    llmByPurpose: countBy(llm, 'purpose'),
    leadsCalls: events.filter((event) => event.type === 'leads' && event.origin !== 'sim').length,
    toClient: out.filter((event) => event.to === 'client').length,
    toManager: out.filter((event) => event.to === 'manager').length,
    tokens,
  };
}

export function summaryOf({ meta, events, turnResults }) {
  const turns = [];
  for (const [index, result] of turnResults) {
    if (index === 0) continue;
    const list = events.filter((event) => event.turn === index);
    const llm = list.filter((event) => event.type === 'llm');
    turns.push({
      index,
      kind: turnTitle(result.turn),
      wait: result.wait ?? null,
      llmCalls: llm.length,
      llmByPurpose: countBy(llm, 'purpose'),
      leadsCalls: list.filter((event) => event.type === 'leads' && event.origin !== 'sim').length,
      botToClient: list.filter((event) => event.type === 'out' && event.to === 'client').map((event) => event.text),
      botToManager: list.filter((event) => event.type === 'out' && event.to === 'manager').length,
      outcomes: list
        .filter((event) => event.type === 'log' && typeof event.ctx.outcome === 'string')
        .map((event) => `${event.ctx.outcome}${event.ctx.reason ? ` (${event.ctx.reason})` : ''}`),
    });
  }
  return { ...meta, turns };
}
