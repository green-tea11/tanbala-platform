import { describe, expect, it, vi } from 'vitest';
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

  it('чат закрыт для отправки (закрытый режим): 422 с понятным текстом, введённое сохранено, чат не передаётся, ничего не уходит', async () => {
    const s = await open();
    s.h.outbox.canSendFromPanel.mockReturnValue(false);

    const response = await reply(s, 2, 'Мой ответ <клиенту>');

    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('role="alert"');
    expect(response.body).toContain('закрытый режим');
    expect(response.body).toContain('статус чата не менялся');
    expect(response.body).toContain('Мой ответ &lt;клиенту&gt;');
    expect(s.h.outbox.canSendFromPanel).toHaveBeenCalledWith(chatIdOf(2));
    expect(s.h.actions()).toEqual([]);
    expect(s.h.chats.setStatus).not.toHaveBeenCalled();
  });

  it('допустимость чата проверяется до передачи менеджеру: порядок вызовов', async () => {
    const s = await open();

    await reply(s, 2, 'Добрый день');

    const firstOrder = (mock: { mock: { invocationCallOrder: number[] } }): number =>
      mock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    expect(s.h.outbox.canSendFromPanel).toHaveBeenCalledTimes(1);
    expect(s.h.handoff.handOff).toHaveBeenCalledTimes(1);
    expect(firstOrder(s.h.outbox.canSendFromPanel)).toBeLessThan(firstOrder(s.h.handoff.handOff));
  });

  it('отказ из-за закрытого чата в аудите: строка без текста сообщения, имени и номера', async () => {
    const s = await open();
    s.h.outbox.canSendFromPanel.mockReturnValue(false);

    await reply(s, 2, 'Секретный текст ответа клиенту');

    expect(s.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'reply_blocked', chatId: 2, level: 40 }),
    );
    const log = s.h.rawLog();
    expect(log).not.toContain('Секретный текст');
    expect(log).not.toContain('Бауыржан');
    expect(log).not.toMatch(/77\d{9}/);
  });

  it('текст проверяется раньше чата: пустое сообщение в закрытом чате получает отказ по тексту', async () => {
    const s = await open();
    s.h.outbox.canSendFromPanel.mockReturnValue(false);

    const response = await reply(s, 2, '   ');

    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('Пустое сообщение не отправляется');
    expect(s.h.actions()).toEqual([]);
  });

  it('отказ самой отправки с понятным текстом (вторая линия защиты после проверки чата): виден на странице, введённое сохранено', async () => {
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

describe('панель: ответ клиенту, повтор той же формы', () => {
  const DUPLICATE_LOCATION = '/chats/2?notice=duplicate';
  const TEXT = 'Добрый день, это менеджер';

  it('двойная отправка формы: повтор не передаёт чат, не отправляет, ведёт на страницу с пометкой', async () => {
    const s = await open();

    const first = await reply(s, 2, TEXT);
    const second = await reply(s, 2, TEXT);

    expect(first.headers['location']).toBe('/chats/2?notice=sent');
    expect(second.statusCode).toBe(303);
    expect(second.headers['location']).toBe(DUPLICATE_LOCATION);
    expect(s.h.actions()).toEqual(['handOff', 'sendFromPanel']);
    expect(s.h.outbox.sendFromPanel).toHaveBeenCalledTimes(1);
  });

  it('страница по ссылке повтора говорит «Это сообщение уже отправлено»', async () => {
    const s = await open();
    await reply(s, 2, TEXT);
    const second = await reply(s, 2, TEXT);

    const page = await s.h.request({
      url: String(second.headers['location']),
      cookie: s.auth.cookie,
    });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Это сообщение уже отправлено');
  });

  it('повтор приходит, пока первый ответ ещё в работе (двойной щелчок): отклоняется, первый доходит до конца', async () => {
    const s = await open();
    let finishHandOff: () => void = () => undefined;
    s.h.handoff.handOff.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishHandOff = resolve;
        }),
    );

    const first = reply(s, 2, TEXT);
    await vi.waitFor(() => expect(s.h.handoff.handOff).toHaveBeenCalledTimes(1));
    const second = await reply(s, 2, TEXT);
    finishHandOff();
    const firstDone = await first;

    expect(second.headers['location']).toBe(DUPLICATE_LOCATION);
    expect(firstDone.headers['location']).toBe('/chats/2?notice=sent');
    expect(s.h.actions()).toEqual(['handOff', 'sendFromPanel']);
  });

  it('через 10 секунд тот же текст уходит снова, раньше нет', async () => {
    const s = await open();
    await reply(s, 2, TEXT);

    s.h.advance(9_999);
    const early = await reply(s, 2, TEXT);
    s.h.advance(1);
    const later = await reply(s, 2, TEXT);

    expect(early.headers['location']).toBe(DUPLICATE_LOCATION);
    expect(later.headers['location']).toBe('/chats/2?notice=sent');
    expect(s.h.outbox.sendFromPanel).toHaveBeenCalledTimes(2);
  });

  it('другой текст в тот же чат и тот же текст в другой чат уходят сразу', async () => {
    const s = await open();
    await reply(s, 2, TEXT);

    const otherText = await reply(s, 2, `${TEXT}. Что у вас за бизнес?`);
    const otherChat = await reply(s, 1, TEXT);

    expect(otherText.headers['location']).toBe('/chats/2?notice=sent');
    expect(otherChat.headers['location']).toBe('/chats/1?notice=sent');
    expect(s.h.outbox.sendFromPanel).toHaveBeenCalledTimes(3);
  });

  it('повтор с другими пробелами по краям тоже повтор: клиенту ушёл бы тот же обрезанный текст', async () => {
    const s = await open();
    await reply(s, 2, TEXT);

    const second = await reply(s, 2, `  ${TEXT}\r\n`);

    expect(second.headers['location']).toBe(DUPLICATE_LOCATION);
    expect(s.h.outbox.sendFromPanel).toHaveBeenCalledTimes(1);
  });

  it('сбой отправки снимает отметку: тот же текст можно отправить сразу', async () => {
    const s = await open();
    s.h.outbox.sendFromPanel.mockRejectedValueOnce(new Error('нет связи'));
    const failed = await reply(s, 2, TEXT);

    const retry = await reply(s, 2, TEXT);

    expect(failed.statusCode).toBe(502);
    expect(retry.statusCode).toBe(303);
    expect(retry.headers['location']).toBe('/chats/2?notice=sent');
  });

  it('сбой передачи чата тоже снимает отметку', async () => {
    const s = await open();
    s.h.handoff.handOff.mockRejectedValueOnce(new Error('база недоступна'));
    const failed = await reply(s, 2, TEXT);

    const retry = await reply(s, 2, TEXT);

    expect(failed.statusCode).toBe(502);
    expect(retry.headers['location']).toBe('/chats/2?notice=sent');
  });

  it('отказ по тексту или по закрытому чату отметку не ставит: после исправления ответ уходит сразу', async () => {
    const s = await open();
    s.h.outbox.canSendFromPanel.mockReturnValueOnce(false);
    const blocked = await reply(s, 2, TEXT);

    const sent = await reply(s, 2, TEXT);

    expect(blocked.statusCode).toBe(422);
    expect(sent.headers['location']).toBe('/chats/2?notice=sent');
    expect(s.h.outbox.sendFromPanel).toHaveBeenCalledTimes(1);
  });

  it('аудит повтора: строка без текста сообщения, имени и номера', async () => {
    const s = await open();
    const secret = 'Секретный текст ответа клиенту';
    await reply(s, 2, secret);

    await reply(s, 2, secret);

    expect(s.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'reply_duplicate', chatId: 2 }),
    );
    const log = s.h.rawLog();
    expect(log).not.toContain('Секретный текст');
    expect(log).not.toContain('Бауыржан');
    expect(log).not.toMatch(/77\d{9}/);
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

  it('после возврата бот отвечает на неотвеченное: сначала returnToBot, потом resume; пометка и число в аудите', async () => {
    const s = await open();
    s.h.resume.mockReturnValueOnce(2);

    const response = await giveBack(s, 1);

    expect(response.headers['location']).toBe('/chats/1?notice=returned_answering');
    expect(s.h.actions()).toEqual(['returnToBot', 'resume']);
    expect(s.h.resume).toHaveBeenCalledWith(chatIdOf(1));
    expect(s.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'return_to_bot', chatId: 1, resumed: 2 }),
    );
  });

  it('отвечать не на что: пометка returned, в аудите ноль', async () => {
    const s = await open();

    const response = await giveBack(s, 1);

    expect(response.headers['location']).toBe('/chats/1?notice=returned');
    expect(s.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'return_to_bot', chatId: 1, resumed: 0 }),
    );
  });

  it('сбой ответа на неотвеченное: чат всё равно возвращён, ошибка в аудите без подробностей', async () => {
    const s = await open();
    s.h.resume.mockImplementationOnce(() => {
      throw new Error('сбой базы 77001234567');
    });

    const response = await giveBack(s, 1);

    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe('/chats/1?notice=returned');
    expect(s.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'resume_failed', chatId: 1, errorName: 'Error' }),
    );
    expect(s.h.rawLog()).not.toContain('77001234567');
  });

  it('сбой ответа на неотвеченное не ошибкой, а строкой: в аудите только тип значения', async () => {
    const s = await open();
    s.h.resume.mockImplementationOnce(() => {
      throw 'номер 77001234567' as unknown as Error;
    });

    await giveBack(s, 1);

    expect(s.h.logs()).toContainEqual(
      expect.objectContaining({ action: 'resume_failed', errorName: 'string' }),
    );
    expect(s.h.rawLog()).not.toContain('77001234567');
  });

  it('возврат не удался: на неотвеченное бот не отвечает', async () => {
    const s = await open();
    s.h.handoff.returnToBot.mockRejectedValueOnce(new Error('сбой записи'));

    await giveBack(s, 1);

    expect(s.h.resume).not.toHaveBeenCalled();
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
