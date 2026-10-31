import { describe, expect, it } from 'vitest';
import type { ClientProfile } from '../../../src/domain/types.js';
import { questionText } from '../../../src/pipeline/safe-questions.js';
import { createScenario, dataOf } from './company-scenarios-harness.js';
import type { InterestScript, LlmScript } from './scripted-llm.js';

// Когда чат уходит коллеге (решение владельца 30.10.2026) на уровне конвейера: реплики клиента идут через очередь
// склейки, конвейер, настоящие агент, проверки, передачу и базу. Поддельные только модель (сценарий ответа), WhatsApp и
// проект B (компанию не находит): 0 токенов, без сети. Чат первый в базе, поэтому его ID 1, как у живого диалога 28.10.

/** Живой диалог 28.10 (чат ID 1): склад 5000 м², ввоз и вывоз, вопрос про 1С и цену; компания не определена. */
const CLIENT_28_10 =
  'Здравствуйте, у нас склад 5000 квадратов, хотим учитывать, что приходит и что уходит. Вы интегрируетесь с нашей 1С? И сколько это будет стоить?';

/** Что оценка интереса узнала из этого сообщения: задача не понятна (что на хранении и сколько, неизвестно). */
const PROFILE_28_10: Partial<ClientProfile> = {
  business: 'склад',
  premises: 'склад',
  area: '5000 м²',
  scope: 'ввоз и вывоз',
  has1C: true,
  problemAgreed: true,
};

/** Задача понятна: известно, что на хранении и сколько. */
const TASK: Partial<ClientProfile> = {
  ...PROFILE_28_10,
  items: 'запчасти',
  itemCount: 'около 3000',
};

/** Для расчёта известно всё. */
const READY: Partial<ClientProfile> = {
  ...TASK,
  monthlyIntake: '200 в месяц',
  passages: 'один вход',
  city: 'Алматы',
};

/** Ответ по правилу: из знаний про 1С, ориентир назовёт коллега, один вопрос. */
const ANSWER_28_10 =
  'Да, мы проводим интеграцию с вашей 1С, детали зависят от конфигурации. Ориентир коллега назовёт, когда поймём вашу задачу. Расскажите, что у вас лежит на хранении?';

/** Так ответил старый бот: сразу передача. */
const OLD_HOT =
  'Да, мы проводим интеграцию с вашей 1С. Я уточню у коллеги решение и ориентир под вашу задачу.';

const SOLUTION_PHRASE = 'Я уточню у коллеги решение и ориентир под вашу задачу.';
const HANDOFF_PHRASE = 'Уточню у коллеги и вернусь к вам.';
const ASK_COUNT = 'Расскажите, сколько примерно позиций у вас на хранении?';

function turn(
  replies: LlmScript['replies'],
  profile: Partial<ClientProfile>,
  extra: Omit<InterestScript, 'profile'> = {},
): LlmScript {
  return { replies, interests: [{ level: 'warm', profile, ...extra }] };
}

function priceTurn(replies: LlmScript['replies'], profile = PROFILE_28_10): LlmScript {
  return turn(replies, profile, { priceAsked: true });
}

function hotPrice(text = SOLUTION_PHRASE): LlmScript['replies'][number] {
  return { outcome: 'hot', text, aboutPrice: true };
}

