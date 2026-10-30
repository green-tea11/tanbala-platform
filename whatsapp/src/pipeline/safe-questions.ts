import { calcMissing, recommendStage, type CalcField } from '../agent/stage.js';
import type { CompanyQuestion } from '../domain/company.js';
import type { ClientProfile, ConversationStage, ReviewedText } from '../domain/types.js';
import { ESTIMATE_LATER, type HandoffMinimum } from '../handoff/minimum.js';

export { ESTIMATE_LATER } from '../handoff/minimum.js';

/**
 * Готовый открытый вопрос (решение владельца 30.10.2026): знакомство, крючок (знает ли клиент RFID) и по вопросу на
 * каждое поле для расчёта, кроме бизнеса (его спрашивает знакомство).
 */
export type QuestionKey = 'intro' | 'hook' | Exclude<CalcField, 'business'>;

/** Вопросы по порядку разговора. */
export const QUESTION_KEYS: readonly QuestionKey[] = [
  'intro',
  'hook',
  'items',
  'itemCount',
  'monthlyIntake',
  'passages',
  'has1C',
  'city',
];

/** Тексты владельца, без двоеточий и тире, без фактов о Tanbala, цен и обещаний. */
const QUESTIONS: Readonly<Record<QuestionKey, string>> = {
  intro: 'Расскажите, из какой вы компании и чем она занимается?',
  hook: 'Вы уже знаете, как работает RFID и что мы предлагаем?',
  items: 'Расскажите, что у вас лежит на хранении и в каком виде?',
  itemCount: 'Расскажите, сколько примерно позиций у вас на хранении?',
  monthlyIntake: 'Расскажите, сколько нового товара приходит к вам за месяц?',
  passages: 'Расскажите, сколько проходов нужно учитывать?',
  has1C: 'Расскажите, в какой 1С вы ведёте учёт или учёта в 1С пока нет?',
  city: 'Подскажите, в каком городе всё это находится?',
};

/**
 * Готовый вопрос; на ходу с вопросом цены перед ним фраза об ориентире. Проходит проверки кодом (это проверяют тесты),
 * поэтому к ReviewedText приводится здесь, как проверенный текст модели.
 */
export function questionText(key: QuestionKey, aboutPrice: boolean): ReviewedText {
  const question = QUESTIONS[key];
  return (aboutPrice ? `${ESTIMATE_LATER} ${question}` : question) as ReviewedText;
}

const ONE_C = String.raw`1\s?[сc](?!\p{L})`;

/**
 * Признаки вопроса в тексте бота: по ним не задаётся вопрос, который бот уже задавал. Готовые вопросы узнаются своими
 * словами (это проверяют тесты); вопрос модели узнаётся, если в нём те же слова. exclude: вопрос о другом поле с похожими
 * словами («сколько нового товара» не вопрос о числе позиций).
 */
const ASKED: Readonly<Record<QuestionKey, { readonly match: RegExp; readonly exclude?: RegExp }>> =
  {
    intro: {
      match:
        /из какой[^?]{0,20}компани|из компании|как называется ваша|чем[^?]{0,15}занимает|какой у вас бизнес/iu,
    },
    hook: { match: /знаете[^?]{0,30}(?:rfid|работает)|(?:знакомы|слышали)[^?]{0,20}rfid/iu },
    items: {
      match:
        /какие вещи|что[^?]{0,20}(?:лежит|храните|хранится)|что (?:именно )?(?:нужно |хотите |будете )?(?:учитывать|метить)|какой товар|какие товары/iu,
    },
    itemCount: {
      match:
        /сколько[^?]{0,40}(?:вещей|позиций|товар|единиц|штук|наименований|sku|меток|предметов|паллет|коробок)/iu,
      exclude: /нового|(?:в|за)\s{1,3}месяц/iu,
    },
    monthlyIntake: { match: /сколько нового|(?:в|за)\s{1,3}месяц|поступа/iu },
    passages: { match: /проход|сколько[^?]{0,20}(?:входов|выходов|ворот|дверей)/iu },
    has1C: {
      match: new RegExp(
        String.raw`(?:есть|используете|работаете|ведёте|ведете)[^?]{0,20}${ONE_C}|как(?:ая|ой|ую)[^?]{0,20}${ONE_C}|конфигурац`,
        'iu',
      ),
    },
    city: { match: /город/iu },
  };

/** Предложения-вопросы текста: только они спрашивают. */
function questionsOf(text: string): readonly string[] {
  return text.split(/(?<=[.!?])\s+/u).filter((sentence) => sentence.includes('?'));
}

function asks(key: QuestionKey, question: string): boolean {
  const { match, exclude } = ASKED[key];
  return match.test(question) && !(exclude?.test(question) ?? false);
}

/** О чём спрашивает текст бота (только его предложения с вопросом). */
export function askedKeys(text: string): ReadonlySet<QuestionKey> {
  const questions = questionsOf(text);
  return new Set(QUESTION_KEYS.filter((key) => questions.some((question) => asks(key, question))));
}

