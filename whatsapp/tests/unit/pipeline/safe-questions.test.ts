import { describe, expect, it } from 'vitest';
import { normalizeDraft, runCodeChecks } from '../../../src/checks/code-checks.js';
import type { ClientProfile, PhoneDigits } from '../../../src/domain/types.js';
import {
  askedKeys,
  INTRO_BUSINESS_QUESTION,
  ESTIMATE_LATER,
  nextSafeQuestion,
  calcSafeQuestion,
  QUESTION_KEYS,
  questionText,
  REACTIONS,
  reactionOf,
  withReaction,
  type QuestionKey,
  type SafeQuestion,
  type SafeQuestionInput,
} from '../../../src/pipeline/safe-questions.js';

// Безопасные вопросы (решение владельца 30.10.2026): вместо анкеты из четырёх групп один открытый вопрос по
// рекомендуемому этапу и первому недостающему для расчёта. Уходят без модели, поэтому без фактов о Tanbala, цен и
// обещаний и проходят проверки кодом. На ходу с вопросом цены перед вопросом фраза об ориентире.

const NO_PHONE = '' as PhoneDigits;

function codeFindings(text: string, priceTurn: boolean) {
  return runCodeChecks(normalizeDraft(text), { ownPhone: NO_PHONE, clientText: '', priceTurn });
}

/** Тексты владельца, ровно такие. */
const TEXTS: Readonly<Record<QuestionKey, string>> = {
  intro: 'Расскажите, из какой вы компании и чем она занимается?',
  hook: 'Вы уже знаете, как работает RFID и что мы предлагаем?',
  items: 'Расскажите, что у вас лежит на хранении и в каком виде?',
  itemCount: 'Расскажите, сколько примерно позиций у вас на хранении?',
  monthlyIntake: 'Расскажите, сколько нового товара приходит к вам за месяц?',
  passages: 'Расскажите, сколько проходов нужно учитывать?',
  has1C: 'Расскажите, в какой 1С вы ведёте учёт или учёта в 1С пока нет?',
  city: 'Подскажите, в каком городе всё это находится?',
};

const EMPTY: ClientProfile = {
  business: null,
  items: null,
  packaging: null,
  material: null,
  city: null,
  premises: null,
  area: null,
  scope: null,
  itemCount: null,
  monthlyIntake: null,
  turnover: null,
  passages: null,
  shelfRecount: null,
  currentTracking: null,
  has1C: null,
  oneCName: null,
  problem: null,
  specifics: null,
  problemAgreed: false,
  inferred: [],
};

/** Всё для расчёта известно. */
const FULL: ClientProfile = {
  ...EMPTY,
  business: 'склад',
  items: 'запчасти в коробках',
  itemCount: '10 тысяч',
  monthlyIntake: '500',
  passages: 'один вход',
  has1C: true,
  city: 'Алматы',
};

function input(profile: ClientProfile, patch: Partial<SafeQuestionInput> = {}): SafeQuestionInput {
  return {
    profile,
    companyAskable: false,
    lastBotText: null,
    ...patch,
  };
}

describe('pipeline/safe-questions: тексты', () => {
  it('восемь открытых вопросов по порядку разговора, тексты владельца ровно', () => {
    expect(QUESTION_KEYS).toEqual([
      'intro',
      'hook',
      'items',
      'itemCount',
      'monthlyIntake',
      'passages',
      'has1C',
      'city',
    ]);
    for (const key of QUESTION_KEYS) {
      expect(questionText(key, false)).toBe(TEXTS[key]);
    }
  });

  it('на ходу с вопросом цены: сначала фраза об ориентире, затем вопрос', () => {
    expect(ESTIMATE_LATER).toBe('Ориентир коллега назовёт, когда поймём вашу задачу.');
    expect(questionText('items', true)).toBe(
      `Ориентир коллега назовёт, когда поймём вашу задачу. ${TEXTS.items}`,
    );
  });

  it.each(QUESTION_KEYS)('вопрос %s проходит проверки кодом, без двоеточий и тире', (key) => {
    for (const aboutPrice of [false, true]) {
      const text = questionText(key, aboutPrice);
      expect(codeFindings(text, aboutPrice)).toEqual([]);
      expect(text).not.toMatch(/[:—–]/u);
    }
  });

  it('анкеты больше нет: о металле, жидкостях и помещении фиксированно не спрашивают', () => {
    const all = QUESTION_KEYS.map((key) => questionText(key, true)).join(' ');

    expect(all).not.toMatch(/металл|жидкост|помещени|коробки, паллеты/u);
  });
});

