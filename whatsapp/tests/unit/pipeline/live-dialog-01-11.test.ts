import { describe, expect, it } from 'vitest';
import { STALE_PROFILE_LINE } from '../../../src/agent/agent.js';
import type { ClientProfile } from '../../../src/domain/types.js';
import {
  CLIENT_PHONE,
  createScenario,
  json,
  nothingFound,
  type ApiRoutes,
} from './company-scenarios-harness.js';
import type { InterestScript, LlmScript } from './scripted-llm.js';

// Прогон симулятора 01.11.2026 с настоящим Claude (сценарии «склад» и «Kusto»): примерно каждый шестой ход ответ не
// доходил до клиента как надо. Здесь те же ходы на уровне конвейера: очередь склейки, настоящие агент, проверки,
// передача и база; поддельные только модель (сценарий ответа), WhatsApp и проект B. 0 токенов, без сети.

/** Склад ответственного хранения: что клиент рассказал за первые два сообщения. */
const WAREHOUSE: Partial<ClientProfile> = {
  business: 'ответственное хранение для торговых компаний',
  items: 'бытовая техника',
  packaging: 'коробки и паллеты',
  itemCount: 'около 12 тысяч мест',
  city: 'Астана',
  problemAgreed: true,
};

/** Третье сообщение клиента «склад»: помещение, площадь, въезды, 1С и расхождения остатков. */
const WAREHOUSE_DETAILS =
  'Склад в Астане, класс B, 4000 квадратов, два въезда. Учёт в 1С Управление торговлей 11, но остатки постоянно не сходятся с фактом.';

/** Что оценка интереса узнала из третьего сообщения: не хватает только нового в месяц. */
const WAREHOUSE_AFTER: Partial<ClientProfile> = {
  ...WAREHOUSE,
  premises: 'склад класса B',
  area: '4000 кв. м',
  passages: 'два въезда',
  has1C: true,
  oneCName: '1С:Управление торговлей 11',
  problem: 'остатки в 1С не сходятся с фактом',
  inferred: ['passages'],
};

const ASK_INTAKE =
  'Остатки, которые не сходятся с 1С, обычно всплывают только при пересчёте. Расскажите, сколько нового товара приходит к вам за месяц?';

function turn(replies: LlmScript['replies'], profile: Partial<ClientProfile>): LlmScript {
  const interest: InterestScript = { level: 'warm', profile };
  return { replies, interests: [interest] };
}

describe('пункт 1: черновик пишется после оценки и видит последнее сообщение клиента', () => {
  it('«склад»: въезды и 1С из этого сообщения в данных черновика уже известны, не хватает только нового в месяц', async () => {
    const s = createScenario({ api: null });
    await s.say('Здравствуйте, мы ответственное хранение в Астане.', turn(['Вопрос?'], WAREHOUSE));

    const third = await s.say(WAREHOUSE_DETAILS, turn([ASK_INTAKE], WAREHOUSE_AFTER));

    expect(third.llm.purposes()).toEqual(['interest', 'reply', 'review']);
    const data = third.data('reply');
    expect(data).toContain('Для расчёта не хватает: сколько нового приходит в месяц.');
    expect(data).toContain('Проходы: вероятно два въезда');
    expect(data).toContain('1С: есть, 1С:Управление торговлей 11');
    expect(data).not.toContain(STALE_PROFILE_LINE);
    expect(third.toClient).toEqual([ASK_INTAKE]);
  });

  it('клиент назвал последнее недостающее: данные черновика уже говорят «известно всё», этап финал', async () => {
    const s = createScenario({ api: null });
    const ready = { ...WAREHOUSE_AFTER, monthlyIntake: 'около 300 мест' };
    await s.say('Здравствуйте, мы ответственное хранение в Астане.', {
      replies: [{ outcome: 'answer', text: 'Вопрос?', stage: 'details' }],
      interests: [{ level: 'warm', profile: WAREHOUSE }],
    });

    const last = await s.say('Новых около 300 мест в месяц', turn(['Вопрос?'], ready));

    const data = last.data('reply');
    expect(data).toContain('Этап по данным системы: 5 финал.');
    expect(data).toContain('Для расчёта известно всё.');
  });
});

/** «Kusto»: клиент назвал паллеты, 3000 мест, Алматы и 1С. */
const KUSTO =
  'Храним товары клиентов на паллетах, примерно 3000 паллетомест, склад в Алматы. 1С есть, Управление торговлей';

