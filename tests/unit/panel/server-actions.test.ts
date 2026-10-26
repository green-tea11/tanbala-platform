import { describe, expect, it } from 'vitest';
import { PanelSendError, PANEL_TEXT_MAX_LENGTH } from '../../../src/messaging/outbox.js';
import { chatIdOf, createHarness, makeChat, type Auth, type Harness } from './harness.js';

const MANAGER_CHAT = makeChat(1, { pushName: 'Алия', control: { status: 'manager', by: 'bot' } });
const BOT_CHAT = makeChat(2, { pushName: 'Бауыржан' });

interface Session {
  readonly h: Harness;
  readonly auth: Auth;
}

async function open(): Promise<Session> {
  const h = createHarness({ data: { chats: [MANAGER_CHAT, BOT_CHAT] } });
  return { h, auth: await h.login() };
}

async function reply(
  { h, auth }: Session,
  chat: number,
  text: string | null,
): Promise<Awaited<ReturnType<Harness['request']>>> {
  return h.request({
    url: `/chats/${String(chat)}/reply`,
    cookie: auth.cookie,
    form: text === null ? { csrf: auth.csrf } : { csrf: auth.csrf, text },
  });
}

describe('панель: ответ клиенту', () => {
  it('сначала передаёт чат менеджеру (человек подключился из панели), потом отправляет; возвращает на чат с пометкой', async () => {
    const s = await open();

    const response = await reply(s, 2, 'Добрый день, это менеджер');

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe('/chats/2?notice=sent');
    expect(s.h.handoff.handOff).toHaveBeenCalledWith(chatIdOf(2), {
      reason: 'human_took_over',
      by: 'panel',
    });
    expect(s.h.outbox.sendFromPanel).toHaveBeenCalledWith(chatIdOf(2), 'Добрый день, это менеджер');
    expect(s.h.actions()).toEqual(['handOff', 'sendFromPanel']);
    expect(s.h.chats.setStatus).not.toHaveBeenCalled();
  });

  it('аудит: строка в лог без текста сообщения, имени и номера', async () => {
    const s = await open();

    await reply(s, 2, 'Секретный текст ответа клиенту');

    expect(s.h.logs()).toContainEqual(expect.objectContaining({ action: 'reply', chatId: 2 }));
    const log = s.h.rawLog();
    expect(log).not.toContain('Секретный текст');
    expect(log).not.toContain('Бауыржан');
    expect(log).not.toMatch(/77\d{9}/);
  });

  it('переводы строк из браузера (CRLF) приводятся к LF', async () => {
    const s = await open();

    await reply(s, 2, 'Первая строка\r\nВторая строка\rТретья');

    expect(s.h.outbox.sendFromPanel).toHaveBeenCalledWith(
      chatIdOf(2),
      'Первая строка\nВторая строка\nТретья',
    );
  });

  it.each([
    ['пустой текст', ''],
    ['только пробелы и переводы строк', '  \r\n \t '],
  ])('%s: 422 с пояснением, чат не передаётся, ничего не отправляется', async (_label, text) => {
    const s = await open();

    const response = await reply(s, 2, text);

    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('Пустое сообщение не отправляется');
    expect(response.body).toContain('role="alert"');
    expect(s.h.actions()).toEqual([]);
  });

  it('поле text не пришло: как пустой текст', async () => {
    const s = await open();

    const response = await reply(s, 2, null);

    expect(response.statusCode).toBe(422);
    expect(s.h.actions()).toEqual([]);
  });

  it('слишком длинный текст: 422, текст остаётся в форме, чат не передаётся', async () => {
    const s = await open();
    const long = `<b>${'я'.repeat(PANEL_TEXT_MAX_LENGTH)}`;

    const response = await reply(s, 2, long);

    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('длиннее 4096');
    expect(response.body).toContain(`&lt;b&gt;${'я'.repeat(100)}`);
    expect(response.body).not.toContain('<b>');
    expect(s.h.actions()).toEqual([]);
  });

  it('чата нет: 404, ничего не вызывается', async () => {
    const s = await open();

    const response = await reply(s, 99, 'текст');

    expect(response.statusCode).toBe(404);
    expect(s.h.actions()).toEqual([]);
  });

  it.each(['abc', '0', '1.5'])('адрес чата «%s» неверен: 404 до обращения к базе', async (id) => {
    const { h, auth } = await open();

    const response = await h.request({
      url: `/chats/${id}/reply`,
      cookie: auth.cookie,
      form: { csrf: auth.csrf, text: 'текст' },
    });

    expect(response.statusCode).toBe(404);
    expect(h.chats.getById).not.toHaveBeenCalled();
    expect(h.actions()).toEqual([]);
  });

  it('отказ отправки с понятным текстом (закрытый режим): виден на странице, введённое сохранено', async () => {
    const s = await open();
    s.h.outbox.sendFromPanel.mockRejectedValueOnce(
      new PanelSendError('Закрытый режим: этот чат не из TEST_ALLOWLIST, сообщение не отправлено'),
    );

    const response = await reply(s, 2, 'Мой ответ <клиенту>');

    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('Закрытый режим: этот чат не из TEST_ALLOWLIST');
    expect(response.body).toContain('Мой ответ &lt;клиенту&gt;');
    expect(s.h.actions()).toEqual(['handOff', 'sendFromPanel']);
    expect(s.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'reply_failed', level: 40 }),
    );
  });

  it('сбой отправки: 502 с общей фразой без текста ошибки, подробности в логе без номеров и текста', async () => {
    const s = await open();
    s.h.outbox.sendFromPanel.mockRejectedValueOnce(new Error('нет связи с 77001234567'));

    const response = await reply(s, 2, 'Мой ответ');

    expect(response.statusCode).toBe(502);
    expect(response.body).toContain('Не удалось отправить сообщение');
    expect(response.body).not.toContain('нет связи');
    expect(response.body).not.toContain('77001234567');
    expect(response.body).toContain('Мой ответ');
    expect(s.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'reply_failed', level: 50 }),
    );
    expect(s.h.rawLog()).not.toContain('77001234567');
    expect(s.h.rawLog()).not.toContain('Мой ответ');
  });

  it('сбой передачи чата: 502, сообщение не отправляется', async () => {
    const s = await open();
    s.h.handoff.handOff.mockRejectedValueOnce(new Error('база недоступна'));

    const response = await reply(s, 2, 'Мой ответ');

    expect(response.statusCode).toBe(502);
    expect(s.h.outbox.sendFromPanel).not.toHaveBeenCalled();
  });

  it('после сбоя страница снова позволяет ответить: форма с токеном на месте', async () => {
    const s = await open();
    s.h.outbox.sendFromPanel.mockRejectedValueOnce(new Error('сбой'));

    const failed = await reply(s, 2, 'Первая попытка');
    const retry = await reply(s, 2, 'Первая попытка');

    expect(failed.body).toContain('action="/chats/2/reply"');
    expect(failed.body).toMatch(/name="csrf" value="[A-Za-z0-9_-]{43}"/);
    expect(retry.statusCode).toBe(303);
  });

  it('GET на адрес ответа не работает: действие только через POST с токеном', async () => {
    const { h, auth } = await open();

    const response = await h.request({ url: '/chats/2/reply', cookie: auth.cookie });

    expect(response.statusCode).toBe(404);
    expect(h.actions()).toEqual([]);
  });
});

