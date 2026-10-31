import { describe, expect, it } from 'vitest';
import { STALE_PROFILE_LINE } from '../../../src/agent/agent.js';
import type { ClientProfile } from '../../../src/domain/types.js';
import { createScenario } from './company-scenarios-harness.js';
import type { InterestScript, LlmScript } from './scripted-llm.js';

// Прогон симулятора 01.11.2026 с настоящим Claude (сценарии «склад» и «Kusto»): примерно каждый шестой ход ответ не
// доходил до клиента как надо. Здесь те же ходы на уровне конвейера: очередь склейки, настоящие агент, проверки,
// передача и база; поддельные только модель (сценарий ответа), WhatsApp и проект B. 0 токенов, без сети.

/** Склад ответственного хранения: что клиент рассказал за первые два сообщения. */
const WAREHOUSE: Partial<ClientProfile> = {
  business: 'ответственное хранение для торговых компаний',
  items: 'бытовая техника',
  packaging: 'коробки и паллеты',
  itemCount: 'около 12 тысяч мест',
  city: 'Астана',
  problemAgreed: true,
};

/** Третье сообщение клиента «склад»: помещение, площадь, въезды, 1С и расхождения остатков. */
const WAREHOUSE_DETAILS =
  'Склад в Астане, класс B, 4000 квадратов, два въезда. Учёт в 1С Управление торговлей 11, но остатки постоянно не сходятся с фактом.';

/** Что оценка интереса узнала из третьего сообщения: не хватает только нового в месяц. */
const WAREHOUSE_AFTER: Partial<ClientProfile> = {
  ...WAREHOUSE,
  premises: 'склад класса B',
  area: '4000 кв. м',
  passages: 'два въезда',
  has1C: true,
  oneCName: '1С:Управление торговлей 11',
  problem: 'остатки в 1С не сходятся с фактом',
  inferred: ['passages'],
};

const ASK_INTAKE =
  'Остатки, которые не сходятся с 1С, обычно всплывают только при пересчёте. Расскажите, сколько нового товара приходит к вам за месяц?';

function turn(replies: LlmScript['replies'], profile: Partial<ClientProfile>): LlmScript {
  const interest: InterestScript = { level: 'warm', profile };
  return { replies, interests: [interest] };
}

describe('пункт 1: черновик пишется после оценки и видит последнее сообщение клиента', () => {
  it('«склад»: въезды и 1С из этого сообщения в данных черновика уже известны, не хватает только нового в месяц', async () => {
    const s = createScenario({ api: null });
    await s.say('Здравствуйте, мы ответственное хранение в Астане.', turn(['Вопрос?'], WAREHOUSE));

    const third = await s.say(WAREHOUSE_DETAILS, turn([ASK_INTAKE], WAREHOUSE_AFTER));

    expect(third.llm.purposes()).toEqual(['interest', 'reply', 'review']);
    const data = third.data('reply');
    expect(data).toContain('Для расчёта не хватает: сколько нового приходит в месяц.');
    expect(data).toContain('Проходы: вероятно два въезда');
    expect(data).toContain('1С: есть, 1С:Управление торговлей 11');
    expect(data).not.toContain(STALE_PROFILE_LINE);
    expect(third.toClient).toEqual([ASK_INTAKE]);
  });

  it('клиент назвал последнее недостающее: данные черновика уже говорят «известно всё», этап финал', async () => {
    const s = createScenario({ api: null });
    const ready = { ...WAREHOUSE_AFTER, monthlyIntake: 'около 300 мест' };
    await s.say('Здравствуйте, мы ответственное хранение в Астане.', {
      replies: [{ outcome: 'answer', text: 'Вопрос?', stage: 'details' }],
      interests: [{ level: 'warm', profile: WAREHOUSE }],
    });

    const last = await s.say('Новых около 300 мест в месяц', turn(['Вопрос?'], ready));

    const data = last.data('reply');
    expect(data).toContain('Этап по данным системы: 5 финал.');
    expect(data).toContain('Для расчёта известно всё.');
  });
});