const KUSTO_PROFILE: Partial<ClientProfile> = {
  business: 'логистика',
  items: 'товары клиентов',
  packaging: 'паллеты',
  itemCount: 'примерно 3000 паллетомест',
  city: 'Алматы',
  premises: 'склад',
  has1C: true,
  oneCName: '1С:Управление торговлей',
};

/** Черновик 1: два вопроса о разном, проверка его не пропустила («анкета»). */
const KUSTO_FIRST =
  '3000 паллетомест под товары клиентов, это серьёзный объём. Метка записывает сам товар, поэтому любой ридер сразу видит, какой это товар. Расскажите, сколько новых паллет приходит у вас за месяц и сколько проходов нужно учитывать?';

/** Черновик 2: модель перенесла номер сильной стороны в текст. */
const KUSTO_SECOND =
  '3000 паллетомест с чужими товарами, значит, каждая ошибка в учёте бьёт по вашим клиентам. С метками на паллетах и коробках F5 запись о товаре зашита в сам код, и любой ридер видит, что это за товар. Расскажите, сколько новых паллет у вас приходит за месяц?';

describe('пункт 2: номер сильной стороны в тексте убирает код, черновик не отклоняется', () => {
  it('«Kusto»: второй черновик с «F5» уходит без номера, а не голый безопасный вопрос', async () => {
    const s = createScenario({ api: null });

    const reply = await s.say(KUSTO, {
      replies: [
        { outcome: 'answer', text: KUSTO_FIRST, usedFacts: ['F5'] },
        { outcome: 'answer', text: KUSTO_SECOND, usedFacts: ['F5'] },
      ],
      interests: [{ level: 'warm', profile: KUSTO_PROFILE }],
      reviews: [['Два вопроса о разном подряд: это анкета, оставь один открытый вопрос.'], []],
    });

    expect(reply.llm.purposes()).toEqual(['interest', 'reply', 'review', 'reply', 'review']);
    expect(reply.toClient).toEqual([KUSTO_SECOND.replace(' F5', '')]);
    expect(reply.toClient.join('')).not.toMatch(/F5/u);
    expect(s.storage.chats.getProgress(s.chatId()).toldFacts).toEqual(['F5']);
  });
});

/** Черновики хода 3 «склад»: первый с фактом не из документов и повтором вопроса, второй только с повтором. */
const WAREHOUSE_FIRST =
  'Остатки в 1С Управление торговлей 11 постоянно не сходятся с фактом, это частая история. Данные идут в 1С сами, поэтому расхождения видны сразу. Расскажите, сколько нового товара приходит к вам за месяц?';
const WAREHOUSE_SECOND =
  'Остатки в 1С постоянно не сходятся с фактом, на ответственном хранении это обычная история. Антенны на въездах сами отмечают, что пришло и что ушло. Расскажите, какой объём новой техники у вас принимается в течение месяца?';

describe('пункт 3: после двух замечаний проверки не голый вопрос и не передача', () => {
  it('«склад»: второй черновик без замечаний уходит клиенту; проверка видит выжимку, но не правила о вопросах', async () => {
    const s = createScenario({ api: null });
    await s.say('Здравствуйте, мы ответственное хранение в Астане.', turn(['Вопрос?'], WAREHOUSE));

    const third = await s.say(WAREHOUSE_DETAILS, {
      replies: [WAREHOUSE_FIRST, WAREHOUSE_SECOND],
      interests: [{ level: 'warm', profile: WAREHOUSE_AFTER }],
      reviews: [['«Расхождения видны сразу» нет в знаниях.'], []],
    });

    expect(third.outcome).toEqual({ kind: 'replied' });
    expect(third.toClient).toEqual([WAREHOUSE_SECOND]);
    expect(third.toManager).toEqual([]);
    expect(s.storage.chats.getById(s.chatId())?.control).toEqual({ status: 'bot', by: null });
    // Проверка видит выжимку (сказанное раньше не выдумка); вопросы она не оценивает (03.11.2026).
    expect(third.data('review')).toContain('Проходы: вероятно два въезда');
    expect(third.data('review')).not.toContain('Для расчёта');
  });

  it('оба раза замечание о фактах: готовый вопрос с реакцией на новое для расчёта, без передачи', async () => {
    const s = createScenario({ api: null });
    await s.say('Здравствуйте, мы ответственное хранение в Астане.', turn(['Вопрос?'], WAREHOUSE));

    const third = await s.say(WAREHOUSE_DETAILS, {
      replies: [WAREHOUSE_FIRST, WAREHOUSE_FIRST],
      interests: [{ level: 'warm', profile: WAREHOUSE_AFTER }],
      problems: ['«Расхождения видны сразу» нет в документах.'],
    });

    expect(third.outcome).toEqual({ kind: 'replied' });
    expect(third.toClient).toEqual([
      'Спасибо, это важно для расчёта. Расскажите, сколько нового товара приходит к вам за месяц?',
    ]);
    expect(third.toManager).toEqual([]);
  });
});

