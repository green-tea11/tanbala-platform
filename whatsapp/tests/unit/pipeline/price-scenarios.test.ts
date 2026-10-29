import { describe, expect, it } from 'vitest';
import type { ClientProfile } from '../../../src/domain/types.js';
import { createScenario, dataOf } from './company-scenarios-harness.js';
import type { LlmScript } from './scripted-llm.js';

// Правило минимума перед передачей по цене (решение владельца 29.10.2026) на уровне конвейера: реплики клиента идут
// через очередь склейки, конвейер, настоящие агент, проверки, передачу и базу. Поддельные только модель (сценарий
// ответа), WhatsApp и проект B (компанию не находит): 0 токенов, без сети. Чат первый в базе, поэтому его ID 1, как у
// живого диалога 28.10.

/**
 * Живой диалог 28.10 (чат ID 1): клиент прислал голосовое, расшифровка идёт в конвейер обычным текстом клиента.
 * Склад 5000 м², ввоз и вывоз, вопрос про 1С и цену; компания не определена.
 */
const CLIENT_28_10 =
  'Здравствуйте, у нас склад 5000 квадратов, хотим учитывать, что приходит и что уходит. Вы интегрируетесь с нашей 1С? И сколько это будет стоить?';

/** Что оценка интереса узнала из этого сообщения. */
const PROFILE_28_10: Partial<ClientProfile> = {
  business: 'склад',
  area: '5000 м²',
  scope: 'ввоз и вывоз',
  has1C: true,
  problemAgreed: true,
};

/** Ответ по новому правилу: из знаний про 1С, цена зависит от объёма, один вопрос и зачем он. */
const ANSWER_28_10 =
  'Да, мы проводим интеграцию с вашей 1С, детали зависят от конфигурации. Цена сильно зависит от объёма: сколько примерно вещей нужно учитывать? Это нужно, чтобы коллега сразу назвал ориентир.';

/** Так ответил старый бот: сразу передача с фразой о цене. */
const OLD_HOT =
  'Да, мы проводим интеграцию с вашей 1С. Цена сильно зависит от объёма. Уточню у коллеги и вернусь к вам.';

const PRICE_PHRASE = 'Цена сильно зависит от объёма. Уточню у коллеги и вернусь к вам.';

const ASK_SCOPE =
  'Цена сильно зависит от объёма. Что нужно учитывать: только ввоз и вывоз или где лежит каждая вещь? Это нужно, чтобы коллега сразу назвал ориентир.';

const FULL: Partial<ClientProfile> = {
  ...PROFILE_28_10,
  itemCount: 'около 3000',
  oneCName: 'УТ 11',
};

function priceTurn(script: Omit<LlmScript, 'interests'>, profile = PROFILE_28_10): LlmScript {
  return { ...script, interests: [{ level: 'warm', profile, priceAsked: true }] };
}

function hotPrice(text = PRICE_PHRASE): LlmScript['replies'][number] {
  return { outcome: 'hot', text, aboutPrice: true };
}

