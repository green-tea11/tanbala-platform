import { describe, expect, it } from 'vitest';
import type { ClientProfile } from '../../../src/domain/types.js';
import { safeQuestion } from '../../../src/pipeline/safe-questions.js';
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
  premises: 'склад',
  area: '5000 м²',
  scope: 'ввоз и вывоз',
  has1C: true,
  problemAgreed: true,
};

/** Ответ по новому правилу: из знаний про 1С, ориентир назовёт коллега, один вопрос. */
const ANSWER_28_10 =
  'Да, мы проводим интеграцию с вашей 1С, детали зависят от конфигурации. Ориентир коллега назовёт, когда поймём ваш объект. Какие вещи нужно учитывать?';

/** Так ответил старый бот: сразу передача с фразой о цене. */
const OLD_HOT =
  'Да, мы проводим интеграцию с вашей 1С. Цена сильно зависит от объёма. Уточню у коллеги и вернусь к вам.';

const PRICE_PHRASE = 'Цена сильно зависит от объёма. Уточню у коллеги и вернусь к вам.';

const ASK_ITEMS =
  'Ориентир коллега назовёт, когда поймём ваш объект. Подскажите, какие вещи нужно учитывать?';

const FULL: Partial<ClientProfile> = {
  ...PROFILE_28_10,
  items: 'запчасти',
  material: 'металл',
  city: 'Алматы',
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
  it('диалог 28.10 (чат ID 1): вместо передачи вопрос о вещах; данные модели говорят, чего не хватает', async () => {
    const s = createScenario();

    const turn = await s.say(CLIENT_28_10, priceTurn({ replies: [ANSWER_28_10] }));

    expect(s.chatId()).toBe(1);
    expect(turn.outcome).toEqual({ kind: 'replied' });
    expect(turn.toClient).toEqual([ANSWER_28_10]);
    expect(turn.toManager).toEqual([]);
    expect(s.storage.handoffs.findOpen(s.chatId())).toBeNull();
    expect(s.storage.chats.getById(s.chatId())?.control).toEqual({ status: 'bot', by: null });
    // Черновик пишется параллельно с оценкой этого сообщения: выжимка в данных до него, вопросы даны группами.
    const data = turn.data('reply');
    expect(data).toContain('Для передачи по цене собрано: ничего');
    expect(data).toContain('о котором клиент не сказал в последнем сообщении');
    expect(data).toMatch(
      /Недостающее по группам: 1\) из какой клиент компании \(companyQuestion: name\); 2\) какие вещи клиент хочет учитывать/,
    );
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
      'Передавать чат рано: для передачи по цене не хватает: какие вещи, материал, примерное число вещей, город',
    );
    expect(s.storage.handoffs.findOpen(s.chatId())).toBeNull();
  });

  it('диалог 28.10, модель дважды хочет передать: уходит фиксированный вопрос о вещах', async () => {
    const s = createScenario();

    const turn = await s.say(CLIENT_28_10, priceTurn({ replies: [hotPrice(OLD_HOT)] }));

    expect(turn.outcome).toEqual({ kind: 'replied' });
    expect(turn.toClient).toEqual([safeQuestion('items', true)]);
    expect(turn.toManager).toEqual([]);
  });

  it('минимум собран: передача hot с фразой о цене, в уведомлении что собрано и «всё выяснено»', async () => {
    const s = createScenario();

    const turn = await s.say(
      'Склад металлических запчастей в Алматы, 5000 квадратов, ввоз и вывоз, около 3000 позиций, 1С УТ 11. Мы ТОО Склад Алматы, теряем товар при отгрузке. Сколько стоит?',
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
      'Для оценки цены собрано: какие вещи, материал, примерное число вещей, тип помещения, город, есть ли 1С, название компании',
    );
    expect(notice).toContain('Не удалось выяснить: всё выяснено');
    expect(notice).toContain('Компания: не определена, клиент назвал «ТОО Склад Алматы»');
  });

  it('отказ отвечать: передача сразу, без минимума', async () => {
    const s = createScenario();
    await s.say('Сколько стоит?', priceTurn({ replies: [ASK_ITEMS] }, {}));

    const refused = await s.say('Не скажу, просто назовите цену', {
      replies: [hotPrice()],
      interests: [{ level: 'hot', priceAsked: true, refused: true }],
    });

    expect(refused.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(refused.toClient).toEqual([PRICE_PHRASE]);
    expect(refused.toManager[0]).toContain(
      'Не удалось выяснить: какие вещи, материал, примерное число вещей, тип помещения, город, есть ли 1С',
    );
  });

  it('отказ отвечать, а модель ответила answer с новым вопросом: код всё равно передаёт чат (ревью 29.10.2026)', async () => {
    const s = createScenario();
    await s.say('Сколько стоит?', priceTurn({ replies: [ASK_ITEMS] }, {}));

    const refused = await s.say('Не скажу, просто назовите цену', {
      replies: ['Понимаю. А сколько примерно вещей нужно учитывать?'],
      interests: [{ level: 'hot', priceAsked: true, refused: true }],
    });

    expect(refused.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(refused.toClient).toEqual([PRICE_PHRASE]);
    expect(refused.llm.purposes()).toEqual(['reply', 'interest']);
  });

  it('четвёртый вопрос цены: первые три без передачи, четвёртый передаёт; модель видит счётчик', async () => {
    const s = createScenario();

    const first = await s.say('Сколько стоит?', priceTurn({ replies: [ASK_ITEMS] }, {}));
    const second = await s.say(
      'Я спросил, сколько стоит?',
      priceTurn({ replies: [hotPrice(), ASK_ITEMS] }, {}),
    );
    const third = await s.say(
      'Так сколько стоит?',
      priceTurn({ replies: [hotPrice(), ASK_ITEMS] }, {}),
    );
    const fourth = await s.say('Цену скажите!', priceTurn({ replies: [hotPrice()] }, {}));

    expect(first.outcome).toEqual({ kind: 'replied' });
    expect(second.outcome).toEqual({ kind: 'replied' });
    expect(third.outcome).toEqual({ kind: 'replied' });
    expect([second.toManager, third.toManager]).toEqual([[], []]);
    expect(fourth.data('reply')).toMatch(
      /спрашивал цену 3 раза[^\n]*четвёртый раз: передай чат сразу \(hot\)/,
    );
    expect(fourth.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(fourth.toClient).toEqual([PRICE_PHRASE]);
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
    await s.say('Сколько стоит?', priceTurn({ replies: [ASK_ITEMS] }, {}));
    await s.say('Позовите человека', { replies: [{ outcome: 'asked_human' }] });

    await s.services.handoff.returnToBot(s.chatId());

    expect(s.storage.chats.getProgress(s.chatId())).toEqual({ priceAsks: 0, refused: false });
  });
});
