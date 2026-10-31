import { describe, expect, it } from 'vitest';
import type { ClientProfile } from '../../../src/domain/types.js';
import { createScenario, type Scenario, type Turn } from './company-scenarios-harness.js';
import type { InterestScript, LlmScript, ReplyScript } from './scripted-llm.js';

// Живой тест владельца 30.10.2026 на моках: реплики клиента идут через очередь склейки, конвейер, настоящие агент,
// проверки кодом, передачу и базу; поддельные только модель, WhatsApp и проект B (компанию не находит). Тогда чат ушёл
// менеджеру на пятом сообщении клиента посреди разговора (передача по пределу сообщений), а в панели стояла причина
// «спрашивает цену», хотя клиент цену не спрашивал. С 30.10.2026 бот консультант: ведёт разговор до финала.

const INTRO =
  'Здравствуйте! Мы в Tanbala ставим учёт на RFID-метках под ключ. Расскажите, из какой вы компании и чем она занимается?';
const HOOK =
  'Спасибо! В банках на хранении обычно много всего, архив с делами, запас техники и расходников, и ручной пересчёт отнимает у сотрудников дни. С метками на это уходят часы, достаточно пройти вдоль полок со сканером. Вы уже знаете, как работает RFID и что мы предлагаем?';
const EXPLAIN =
  'Всё просто. На каждый товар на хранении клеится метка. Антенны на входе и выходе считывают метки и сами отмечают, что пришло и что ушло, всю партию сразу. Данные уходят в вашу 1С, интеграцию делает наш сотрудник. Расскажите, что у вас лежит на хранении и как сейчас проходит проверка?';
const DETAILS =
  'Для 10 тыс позиций на складе ручной пересчёт обычно отнимает дни. Ручной сканер видит сотни меток за секунду, даже в закрытых коробках, поэтому сверить склад можно в любой день. Расскажите, в каком городе склад и в какой системе вы ведёте учёт?';
const AFTER_FIFTH =
  'Интеграцию с вашей 1С делает наш сотрудник, детали зависят от конфигурации. Расскажите, сколько нового товара приходит к вам за месяц?';

const BUSINESS: Partial<ClientProfile> = { business: 'банк' };
const STOCK: Partial<ClientProfile> = {
  ...BUSINESS,
  items: 'товар на складе',
  itemCount: '10 тыс',
  premises: 'склад',
};
const FIFTH: Partial<ClientProfile> = { ...STOCK, city: 'Алматы', has1C: true };

function turn(reply: ReplyScript, interest: InterestScript): LlmScript {
  return { replies: [reply], interests: [{ level: 'warm', ...interest }] };
}

/** Первые четыре реплики клиента из живого теста: бот ведёт разговор, чат у него. */
async function firstFour(s: Scenario): Promise<readonly Turn[]> {
  return [
    await s.say(
      'Здравствуйте',
      turn({ outcome: 'answer', text: INTRO, stage: 'intro', companyQuestion: 'name' }, {}),
    ),
    await s.say(
      'Тинькофф, банки',
      turn(
        { outcome: 'answer', text: HOOK, stage: 'hook', usedFacts: ['F4'] },
        { companyName: 'Тинькофф', profile: BUSINESS },
      ),
    ),
    await s.say(
      'Нет нету',
      turn(
        { outcome: 'answer', text: EXPLAIN, stage: 'explain', usedFacts: ['F3', 'F6'] },
        { profile: BUSINESS },
      ),
    ),
    await s.say(
      'На складе 10 тыс',
      turn(
        { outcome: 'answer', text: DETAILS, stage: 'details', usedFacts: ['F2'] },
        { profile: STOCK },
      ),
    ),
  ];
}

describe('живой тест 30.10.2026: «Здравствуйте», «Тинькофф, банки», «Нет нету», «На складе 10 тыс», «Алматы, да у нас есть 1c система»', () => {
  it('первые четыре сообщения: бот отвечает, чат у бота', async () => {
    const s = createScenario();

    const turns = await firstFour(s);

    expect(turns.map((t) => t.outcome)).toEqual(Array(4).fill({ kind: 'replied' }));
    expect(turns.map((t) => t.toClient)).toEqual([[INTRO], [HOOK], [EXPLAIN], [DETAILS]]);
    expect(turns.flatMap((t) => t.toManager)).toEqual([]);
  });

  it('после пятого сообщения чат не передаётся: бот отвечает вопросом, менеджеру ничего', async () => {
    const s = createScenario();
    await firstFour(s);

    const fifth = await s.say(
      'Алматы, да у нас есть 1c система',
      turn({ outcome: 'answer', text: AFTER_FIFTH, stage: 'details' }, { profile: FIFTH }),
    );

    expect(fifth.outcome).toEqual({ kind: 'replied' });
    expect(fifth.toClient).toEqual([AFTER_FIFTH]);
    expect(fifth.toClient[0]).toMatch(/\?$/u);
    expect(fifth.toManager).toEqual([]);
    expect(s.storage.handoffs.findOpen(s.chatId())).toBeNull();
    expect(s.storage.chats.getById(s.chatId())?.control).toEqual({ status: 'bot', by: null });
    expect(s.storage.chats.getById(s.chatId())?.level).toBe('warm');
  });

  it('шестое сообщение тоже не передаёт: предела сообщений больше нет', async () => {
    const s = createScenario();
    await firstFour(s);
    await s.say(
      'Алматы, да у нас есть 1c система',
      turn({ outcome: 'answer', text: AFTER_FIFTH, stage: 'details' }, { profile: FIFTH }),
    );

    const sixth = await s.say(
      'Штук 300',
      turn(
        {
          outcome: 'answer',
          text: '300 новых в месяц можно сразу принимать с метками. Расскажите, сколько проходов нужно учитывать?',
          stage: 'details',
        },
        { profile: { ...FIFTH, monthlyIntake: '300' } },
      ),
    );

    expect(sixth.outcome).toEqual({ kind: 'replied' });
    expect(sixth.toManager).toEqual([]);
  });
});
