import { describe, expect, it, vi } from 'vitest';
import { PanelSendError, PANEL_TEXT_MAX_LENGTH } from '../../../src/messaging/outbox.js';
import {
  CONSOLE_USER,
  createConsoleHarness,
  jsonOf,
  type ConsoleHarness,
} from './console-harness.js';
import { chatIdOf, makeChat } from './harness.js';

// Действия API консоли: ответ клиенту и возврат боту — та же логика и тот же порядок вызовов, что у кнопок старой
// панели (panel/chat-actions.ts), одно окно дубля 10 секунд на обе панели.

const MANAGER_CHAT = makeChat(1, { pushName: 'Алия', control: { status: 'manager', by: 'bot' } });
const BOT_CHAT = makeChat(2, { pushName: 'Бауыржан' });
const TEXT = 'Добрый день, это менеджер';

function open(): ConsoleHarness {
  return createConsoleHarness({ data: { chats: [MANAGER_CHAT, BOT_CHAT] } });
}

function reply(c: ConsoleHarness, chat: number | string, body: unknown) {
  return c.request({ url: `/internal/console/chats/${String(chat)}/reply`, body });
}

function returnToBot(c: ConsoleHarness, chat: number | string, body: unknown) {
  return c.request({ url: `/internal/console/chats/${String(chat)}/return`, body });
}

