import { describe, expect, it } from 'vitest';
import type { RecordedRequest } from './scripted-llm.js';
import { createScenario, dataOf, type Turn } from './company-scenarios-harness.js';

// Заметка для бота при возврате чата (решение владельца 29.10.2026) на уровне конвейера: заметка не видна клиенту,
// хранится в чате, идёт в промпт ответа и проверки отдельным блоком «указание коллеги» и действует до следующей
// передачи. Цифры и обещания в ответе только из заметки. Модель, WhatsApp и проект B поддельные: 0 токенов, без сети.

const TASK_NOTE = 'Узнай количество вещей и какая у них 1С';
const PRICE_NOTE = 'Ориентир от 1 500 000 тенге, нужен выезд на объект';
const ASK_COUNT =
  'Подскажите, сколько примерно вещей нужно учитывать? Это нужно, чтобы коллега сразу назвал ориентир.';
const PRICE_ANSWER =
  'Коллега подсказал ориентир: от 1 500 000 тенге. Точнее скажем после выезда на объект.';
const NO_PRICE_ANSWER =
  'Цена сильно зависит от объёма. Подскажите, сколько примерно вещей нужно учитывать? Это нужно, чтобы коллега сразу назвал ориентир.';

function noteBlockOf(turn: Turn, purpose: 'reply' | 'review'): string {
  const request: RecordedRequest | undefined = turn.llm.requests.find((r) => r.purpose === purpose);
  return request?.system[2]?.text ?? '';
}

/** Клиент спросил цену, бот передал чат, клиент ждёт: на последнее сообщение ещё никто не ответил. */
async function waitingForPrice() {
  const s = createScenario({ api: null });
  await s.say('Сколько стоит учёт на складе?', {
    replies: [{ outcome: 'hot', aboutPrice: true }],
    interests: [{ priceAsked: true, refused: true }],
  });
  await s.say('Ну что по цене?', { replies: [ASK_COUNT] });
  return s;
}

describe('сценарии владельца 29.10.2026: заметка для бота', () => {
  it('заметка-задание: бот продолжает разговор и выясняет это, заметка в промпте отдельным блоком', async () => {
    const s = await waitingForPrice();

    const back = await s.returnToBot({ replies: [ASK_COUNT] }, TASK_NOTE);

    expect(back.toClient).toEqual([ASK_COUNT]);
    const block = noteBlockOf(back, 'reply');
    expect(block).toMatch(/^Указание коллеги/);
    expect(block).toContain(`<указание_коллеги>\n${TASK_NOTE}\n</указание_коллеги>`);
    expect(noteBlockOf(back, 'review')).toContain(TASK_NOTE);
    // Заметка не слова клиента: её нет в репликах и в блоке данных.
    for (const request of back.llm.requests) {
      expect(request.turns.map((t) => t.text).join('\n')).not.toContain(TASK_NOTE);
    }
    expect(s.storage.chats.getNote(s.chatId())).toMatchObject({ text: TASK_NOTE });
  });

  it('заметка с ценой: цена в ответе ровно как в заметке, ответ уходит клиенту', async () => {
    const s = await waitingForPrice();

    const back = await s.returnToBot({ replies: [PRICE_ANSWER] }, PRICE_NOTE);

    expect(back.outcome).toEqual({ kind: 'replied' });
    expect(back.toClient).toEqual([PRICE_ANSWER]);
    expect(back.toClient.join(' ')).toContain('1 500 000 тенге');
    expect(dataOf(back.llm.requests[0])).toMatch(/Если в указании коллеги есть ориентир цены/);
  });

  it('заметка с ценой, а модель назвала другую сумму: клиенту она не уходит, повтор даёт сумму из заметки', async () => {
    const s = await waitingForPrice();

    const back = await s.returnToBot(
      {
        replies: [
          'Коллега подсказал ориентир: от 1,5 млн тенге. Точнее после выезда.',
          PRICE_ANSWER,
        ],
      },
      PRICE_NOTE,
    );

    expect(back.toClient).toEqual([PRICE_ANSWER]);
    expect(back.toClient.join(' ')).not.toContain('млн');
  });

  it('без заметки бот цену не называет: черновик с ценой не уходит, после повтора вопрос без цены', async () => {
    const s = await waitingForPrice();

    const back = await s.returnToBot({ replies: [PRICE_ANSWER, NO_PRICE_ANSWER] });

    expect(back.toClient).toEqual([NO_PRICE_ANSWER]);
    expect(back.toClient.join(' ')).not.toMatch(/тенге|1 500 000/);
    expect(noteBlockOf(back, 'reply')).toBe('');
  });

  it('заметка действует до следующей передачи: передача снимает её, следующий возврат без неё', async () => {
    const s = await waitingForPrice();
    await s.returnToBot({ replies: [PRICE_ANSWER] }, PRICE_NOTE);

    const handed = await s.say('Позовите менеджера', { replies: [{ outcome: 'asked_human' }] });

    expect(handed.outcome).toEqual({ kind: 'handed_off', reason: 'asked_human' });
    expect(s.storage.chats.getNote(s.chatId())).toBeNull();
  });

  it('заметка клиенту не уходит: ни в фразах, ни в уведомлении менеджеру', async () => {
    const s = await waitingForPrice();

    const back = await s.returnToBot({ replies: [ASK_COUNT] }, TASK_NOTE);

    expect(back.toClient.join(' ')).not.toContain(TASK_NOTE);
    expect(back.toManager).toEqual([]);
  });
});