describe('диалог 28.10: вопрос цены, а задача не понятна', () => {
  it('вместо передачи ответ с фразой об ориентире и вопросом; данные модели говорят, что задача не понятна', async () => {
    const s = createScenario();

    const first = await s.say(CLIENT_28_10, priceTurn([ANSWER_28_10]));

    expect(s.chatId()).toBe(1);
    expect(first.outcome).toEqual({ kind: 'replied' });
    expect(first.toClient).toEqual([ANSWER_28_10]);
    expect(first.toManager).toEqual([]);
    expect(s.storage.chats.getById(s.chatId())?.control).toEqual({ status: 'bot', by: null });
    const data = first.data('reply');
    // Черновик пишется после оценки этого хода (пункт 1 задания 01.11.2026): клиент назвал бизнес, этап уже крючок.
    expect(data).toContain('Этап по данным системы: 2 крючок.');
    expect(data).toContain('Бизнес: склад');
    expect(data).toContain(
      'Задача клиента ещё не понятна: на вопрос цены, сроков или договора ответь «Ориентир коллега назовёт, когда поймём вашу задачу.» и задай один вопрос.',
    );
    expect(s.storage.chats.getProgress(s.chatId())).toEqual({
      priceAsks: 1,
      refused: false,
      lastStage: 'details',
    });
  });

  it('модель по старой привычке отвечает hot: код не передаёт чат, повтор с замечанием даёт ответ', async () => {
    const s = createScenario();

    const first = await s.say(CLIENT_28_10, priceTurn([hotPrice(OLD_HOT), ANSWER_28_10]));

    expect(first.outcome).toEqual({ kind: 'replied' });
    expect(first.toClient).toEqual([ANSWER_28_10]);
    expect(first.llm.purposes()).toEqual(['interest', 'reply', 'reply', 'review']);
    const retry = dataOf(first.llm.requests.filter((request) => request.purpose === 'reply')[1]);
    expect(retry).toContain(
      'Цену, сроки и договор называет коллега. Ответь «Ориентир коллега назовёт, когда поймём вашу задачу.» и задай один открытый вопрос о недостающем: что лежит на хранении.',
    );
    expect(s.storage.handoffs.findOpen(s.chatId())).toBeNull();
  });

  it('модель дважды хочет передать: уходит готовый вопрос о первом недостающем для расчёта', async () => {
    const s = createScenario();

    const first = await s.say(CLIENT_28_10, priceTurn([hotPrice(OLD_HOT)]));

    expect(first.outcome).toEqual({ kind: 'replied' });
    expect(first.toClient).toEqual([questionText('items', true)]);
    expect(first.toManager).toEqual([]);
  });
});