describe('pipeline/safe-questions: реакция перед готовым вопросом (пункт 3 задания 01.11.2026)', () => {
  const ASKED: SafeQuestion = { key: 'items', text: questionText('items', false) };

  it('три фиксированные фразы, без «Понятно» и пересказа слов клиента', () => {
    expect(REACTIONS).toEqual({
      greeting: 'Здравствуйте!',
      newData: 'Спасибо, это важно для расчёта.',
      thanks: 'Спасибо!',
    });
  });

  it.each(Object.values(REACTIONS))(
    'реакция «%s» с любым вопросом проходит проверки кодом, без двоеточий и тире',
    (reaction) => {
      for (const key of QUESTION_KEYS) {
        const text = withReaction({ key, text: questionText(key, false) }, reaction, false).text;
        expect(codeFindings(text, false)).toEqual([]);
        expect(text).not.toMatch(/[:—–]/u);
      }
    },
  );

  it('бот ещё не писал: приветствие', () => {
    expect(reactionOf({ before: EMPTY, after: FULL, botWrote: false })).toBe(REACTIONS.greeting);
  });

  it('по выжимке этого хода стало известно новое для расчёта: «Спасибо, это важно для расчёта.»', () => {
    const before = { ...EMPTY, business: 'склад' };
    const after = { ...before, passages: 'два въезда', inferred: ['passages' as const] };

    expect(reactionOf({ before, after, botWrote: true })).toBe(REACTIONS.newData);
  });

  it('нового для расчёта нет (другое поле или то же самое): «Спасибо!»', () => {
    const before = { ...EMPTY, business: 'склад' };

    expect(reactionOf({ before, after: before, botWrote: true })).toBe(REACTIONS.thanks);
    expect(reactionOf({ before, after: { ...before, area: '4000 м²' }, botWrote: true })).toBe(
      REACTIONS.thanks,
    );
  });

  it('withReaction: реакция перед вопросом, вопрос о компании сохраняется', () => {
    const intro: SafeQuestion = {
      key: 'intro',
      text: questionText('intro', false),
      companyQuestion: 'name',
    };

    expect(withReaction(ASKED, REACTIONS.thanks, false)).toEqual({
      key: 'items',
      text: `Спасибо! ${TEXTS.items}`,
    });
    expect(withReaction(intro, REACTIONS.greeting, false)).toEqual({
      key: 'intro',
      text: `Здравствуйте! ${TEXTS.intro}`,
      companyQuestion: 'name',
    });
  });

  it('ход с вопросом цены: реакции нет, перед вопросом и так фраза об ориентире', () => {
    const priced: SafeQuestion = { key: 'items', text: questionText('items', true) };

    expect(withReaction(priced, REACTIONS.thanks, true)).toBe(priced);
  });
});

describe('pipeline/safe-questions: недостающее можно спросить ещё раз, один раз и другими словами', () => {
  /** «Склад» 01.11.2026: не хватает только нового в месяц, бот прошлым ходом спрашивал о нём своими словами. */
  const WAREHOUSE: ClientProfile = { ...FULL, monthlyIntake: null };
  const MODEL_ASKED =
    'Антенны на входе и выходе видят всю партию сразу. Расскажите, сколько нового товара приходит к вам за месяц и сколько проходов нужно учитывать?';
  const DETAILS = { lastStage: 'details' as const };

  it('спрошено один раз словами модели: готовый вопрос о том же, а не «спросить нечего»', () => {
    const question = nextSafeQuestion(
      input(WAREHOUSE, { ...DETAILS, botTexts: [MODEL_ASKED] }),
      false,
    );

    expect(question).toEqual({ key: 'monthlyIntake', text: TEXTS.monthlyIntake });
  });

  it('спрошено дважды или готовым текстом: снова не спрашивается, null', () => {
    const twice = input(WAREHOUSE, { ...DETAILS, botTexts: [MODEL_ASKED, MODEL_ASKED] });
    const fixed = input(WAREHOUSE, { ...DETAILS, botTexts: [TEXTS.monthlyIntake] });

    expect(nextSafeQuestion(twice, false)).toBeNull();
    expect(nextSafeQuestion(fixed, false)).toBeNull();
  });

  it('незаданный вопрос по-прежнему первым, повтор только когда незаданных нет', () => {
    const profile = { ...WAREHOUSE, city: null };
    const question = nextSafeQuestion(
      input(profile, { ...DETAILS, botTexts: [MODEL_ASKED] }),
      false,
    );

    expect(question?.key).toBe('city');
  });

  it('знакомство не повторяется: неизвестен только бизнес, о нём уже спрашивали => null', () => {
    const onlyBusiness = input(
      { ...FULL, business: null },
      { ...DETAILS, botTexts: ['Расскажите, из какой вы компании, чем занимаетесь?'] },
    );

    expect(nextSafeQuestion(onlyBusiness, false)).toBeNull();
  });
});