/** Что известно для выбора безопасного вопроса. */
export interface SafeQuestionInput {
  /** Выжимка после оценки этого хода (если она есть). */
  readonly profile: ClientProfile;
  /** Минимум по той же выжимке: компания в нём недостающая, только если о ней можно спросить. */
  readonly minimum: HandoffMinimum;
  /** Прошлое сообщение бота клиенту; null: бот ещё не писал. Учитывается, если нет botTexts. */
  readonly lastBotText: string | null;
  /** Все прошлые ответы бота в окне истории; нет поля => только lastBotText. */
  readonly botTexts?: readonly string[];
  /** Этап последнего отправленного ответа бота; нет поля => бот ещё не отвечал текстом модели. */
  readonly lastStage?: ConversationStage | null;
  /** Чат уже передавался коллеге; нет поля => нет. */
  readonly handedOff?: boolean;
}

/** Готовый вопрос: какой, текст и вопрос о названии компании, если он в тексте. */
export interface SafeQuestion {
  readonly key: QuestionKey;
  readonly text: ReviewedText;
  readonly companyQuestion?: CompanyQuestion;
}

/** Вопросы, которые бот уже задавал в чате: по всем прошлым ответам, без них по прошлому сообщению. */
function alreadyAsked(input: SafeQuestionInput): ReadonlySet<QuestionKey> {
  const texts = input.botTexts ?? (input.lastBotText === null ? [] : [input.lastBotText]);
  return new Set(texts.flatMap((text) => [...askedKeys(text)]));
}

/** Вопросы о недостающем для расчёта по порядку; бизнес спрашивает знакомство. */
function calcQuestions(profile: ClientProfile): readonly QuestionKey[] {
  return calcMissing(profile).map((field) => (field === 'business' ? 'intro' : field));
}

/** Вопрос знакомства спрашивает и название компании: отметка, если о компании сейчас можно спросить. */
function safeQuestionOf(
  key: QuestionKey,
  aboutPrice: boolean,
  input: SafeQuestionInput,
): SafeQuestion {
  const text = questionText(key, aboutPrice);
  return key === 'intro' && input.minimum.missing.includes('company')
    ? { key, text, companyQuestion: 'name' }
    : { key, text };
}

/** Этапы, на которых бот ещё не спросил, знает ли клиент RFID. */
const BEFORE_HOOK: readonly (ConversationStage | null)[] = [null, 'intro'];

/**
 * Вопросы по рекомендуемому этапу (agent/stage.ts): на знакомстве знакомство, на знакомстве и крючке вопрос о RFID,
 * если бот ещё не был на крючке, затем недостающее для расчёта по порядку. Финал: спрашивать нечего.
 */
function stageQuestions(input: SafeQuestionInput): readonly QuestionKey[] {
  const lastStage = input.lastStage ?? null;
  const { stage } = recommendStage({
    profile: input.profile,
    lastStage,
    handedOff: input.handedOff === true,
  });
  if (stage === 'final') return [];
  const calc = calcQuestions(input.profile);
  const hook = (stage === 'intro' || stage === 'hook') && BEFORE_HOOK.includes(lastStage);
  if (!hook) return calc;
  // Знакомство (если бизнес неизвестен) первым, крючок сразу после него.
  return calc[0] === 'intro' ? ['intro', 'hook', ...calc.slice(1)] : ['hook', ...calc];
}

/**
 * Безопасный вопрос вместо черновика, который дважды не прошёл проверки (решение владельца 30.10.2026): один открытый
 * вопрос по рекомендуемому этапу и первому недостающему для расчёта, который бот ещё не задавал в чате. Спросить нечего
 * => null (тогда передача check_failed). aboutPrice: перед вопросом фраза об ориентире.
 */
export function nextSafeQuestion(
  input: SafeQuestionInput,
  aboutPrice: boolean,
): SafeQuestion | null {
  const asked = alreadyAsked(input);
  const key = stageQuestions(input).find((candidate) => !asked.has(candidate));
  return key === undefined ? null : safeQuestionOf(key, aboutPrice, input);
}

/**
 * Вопрос вместо ранней передачи по цене (pipeline/price-gate.ts): первое недостающее для расчёта (бизнес спрашивает
 * знакомство), без вопроса о RFID, которого бот ещё не задавал; всё спрошено => первое недостающее; всё известно =>
 * вопрос о том, что лежит на хранении. С фразой об ориентире или без.
 */
export function minimumSafeQuestion(input: SafeQuestionInput, aboutPrice: boolean): SafeQuestion {
  const asked = alreadyAsked(input);
  const candidates = calcQuestions(input.profile);
  const key = candidates.find((candidate) => !asked.has(candidate)) ?? candidates[0] ?? 'items';
  return safeQuestionOf(key, aboutPrice, input);
}