describe('панель: возврат чата боту', () => {
  async function giveBack(s: Session, chat: number) {
    return s.h.request({
      url: `/chats/${String(chat)}/return`,
      cookie: s.auth.cookie,
      form: { csrf: s.auth.csrf },
    });
  }

  it('чат у менеджера: returnToBot, переход на чат с пометкой, аудит', async () => {
    const s = await open();

    const response = await giveBack(s, 1);

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe('/chats/1?notice=returned');
    expect(s.h.handoff.returnToBot).toHaveBeenCalledWith(chatIdOf(1));
    expect(s.h.chats.setStatus).not.toHaveBeenCalled();
    expect(s.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'return_to_bot', chatId: 1 }),
    );
    expect(s.h.rawLog()).not.toContain('Алия');
  });

  it('чат уже у бота (устаревшая страница): ничего не вызывается, пометка already_bot', async () => {
    const s = await open();

    const response = await giveBack(s, 2);

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe('/chats/2?notice=already_bot');
    expect(s.h.actions()).toEqual([]);
  });

  it('чата нет: 404', async () => {
    const s = await open();

    expect((await giveBack(s, 99)).statusCode).toBe(404);
    expect(s.h.actions()).toEqual([]);
  });

  it('сбой возврата: 502 с общей фразой, подробности в логе', async () => {
    const s = await open();
    s.h.handoff.returnToBot.mockRejectedValueOnce(new Error('сбой записи 77001234567'));

    const response = await giveBack(s, 1);

    expect(response.statusCode).toBe(502);
    expect(response.body).toContain('Не удалось вернуть чат боту');
    expect(response.body).not.toContain('сбой записи');
    expect(s.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'return_to_bot_failed', level: 50 }),
    );
    expect(s.h.rawLog()).not.toContain('77001234567');
  });

  it('GET на адрес возврата не работает', async () => {
    const { h, auth } = await open();

    const response = await h.request({ url: '/chats/1/return', cookie: auth.cookie });

    expect(response.statusCode).toBe(404);
    expect(h.actions()).toEqual([]);
  });
});
