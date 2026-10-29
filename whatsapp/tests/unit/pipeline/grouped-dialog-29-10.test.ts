import { describe, expect, it } from 'vitest';
import type { ClientProfile } from '../../../src/domain/types.js';
import { CAP_HANDOFF_TEXT, MINIMUM_HANDOFF_TEXT } from '../../../src/handoff/minimum.js';
import { runCodeChecks, normalizeDraft } from '../../../src/checks/code-checks.js';
import type { PhoneDigits } from '../../../src/domain/types.js';
import { createScenario, type Scenario } from './company-scenarios-harness.js';
import type { InterestScript, LlmScript } from './scripted-llm.js';

// Тест владельца с телефона 29.10.2026 вечером (клиент «tyri», склады и отгрузки) на моках, после решения: вопросы
// группами (пункт A) и передача, как только собран минимум (пункт B). Раньше бот задавал по одному вопросу (9 сообщений),
// после ответа о 1С минимум был собран, а бот всё спрашивал о болях и трижды повторял про ридер на входе и выходе.
// Реплики клиента идут через очередь склейки, конвейер, настоящие агент, проверки кодом, передачу и базу; поддельные
// только модель, WhatsApp и проект B (компанию не находит).

const GREETING = 'Здравствуйте! Подскажите, как называется ваша компания и чем она занимается?';
const HOW_IT_WORKS =
  'Метку клеят на вещь, а ридеры на входах и выходах сами отмечают приход и уход, сканировать по одной не нужно. Подскажите, какие вещи нужно учитывать, в чём они лежат (коробки, паллеты или поштучно) и есть ли среди них металл или жидкости?';
const WHERE_AND_HOW_MANY =
  'Подскажите, в каком городе склад и сколько примерно паллет и коробок проходит через него за месяц?';
const ONE_C = 'Подскажите, есть ли у вас 1С и какая?';
/** Так модель отвечала раньше после ответа о 1С: снова вопросы о болях вместо передачи. */
const MORE_QUESTIONS =
  'Понял, обычная 1С. Подскажите, как вы сейчас ведёте учёт и что мешает больше всего?';

const P2: Partial<ClientProfile> = {
  business: 'склады и отгрузки',
  premises: 'склад',
  inferred: ['premises'],
};
const P3: Partial<ClientProfile> = {
  ...P2,
  items: 'товар',
  packaging: 'паллеты и коробки',
  material: 'металл есть, жидкостей нет',
};
const P4: Partial<ClientProfile> = { ...P3, city: 'Алматы', itemCount: 'около 5000 в месяц' };
const P5: Partial<ClientProfile> = { ...P4, has1C: true };

function turn(reply: LlmScript['replies'][0], interest: InterestScript): LlmScript {
  return { replies: [reply], interests: [{ level: 'warm', ...interest }] };
}

/** Первые четыре реплики: вопросы группами, чат у бота. */
async function upToOneCQuestion(s: Scenario) {
  const turns = [
    await s.say(
      'Здравствуйте',
      turn({ outcome: 'answer', text: GREETING, companyQuestion: 'name' }, {}),
    ),
    await s.say(
      'Компания tyri, занимаемся складами и отгрузками как работает ваше оборудование',
      turn(HOW_IT_WORKS, { companyName: 'tyri', profile: P2 }),
    ),
    await s.say(
      'У нас полета и коробки с товаром. Метал имеется жидкости нет',
      turn(WHERE_AND_HOW_MANY, { profile: P3 }),
    ),
    await s.say('Алматы, около 5000 тысяч в месяц', turn(ONE_C, { profile: P4 })),
  ];
  return turns;
}

