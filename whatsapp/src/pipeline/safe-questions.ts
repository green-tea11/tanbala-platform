import {
  calcKnown,
  calcMissing,
  ESTIMATE_LATER,
  recommendStage,
  type CalcField,
} from '../agent/stage.js';
import type { CompanyQuestion } from '../domain/company.js';
import type { ClientProfile, ConversationStage, ReviewedText } from '../domain/types.js';

export { ESTIMATE_LATER } from '../agent/stage.js';

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
 * Знакомство, когда о компании спрашивать не нужно (ревью этапа 2): название уже известно (клиент назвал или подтвердил)
 * или блок о компании спрашивать о ней не разрешает. Тогда только чем она занимается.
 */
export const INTRO_BUSINESS_QUESTION = 'Расскажите, чем занимается ваша компания?';

/** На ходу с вопросом цены перед вопросом фраза об ориентире. */
function withEstimate(question: string, aboutPrice: boolean): ReviewedText {
  return (aboutPrice ? `${ESTIMATE_LATER} ${question}` : question) as ReviewedText;
}

/**
 * Готовый вопрос; на ходу с вопросом цены перед ним фраза об ориентире. Проходит проверки кодом (это проверяют тесты),
 * поэтому к ReviewedText приводится здесь, как проверенный текст модели.
 */
export function questionText(key: QuestionKey, aboutPrice: boolean): ReviewedText {
  return withEstimate(QUESTIONS[key], aboutPrice);
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
      exclude: /нового|(?:в|за)\s{1,3}месяц|двер|вход|выход|ворот|проход/iu,
    },
    monthlyIntake: { match: /сколько нового|(?:в|за)\s{1,3}месяц|поступа/iu },
    // «Проход» отдельным словом: «проходит за месяц» не вопрос о проходах (ревью этапа 2).
    passages: {
      match:
        /(?<!\p{L})проход(?:а|ы|ов|ам|ами|ах)?(?!\p{L})|сколько[^?]{0,20}(?:входов|выходов|ворот|дверей)/iu,
    },
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
  /** О названии компании можно спросить: оно неизвестно, и блок о компании это разрешает. */
  readonly companyAskable: boolean;
  /** Прошлое сообщение бота клиенту; null: бот ещё не писал. Учитывается, если нет botTexts. */
  readonly lastBotText: string | null;
  /** Все прошлые ответы бота в окне истории; нет поля => только lastBotText. */
  readonly botTexts?: readonly string[];
  /** Самый дальний этап отправленных ответов бота; нет поля => бот ещё не отвечал текстом модели. */
  readonly lastStage?: ConversationStage | null;
  /** Чат уже передавался коллеге; нет поля => нет. */
  readonly handedOff?: boolean;
  /**
   * Выжимка собрана до последнего сообщения клиента (оценка этого хода не получилась): повтор вопроса (secondAsk)
   * не задаётся, клиент мог ответить на него как раз сейчас (ревью 01.11.2026). Нет поля => выжимка свежая.
   */
  readonly profileStale?: boolean;
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

/**
 * Вопрос знакомства спрашивает и название компании, только если о ней сейчас можно спросить (название неизвестно, блок о
 * компании разрешает), с отметкой; иначе только чем она занимается (ревью этапа 2: не переспрашивать названную компанию).
 */