describe('pipeline/safe-questions: о чём бот уже спрашивал', () => {
  it.each(QUESTION_KEYS)('свой вопрос %s узнаётся, и только он', (key) => {
    expect(askedKeys(questionText(key, false))).toEqual(new Set([key]));
    expect(askedKeys(questionText(key, true))).toEqual(new Set([key]));
  });

  it.each<[string, QuestionKey]>([
    ['Расскажите, что у вас лежит на хранении и как сейчас проходит проверка?', 'items'],
    ['Как у вас лежит товар и сколько нового приходит за месяц?', 'monthlyIntake'],
    ['Сколько проходов нужно учитывать?', 'passages'],
    ['А какая у вас 1С?', 'has1C'],
    ['Подскажите, есть ли у вас 1С?', 'has1C'],
    ['Сколько примерно позиций на складе?', 'itemCount'],
    ['Из какой вы компании?', 'intro'],
    ['Вы знакомы с RFID?', 'hook'],
    ['В каком городе склад?', 'city'],
  ])('вопрос модели «%s» узнаётся как %s', (text, key) => {
    expect(askedKeys(text).has(key)).toBe(true);
  });

  it('утверждение без вопроса ничего не спрашивает', () => {
    expect(
      askedKeys('Антенны на входе и выходе сами отмечают приход. Данные уходят в 1С.'),
    ).toEqual(new Set());
  });
});

