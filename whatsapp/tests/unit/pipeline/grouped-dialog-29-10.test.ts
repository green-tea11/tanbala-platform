import { describe, expect, it } from 'vitest';
import type { ClientProfile } from '../../../src/domain/types.js';
import { runCodeChecks, normalizeDraft } from '../../../src/checks/code-checks.js';
import type { PhoneDigits } from '../../../src/domain/types.js';
import { createScenario, type Scenario } from './company-scenarios-harness.js';
import type { InterestScript, LlmScript } from './scripted-llm.js';

// Тест владельца с телефона 29.10.2026 вечером (клиент «tyri», склады и отгрузки) на моках: вопросы группами проходят
// проверки кодом. Передачу по собранному минимуму и по пятому сообщению владелец отменил 30.10.2026: бот ведёт разговор
// до финала (pipeline/live-dialog-30-10.test.ts).
// Реплики клиента идут через очередь склейки, конвейер, настоящие агент, проверки кодом, передачу и базу; поддельные
// только модель, WhatsApp и проект B (компанию не находит).

const GREETING = 'Здравствуйте! Подскажите, как называется ваша компания и чем она занимается?';
const HOW_IT_WORKS =
  'Метку клеят на вещь, а ридеры на входах и выходах сами отмечают приход и уход, сканировать по одной не нужно. Подскажите, какие вещи нужно учитывать, в чём они лежат (коробки, паллеты или поштучно) и есть ли среди них металл или жидкости?';
const WHERE_AND_HOW_MANY =
  'Подскажите, в каком городе склад и сколько примерно паллет и коробок проходит через него за месяц?';
const ONE_C = 'Подскажите, есть ли у вас 1С и какая?';

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

describe('диалог 29.10.2026 вечером: вопросы группами', () => {
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

  it('«Да обычная 1с»: старый минимум собран, но чат не передаётся (решение владельца 30.10.2026), бот ведёт разговор', async () => {
    const s = createScenario();
    await upToOneCQuestion(s);
    const next =
      'Интеграцию с вашей 1С делает наш сотрудник, детали зависят от конфигурации. Расскажите, сколько проходов нужно учитывать?';

    const fifth = await s.say('Да обычная 1с', turn(next, { profile: P5 }));

    expect(fifth.outcome).toEqual({ kind: 'replied' });
    expect(fifth.toClient).toEqual([next]);
    expect(fifth.toManager).toEqual([]);
    expect(s.storage.handoffs.findOpen(s.chatId())).toBeNull();
    expect(s.storage.chats.getById(s.chatId())?.level).toBe('warm');
  });
});

describe('пять сообщений клиента без передачи (решение владельца 30.10.2026: предела сообщений нет)', () => {
  it('пять коротких сообщений: на каждое бот отвечает, менеджеру ничего', async () => {
    const s = createScenario();
    const ask = 'Расскажите, что у вас лежит на хранении и в каком виде?';
    const turns = [];
    for (const text of ['Здравствуйте', 'Интересно', 'Ну', 'Пока не знаю', 'Расскажите']) {
      turns.push(await s.say(text, turn(ask, {})));
    }

    expect(turns.map((t) => t.outcome)).toEqual(Array(5).fill({ kind: 'replied' }));
    expect(turns.flatMap((t) => t.toManager)).toEqual([]);
  });
});

describe('«вы нам писали на почту» (решение владельца 29.10.2026 вечером)', () => {
  /** Черновик из теста владельца: фраза об ориентире без вопроса цены, письмо проигнорировано. */
  const OLD_DRAFT =
    'Здравствуйте! Ориентир коллега назовёт, когда поймём вашу задачу. Подскажите, какие именно вещи нужно учитывать?';
  const LETTER = 'Здравствуйте! Найду письмо, подскажите, из какой вы компании?';

  it('бот здоровается, обещает найти письмо и спрашивает компанию; фраза об ориентире отклонена кодом', async () => {
    const s = createScenario();

    const first = await s.say('Здравствуйте вы нам писали на почту', {
      replies: [OLD_DRAFT, { outcome: 'answer', text: LETTER, companyQuestion: 'name' }],
      interests: [{ level: 'cold' }],
    });

    expect(first.outcome).toEqual({ kind: 'replied' });
    expect(first.toClient).toEqual([LETTER]);
    expect(first.toClient.join(' ')).not.toMatch(/Ориентир/);
    expect(first.llm.purposes()).toEqual(['interest', 'reply', 'reply', 'review']);
    const rejected = s.storage.rejectedDrafts.listForChat(s.chatId(), 10);
    expect(rejected.map(({ source, draft }) => ({ source, draft }))).toEqual([
      { source: 'code', draft: OLD_DRAFT },
    ]);
    expect(rejected[0]?.remarks.join(' ')).toMatch(/только когда клиент спрашивает цену/);
    // Вопрос о компании запомнен: второй раз его не зададут.
    expect(s.state().nameAskedAtMs).not.toBeNull();
  });

  it('правило о письме есть в инструкции ответа', async () => {
    const s = createScenario();

    const first = await s.say('Здравствуйте вы нам писали на почту', {
      replies: [{ outcome: 'answer', text: LETTER, companyQuestion: 'name' }],
    });

    const reply = first.llm.requests.find((request) => request.purpose === 'reply');
    const system = reply?.system.map((block) => block.text).join('\n') ?? '';
    expect(system).toContain(
      'Клиент пишет, что получил наше письмо: поздоровайся, скажи, что найдёшь письмо, и, если данные не запрещают, спроси, из какой он компании.',
    );
  });
});