describe('API консоли: ответ клиенту', () => {
  it('передача менеджеру, затем отправка; {result: "sent"}', async () => {
    const c = open();

    const response = await reply(c, 2, { text: TEXT });

    expect(response.statusCode).toBe(200);
    expect(jsonOf(response)).toEqual({ result: 'sent' });
    expect(c.h.handoff.handOff).toHaveBeenCalledWith(chatIdOf(2), {
      reason: 'human_took_over',
      by: 'panel',
    });
    expect(c.h.outbox.sendFromPanel).toHaveBeenCalledWith(chatIdOf(2), TEXT);
    expect(c.h.actions()).toEqual(['handOff', 'sendFromPanel']);
  });

  it('журнал: строка reply с именем пользователя консоли и ID чата, без текста, имени и номера', async () => {
    const c = open();

    await reply(c, 2, { text: 'Секретный текст ответа' });

    expect(c.h.logs()).toContainEqual(
      expect.objectContaining({
        module: 'console-api',
        action: 'reply',
        user: CONSOLE_USER,
        chatId: 2,
        level: 30,
      }),
    );
    const log = c.h.rawLog();
    expect(log).not.toContain('Секретный');
    expect(log).not.toContain('Бауыржан');
    expect(log).not.toMatch(/77\d{9}/);
  });

  it('переводы строк CRLF приводятся к LF', async () => {
    const c = open();

    await reply(c, 2, { text: 'Первая\r\nВторая\rТретья' });

    expect(c.h.outbox.sendFromPanel).toHaveBeenCalledWith(chatIdOf(2), 'Первая\nВторая\nТретья');
  });

  it.each([
    ['пустой текст', '', 'Пустое сообщение не отправляется'],
    ['только пробелы', ' \r\n\t ', 'Пустое сообщение не отправляется'],
    ['длинный текст', 'я'.repeat(PANEL_TEXT_MAX_LENGTH + 1), 'длиннее 4096'],
  ])('%s: 422 refused, чат не передаётся, строка в журнале', async (_label, text, message) => {
    const c = open();

    const response = await reply(c, 2, { text });

    expect(response.statusCode).toBe(422);
    expect(jsonOf(response)['error']).toBe('refused');
    expect(jsonOf(response)['message']).toContain(message);
    expect(c.h.actions()).toEqual([]);
    expect(c.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'reply_refused', user: CONSOLE_USER, chatId: 2 }),
    );
  });

  it.each([
    ['нет поля text', {}],
    ['text не строка', { text: 5 }],
    ['text null', { text: null }],
  ])('%s: 400 bad_request, ничего не вызывается', async (_label, body) => {
    const c = open();

    const response = await reply(c, 2, body);

    expect(response.statusCode).toBe(400);
    expect(c.h.outbox.canSendFromPanel).not.toHaveBeenCalled();
    expect(c.h.actions()).toEqual([]);
  });

  it('закрытый режим или WhatsApp не подключён: 422 refused с текстом старой панели, статус не менялся', async () => {
    const c = open();
    c.h.outbox.canSendFromPanel.mockReturnValue(false);

    const response = await reply(c, 2, { text: TEXT });

    expect(response.statusCode).toBe(422);
    expect(jsonOf(response)).toEqual({
      error: 'refused',
      message:
        'Ответ не отправлен, статус чата не менялся: чат не из TEST_ALLOWLIST (закрытый режим) или WhatsApp не подключён.',
    });
    expect(c.h.actions()).toEqual([]);
    expect(c.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'reply_blocked', user: CONSOLE_USER }),
    );
  });

  it('отказ самой отправки (PanelSendError): 422 с его текстом и тем, что чат уже у менеджера', async () => {
    const c = open();
    c.h.outbox.sendFromPanel.mockRejectedValueOnce(
      new PanelSendError('Закрытый режим: этот чат не из TEST_ALLOWLIST'),
    );

    const response = await reply(c, 2, { text: TEXT });

    expect(response.statusCode).toBe(422);
    expect(jsonOf(response)['message']).toBe(
      'Закрытый режим: этот чат не из TEST_ALLOWLIST. Чат уже у менеджера, бот в нём молчит.',
    );
    expect(c.h.actions()).toEqual(['handOff', 'sendFromPanel']);
  });

  it('сбой отправки после передачи: 502 send_failed «Чат уже у менеджера», текст ошибки не уходит', async () => {
    const c = open();
    c.h.outbox.sendFromPanel.mockRejectedValueOnce(new Error('нет связи с 77001234567'));

    const response = await reply(c, 1, { text: TEXT });

    expect(response.statusCode).toBe(502);
    expect(jsonOf(response)).toEqual({
      error: 'send_failed',
      message: 'Не отправлено. Чат уже у менеджера, бот в нём молчит.',
    });
    expect(response.body).not.toContain('77001234567');
    expect(c.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'reply_failed', level: 50 }),
    );
    expect(c.h.rawLog()).not.toContain('77001234567');
  });

  it('сбой передачи (чат остался у бота): 502 send_failed «Статус чата не менялся», отправки нет', async () => {
    const c = open();
    c.h.handoff.handOff.mockRejectedValueOnce(new Error('база недоступна'));

    const response = await reply(c, 2, { text: TEXT });

    expect(response.statusCode).toBe(502);
    expect(jsonOf(response)['message']).toBe('Не отправлено. Статус чата не менялся.');
    expect(c.h.outbox.sendFromPanel).not.toHaveBeenCalled();
  });

  it('после сбоя тот же текст можно отправить сразу: отметка дубля снята', async () => {
    const c = open();
    c.h.outbox.sendFromPanel.mockRejectedValueOnce(new Error('сбой'));

    await reply(c, 2, { text: TEXT });
    const retry = await reply(c, 2, { text: TEXT });

    expect(jsonOf(retry)).toEqual({ result: 'sent' });
  });

  it.each(['99', 'abc', '0'])('чата «%s» нет: 404 not_found, ничего не вызывается', async (id) => {
    const c = open();

    const response = await reply(c, id, { text: TEXT });

    expect(response.statusCode).toBe(404);
    expect(jsonOf(response)['error']).toBe('not_found');
    expect(c.h.outbox.canSendFromPanel).not.toHaveBeenCalled();
    expect(c.h.actions()).toEqual([]);
  });

  it('GET на адрес ответа: 404, действие только POST', async () => {
    const c = open();

    const response = await c.request({ url: '/internal/console/chats/2/reply' });

    expect(response.statusCode).toBe(404);
    expect(c.h.actions()).toEqual([]);
  });
});

