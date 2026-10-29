import type { CompanyPrompt } from '../domain/company.js';
import type { ChatProgress, ClientProfile } from '../domain/types.js';
import {
  companyAskable,
  handoffMinimum,
  MINIMUM_LABELS,
  minimumQuestion,
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
}

const COLLECTED_ALL =
  'Минимум для передачи по цене собран: если клиент спрашивает цену, сроки или договор, передай чат (hot).';
const ALWAYS_NOW =
  'Сразу, при любом минимуме, чат передаётся, если клиент прямо просит живого человека (asked_human) или жалуется (complaint).';
const NOTE_PRICE =
  'Если в указании коллеги есть ориентир цены, на вопрос цены отвечай им, ровно как в указании, и чат не передавай; если ориентира в указании нет, действуй по строкам выше.';
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

function priceAsksLine(priceAsks: number): string {
  if (priceAsks === 0) return 'До этого сообщения клиент цену ещё не спрашивал.';
  const asked = `До этого сообщения клиент спрашивал цену ${priceAsks} ${times(priceAsks)}.`;
  if (priceAsks < PRICE_ASKS_FOR_HANDOFF - 1) return asked;
  const third = priceAsks === PRICE_ASKS_FOR_HANDOFF - 1 ? 'это третий раз: передай' : 'передай';
  return `${asked} Если сейчас он спрашивает цену снова, ${third} чат сразу (hot).`;
}

/** Строки, пока минимума нет: что собрано, чего не хватает и какой один вопрос задать при вопросе цены. */
/**
 * Строки, пока минимума нет: что собрано, чего не хватает и как задать один вопрос при вопросе цены. Черновик пишется
 * параллельно с оценкой последнего сообщения, поэтому вопросы даны по порядку: модель берёт первый, о котором клиент
 * в последнем сообщении не сказал. Вопрос о компании ждёт своей очереди: иначе блок о компании добавил бы второй вопрос.
 */
function missingLines(
  input: PriceDataInput,
  collected: readonly MinimumField[],
  missing: readonly MinimumField[],
): string[] {
  const questions = missing.map((field) => minimumQuestion(field, input.company)).join('; ');
  const holdCompany = missing.includes('company')
    ? ' О компании спрашивай, только если до неё дошла очередь.'
    : '';
  return [
    `Для передачи по цене собрано: ${labels(collected)}; не хватает: ${labels(missing)}. Это выжимка до последнего сообщения клиента: что он сказал в последнем сообщении, считай выясненным.`,
    `Если клиент спрашивает цену, а минимума нет, не передавай чат (answer): ответь на то, что есть в документах (например, про интеграцию с 1С), напиши, что цена сильно зависит от объёма, и задай один вопрос о первом из недостающего, о чём клиент не сказал в последнем сообщении. Вопросы по порядку: ${questions}. Объясни зачем: чтобы коллега сразу назвал ориентир. Других вопросов в этом сообщении не задавай.${holdCompany}`,
  ];
}

/**
 * Строки о цене для блока данных вызова ответа (решение владельца 29.10.2026): что из минимума собрано и чего не
 * хватает (handoff/minimum.ts; компания, о которой спросить нельзя, не упоминается), какой один вопрос задать при
 * вопросе цены, сколько раз клиент уже спрашивал цену (третий раз даёт передачу), отказывался ли отвечать, и что
 * просьба о человеке и жалоба передаются сразу. Строки есть всегда: черновик пишется параллельно с оценкой интереса,
 * поэтому заранее неизвестно, спрашивает ли клиент цену.
 */
export function priceReplyData(input: PriceDataInput): string {
  const minimum = handoffMinimum({
    profile: input.profile,
    companyName: input.companyName,
    companyAskable: companyAskable(input.company),
  });
  const minimumLines =
    minimum.missing.length === 0
      ? [COLLECTED_ALL]
      : missingLines(input, minimum.collected, minimum.missing);
  return [
    ...minimumLines,
    priceAsksLine(input.progress.priceAsks),
    ...(input.progress.refused ? [REFUSED] : []),
    ...(input.hasNote === true ? [NOTE_PRICE] : []),
    ALWAYS_NOW,
  ].join('\n');
}
