import { profileEntries } from '../agent/profile.js';
import {
  CALC_LABELS,
  calcKnown,
  calcMissing,
  STRENGTH_LABELS,
  type CalcField,
} from '../agent/stage.js';
import type { CompanySummary } from '../domain/company.js';
import type {
  BacklogChat,
  BudgetScope,
  ChatId,
  ClientProfile,
  HandoffReason,
  InterestLevel,
  PhoneDigits,
  StrengthId,
} from '../domain/types.js';
import { companyCardHref } from './card-link.js';

/** Причина в уведомлении: для лимита обязательно указать, какой лимит исчерпан. */
export type NotificationReason =
  | { readonly reason: Exclude<HandoffReason, 'limit'> }
  | { readonly reason: 'limit'; readonly scope: BudgetScope };

/** Данные для уведомления менеджеру. */
export type ManagerNotificationInput = NotificationReason & {
  /**
   * Причина передачи своими словами с цитатой клиента (pipeline/handoff-reason.ts): недоверенный текст (в цитате слова
   * клиента). Нет поля или null: строки нет (технические причины, лимит).
   */
  readonly detail?: string | null;
  /** Имя из профиля WhatsApp: недоверенный текст. */
  readonly name: string | null;
  /** Номер клиента; null, если чат пришёл только с адресом @lid. */
  readonly phone: PhoneDigits | null;
  readonly level: InterestLevel;
  readonly profile: ClientProfile;
  /** Сильные стороны, уже рассказанные клиенту (ChatProgress.toldFacts); нет поля => ни одной. */
  readonly toldFacts?: readonly StrengthId[];
  /** ID чата в панели. */
  readonly chatId: ChatId;
  /**
   * Что известно о компании клиента: строки после выжимки, только при передаче. Нет поля или null: строк о компании
   * нет. Уведомление о лимите их не получает никогда.
   */
  readonly company?: CompanySummary | null;
};

/** Длина причины передачи в уведомлении, в символах Unicode: текст причины и цитата до 150 знаков. */
export const DETAIL_MAX_LENGTH = 300;

/** Длина имени из профиля в уведомлении, в символах Unicode. */
export const NAME_MAX_LENGTH = 50;

/** Длина каждого поля выжимки в уведомлении: столько же оставляет оценка интереса. */
export const PROFILE_FIELD_MAX_LENGTH = 200;

/** Длина названия и города компании в уведомлении, в символах Unicode. */
export const COMPANY_FIELD_MAX_LENGTH = 100;

/** Длина одной подтверждённой боли в уведомлении, в символах Unicode. */
export const PAIN_MAX_LENGTH = 150;

/** Сколько подтверждённых болей идёт в уведомление: столько хранит состояние чата. */
export const PAINS_MAX_COUNT = 5;

/** Общий предел текста со списком простоя: лишние чаты сворачиваются в одну строку. */
export const BACKLOG_TEXT_MAX_LENGTH = 3_000;

/** Сколько символов недоверенного поля читается вообще: остальное отбрасывается до любой обработки. */
const RAW_INPUT_LIMIT = 2_000;

/** Запас в тексте списка под строку «и ещё N чатов, список в панели». */
const BACKLOG_TAIL_RESERVE = 60;

const ELLIPSIS = '…';
const LINK_PLACEHOLDER = '[ссылка скрыта]';
const NOT_KNOWN = 'не выяснено';
const NO_NAME = 'не указано';
const NO_NAME_IN_LIST = 'без имени';
const HIDDEN_PHONE = 'номер скрыт';
const UNKNOWN_TIME = 'время неизвестно';
const ALMATY_ZONE = 'Asia/Almaty';
const PAIN_SEPARATOR = '; ';

/** Пробелы всех видов и переводы строк (в том числе NEL, U+2028 и U+2029), кроме которых ничего не склеивается. */
const SPACES_AND_BREAKS = /[\s\u0085]+/gu;

/** Управляющие, невидимые (Cf: нулевая ширина, смена направления текста), одиночные суррогаты и неназначенные. */
const INVISIBLE = /\p{C}/gu;

/**
 * Ссылка, которую WhatsApp сделает нажимаемой: с протоколом, с www или голый домен с коротким доменом верхнего
 * уровня (ASCII или несколько кириллических) и необязательным путём. После NFKC ссылка из полноширинных букв
 * тоже узнаётся. Метки домена не содержат точки, поэтому разбор линейный.
 */