describe('б) вопрос цены, сроков или договора, когда задача понятна', () => {
  it('модель вернула hot: передача, клиенту фраза о решении и ориентире, уровень hot', async () => {
    const s = createScenario();
    await s.say(CLIENT_28_10, priceTurn([ANSWER_28_10]));

    const second = await s.say(
      'Запчасти, около 3000 позиций. Так сколько?',
      priceTurn([hotPrice()], TASK),
    );

    expect(second.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(second.toClient).toEqual([SOLUTION_PHRASE]);
    expect(second.toManager).toHaveLength(1);
    // Причина своими словами с цитатой клиента, а не заготовка «спрашивает цену» (пункт 3).
    expect(second.toManager[0]?.split('\n')[1]).toBe(
      'Причина: Спрашивает цену, сроки или договор, задача понятна. Клиент: «Запчасти, около 3000 позиций. Так сколько?»',
    );
    expect(s.storage.chats.getById(s.chatId())?.level).toBe('hot');
    expect(s.storage.handoffs.findOpen(s.chatId())).toMatchObject({ reason: 'hot', level: 'hot' });
  });

  it('модель ответила answer: код передаёт чат сам, черновик не проверяется', async () => {
    const s = createScenario();
    await s.say(CLIENT_28_10, priceTurn([ANSWER_28_10]));

    const second = await s.say(
      'Запчасти, около 3000 позиций. Когда сможете поставить и как заключить договор?',
      priceTurn([ANSWER_28_10], TASK),
    );

    expect(second.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(second.toClient).toEqual([SOLUTION_PHRASE]);
    expect(second.llm.purposes()).toEqual(['interest', 'reply']);
  });

  it('данные следующего ответа говорят модели, что задача понятна и вопрос цены передаёт чат', async () => {
    const s = createScenario();
    await s.say('Около 3000 запчастей на складе', turn([ASK_COUNT], TASK));

    const next = await s.say('А какие сроки?', turn([ASK_COUNT], TASK));

    expect(next.data('reply')).toContain(
      'Задача клиента понятна: если он спрашивает цену, сроки или договор, передай чат (hot) с фразой «Я уточню у коллеги решение и ориентир под вашу задачу.».',
    );
  });
});

describe('в) третий вопрос цены передаёт чат (было четыре)', () => {
  it('первые два без передачи, третий передаёт; модель видит счётчик', async () => {
    const s = createScenario();

    const first = await s.say('Сколько стоит?', priceTurn([ASK_COUNT], {}));
    const second = await s.say('Я спросил, сколько стоит?', priceTurn([hotPrice(), ASK_COUNT], {}));
    const third = await s.say('Так сколько стоит?', priceTurn([ASK_COUNT], {}));

    expect(first.outcome).toEqual({ kind: 'replied' });
    expect(second.outcome).toEqual({ kind: 'replied' });
    expect([first.toManager, second.toManager]).toEqual([[], []]);
    expect(third.data('reply')).toContain('До этого сообщения клиент спрашивал цену 2 раза.');
    expect(third.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(third.toClient).toEqual([SOLUTION_PHRASE]);
  });
});

describe('г) клиент два хода подряд уходит от вопросов', () => {
  const DODGE = 'Это неважно, просто расскажите';

  it('первый уход: ответ, счёт в базе; второй подряд: передача с «Уточню у коллеги и вернусь к вам.»', async () => {
    const s = createScenario();

    const first = await s.say('Не скажу', turn([ASK_COUNT], {}, { refused: true }));
    const progress = s.storage.chats.getProgress(s.chatId());
    const second = await s.say('Не скажу же', turn([ASK_COUNT], {}, { refused: true }));

    expect(first.outcome).toEqual({ kind: 'replied' });
    expect(progress).toMatchObject({ refused: true, refusedStreak: 1 });
    expect(second.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(second.toClient).toEqual([HANDOFF_PHRASE]);
    expect(second.toManager[0]).toContain(
      'Причина: Дважды подряд уходит от вопросов. Клиент: «Не скажу же»',
    );
    expect(second.llm.purposes()).toEqual(['interest', 'reply']);
  });

  it('уход, обычный ответ, снова уход: счёт обнулился, чат у бота', async () => {
    const s = createScenario();

    await s.say('Не скажу', turn([ASK_COUNT], {}, { refused: true }));
    await s.say('Около 3000', turn([ASK_COUNT], { itemCount: 'около 3000' }));
    const third = await s.say(
      DODGE,
      turn([ASK_COUNT], { itemCount: 'около 3000' }, { refused: true }),
    );

    expect(third.outcome).toEqual({ kind: 'replied' });
    expect(s.storage.chats.getProgress(s.chatId())).toMatchObject({ refusedStreak: 1 });
  });

  it('возврат чата боту обнуляет счёт уходов', async () => {
    const s = createScenario();
    await s.say('Не скажу', turn([ASK_COUNT], {}, { refused: true }));
    await s.say('Позовите человека', { replies: [{ outcome: 'asked_human' }] });

    await s.services.handoff.returnToBot(s.chatId());

    expect(s.storage.chats.getProgress(s.chatId())).toEqual({
      priceAsks: 0,
      refused: false,
      handedOff: true,
      lastStage: 'details',
    });
  });
});

describe('а) финал: для расчёта известно всё', () => {
  const SUMMARY = `Склад запчастей в Алматы, около 3000 позиций, 200 новых в месяц, один вход, 1С есть. ${SOLUTION_PHRASE}`;

  it('клиент назвал последнее недостающее, модель вернула hot со сводкой: передача с текстом модели', async () => {
    const s = createScenario();
    await s.say('Около 3000 запчастей, 200 новых в месяц', turn([ASK_COUNT], { ...TASK }));

    const last = await s.say(
      'Алматы, один вход',
      turn([{ outcome: 'hot', text: SUMMARY, stage: 'final' }], READY),
    );

    expect(last.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(last.toClient).toEqual([SUMMARY]);
    expect(last.llm.purposes()).toEqual(['interest', 'reply', 'review']);
    expect(last.toManager[0]).toContain(
      'Причина: Всё для расчёта известно, клиент готов к расчёту. Клиент: «Алматы, один вход»',
    );
  });

  it('для расчёта известно не всё, модель вернула hot: повтор с замечанием, чего не хватает для финала', async () => {
    const s = createScenario();

    const early = await s.say(
      'Около 3000 запчастей',
      turn([{ outcome: 'hot', text: SUMMARY }, ASK_COUNT], TASK),
    );

    expect(early.outcome).toEqual({ kind: 'replied' });
    expect(early.toClient).toEqual([ASK_COUNT]);
    const retry = dataOf(early.llm.requests.filter((request) => request.purpose === 'reply')[1]);
    expect(retry).toContain(
      'Для финала не хватает: сколько нового приходит в месяц, сколько проходов нужно учитывать, город. Задай один открытый вопрос о недостающем.',
    );
  });
});

describe('д) просьба о живом человеке', () => {
  it('передача сразу, без повтора', async () => {
    const s = createScenario();

    const first = await s.say('Позовите, пожалуйста, менеджера', {
      replies: [{ outcome: 'asked_human' }],
    });

    expect(first.outcome).toEqual({ kind: 'handed_off', reason: 'asked_human' });
    expect(first.llm.purposes()).toEqual(['interest', 'reply']);
    expect(first.toManager[0]).toContain('Передача чата менеджеру: клиент просит живого человека.');
  });
});
