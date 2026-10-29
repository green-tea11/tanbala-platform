import { describe, expect, it } from 'vitest';
import type { StoredRejectedDraft } from '../../../src/domain/types.js';
import { REJECTED_DRAFTS_SHOWN } from '../../../src/panel/chat-model.js';
import { chatIdOf, createHarness, makeChat, MINUTE_MS, T0, type Harness } from './harness.js';

// Отклонённые черновики и замечания проверок в карточке чата (пункт 7 задания 29.10.2026): за паролем панели,
// экранированы, свежие первыми, в свёрнутом блоке.

function rejected(id: number, overrides: Partial<StoredRejectedDraft> = {}): StoredRejectedDraft {
  return {
    id,
    chatId: chatIdOf(1),
    attempt: 1,
    source: 'code',
    draft: `Черновик ${String(id)}`,
    remarks: [`Замечание ${String(id)}`],
    atMs: T0 + id * MINUTE_MS,
    ...overrides,
  };
}

async function chatPage(h: Harness): Promise<string> {
  const { cookie } = await h.login();
  const response = await h.request({ url: '/chats/1', cookie });
  expect(response.statusCode).toBe(200);
  return response.body;
}

describe('панель: отклонённые черновики в карточке чата', () => {
  it('свёрнутый блок с числом; свежие первыми: время, попытка, проверка, черновик и замечания', async () => {
    const h = createHarness({
      data: {
        chats: [makeChat(1)],
        rejectedDrafts: [
          rejected(1, { attempt: 1, source: 'code', remarks: ['цена: «3000»'] }),
          rejected(2, { attempt: 2, source: 'review', remarks: ['Назван срок.', 'Обещание.'] }),
        ],
      },
    });

    const page = await chatPage(h);

    expect(page).toMatch(/<details[^>]*>\s*<summary>Отклонённые черновики: 2<\/summary>/);
    const second = page.indexOf('Черновик 2');
    const first = page.indexOf('Черновик 1');
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(second);
    expect(page).toContain('попытка 2, проверка вторым вызовом');
    expect(page).toContain('попытка 1, проверка кодом');
    expect(page).toContain('<li>Назван срок.</li>');
    expect(page).toContain('<li>Обещание.</li>');
    expect(page).toContain('цена: «3000»');
    expect(h.rejectedDrafts.listForChat).toHaveBeenCalledWith(1, REJECTED_DRAFTS_SHOWN);
  });

  it('нет отклонённых черновиков: блок с пометкой «нет»', async () => {
    const h = createHarness({ data: { chats: [makeChat(1)] } });

    const page = await chatPage(h);

    expect(page).toContain('Отклонённые черновики: нет');
    expect(page).not.toContain('<details');
  });

  it('черновик и замечания экранируются: разметка не выполняется', async () => {
    const attack = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    const h = createHarness({
      data: {
        chats: [makeChat(1)],
        rejectedDrafts: [rejected(1, { draft: attack, remarks: [attack] })],
      },
    });

    const page = await chatPage(h);

    expect(page).not.toMatch(/<script|<img/i);
    expect(page.split('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;').length).toBe(3);
  });

  it('пустой список замечаний: «причина не названа»', async () => {
    const h = createHarness({
      data: { chats: [makeChat(1)], rejectedDrafts: [rejected(1, { remarks: [] })] },
    });

    const page = await chatPage(h);

    expect(page).toContain('причина не названа');
  });

  it('без входа страница чата не открывается и черновики не видны', async () => {
    const h = createHarness({
      data: {
        chats: [makeChat(1)],
        rejectedDrafts: [rejected(1, { draft: 'Секретный черновик' })],
      },
    });

    const response = await h.request({ url: '/chats/1' });

    expect(response.statusCode).toBe(303);
    expect(response.body).not.toContain('Секретный черновик');
    expect(h.rejectedDrafts.listForChat).not.toHaveBeenCalled();
  });

  it('тексты черновиков и замечаний не попадают в лог панели', async () => {
    const h = createHarness({
      data: {
        chats: [makeChat(1)],
        rejectedDrafts: [rejected(1, { draft: 'Текст черновика XYZ', remarks: ['Замечание QWE'] })],
      },
    });

    await chatPage(h);

    expect(h.rawLog()).not.toContain('XYZ');
    expect(h.rawLog()).not.toContain('QWE');
  });
});