describe('API консоли: окно дубля 10 секунд', () => {
  it('повтор того же текста: {result: "duplicate"}, без передачи и отправки; через 10 секунд снова уходит', async () => {
    const c = open();

    await reply(c, 2, { text: TEXT });
    c.h.advance(9_999);
    const early = await reply(c, 2, { text: `  ${TEXT} ` });
    c.h.advance(1);
    const later = await reply(c, 2, { text: TEXT });

    expect(jsonOf(early)).toEqual({ result: 'duplicate' });
    expect(jsonOf(later)).toEqual({ result: 'sent' });
    expect(c.h.outbox.sendFromPanel).toHaveBeenCalledTimes(2);
    expect(c.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'reply_duplicate', user: CONSOLE_USER }),
    );
  });

  it('одновременные одинаковые запросы: проходит один', async () => {
    const c = open();
    let finish: () => void = () => undefined;
    c.h.handoff.handOff.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    const first = reply(c, 2, { text: TEXT });
    await vi.waitFor(() => expect(c.h.handoff.handOff).toHaveBeenCalledTimes(1));
    const second = await reply(c, 2, { text: TEXT });
    finish();

    expect(jsonOf(second)).toEqual({ result: 'duplicate' });
    expect(jsonOf(await first)).toEqual({ result: 'sent' });
    expect(c.h.actions()).toEqual(['handOff', 'sendFromPanel']);
  });

  it('ответ из старой панели, затем тот же текст из консоли: дубль', async () => {
    const c = open();

    const html = await c.panelPost('/chats/2/reply', { text: TEXT });
    const json = await reply(c, 2, { text: TEXT });

    expect(html.headers['location']).toBe('/chats/2?notice=sent');
    expect(jsonOf(json)).toEqual({ result: 'duplicate' });
    expect(c.h.outbox.sendFromPanel).toHaveBeenCalledTimes(1);
  });

  it('ответ из консоли, затем та же форма старой панели: дубль', async () => {
    const c = open();

    await reply(c, 2, { text: TEXT });
    const html = await c.panelPost('/chats/2/reply', { text: TEXT });

    expect(html.headers['location']).toBe('/chats/2?notice=duplicate');
    expect(c.h.outbox.sendFromPanel).toHaveBeenCalledTimes(1);
  });
});

describe('API консоли: возврат боту', () => {
  it('возврат с заметкой: {result: "returned"}, заметка очищена, затем ответ бота на неотвеченное', async () => {
    const c = open();

    const response = await returnToBot(c, 1, {
      note: 'Ответ клиенту: ориентир от X\r\n\r\n\r\nЗадание боту: узнай 1С\u200b',
    });

    expect(jsonOf(response)).toEqual({ result: 'returned', resumed: 0 });
    expect(c.h.handoff.returnToBot).toHaveBeenCalledWith(
      chatIdOf(1),
      'Ответ клиенту: ориентир от X\n\nЗадание боту: узнай 1С',
    );
    expect(c.h.actions()).toEqual(['returnToBot', 'resume']);
    expect(c.h.logs()).toContainEqual(
      expect.objectContaining({
        action: 'return_to_bot',
        user: CONSOLE_USER,
        chatId: 1,
        note: true,
        resumed: 0,
      }),
    );
    expect(c.h.rawLog()).not.toContain('ориентир');
  });

  it('без поля note и с пустой заметкой: заметки нет (null)', async () => {
    const c = open();

    await returnToBot(c, 1, {});
    await returnToBot(c, 1, { note: '   ' });

    expect(c.h.handoff.returnToBot).toHaveBeenNthCalledWith(1, chatIdOf(1), null);
    expect(c.h.handoff.returnToBot).toHaveBeenNthCalledWith(2, chatIdOf(1), null);
  });

  it('бот ответит на неотвеченное: returned_answering и число сообщений', async () => {
    const c = open();
    c.h.resume.mockReturnValue(2);

    const response = await returnToBot(c, 1, { note: '' });

    expect(jsonOf(response)).toEqual({ result: 'returned_answering', resumed: 2 });
  });

  it('чат уже у бота: already_bot с пояснением, заметка не сохраняется, ничего не вызывается', async () => {
    const c = open();

    const response = await returnToBot(c, 2, { note: 'Задание' });

    expect(response.statusCode).toBe(200);
    expect(jsonOf(response)).toEqual({
      result: 'already_bot',
      message: 'Чат уже ведёт бот: заметка не сохранена.',
    });
    expect(c.h.actions()).toEqual([]);
    expect(c.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'return_already_bot', user: CONSOLE_USER }),
    );
  });

  it('заметка длиннее 1000 символов: 422 refused, чат остаётся у менеджера', async () => {
    const c = open();

    const response = await returnToBot(c, 1, { note: 'я'.repeat(1001) });

    expect(response.statusCode).toBe(422);
    expect(jsonOf(response)).toEqual({
      error: 'refused',
      message: 'Заметка длиннее 1000 символов: сократите её',
    });
    expect(c.h.actions()).toEqual([]);
  });

  it('ровно 1000 символов можно', async () => {
    const c = open();

    expect(jsonOf(await returnToBot(c, 1, { note: 'я'.repeat(1000) }))['result']).toBe('returned');
  });

  it('сбой возврата: 502 return_failed, бот не отвечает; ошибка в журнал', async () => {
    const c = open();
    c.h.handoff.returnToBot.mockRejectedValueOnce(new Error('база'));

    const response = await returnToBot(c, 1, { note: '' });

    expect(response.statusCode).toBe(502);
    expect(jsonOf(response)).toEqual({
      error: 'return_failed',
      message: 'Не удалось вернуть чат боту. Подробности записаны в лог бота.',
    });
    expect(c.h.resume).not.toHaveBeenCalled();
    expect(c.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'return_to_bot_failed', level: 50 }),
    );
  });

  it('сбой ответа бота после возврата возврат не отменяет', async () => {
    const c = open();
    c.h.resume.mockImplementationOnce(() => {
      throw new RangeError('очередь');
    });

    const response = await returnToBot(c, 1, { note: '' });

    expect(jsonOf(response)).toEqual({ result: 'returned', resumed: 0 });
    expect(c.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'resume_failed', errorName: 'RangeError' }),
    );
  });

  it.each([
    ['note число', { note: 1 }],
    ['note null', { note: null }],
  ])('%s: 400 bad_request', async (_label, body) => {
    const c = open();

    expect((await returnToBot(c, 1, body)).statusCode).toBe(400);
    expect(c.h.actions()).toEqual([]);
  });

  it('чата нет: 404', async () => {
    const c = open();

    const response = await returnToBot(c, 9, { note: '' });

    expect(response.statusCode).toBe(404);
    expect(c.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'chat_not_found', chatId: 9 }),
    );
  });
});

