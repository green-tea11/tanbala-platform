import { describe, expect, it } from 'vitest';
import { json } from '../helpers/fake-backends.js';
import { harnessPerTest, type Harness } from '../helpers/harness.js';

const start = harnessPerTest();

function lastAudit(harness: Harness) {
  const [entry] = harness.context.audit.page(1, 1).items;
  return entry === undefined
    ? null
    : { actor: entry.actor, action: entry.action, target: entry.target, outcome: entry.outcome };
}

describe('ответ клиенту', () => {
  it.each([
    ['sent', 'Сообщение отправлено клиенту'],
    ['duplicate', 'Это сообщение уже отправлено'],
  ])('итог %s: текст для человека и запись в журнал без текста', async (result, message) => {
    const harness = await start();
    harness.backends.on('POST wa:/chats/12/reply', { result });
    const session = await harness.signIn('aigerim', 'manager');
    const response = await harness.request('POST', '/api/chats/12/reply', {
      session,
      body: { text: 'Добрый день! Секретная цена 100' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result, message });
    expect(lastAudit(harness)).toEqual({
      actor: 'aigerim',
      action: 'chat_reply',
      target: 'chat:12',
      outcome: result,
    });
    const audit = JSON.stringify(harness.db.prepare('SELECT * FROM audit_log').all());
    expect(audit).not.toContain('Секретная');
  });

  it('сбой записи журнала после ушедшего ответа не превращает успех в ошибку', async () => {
    const harness = await start();
    harness.backends.on('POST wa:/chats/12/reply', { result: 'sent' });
    const session = await harness.signIn('aigerim', 'manager');
    harness.db.exec("CREATE TRIGGER audit_fail BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    const response = await harness.request('POST', '/api/chats/12/reply', { session, body: { text: 'Добрый день' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: 'sent', message: 'Сообщение отправлено клиенту' });
  });

  it('пустой или длинный текст: 422 до вызова бота', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    const empty = await harness.request('POST', '/api/chats/12/reply', {
      session,
      body: { text: '  \r\n ' },
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json()).toEqual({ error: 'refused', message: 'Пустое сообщение не отправляется' });
    const long = await harness.request('POST', '/api/chats/12/reply', {
      session,
      body: { text: 'я'.repeat(4097) },
    });
    expect(long.statusCode).toBe(422);
    expect(harness.backends.calls).toEqual([]);
  });

  it('502 бота: «Не отправлено. Чат уже у менеджера, бот в нём молчит.»', async () => {
    const harness = await start();
    harness.backends.on('POST wa:/chats/12/reply', () => json({ error: 'send_failed' }, 502));
    const session = await harness.signIn('owner', 'owner');
    const response = await harness.request('POST', '/api/chats/12/reply', {
      session,
      body: { text: 'Добрый день' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: 'send_failed',
      message: 'Не отправлено. Чат уже у менеджера, бот в нём молчит.',
    });
    expect(lastAudit(harness)?.outcome).toBe('send_failed');
  });

  it('422 бота (закрытый режим): его текст', async () => {
    const harness = await start();
    harness.backends.on('POST wa:/chats/12/reply', () =>
      json({ error: 'refused', message: 'Ответ не отправлен: чат не из TEST_ALLOWLIST.' }, 422),
    );
    const session = await harness.signIn('owner', 'owner');
    const response = await harness.request('POST', '/api/chats/12/reply', {
      session,
      body: { text: 'Добрый день' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      message: 'Ответ не отправлен: чат не из TEST_ALLOWLIST.',
    });
  });
});

describe('«Вернуть боту» с двумя полями', () => {
  it('поля склеиваются в одну заметку с подписями через пустую строку', async () => {
    const harness = await start();
    harness.backends.on('POST wa:/chats/12/return', { result: 'returned_answering' });
    const session = await harness.signIn('aigerim', 'manager');
    const response = await harness.request('POST', '/api/chats/12/return', {
      session,
      body: { answer: ' Ориентир от 500 000 ₸, нужен выезд \r\n', task: 'Узнай число вещей и 1С' },
    });
    expect(response.json()).toEqual({
      result: 'returned_answering',
      message: 'Чат возвращён боту: бот ответит на сообщения клиента без ответа',
    });
    expect(harness.backends.calls[0]?.body).toEqual({
      note: 'Ответ клиенту: Ориентир от 500 000 ₸, нужен выезд\n\nЗадание боту: Узнай число вещей и 1С',
    });
  });

  it.each([
    ['returned', 'Чат возвращён боту'],
    ['already_bot', 'Чат уже ведёт бот: заметка не сохранена'],
  ])('итог %s: свой текст', async (result, message) => {
    const harness = await start();
    harness.backends.on('POST wa:/chats/12/return', { result });
    const session = await harness.signIn('owner', 'owner');
    const response = await harness.request('POST', '/api/chats/12/return', { session, body: {} });
    expect(response.json()).toEqual({ result, message });
    expect(harness.backends.calls[0]?.body).toEqual({ note: '' });
  });

  it('итоговая заметка длиннее 1000 символов: 422 до вызова бота, с длиной', async () => {
    const harness = await start();
    const session = await harness.signIn('owner', 'owner');
    const response = await harness.request('POST', '/api/chats/12/return', {
      session,
      body: { answer: 'а'.repeat(600), task: 'б'.repeat(400) },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'refused', noteLength: 1031 });
    expect(harness.backends.calls).toEqual([]);
  });
});

describe('действия почты (только владелец)', () => {
  it('одобрить, отклонить, изменить, тест: тексты старого интерфейса и журнал', async () => {
    const harness = await start();
    harness.backends.on('POST leads:/drafts/4/approve', { result: 'approved' });
    harness.backends.on('POST leads:/drafts/4/reject', { result: 'rejected' });
    harness.backends.on('POST leads:/drafts/4/edit', {
      result: 'saved',
      checksTotal: 9,
      checksFailed: 1,
    });
    harness.backends.on('POST leads:/drafts/4/send-test', {
      result: 'sent',
      sentTo: 'owner@example.kz',
      at: '2026-10-30T06:05:00Z',
    });
    const session = await harness.signIn('owner', 'owner');
    const post = (url: string, body: unknown = {}) =>
      harness.request('POST', url, { session, body }).then((response) => response.json<unknown>());
    expect(await post('/api/letters/4/approve')).toEqual({
      result: 'approved',
      message: 'Письмо одобрено. Компаниям письма пока не отправляются.',
    });
    expect(await post('/api/letters/4/reject')).toEqual({
      result: 'rejected',
      message: 'Письмо отклонено. Компания вернулась к статусу «Почта проверена».',
    });
    expect(await post('/api/letters/4/edit', { subject: 'Тема', body: 'Текст' })).toEqual({
      result: 'saved',
      checksTotal: 9,
      checksFailed: 1,
      message: 'Изменения сохранены, проверки пройдены заново.',
    });
    expect(await post('/api/letters/4/send-test')).toEqual({
      result: 'sent',
      sentTo: 'owner@example.kz',
      at: '2026-10-30T06:05:00Z',
      message: 'Тест отправлен на owner@example.kz в 11:05.',
    });
    const edit = harness.backends.calls.find((call) => call.path === '/drafts/4/edit');
    expect(edit?.body).toEqual({ subject: 'Тема', body: 'Текст' });
    expect(edit?.headers['x-console-user']).toBe('owner');
    const actions = harness.context.audit.page(1, 10).items.map((item) => item.action);
    expect(actions.slice(0, 4)).toEqual([
      'letter_send_test',
      'letter_edit',
      'letter_reject',
      'letter_approve',
    ]);
  });

  it('«не писать» и «снять отметку WhatsApp»', async () => {
    const harness = await start();
    harness.backends.on('POST leads:/companies/5/block', { result: 'blocked' });
    harness.backends.on('POST leads:/companies/5/whatsapp-clear', {
      result: 'cleared',
      wasRequestedVia: 'whatsapp',
    });
    const session = await harness.signIn('owner', 'owner');
    const block = await harness.request('POST', '/api/companies/5/block', { session });
    expect(block.json()).toEqual({
      result: 'blocked',
      message: 'Готово: компания и её домен в списке «не писать». Письма им не уйдут.',
    });
    const clear = await harness.request('POST', '/api/companies/5/whatsapp-clear', { session });
    expect(clear.json()).toMatchObject({ result: 'cleared', wasRequestedVia: 'whatsapp' });
    expect(lastAudit(harness)).toMatchObject({ target: 'company:5', outcome: 'cleared' });
  });

  it('запуск поиска: тело проверено, номер запуска в ответе и журнале', async () => {
    const harness = await start();
    harness.backends.on('POST leads:/runs', () => json({ runId: 42 }, 202));
    const session = await harness.signIn('owner', 'owner');
    const response = await harness.request('POST', '/api/runs', {
      session,
      body: { query: 'склад, логистика\nпроизводство', city: 'almaty', count: 5, extra: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      result: 'started',
      runId: 42,
      message: 'Поиск запущен: запуск №42.',
    });
    expect(harness.backends.calls[0]?.body).toEqual({
      query: 'склад, логистика\nпроизводство',
      city: 'almaty',
      count: 5,
    });
    expect(lastAudit(harness)).toMatchObject({ action: 'run_start', outcome: 'run:42' });
    const bad = await harness.request('POST', '/api/runs', {
      session,
      body: { query: 'склад', city: 'almaty', count: 21 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ message: 'Неверный запрос: count.' });
  });

  it('импорт «Уже писали»: итог для человека', async () => {
    const harness = await start();
    harness.backends.on('POST leads:/history/import', {
      added: 3,
      existing: 1,
      invalid: ['не адрес'],
      invalidMore: 2,
    });
    const session = await harness.signIn('owner', 'owner');
    const response = await harness.request('POST', '/api/history/import', {
      session,
      body: { kind: 'refused', fileBase64: 'YUBiLmt6' },
    });
    expect(response.json()).toEqual({
      result: 'imported',
      added: 3,
      existing: 1,
      invalid: ['не адрес'],
      invalidMore: 2,
      message: 'Добавлено: 3. Уже были (в том числе из «не писать»): 1. Не распознано: 3.',
    });
    const empty = await harness.request('POST', '/api/history/import', {
      session,
      body: { kind: 'written' },
    });
    expect(empty.statusCode).toBe(400);
  });
});

describe('чтение через приложения', () => {
  it('списки и карточки отдаются как есть, с параметрами', async () => {
    const harness = await start();
    const page = { items: [{ id: 1 }], total: 1, page: 2, pages: 2, pageSize: 50 };
    const routes: [string, string, unknown][] = [
      ['/api/chats/12', 'GET wa:/chats/12', { chat: { id: 12 } }],
      [
        '/api/chats/12/messages?before=40',
        'GET wa:/chats/12/messages',
        { items: [], earlierBefore: null },
      ],
      ['/api/letters?status=all&run=3&page=2', 'GET leads:/letters', page],
      ['/api/letters/4', 'GET leads:/letters/4', { id: 4, subject: 'Тема' }],
      ['/api/runs?page=2', 'GET leads:/runs', page],
      ['/api/runs/active', 'GET leads:/runs/active', null],
      ['/api/runs/42', 'GET leads:/runs/42', { id: 42, status: 'running' }],
      ['/api/search/options', 'GET leads:/search/options', { cities: [] }],
      ['/api/research-jobs?status=failed', 'GET leads:/research-jobs', page],
      ['/api/history?page=2', 'GET leads:/history', page],
      ['/api/blocked', 'GET leads:/blocked', page],
    ];
    for (const [, key, body] of routes) harness.backends.on(key, body);
    const session = await harness.signIn('manager', 'manager');
    for (const [url, , body] of routes) {
      const response = await harness.request('GET', url, { session });
      expect({ url, status: response.statusCode, body: response.json<unknown>() }).toEqual({
        url,
        status: 200,
        body,
      });
    }
    const messages = harness.backends.calls.find((call) => call.path === '/chats/12/messages');
    expect(messages?.url.search).toBe('?before=40');
  });
});
