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