describe('сценарии владельца 29.10.2026: минимум перед передачей по цене', () => {
  it('диалог 28.10 (чат ID 1): вместо передачи вопрос о числе вещей; данные модели говорят, чего не хватает', async () => {
    const s = createScenario();

    const turn = await s.say(CLIENT_28_10, priceTurn({ replies: [ANSWER_28_10] }));

    expect(s.chatId()).toBe(1);
    expect(turn.outcome).toEqual({ kind: 'replied' });
    expect(turn.toClient).toEqual([ANSWER_28_10]);
    expect(turn.toManager).toEqual([]);
    expect(s.storage.handoffs.findOpen(s.chatId())).toBeNull();
    expect(s.storage.chats.getById(s.chatId())?.control).toEqual({ status: 'bot', by: null });
    // Черновик пишется параллельно с оценкой этого сообщения: выжимка в данных до него, вопросы даны по порядку.
    const data = turn.data('reply');
    expect(data).toContain('Для передачи по цене собрано: ничего');
    expect(data).toContain('о чём клиент не сказал в последнем сообщении');
    expect(data).toMatch(/Вопросы по порядку: [^\n]*сколько примерно вещей нужно учитывать/);
    expect(data).toContain('О компании спрашивай, только если до неё дошла очередь');
    // Вопрос цены засчитан: ответ ушёл.
    expect(s.storage.chats.getProgress(s.chatId())).toEqual({ priceAsks: 1, refused: false });
  });

  it('диалог 28.10, модель по старой привычке отвечает hot: код не передаёт чат, повтор с замечанием даёт вопрос', async () => {
    const s = createScenario();

    const turn = await s.say(
      CLIENT_28_10,
      priceTurn({ replies: [hotPrice(OLD_HOT), ANSWER_28_10] }),
    );

    expect(turn.outcome).toEqual({ kind: 'replied' });
    expect(turn.toClient).toEqual([ANSWER_28_10]);
    expect(turn.toManager).toEqual([]);
    expect(turn.llm.purposes()).toEqual(['reply', 'interest', 'reply', 'review']);
    const retry = dataOf(turn.llm.requests.filter((request) => request.purpose === 'reply')[1]);
    expect(retry).toContain(
      'Передавать чат рано: для передачи по цене не хватает: примерное число вещей',
    );
    expect(s.storage.handoffs.findOpen(s.chatId())).toBeNull();
  });

  it('диалог 28.10, модель дважды хочет передать: уходит фиксированный вопрос о числе вещей', async () => {
    const s = createScenario();

    const turn = await s.say(CLIENT_28_10, priceTurn({ replies: [hotPrice(OLD_HOT)] }));

    expect(turn.outcome).toEqual({ kind: 'replied' });
    expect(turn.toClient).toEqual([
      'Цена сильно зависит от объёма. Подскажите, сколько примерно вещей нужно учитывать? Это нужно, чтобы коллега сразу назвал ориентир.',
    ]);
    expect(turn.toManager).toEqual([]);
  });

  it('минимум собран: передача hot с фразой о цене, в уведомлении что собрано и «всё выяснено»', async () => {
    const s = createScenario();

    const turn = await s.say(
      'Склад 5000 квадратов, ввоз и вывоз, около 3000 позиций, 1С УТ 11. Мы ТОО Склад Алматы, теряем товар при отгрузке. Сколько стоит?',
      {
        replies: [hotPrice()],
        interests: [
          { level: 'hot', profile: FULL, priceAsked: true, companyName: 'ТОО Склад Алматы' },
        ],
      },
    );

    expect(turn.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(turn.toClient).toEqual([PRICE_PHRASE]);
    expect(turn.toManager).toHaveLength(1);
    const notice = turn.toManager[0] ?? '';
    expect(notice).toContain('1С: есть, УТ 11');
    expect(notice).toContain(
      'Для оценки цены собрано: что учитывать, примерное число вещей, есть ли 1С, название компании, согласие клиента, что трудность есть',
    );
    expect(notice).toContain('Не удалось выяснить: всё выяснено');
    expect(notice).toContain('Компания: не определена, клиент назвал «ТОО Склад Алматы»');
  });

  it('отказ отвечать: передача сразу, без минимума', async () => {
    const s = createScenario();
    await s.say('Сколько стоит?', priceTurn({ replies: [ASK_SCOPE] }, {}));

    const refused = await s.say('Не скажу, просто назовите цену', {
      replies: [hotPrice()],
      interests: [{ level: 'hot', priceAsked: true, refused: true }],
    });

    expect(refused.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(refused.toClient).toEqual([PRICE_PHRASE]);
    expect(refused.toManager[0]).toContain(
      'Не удалось выяснить: что учитывать, примерное число вещей',
    );
  });

  it('третий вопрос цены: первые два без передачи, третий передаёт; модель видит счётчик', async () => {
    const s = createScenario();

    const first = await s.say('Сколько стоит?', priceTurn({ replies: [ASK_SCOPE] }, {}));
    const second = await s.say(
      'Я спросил, сколько стоит?',
      priceTurn({ replies: [hotPrice(), ASK_SCOPE] }, {}),
    );
    const third = await s.say('Так сколько стоит?', priceTurn({ replies: [hotPrice()] }, {}));

    expect(first.outcome).toEqual({ kind: 'replied' });
    expect(second.outcome).toEqual({ kind: 'replied' });
    expect(second.toManager).toEqual([]);
    expect(third.data('reply')).toMatch(
      /спрашивал цену 2 раза[^\n]*третий раз: передай чат сразу \(hot\)/,
    );
    expect(third.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(third.toClient).toEqual([PRICE_PHRASE]);
  });

  it('просьба о живом человеке: передача сразу, о минимуме не спрашивает', async () => {
    const s = createScenario();

    const turn = await s.say('Позовите, пожалуйста, менеджера', {
      replies: [{ outcome: 'asked_human' }],
    });

    expect(turn.outcome).toEqual({ kind: 'handed_off', reason: 'asked_human' });
    expect(turn.llm.purposes()).toEqual(['reply', 'interest']);
    expect(turn.toManager[0]).toContain('Передача чата менеджеру: клиент просит живого человека.');
  });

  it('после возврата боту вопросы цены считаются заново', async () => {
    const s = createScenario();
    await s.say('Сколько стоит?', priceTurn({ replies: [ASK_SCOPE] }, {}));
    await s.say('Позовите человека', { replies: [{ outcome: 'asked_human' }] });

    await s.services.handoff.returnToBot(s.chatId());

    expect(s.storage.chats.getProgress(s.chatId())).toEqual({ priceAsks: 0, refused: false });
  });
});