describe('диалог 29.10.2026 вечером: вопросы группами и передача по собранному минимуму', () => {
  it('вопросы группами проходят проверки кодом и уходят как есть, чат у бота', async () => {
    const s = createScenario();

    const turns = await upToOneCQuestion(s);

    expect(turns.map((t) => t.outcome)).toEqual(Array(4).fill({ kind: 'replied' }));
    expect(turns.map((t) => t.toClient)).toEqual([
      [GREETING],
      [HOW_IT_WORKS],
      [WHERE_AND_HOW_MANY],
      [ONE_C],
    ]);
    expect(turns.flatMap((t) => t.toManager)).toEqual([]);
    for (const text of [GREETING, HOW_IT_WORKS, WHERE_AND_HOW_MANY, ONE_C]) {
      expect(
        runCodeChecks(normalizeDraft(text), { ownPhone: '' as PhoneDigits, clientText: '' }),
      ).toEqual([]);
    }
  });

  it('«Да обычная 1с»: минимум собран, передача hot без вопроса цены, в уведомлении всё собранное', async () => {
    const s = createScenario();
    await upToOneCQuestion(s);

    const fifth = await s.say('Да обычная 1с', turn(MORE_QUESTIONS, { profile: P5 }));

    expect(fifth.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    // Клиент ничего не спросил: ответа из черновика нет, только фраза передачи; проверка не нужна.
    expect(fifth.toClient).toEqual([MINIMUM_HANDOFF_TEXT]);
    expect(fifth.llm.purposes()).toEqual(['reply', 'interest']);
    expect(s.storage.chats.getById(s.chatId())?.level).toBe('hot');
    expect(s.storage.handoffs.findOpen(s.chatId())?.reason).toBe('hot');
    expect(fifth.toManager).toHaveLength(1);
    const notice = fifth.toManager[0] ?? '';
    for (const line of [
      'клиент назвал «tyri»',
      'Бизнес: склады и отгрузки',
      'Вещи: товар',
      'Материал: металл есть, жидкостей нет',
      'Число вещей: около 5000 в месяц',
      'Город: Алматы',
      '1С: есть',
      'Не удалось выяснить: всё выяснено',
    ]) {
      expect(notice).toContain(line);
    }
  });

  it('после «Вернуть боту» собранный минимум сам чат больше не передаёт', async () => {
    const s = createScenario();
    await upToOneCQuestion(s);
    await s.say('Да обычная 1с', turn(MORE_QUESTIONS, { profile: P5 }));
    await s.returnToBot(turn('Не должно уйти: отвечать не на что.', { profile: P5 }));
    const answer =
      'Металл учитывают при выборе метки, решение под ваш товар подбирает коллега. Подскажите, как вы сейчас ведёте учёт?';

    const next = await s.say('А на металл метки клеятся?', turn(answer, { profile: P5 }));

    expect(next.outcome).toEqual({ kind: 'replied' });
    expect(next.toClient).toEqual([answer]);
    expect(next.toManager).toEqual([]);
    expect(s.storage.handoffs.findOpen(s.chatId())).toBeNull();
    expect(s.storage.chats.getById(s.chatId())?.control.status).toBe('bot');
  });

  it('клиент спросил что-то в последнем сообщении: ответ из черновика остаётся, затем фраза передачи', async () => {
    const s = createScenario();
    await upToOneCQuestion(s);
    const draft =
      'Да, мы проводим интеграцию с вашей 1С, детали зависят от конфигурации. Подскажите, как вы сейчас ведёте учёт?';

    const fifth = await s.say('Да обычная 1с. С ней интегрируется?', turn(draft, { profile: P5 }));

    expect(fifth.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(fifth.toClient).toEqual([
      `Да, мы проводим интеграцию с вашей 1С, детали зависят от конфигурации. ${MINIMUM_HANDOFF_TEXT}`,
    ]);
    // Сообщение передачи проверено вторым вызовом с подписью «сообщение о передаче».
    expect(fifth.llm.purposes()).toEqual(['reply', 'interest', 'review']);
    expect(fifth.data('review')).toContain('Черновик сообщения о передаче чата коллеге');
  });
});

describe('предел пять сообщений клиента (решение владельца 29.10.2026 вечером)', () => {
  it('реплики клиента из теста владельца как есть: минимума нет и к пятому сообщению, передача hot на пятом', async () => {
    const s = createScenario();
    const material = 'Подскажите, есть ли в товаре металл или жидкости?';
    const count =
      'Подскажите, в каком городе склад и сколько примерно паллет и коробок проходит через него за месяц?';
    const P3_ONLY: Partial<ClientProfile> = {
      ...P2,
      items: 'товар',
      packaging: 'паллеты и коробки',
    };
    const P4_ONLY: Partial<ClientProfile> = { ...P3_ONLY, material: 'металл есть, жидкостей нет' };
    const P5_ONLY: Partial<ClientProfile> = { ...P4_ONLY, itemCount: 'около 5000 в месяц' };

    const first = [
      await s.say(
        'Здравствуйте',
        turn({ outcome: 'answer', text: GREETING, companyQuestion: 'name' }, {}),
      ),
      await s.say(
        'Компания tyri, занимаемся складами и отгрузками как работает ваше оборудование',
        turn(HOW_IT_WORKS, { companyName: 'tyri', profile: P2 }),
      ),
      await s.say('У нас полета и коробки с товаром', turn(material, { profile: P3_ONLY })),
      await s.say('Метал имеется жидкости нет', turn(count, { profile: P4_ONLY })),
    ];
    const fifth = await s.say(
      'Около 5000 тысяч в месяц',
      turn('Подскажите, в каком городе склад и есть ли у вас 1С?', { profile: P5_ONLY }),
    );

    expect(first.map((t) => t.outcome)).toEqual(Array(4).fill({ kind: 'replied' }));
    expect(fifth.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(fifth.toClient).toEqual([CAP_HANDOFF_TEXT]);
    expect(s.storage.chats.getById(s.chatId())?.level).toBe('hot');
    const notice = fifth.toManager[0] ?? '';
    for (const line of [
      'клиент назвал «tyri»',
      'Вещи: товар',
      'Материал: металл есть, жидкостей нет',
      'Число вещей: около 5000 в месяц',
      'Не удалось выяснить: город, есть ли 1С',
    ]) {
      expect(notice).toContain(line);
    }
  });

  it('пять коротких сообщений без минимума: передача на пятом, на четвёртом ещё нет', async () => {
    const s = createScenario();
    const ask = 'Подскажите, какие вещи нужно учитывать и в чём они лежат?';
    const turns = [];
    for (const text of ['Здравствуйте', 'Интересно', 'Ну', 'Пока не знаю', 'Расскажите']) {
      turns.push(await s.say(text, turn(ask, {})));
    }

    expect(turns.slice(0, 4).map((t) => t.outcome)).toEqual(Array(4).fill({ kind: 'replied' }));
    expect(turns[4]?.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(turns[4]?.toClient).toEqual([CAP_HANDOFF_TEXT]);
    expect(turns[4]?.toManager[0]).toContain('Для оценки цены собрано: ничего');
  });
});