function safeQuestionOf(
  key: QuestionKey,
  aboutPrice: boolean,
  input: SafeQuestionInput,
): SafeQuestion {
  if (key !== 'intro') return { key, text: questionText(key, aboutPrice) };
  return input.companyAskable
    ? { key, text: questionText(key, aboutPrice), companyQuestion: 'name' }
    : { key, text: withEstimate(INTRO_BUSINESS_QUESTION, aboutPrice) };
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
 * вопрос по рекомендуемому этапу и первому недостающему для расчёта, который бот ещё не задавал в чате. Все такие
 * уже заданы => недостающее для расчёта, о котором бот спрашивал ровно один раз и не этими словами (secondAsk). Спросить
 * нечего => null (тогда передача check_failed). aboutPrice: перед вопросом фраза об ориентире.
 */
export function nextSafeQuestion(
  input: SafeQuestionInput,
  aboutPrice: boolean,
): SafeQuestion | null {
  const asked = alreadyAsked(input);
  const keys = stageQuestions(input);
  const fresh = keys.find((candidate) => !asked.has(candidate));
  const key = fresh ?? (input.profileStale === true ? undefined : secondAsk(keys, input));
  return key === undefined ? null : safeQuestionOf(key, aboutPrice, input);
}

/**
 * Повтор вопроса о недостающем для расчёта (пункт 3 задания 01.11.2026: если клиент не ответил
 * на часть вопроса, спроси недостающее другими словами, один раз): бот спрашивал об этом ровно в одном сообщении, и
 * готовый текст не совпадает с тем, что уже было. Знакомство и крючок не повторяются.
 */
function secondAsk(
  keys: readonly QuestionKey[],
  input: SafeQuestionInput,
): QuestionKey | undefined {
  const texts = input.botTexts ?? (input.lastBotText === null ? [] : [input.lastBotText]);
  return keys.find(
    (key) =>
      key !== 'intro' &&
      key !== 'hook' &&
      texts.filter((text) => askedKeys(text).has(key)).length === 1 &&
      !texts.some((text) => text.includes(QUESTIONS[key])),
  );
}

/**
 * Короткие нейтральные реакции перед готовым вопросом (пункт 3 задания 01.11.2026): без пересказа слов клиента и без
 * фактов о нас, только из того, что известно системе.
 */
export const REACTIONS = {
  /** Бот в этом чате ещё не писал: первое сообщение. */
  greeting: 'Здравствуйте!',
  /** Клиент в этом ходе назвал новое для расчёта (по выжимке). */
  newData: 'Спасибо, это важно для расчёта.',
  /** Иначе. */
  thanks: 'Спасибо!',
} as const;

/** Что известно для выбора реакции. */
export interface ReactionInput {
  /** Выжимка до этого хода. */
  readonly before: ClientProfile;
  /** Выжимка после оценки этого хода (без оценки та же). */
  readonly after: ClientProfile;
  /** Бот уже писал клиенту в окне истории. */
  readonly botWrote: boolean;
}

/**
 * Реакция по данным: первое сообщение бота => приветствие; по выжимке этого хода для расчёта стало известно новое =>
 * «Спасибо, это важно для расчёта.»; иначе «Спасибо!».
 */
export function reactionOf(input: ReactionInput): string {
  if (!input.botWrote) return REACTIONS.greeting;
  const known = new Set(calcKnown(input.before));
  const learned = calcKnown(input.after).some((field) => !known.has(field));
  return learned ? REACTIONS.newData : REACTIONS.thanks;
}

/**
 * Готовый вопрос с реакцией перед ним, чтобы клиент не получил голый вопрос без отклика на свои слова (пункт 3
 * задания 01.11.2026). На ходу с вопросом цены реакции нет: перед вопросом уже фраза об ориентире.
 */
export function withReaction(
  question: SafeQuestion,
  reaction: string,
  aboutPrice: boolean,
): SafeQuestion {
  if (aboutPrice) return question;
  return { ...question, text: `${reaction} ${question.text}` as ReviewedText };
}

/**
 * Вопрос вместо ранней передачи (pipeline/handoff-gate.ts): первое недостающее для расчёта (бизнес спрашивает
 * знакомство), без вопроса о RFID, которого бот ещё не задавал; всё спрошено => первое недостающее; всё известно =>
 * вопрос о том, что лежит на хранении. С фразой об ориентире или без.
 */
export function calcSafeQuestion(input: SafeQuestionInput, aboutPrice: boolean): SafeQuestion {
  const asked = alreadyAsked(input);
  const candidates = calcQuestions(input.profile);
  const key = candidates.find((candidate) => !asked.has(candidate)) ?? candidates[0] ?? 'items';
  return safeQuestionOf(key, aboutPrice, input);
}