describe('pipeline/safe-questions: какой вопрос задать вместо отклонённого черновика', () => {
  it('бизнес неизвестен, о компании спрашивать не нужно: знакомство только о том, чем она занимается (ревью этапа 2)', () => {
    expect(nextSafeQuestion(input(EMPTY), false)).toEqual({
      key: 'intro',
      text: INTRO_BUSINESS_QUESTION,
    });
    expect(nextSafeQuestion(input(EMPTY), true)?.text).toBe(
      `${ESTIMATE_LATER} ${INTRO_BUSINESS_QUESTION}`,
    );
    expect(codeFindings(INTRO_BUSINESS_QUESTION, false)).toEqual([]);
    expect(askedKeys(INTRO_BUSINESS_QUESTION)).toEqual(new Set(['intro']));
  });

  it('компания названа (известно название): знакомство не переспрашивает компанию', () => {
    const named = input(EMPTY, { companyAskable: false });

    expect(nextSafeQuestion(named, false)).toEqual({
      key: 'intro',
      text: INTRO_BUSINESS_QUESTION,
    });
  });

  it.each([
    ['Сколько единиц товара проходит за месяц?', ['monthlyIntake']],
    ['Через сколько дверей идёт товар?', ['passages']],
    ['Сколько проходов нужно учитывать?', ['passages']],
    ['Сколько у вас проходов и входов?', ['passages']],
  ] as const)('«%s» распознаётся как %j, без лишнего (ревью этапа 2)', (text, keys) => {
    expect([...askedKeys(text)]).toEqual(keys);
  });

  it('о компании можно спросить: вопрос знакомства отмечается как вопрос о названии', () => {
    const asking = input(EMPTY, { companyAskable: true });

    expect(nextSafeQuestion(asking, false)).toEqual({
      key: 'intro',
      text: TEXTS.intro,
      companyQuestion: 'name',
    });
  });

  it('бизнес известен, бот ещё не был на крючке: вопрос о RFID', () => {
    const profile = { ...EMPTY, business: 'банк' };

    expect(nextSafeQuestion(input(profile), false)?.key).toBe('hook');
    expect(nextSafeQuestion(input(profile, { lastStage: 'intro' }), false)?.key).toBe('hook');
  });

  it('после крючка и дальше: первое недостающее для расчёта', () => {
    const profile = { ...FULL, items: null, passages: null };

    expect(nextSafeQuestion(input(profile, { lastStage: 'hook' }), false)?.key).toBe('items');
    expect(nextSafeQuestion(input(profile, { lastStage: 'details' }), true)).toEqual({
      key: 'items',
      text: `${ESTIMATE_LATER} ${TEXTS.items}`,
    });
  });

  it('вопрос, который бот уже задавал в чате (в любом прошлом ответе), второй раз не выбирается', () => {
    const profile = { ...FULL, items: null, passages: null, city: null };
    const botTexts = [`Спасибо! ${TEXTS.items}`, 'Сколько проходов нужно учитывать у вас?'];

    expect(nextSafeQuestion(input(profile, { lastStage: 'details', botTexts }), false)?.key).toBe(
      'city',
    );
  });

  it('без списка прошлых ответов учитывается прошлое сообщение бота', () => {
    const profile = { ...FULL, items: null, city: null };

    expect(
      nextSafeQuestion(input(profile, { lastStage: 'details', lastBotText: TEXTS.items }), false)
        ?.key,
    ).toBe('city');
  });

  it('знакомство уже спрошено: дальше крючок, затем недостающее для расчёта', () => {
    const botTexts = [TEXTS.intro];

    expect(nextSafeQuestion(input(EMPTY, { botTexts }), false)?.key).toBe('hook');
    expect(
      nextSafeQuestion(input(EMPTY, { botTexts: [TEXTS.intro, TEXTS.hook] }), false)?.key,
    ).toBe('items');
  });

  it('вывод «вероятно» считается выясненным', () => {
    const profile: ClientProfile = { ...FULL, city: 'Алматы', inferred: ['city'] };

    expect(nextSafeQuestion(input(profile, { lastStage: 'details' }), false)).toBeNull();
  });

  it('всё для расчёта известно (финал) или всё спрошено: безопасного вопроса нет', () => {
    const asked = [TEXTS.city];

    expect(nextSafeQuestion(input(FULL, { lastStage: 'details' }), false)).toBeNull();
    expect(
      nextSafeQuestion(
        input({ ...FULL, city: null }, { lastStage: 'details', botTexts: asked }),
        false,
      ),
    ).toBeNull();
  });

  it('чат уже передавался и всё известно: спросить нечего', () => {
    expect(
      nextSafeQuestion(input(FULL, { lastStage: 'details', handedOff: true }), false),
    ).toBeNull();
  });
});

describe('pipeline/safe-questions: вместо раннего hot (pipeline/handoff-gate.ts)', () => {
  it('первое недостающее для расчёта с фразой об ориентире, без вопроса о RFID', () => {
    const profile = { ...EMPTY, business: 'склад' };

    expect(calcSafeQuestion(input(profile), true)).toEqual({
      key: 'items',
      text: `${ESTIMATE_LATER} ${TEXTS.items}`,
    });
  });

  it('бизнес неизвестен, о компании можно спросить: знакомство как вопрос о названии', () => {
    const asking = input(EMPTY, { companyAskable: true });

    expect(calcSafeQuestion(asking, true)).toEqual({
      key: 'intro',
      text: `${ESTIMATE_LATER} ${TEXTS.intro}`,
      companyQuestion: 'name',
    });
  });

  it('прошлым сообщением бот спросил о вещах: следующий вопрос', () => {
    const profile = { ...EMPTY, business: 'склад' };

    expect(calcSafeQuestion(input(profile, { lastBotText: TEXTS.items }), true).key).toBe(
      'itemCount',
    );
  });

  it('всё спрошено или для расчёта всё известно: вопрос всё равно есть', () => {
    const profile = { ...FULL, city: null };

    expect(calcSafeQuestion(input(profile, { lastBotText: TEXTS.city }), true).key).toBe('city');
    expect(calcSafeQuestion(input(FULL), true).key).toBe('items');
  });
});
