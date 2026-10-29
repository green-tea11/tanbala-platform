import { describe, expect, it } from 'vitest';
import { createScenario } from './company-scenarios-harness.js';

// Возврат чата боту (решение владельца 29.10.2026) на уровне конвейера: после «Вернуть боту» бот отвечает на сообщения
// клиента, пришедшие после последнего исходящего (бота или менеджера) и не старше 12 часов. Если после них менеджер
// уже ответил, бот молчит. Модель, WhatsApp и проект B поддельные: 0 токенов, без сети.

const HOUR_MS = 60 * 60 * 1000;
const ASK = 'Учёт подбираем под задачу. Что вы храните?';
const LATER =
  'Да, мы проводим интеграцию с вашей 1С. Что нужно учитывать: ввоз и вывоз или место каждой вещи?';

describe('сценарии владельца 29.10.2026: возврат боту', () => {
  it('без заметки: бот отвечает на сообщение, пришедшее, пока чат был у менеджера', async () => {
    const s = createScenario({ api: null });
    await s.say('Здравствуйте', { replies: [ASK] });
    await s.say('Позовите менеджера', { replies: [{ outcome: 'asked_human' }] });
    const waiting = await s.say('А с 1С вы работаете?', { replies: [LATER] });

    const back = await s.returnToBot({ replies: [LATER] });

    expect(waiting.outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(waiting.toClient).toEqual([]);
    expect(back.outcome).toEqual({ kind: 'replied' });
    expect(back.toClient).toEqual([LATER]);
    expect(back.llm.purposes()).toEqual(['reply', 'interest', 'review']);
    expect(s.storage.chats.getById(s.chatId())?.control).toEqual({ status: 'bot', by: 'panel' });
  });

  it('клиент написал после фразы передачи, менеджер не ответил: бот отвечает одним ответом на всю пачку', async () => {
    const s = createScenario({ api: null });
    await s.say('Позовите человека', { replies: [{ outcome: 'asked_human' }] });
    await s.say('Алло?', { replies: [ASK] });
    await s.say('Есть кто-нибудь?', { replies: [ASK] });

    const back = await s.returnToBot({ replies: [ASK] });

    expect(back.toClient).toEqual([ASK]);
    const reply = back.llm.requests.find((request) => request.purpose === 'reply');
    expect(reply?.turns.at(-1)?.text).toContain('Алло?');
    expect(reply?.turns.at(-1)?.text).toContain('Есть кто-нибудь?');
  });

  it('менеджер уже ответил после сообщения клиента: бот молчит, модель не вызывается', async () => {
    const s = createScenario({ api: null });
    await s.say('Позовите менеджера', { replies: [{ outcome: 'asked_human' }] });
    await s.say('Сколько ждать?', { replies: [ASK] });
    await s.managerWrites('Добрый день, это менеджер, сейчас посмотрю');

    const back = await s.returnToBot({ replies: [ASK] });

    expect(back.toClient).toEqual([]);
    expect(back.llm.requests).toEqual([]);
    expect(back.outcome).toBeNull();
  });

  it('сообщение старше 12 часов: бот на него не отвечает и модель не вызывает', async () => {
    const s = createScenario({ api: null });
    await s.say('Позовите менеджера', { replies: [{ outcome: 'asked_human' }] });
    await s.say('Жду ответа', { replies: [ASK] });
    s.advance(13 * HOUR_MS);

    const back = await s.returnToBot({ replies: [ASK] });

    expect(back.toClient).toEqual([]);
    expect(back.llm.requests).toEqual([]);
  });

  it('отвечать не на что (после фразы передачи клиент молчал): после возврата бот молчит до нового сообщения', async () => {
    const s = createScenario({ api: null });
    await s.say('Позовите менеджера', { replies: [{ outcome: 'asked_human' }] });

    const back = await s.returnToBot({ replies: [ASK] });
    const next = await s.say('Здравствуйте ещё раз', { replies: [ASK] });

    expect(back.toClient).toEqual([]);
    expect(next.toClient).toEqual([ASK]);
  });
});

describe('возврат боту: ответ менеджера из панели (то же правило, что с телефона)', () => {
  it('менеджер ответил из панели после сообщения клиента: бот молчит, модель не вызывается', async () => {
    const s = createScenario({ api: null });
    await s.say('Позовите менеджера', { replies: [{ outcome: 'asked_human' }] });
    await s.say('Сколько ждать?', { replies: [ASK] });
    await s.managerWritesFromPanel('Добрый день, это менеджер, сейчас посмотрю');

    const back = await s.returnToBot({ replies: [ASK] });

    expect(back.toClient).toEqual([]);
    expect(back.llm.requests).toEqual([]);
    expect(back.outcome).toBeNull();
  });
});

// Возврат с заметкой после фразы передачи (ревью 29.10.2026, ждёт подтверждения владельца): клиент спросил цену, бот
// ответил фразой передачи, клиент молчит, менеджер возвращает чат с заметкой. Бот возвращается к сообщениям, на которые
// ответила фраза, обычным путём: проверки кодом и Haiku, лимиты, очередь чата.
describe('возврат боту с заметкой, когда клиент молчал после фразы передачи', () => {
  const PRICE_NOTE = 'Ориентир от 1 500 000 тенге, нужен выезд';
  const TASK_NOTE = 'Узнай количество вещей и какая у них 1С';
  const PRICE_PHRASE = 'Цена сильно зависит от объёма. Уточню у коллеги и вернусь к вам.';
  const PRICE_REPLY = 'Коллега подсказал: ориентир от 1 500 000 тенге, нужен выезд на склад.';
  const ASK_COUNT =
    'Чтобы коллега точнее назвал ориентир, подскажите, сколько примерно вещей нужно учитывать?';

  /** Клиент спросил цену и отказался отвечать: бот передал чат фразой о цене. Клиент больше не пишет. */
  async function handedOffOnPrice() {
    const s = createScenario({ api: null });
    const asked = await s.say('Сколько стоит учёт на складе? Без подробностей, просто цену', {
      replies: [{ outcome: 'hot', aboutPrice: true }],
      interests: [{ priceAsked: true, refused: true }],
    });
    expect(asked.toClient).toEqual([PRICE_PHRASE]);
    return s;
  }

  it('заметка с ценой: один ответ ровно с суммой из заметки', async () => {
    const s = await handedOffOnPrice();

    const back = await s.returnToBot({ replies: [PRICE_REPLY] }, PRICE_NOTE);

    expect(back.outcome).toEqual({ kind: 'replied' });
    expect(back.toClient).toEqual([PRICE_REPLY]);
    expect(back.toClient[0]).toContain('1 500 000 тенге');
    expect(back.llm.purposes()).toEqual(['reply', 'interest', 'review']);
  });

  it('заметка с ценой, а модель назвала другую сумму: она клиенту не уходит', async () => {
    const s = await handedOffOnPrice();

    const back = await s.returnToBot(
      { replies: ['Коллега подсказал: ориентир от 1 млн тенге.', PRICE_REPLY] },
      PRICE_NOTE,
    );

    expect(back.toClient).toEqual([PRICE_REPLY]);
  });

  it('заметка-задание: один ответ с одним вопросом', async () => {
    const s = await handedOffOnPrice();

    const back = await s.returnToBot({ replies: [ASK_COUNT] }, TASK_NOTE);

    expect(back.toClient).toEqual([ASK_COUNT]);
    expect(back.toClient[0]?.match(/\?/gu)).toHaveLength(1);
  });

  it('без заметки: бот молчит, модель не вызывается', async () => {
    const s = await handedOffOnPrice();

    const back = await s.returnToBot({ replies: [PRICE_REPLY] });

    expect(back.toClient).toEqual([]);
    expect(back.llm.requests).toEqual([]);
  });

  it.each([
    [
      'из панели',
      (s: Awaited<ReturnType<typeof handedOffOnPrice>>) =>
        s.managerWritesFromPanel('Посчитаю и напишу'),
    ],
    [
      'с телефона',
      (s: Awaited<ReturnType<typeof handedOffOnPrice>>) => s.managerWrites('Посчитаю и напишу'),
    ],
  ])('менеджер написал %s после фразы передачи: бот молчит и с заметкой', async (_how, write) => {
    const s = await handedOffOnPrice();
    await write(s);

    const back = await s.returnToBot({ replies: [PRICE_REPLY] }, PRICE_NOTE);

    expect(back.toClient).toEqual([]);
    expect(back.llm.requests).toEqual([]);
  });

  it('фраза передачи старше 12 часов: бот молчит', async () => {
    const s = await handedOffOnPrice();
    s.advance(13 * HOUR_MS);

    const back = await s.returnToBot({ replies: [PRICE_REPLY] }, PRICE_NOTE);

    expect(back.toClient).toEqual([]);
  });

  it('повторный возврат после ответа бота ничего не повторяет', async () => {
    const s = await handedOffOnPrice();
    await s.returnToBot({ replies: [PRICE_REPLY] }, PRICE_NOTE);
    await s.say('Позовите менеджера', { replies: [{ outcome: 'asked_human' }] });
    await s.managerWritesFromPanel('Добрый день');

    const again = await s.returnToBot({ replies: [PRICE_REPLY] }, PRICE_NOTE);

    expect(again.toClient).toEqual([]);
  });
});

describe('возврат боту: голосовое, пришедшее, пока чат был у менеджера (ревью 29.10.2026)', () => {
  it('голосовое без расшифровки: после возврата фраза про голосовое, модель не вызывается', async () => {
    const s = createScenario({ api: null });
    await s.say('Позовите менеджера', { replies: [{ outcome: 'asked_human' }] });
    const voice = await s.sayVoice({ replies: [ASK] });

    const back = await s.returnToBot({ replies: [ASK] });

    expect(voice.outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(back.outcome).toEqual({ kind: 'voice_notice' });
    expect(back.toClient).toEqual([
      'Сейчас не могу прослушать голосовое, напишите, пожалуйста, текстом',
    ]);
    expect(back.llm.requests).toEqual([]);
  });
});
