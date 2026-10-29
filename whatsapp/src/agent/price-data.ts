import type { CompanyPrompt } from '../domain/company.js';
import type { ChatProgress, ClientProfile } from '../domain/types.js';
import {
  CAP_HANDOFF_TEXT,
  CLIENT_MESSAGES_FOR_HANDOFF,
  companyAskable,
  ESTIMATE_LATER,
  handoffMinimum,
  MINIMUM_HANDOFF_TEXT,
  MINIMUM_LABELS,
  minimumGroupQuestions,
  PRICE_ASKS_FOR_HANDOFF,
  type MinimumField,
} from '../handoff/minimum.js';

/** Что нужно строкам о цене в блоке данных вызова ответа. */
export interface PriceDataInput {
  /** Выжимка, которую система хранит сейчас (до оценки последнего сообщения клиента). */
  readonly profile: ClientProfile;
  readonly company: CompanyPrompt | undefined;
  /** Название компании для минимума: подтверждённое или со слов клиента; null: неизвестно. */
  readonly companyName: string | null;
  readonly progress: ChatProgress;
  /** Есть заметка для бота (указание коллеги): ориентир цены из неё и есть ответ на вопрос цены. */
  readonly hasNote?: boolean;
  /**
   * В заметке есть сумма-цена (checks/amounts.priceAmountsOf): на вопрос цены бот отвечает ею, и строки не велят
   * передавать чат ни при собранном минимуме, ни при отказе отвечать, ни при четвёртом вопросе (код тоже не передаёт).
   */
  readonly notePrice?: boolean;
  /** Сколько сообщений клиента в переписке (вместе с последним); нет поля => не считается. */
  readonly clientMessages?: number;
}

const COLLECTED_ALL =
  'Минимум для передачи по цене собран: если клиент спрашивает цену, сроки или договор, передай чат (hot).';
/** Чат ещё не передавался (решение владельца 29.10.2026 вечером): собранный минимум передаёт чат сразу. */
const COLLECTED_ALL_FIRST = `Минимум для передачи собран, и чат ещё не передавался коллеге: передай чат сейчас (hot), даже если клиент не спрашивает цену. Ответь на вопрос клиента, если он есть и ответ есть в документах, затем напиши «${MINIMUM_HANDOFF_TEXT}»; если клиент спрашивает цену, вместо этого «Цена сильно зависит от объёма. Уточню у коллеги и вернусь к вам.». Вопросов не задавай.`;
const CAP_NOW = `Клиент написал уже пять сообщений или больше, а минимума нет, и чат ещё не передавался коллеге: передай чат сейчас (hot), даже если клиент не спрашивает цену. Ответь на вопрос клиента, если он есть и ответ есть в документах, затем напиши «${CAP_HANDOFF_TEXT}»; если клиент спрашивает цену, вместо этого «Цена сильно зависит от объёма. Уточню у коллеги и вернусь к вам.». Вопросов не задавай.`;
const COMPLETES_NOW = `Если в последнем сообщении клиент назвал всё, чего не хватает, минимум собран: передай чат сейчас (hot) с фразой «${MINIMUM_HANDOFF_TEXT}», вопросов не задавай.`;
const ALWAYS_NOW =
  'Сразу, при любом минимуме, чат передаётся, если клиент прямо просит живого человека (asked_human) или жалуется (complaint).';
const NOTE_PRICE =
  'Если в указании коллеги есть ориентир цены, на вопрос цены отвечай им, ровно как в указании, и чат не передавай; если ориентира в указании нет, действуй по строкам выше.';
const COLLECTED_ALL_NOTE = 'Минимум для передачи по цене собран.';
const NOTE_HAS_PRICE =
  'В указании коллеги есть ориентир цены: на вопрос цены отвечай им, ровно как в указании, и чат не передавай, даже если минимум собран, клиент спрашивает цену четвёртый раз или отказывается отвечать.';
const REFUSED =
  'Клиент уже отказывался отвечать на вопросы: если он спрашивает цену, передай чат сразу (hot).';

function labels(fields: readonly MinimumField[]): string {
  return fields.length === 0 ? 'ничего' : fields.map((field) => MINIMUM_LABELS[field]).join(', ');
}

/** «раз», «раза» или «раз» по числу. */
function times(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'раза' : 'раз';
}