/** Так бот «склад» спросил прошлым ходом: о новом в месяц и о проходах. */
const WAREHOUSE_ASKED =
  'Антенны на входе и выходе видят всю партию сразу, сканировать по одной не нужно. Расскажите, сколько нового товара приходит к вам за месяц и сколько проходов нужно учитывать?';

describe('пункт 3: «спросить нечего» больше не бывает, если недостающее спрашивали один раз', () => {
  it('«склад» как в прогоне: о новом в месяц бот уже спрашивал, оба черновика с замечанием о фактах => тот же вопрос другими словами, без передачи', async () => {
    const s = createScenario({ api: null });
    await s.say(
      'Здравствуйте, мы ответственное хранение в Астане.',
      turn([WAREHOUSE_ASKED], WAREHOUSE),
    );

    const third = await s.say(WAREHOUSE_DETAILS, {
      replies: [WAREHOUSE_FIRST, WAREHOUSE_FIRST],
      interests: [{ level: 'warm', profile: WAREHOUSE_AFTER }],
      problems: ['«Расхождения видны сразу» нет в документах.'],
    });

    expect(third.outcome).toEqual({ kind: 'replied' });
    expect(third.toClient).toEqual([
      'Спасибо, это важно для расчёта. Расскажите, сколько нового товара приходит к вам за месяц?',
    ]);
    expect(third.toManager).toEqual([]);
    expect(s.storage.chats.getById(s.chatId())?.control).toEqual({ status: 'bot', by: null });
  });
});

/** Карточка 2ГИС «Kusto»: название с хвостом после запятой, как в прогоне. */
const KUSTO_ID = 41;
const KUSTO_CARD = 'Kusto Logistics Management, компания';

function kustoJson(): unknown {
  return {
    id: KUSTO_ID,
    name: KUSTO_CARD,
    city: 'Алматы',
    rubric: 'Логистические услуги',
    match_by: 'phone',
    match_score: 1,
    emailed: false,
  };
}

const KUSTO_BY_PHONE: ApiRoutes = {
  lookup: (query) =>
    query['phone'] === CLIENT_PHONE ? json(200, { candidates: [kustoJson()] }) : nothingFound(),
  brief: (id) =>
    id === KUSTO_ID
      ? json(200, {
          ...(kustoJson() as Record<string, unknown>),
          segment: null,
          fit: null,
          fit_score: null,
          reason: null,
          pains: [],
          emailed_at: null,
          email_subject: null,
        })
      : json(404, { error: 'not_found' }),
};

describe('пункт 5: данные подтверждённой компании доходят до бота, вопрос с чистым названием', () => {
  it('«Kusto»: вопрос без «, компания»; после «да» город и рубрика в данных черновика, город не спрашивается', async () => {
    const s = createScenario({ api: KUSTO_BY_PHONE });
    const ask = 'Здравствуйте! Вы из компании Kusto Logistics Management, правильно?';

    const hello = await s.say('Здравствуйте', {
      replies: [{ outcome: 'answer', text: ask, companyQuestion: 'confirm', stage: 'intro' }],
    });
    const yes = await s.say('Да', {
      replies: ['Расскажите, что у вас лежит на хранении и в каком виде?'],
      interests: [{ level: 'warm', companyAnswer: 'yes' }],
    });

    expect(hello.data('reply')).toContain(
      '«Вы из компании Kusto Logistics Management, правильно?»',
    );
    expect(hello.data('reply')).not.toContain('компания»');
    expect(hello.toClient).toEqual([ask]);
    const data = yes.data('reply');
    expect(data).toContain(
      'Компания клиента: «Kusto Logistics Management».\nГород компании: Алматы.',
    );
    expect(data).toContain('Город: вероятно Алматы');
    expect(data).toContain('Бизнес: вероятно Логистические услуги');
    expect(data).not.toMatch(/Для расчёта не хватает: [^\n]*город/u);
    // Выжимка с городом и рубрикой сохранена: менеджер и следующие ходы видят их с «вероятно».
    expect(s.storage.chats.getById(s.chatId())?.profile).toMatchObject({
      city: 'Алматы',
      business: 'Логистические услуги',
      inferred: ['business', 'city'],
    });
  });
});