const LINK =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+|(?:[\p{L}\p{N}-]+\.)+(?:[a-z]{2,}|рф|қаз|рус|онлайн|сайт)(?![\p{L}\p{N}-])(?:[/?#]\S*)?/giu;

const LEVEL_WORDS: Readonly<Record<InterestLevel, string>> = {
  cold: 'холодный',
  warm: 'тёплый',
  hot: 'горячий',
};

const REASON_PHRASES: Readonly<Record<Exclude<HandoffReason, 'limit'>, string>> = {
  hot: 'горячий клиент',
  no_answer: 'в знаниях нет ответа на вопрос клиента',
  check_failed: 'ответ бота не прошёл проверку',
  asked_human: 'клиент просит живого человека',
  complaint: 'клиент жалуется или раздражён',
  human_took_over: 'в чат написал человек, бот выключен',
  llm_error: 'сбой модели, бот не смог ответить',
};

const LIMIT_PHRASES: Readonly<Record<BudgetScope, string>> = {
  chat: 'исчерпан лимит чата (API_DAILY_LIMIT_PER_CHAT)',
  global: 'исчерпан общий лимит бота на сутки (API_DAILY_LIMIT)',
};

/**
 * Текст уведомления на номер менеджера: имя и номер клиента, уровень интереса, выжимка и причина передачи.
 * Чистая функция, без LLM. Фиксированный шаблон: первая строка с причиной, затем строка «Причина: ...» своими словами с
 * цитатой клиента (detail, если есть; у лимита никогда), имя, номер, ID чата в панели,
 * уровень и все поля выжимки (agent/profile.profileEntries: компания, вещи, материал, город, помещение, число вещей,
 * 1С и остальное) с пометкой «всё со слов клиента». Нет номера: «номер скрыт» и ID чата, по которому
 * чат ищут в панели. Лимит (reason 'limit'): «бот замолчал в этом чате» с названием настройки, ID чата и номер те же.
 * При передаче (не лимит) после выжимки и пустой строки идут три строки (решение владельца 30.10.2026): что для расчёта
 * известно и чего не хватает (agent/stage.ts) и что из сильных сторон уже рассказано клиенту (calcLines), затем с
 * данными о компании блок о компании (companyLines: подтверждённые боли там).
 * Имя, каждое поле выжимки и тексты о компании недоверенные (клиент, модель, сайты и 2ГИС): одной строкой (переводы
 * строк, управляющие и невидимые символы убираются), без ссылок, с лимитом длины, поэтому подделать строки шаблона
 * или доставить менеджеру чужую ссылку нельзя.
 */
export function formatManagerNotification(input: ManagerNotificationInput): string {
  const company = input.reason === 'limit' ? null : (input.company ?? null);
  return [
    headline(input),
    ...detailLines(input),
    `Имя в WhatsApp: ${knownOr(input.name, NAME_MAX_LENGTH, NO_NAME)}`,
    phoneLine(input.phone, input.chatId),
    `Чат в панели: ID ${input.chatId}`,
    `Уровень интереса: ${LEVEL_WORDS[input.level]}`,
    '',
    'Выжимка (со слов клиента, не проверено; «вероятно»: вывод из его слов):',
    ...profileEntries(input.profile).map(
      ({ label, value }) => `${label}: ${knownOr(value, PROFILE_FIELD_MAX_LENGTH, NOT_KNOWN)}`,
    ),
    ...(input.reason === 'limit' ? [] : ['', ...calcLines(input.profile, input.toldFacts ?? [])]),
    ...(company === null ? [] : ['', ...companyLines(company)]),
  ].join('\n');
}

/** Причина своими словами одной строкой (недоверенный текст: чистится как поля выжимки); у лимита строки нет. */
function detailLines(input: ManagerNotificationInput): readonly string[] {
  if (input.reason === 'limit') return [];
  const detail = knownOr(input.detail ?? null, DETAIL_MAX_LENGTH, '');
  return detail === '' ? [] : [`Причина: ${detail}`];
}

const NOTHING = 'ничего';
const ALL_KNOWN = 'всё известно';

/**
 * Что для расчёта известно и чего не хватает (agent/stage.ts) подписями, без значений (значения выше, в выжимке); известное
 * по выводу из слов клиента помечено «(вероятно)». Затем рассказанные сильные стороны короткими названиями. Подписи свои,
 * недоверенного текста в этих строках нет.
 */
function calcLines(profile: ClientProfile, toldFacts: readonly StrengthId[]): readonly string[] {
  const inferred = new Set<string>(profile.inferred);
  const known = (field: CalcField): string =>
    inferred.has(field) ? `${CALC_LABELS[field]} (вероятно)` : CALC_LABELS[field];
  const words = (labels: readonly string[], empty: string): string =>
    labels.length === 0 ? empty : labels.join(', ');
  return [
    `Для расчёта известно: ${words(calcKnown(profile).map(known), NOTHING)}`,
    `Для расчёта не хватает: ${words(
      calcMissing(profile).map((field) => CALC_LABELS[field]),
      ALL_KNOWN,
    )}`,
    `Рассказано клиенту: ${words(
      toldFacts.map((id) => STRENGTH_LABELS[id]),
      NOTHING,
    )}`,
  ];
}

/**
 * Одно уведомление менеджеру со списком чатов, на которые бот не ответил после простоя (решение владельца).
 * Чистая функция, без LLM. Фиксированный шаблон: заголовок с порогом в часах и числом чатов, затем по строке на чат:
 * имя, номер или «номер скрыт», ID чата, время последнего сообщения по Алматы. Имена недоверенные: одной строкой,
 * без ссылок, с лимитом длины. Текст не длиннее BACKLOG_TEXT_MAX_LENGTH: чаты, что не поместились, сворачиваются
 * в «и ещё N чатов, список в панели». Порядок чатов сохраняется. Справка: в закрытом режиме сюда попадают только
 * чаты из TEST_ALLOWLIST, остальные отсекает whatsapp/inbound.ts.
 */
export function formatBacklogNotification(
  chats: readonly BacklogChat[],
  thresholdHours: number,
): string {
  const head = [
    `Простой бота: сообщения старше ${thresholdHours} ${plural(thresholdHours, 'час', 'часа', 'часов')} остались без ответа.`,
    'Бот на них не отвечал и не отмечал их прочитанными.',
    `Чатов: ${chats.length}. Время по Алматы.`,
  ];
  if (chats.length === 0) return head.join('\n');
  const formatTime = createAlmatyTimeFormat();
  const entries = chats.map((chat, index) => backlogLine(chat, index + 1, formatTime));
  const budget = BACKLOG_TEXT_MAX_LENGTH - head.join('\n').length - BACKLOG_TAIL_RESERVE;
  const shown = countFitting(entries, budget);
  const hidden = entries.length - shown;
  const tail = hidden === 0 ? [] : [hiddenChatsLine(hidden)];
  return [...head, '', ...entries.slice(0, shown), ...tail].join('\n');
}

/**
 * Блок о компании клиента: подтверждена, кандидат или не определена (с названием со слов клиента, если оно есть),
 * затем ссылка на карточку в почтовом проекте и боли, которые клиент подтвердил. Город пропускается, если его нет.
 * Ссылка своя (адрес EMAIL_UI_URL и числовой ID) и идёт без замены, но только с протоколом http или https.
 */
function companyLines(summary: CompanySummary): readonly string[] {
  const card = companyCardHref(summary.cardUrl);
  const pains = summary.confirmedPains
    .slice(0, PAINS_MAX_COUNT)
    .map((pain) => oneLine(pain, PAIN_MAX_LENGTH))
    .filter((pain) => pain !== '');
  return [
    `Компания: ${companyWords(summary)}`,
    ...(card === null ? [] : [`Карточка: ${card}`]),
    ...(pains.length === 0 ? [] : [`Подтверждённые боли: ${pains.join(PAIN_SEPARATOR)}`]),
  ];
}

/** Кто компания клиента. Кандидат или подтверждённая без названия после очистки считаются неопределёнными. */
function companyWords(summary: CompanySummary): string {
  const name = companyField(summary.name);
  const place = `«${name}»${cityPart(summary.city)}`;
  if (name !== '' && summary.status === 'confirmed') return `${place} (клиент подтвердил)`;
  if (name !== '' && summary.status === 'candidate') {
    return `возможно ${place} (клиент не подтвердил)`;
  }
  const stated = companyField(summary.statedName);
  return stated === '' ? 'не определена' : `не определена, клиент назвал «${stated}»`;
}

function cityPart(city: string | null): string {
  const line = companyField(city);
  return line === '' ? '' : `, ${line}`;
}

function companyField(value: string | null): string {
  return value === null ? '' : oneLine(value, COMPANY_FIELD_MAX_LENGTH);
}

function headline(input: NotificationReason): string {
  if (input.reason === 'limit') return `Бот замолчал в этом чате: ${LIMIT_PHRASES[input.scope]}.`;
  return `Передача чата менеджеру: ${REASON_PHRASES[input.reason]}.`;
}

function phoneLine(phone: PhoneDigits | null, chatId: ChatId): string {
  const digits = phoneDigits(phone);
  return digits === ''
    ? `Номер: ${HIDDEN_PHONE}, чат ищите в панели по ID ${chatId}`
    : `Номер: +${digits}`;
}

function phoneDigits(phone: PhoneDigits | null): string {
  return phone === null ? '' : phone.replace(/\D/g, '');
}

function backlogLine(
  chat: BacklogChat,
  position: number,
  formatTime: (ms: number) => string,
): string {
  const digits = phoneDigits(chat.phone);
  const phone = digits === '' ? HIDDEN_PHONE : `+${digits}`;
  const name = knownOr(chat.name, NAME_MAX_LENGTH, NO_NAME_IN_LIST);
  const time = formatTime(chat.lastMessageAtMs);
  return `${position}. ${name}, ${phone}, чат ID ${chat.chatId}, последнее сообщение ${time}`;
}

/** Сколько первых строк помещается в budget символов вместе с переводами строк между ними. */
function countFitting(entries: readonly string[], budget: number): number {
  let used = 0;
  let count = 0;
  for (const entry of entries) {
    used += entry.length + 1;
    if (used > budget) break;
    count += 1;
  }
  return count;
}

function hiddenChatsLine(hidden: number): string {
  return `и ещё ${hidden} ${plural(hidden, 'чат', 'чата', 'чатов')}, список в панели`;
}

/** Склонение по числу: 1 час, 2 часа, 5 часов, 11 часов, 21 час. */
function plural(count: number, one: string, few: string, many: string): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  return last >= 2 && last <= 4 ? few : many;
}

/** Время «26.10.2026 17:00» по Алматы; не время: «время неизвестно». */
function createAlmatyTimeFormat(): (ms: number) => string {
  const format = new Intl.DateTimeFormat('ru-RU', {
    timeZone: ALMATY_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return (ms) => {
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return UNKNOWN_TIME;
    const fields = new Map(format.formatToParts(date).map((part) => [part.type, part.value]));
    const day = `${fields.get('day')}.${fields.get('month')}.${fields.get('year')}`;
    return `${day} ${fields.get('hour')}:${fields.get('minute')}`;
  };
}

/** Недоверенное поле одной строкой; нет значения или после очистки пусто: fallback. */
function knownOr(value: string | null, limit: number, fallback: string): string {
  if (value === null) return fallback;
  const line = oneLine(value, limit);
  return line === '' ? fallback : line;
}

/**
 * Очистка недоверенного текста для уведомления: NFKC (полноширинные буквы ссылки становятся обычными), переводы
 * строк и пробелы всех видов в один пробел, управляющие и невидимые символы долой, ссылки заменены меткой, длина
 * не больше limit символов Unicode (в конце многоточие).
 */
function oneLine(value: string, limit: number): string {
  const flat = value
    .slice(0, RAW_INPUT_LIMIT)
    .normalize('NFKC')
    .replace(SPACES_AND_BREAKS, ' ')
    .replace(INVISIBLE, '')
    .replace(/ {2,}/g, ' ')
    .replace(LINK, LINK_PLACEHOLDER)
    .trim();
  return truncate(flat, limit);
}

/** Обрезка по символам Unicode, а не по кодовым единицам: суррогатная пара не рвётся. */
function truncate(text: string, limit: number): string {
  const symbols = Array.from(text);
  if (symbols.length <= limit) return text;
  return `${symbols
    .slice(0, limit - 1)
    .join('')
    .trimEnd()}${ELLIPSIS}`;
}