/** Сколько раз клиент спрашивал цену; без указания на передачу, если ответ коллеги уже в заметке (notePrice). */
function priceAsksLine(priceAsks: number, notePrice: boolean): string {
  if (priceAsks === 0) return 'До этого сообщения клиент цену ещё не спрашивал.';
  const asked = `До этого сообщения клиент спрашивал цену ${priceAsks} ${times(priceAsks)}.`;
  if (notePrice || priceAsks < PRICE_ASKS_FOR_HANDOFF - 1) return asked;
  const last = priceAsks === PRICE_ASKS_FOR_HANDOFF - 1 ? 'это четвёртый раз: передай' : 'передай';
  return `${asked} Если сейчас он спрашивает цену снова, ${last} чат сразу (hot).`;
}

/**
 * Строки, пока минимума нет: что собрано, чего не хватает и какие вопросы задать при вопросе цены. Черновик пишется
 * параллельно с оценкой последнего сообщения, поэтому недостающее дано группами по порядку (handoff/minimum.ts,
 * MINIMUM_GROUPS): модель берёт первую группу, где есть то, о чём клиент в последнем сообщении не сказал, и задаёт её
 * вопросы одним блоком.
 */
function missingLines(
  input: PriceDataInput,
  collected: readonly MinimumField[],
  missing: readonly MinimumField[],
): string[] {
  const groups = minimumGroupQuestions(missing, input.company);
  return [
    `Для передачи по цене собрано: ${labels(collected)}; не хватает: ${labels(missing)}. Это выжимка до последнего сообщения клиента: что он сказал в последнем сообщении, считай выясненным.`,
    `Если клиент спрашивает цену, а минимума нет, не передавай чат (answer): ответь на то, что есть в документах (например, про интеграцию с 1С), напиши «${ESTIMATE_LATER}» и задай одним блоком вопросы первой группы, где есть недостающее, о котором клиент не сказал в последнем сообщении и которого нельзя понять из его слов. Недостающее по группам: ${groups}. Вопросов других групп в этом сообщении не задавай.`,
  ];
}

/**
 * Минимума нет, а чат ещё не передавался: что делать, если клиент назвал недостающее сейчас, и передача по пределу
 * сообщений клиента (CLIENT_MESSAGES_FOR_HANDOFF).
 */
function firstLines(input: PriceDataInput, first: boolean): string[] {
  if (!first) return [];
  const capped = (input.clientMessages ?? 0) >= CLIENT_MESSAGES_FOR_HANDOFF;
  return capped ? [CAP_NOW] : [COMPLETES_NOW];
}

/**
 * Пока чат ни разу не передавался (progress.handedOff), собранный минимум велит передать чат сейчас, даже без вопроса
 * цены, а при недостающем строка говорит, что делать, если клиент назвал его в последнем сообщении (решение владельца
 * 29.10.2026 вечером; держит код: pipeline/auto-handoff.ts).
 * Строки о цене для блока данных вызова ответа (решение владельца 29.10.2026): что из минимума собрано и чего не
 * хватает (handoff/minimum.ts; компания, о которой спросить нельзя, не упоминается), какой один вопрос задать при
 * вопросе цены, сколько раз клиент уже спрашивал цену (четвёртый раз даёт передачу), отказывался ли отвечать, и что
 * просьба о человеке и жалоба передаются сразу. Строки есть всегда: черновик пишется параллельно с оценкой интереса,
 * поэтому заранее неизвестно, спрашивает ли клиент цену.
 */
export function priceReplyData(input: PriceDataInput): string {
  const minimum = handoffMinimum({
    profile: input.profile,
    companyName: input.companyName,
    companyAskable: companyAskable(input.company),
  });
  const notePrice = input.notePrice === true;
  const first = input.progress.handedOff !== true;
  const minimumLines =
    minimum.missing.length === 0
      ? [notePrice ? COLLECTED_ALL_NOTE : first ? COLLECTED_ALL_FIRST : COLLECTED_ALL]
      : [...missingLines(input, minimum.collected, minimum.missing), ...firstLines(input, first)];
  const noteLines = notePrice ? [NOTE_HAS_PRICE] : input.hasNote === true ? [NOTE_PRICE] : [];
  return [
    ...minimumLines,
    priceAsksLine(input.progress.priceAsks, notePrice),
    ...(input.progress.refused && !notePrice ? [REFUSED] : []),
    ...noteLines,
    ALWAYS_NOW,
  ].join('\n');
}