describe('API консоли и старая панель: одинаковые вызовы', () => {
  type Scenario = readonly [
    label: string,
    setup: (c: ConsoleHarness) => void,
    path: 'reply' | 'return',
    chat: number,
    value: string,
  ];

  const SCENARIOS: readonly Scenario[] = [
    ['ответ', () => undefined, 'reply', 2, TEXT],
    [
      'ответ в закрытый чат',
      (c) => c.h.outbox.canSendFromPanel.mockReturnValue(false),
      'reply',
      2,
      TEXT,
    ],
    ['пустой ответ', () => undefined, 'reply', 2, '  '],
    [
      'ответ со сбоем отправки',
      (c) => c.h.outbox.sendFromPanel.mockRejectedValue(new Error('x')),
      'reply',
      1,
      TEXT,
    ],
    [
      'ответ со сбоем передачи',
      (c) => c.h.handoff.handOff.mockRejectedValue(new Error('x')),
      'reply',
      2,
      TEXT,
    ],
    ['возврат', () => undefined, 'return', 1, 'Задание'],
    ['возврат с ответом бота', (c) => c.h.resume.mockReturnValue(1), 'return', 1, ''],
    ['возврат чата у бота', () => undefined, 'return', 2, 'Задание'],
    ['возврат с длинной заметкой', () => undefined, 'return', 1, 'я'.repeat(1001)],
    [
      'возврат со сбоем',
      (c) => c.h.handoff.returnToBot.mockRejectedValue(new Error('x')),
      'return',
      1,
      '',
    ],
  ];

  /** Вызовы зависимостей действия по порядку, с аргументами. */
  function callsOf(c: ConsoleHarness): unknown[] {
    const tagged = [
      ['canSendFromPanel', c.h.outbox.canSendFromPanel],
      ['handOff', c.h.handoff.handOff],
      ['sendFromPanel', c.h.outbox.sendFromPanel],
      ['returnToBot', c.h.handoff.returnToBot],
      ['resume', c.h.resume],
    ] as const;
    return tagged
      .flatMap(([name, mock]) =>
        mock.mock.calls.map((args, index) => ({
          name,
          args,
          order: mock.mock.invocationCallOrder[index] ?? 0,
        })),
      )
      .sort((a, b) => a.order - b.order)
      .map(({ name, args }) => [name, ...args]);
  }

  it.each(SCENARIOS)(
    '%s: те же функции, те же аргументы, тот же порядок',
    async (_label, setup, path, chat, value) => {
      const viaHtml = open();
      setup(viaHtml);
      await viaHtml.panelPost(
        `/chats/${String(chat)}/${path}`,
        path === 'reply' ? { text: value } : { note: value },
      );
      const viaJson = open();
      setup(viaJson);
      await viaJson.request({
        url: `/internal/console/chats/${String(chat)}/${path}`,
        body: path === 'reply' ? { text: value } : { note: value },
      });

      expect(callsOf(viaJson)).toEqual(callsOf(viaHtml));
    },
  );
});
