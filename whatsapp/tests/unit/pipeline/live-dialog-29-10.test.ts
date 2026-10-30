import { describe, expect, it } from 'vitest';
import { profileEntries } from '../../../src/agent/profile.js';
import type { ClientProfile } from '../../../src/domain/types.js';
import { questionText } from '../../../src/pipeline/safe-questions.js';
import { createScenario, type Scenario } from './company-scenarios-harness.js';
import type { LlmScript } from './scripted-llm.js';

// Живой тест владельца 29.10.2026 на моках (пункт 6 задания): реплики клиента идут через очередь склейки, конвейер,
// настоящие агент, проверки кодом, передачу и базу. Поддельные только модель (сценарий ответа), WhatsApp и проект B
// (компанию не находит). Тогда на шаге 2 черновик не прошёл проверку кодом, повтор не прошёл ревью, и чат ушёл
// менеджеру с check_failed; в выжимке было «1С: не выяснено».

const CLIENT_1 =
  'Здравствуйте. У нас склад 5000 м2, нужно учитывать ввоз и вывоз. С 1С интегрируется? Сколько стоит?';
const BOT_1 =
  'Да, мы проводим интеграцию с вашей 1С, детали зависят от конфигурации. Ориентир коллега назовёт, когда поймём вашу задачу. Подскажите, сколько примерно вещей нужно учитывать?';
const CLIENT_2 = 'Около 3000 позиций. Так сколько примерно?';

/** Черновик, который проверка кодом не пропускает (цена). */
const PRICED_DRAFT =
  'Для 3000 позиций внедрение стоит около 2 000 000 тенге. Из какого материала вещи?';
/** Повтор, который не пропускает ревью (сценарий: замечание проверки). */
const REVIEW_REJECTED =
  'Tanbala уже делала такой склад в Алматы. Подскажите, из какого материала эти вещи?';
const REVIEW_REMARK = 'Кейс о складе в Алматы не из документов: уберите его.';

/** Черновики Sonnet из живого прогона: раньше их ложно отклоняла проверка цены (пункт 1). */
const LIVE_FALSE_POSITIVE =
  'Цена сильно зависит от объёма, и 3000 позиций уже хороший ориентир для коллеги. Подскажите, какие вещи нужно учитывать?';

const PRICE_PHRASE = 'Цена сильно зависит от объёма. Уточню у коллеги и вернусь к вам.';
const INFERRED_1C = '1С: вероятно есть, конфигурация не выяснена';

/** Что оценка интереса узнала из первого сообщения: склад, площадь, ввоз и вывоз; 1С по выводу из вопроса. */
const PROFILE_1: Partial<ClientProfile> = {
  business: 'склад',
  premises: 'склад',
  area: '5000 м²',
  scope: 'ввоз и вывоз',
  has1C: true,
  inferred: ['has1C'],
};

const PROFILE_2: Partial<ClientProfile> = { ...PROFILE_1, itemCount: 'около 3000 позиций' };

function turn(
  replies: LlmScript['replies'],
  profile: Partial<ClientProfile>,
  extra: Omit<LlmScript, 'replies' | 'interests'> & { readonly companyName?: string } = {},
): LlmScript {
  const { companyName, ...rest } = extra;
  return {
    ...rest,
    replies,
    interests: [
      {
        level: 'warm',
        profile,
        priceAsked: true,
        ...(companyName === undefined ? {} : { companyName }),
      },
    ],
  };
}

async function firstTurn(s: Scenario) {
  return s.say(CLIENT_1, turn([BOT_1], PROFILE_1));
}

describe('живой тест 29.10.2026: склад 5000 м², ввоз и вывоз, 1С, цена', () => {
  it('шаг 1: ответ с вопросом, чат у бота; в выжимке «1С: вероятно есть», а не «не выяснено»', async () => {
    const s = createScenario();

    const first = await firstTurn(s);

    expect(first.outcome).toEqual({ kind: 'replied' });
    expect(first.toClient).toEqual([BOT_1]);
    expect(first.toManager).toEqual([]);
    const profile = s.storage.chats.getById(s.chatId())?.profile;
    expect(profile?.has1C).toBe(true);
    expect(profile?.inferred).toEqual(['has1C']);
    const oneC = profileEntries(profile ?? ({} as ClientProfile)).find(
      ({ label }) => label === '1С',
    );
    expect(`1С: ${oneC?.value ?? ''}`).toBe(INFERRED_1C);
  });

  it('шаг 2: «Около 3000 позиций. Так сколько примерно?», два провала проверок: вопрос, а не передача', async () => {
    const s = createScenario();
    await firstTurn(s);

    const second = await s.say(
      CLIENT_2,
      turn([PRICED_DRAFT, REVIEW_REJECTED], PROFILE_2, { problems: [REVIEW_REMARK] }),
    );

    expect(second.outcome).toEqual({ kind: 'replied' });
    // Прошлым сообщением бот спросил о числе вещей: оно теперь известно. С 30.10.2026 один открытый вопрос о первом
    // недостающем для расчёта: что лежит на хранении.
    expect(second.toClient).toEqual([questionText('items', true)]);
    expect(second.toManager).toEqual([]);
    expect(s.storage.handoffs.findOpen(s.chatId())).toBeNull();
    expect(s.storage.chats.getById(s.chatId())?.control).toEqual({ status: 'bot', by: null });
    expect(second.llm.purposes()).toEqual(['reply', 'interest', 'reply', 'review']);
    // Модель видит вывод о 1С с пометкой: можно уточнить конфигурацию, переспрашивать «есть ли 1С» не нужно.
    expect(second.data('reply')).toContain(INFERRED_1C);
    expect(s.storage.chats.getProgress(s.chatId())).toEqual({
      priceAsks: 2,
      refused: false,
      lastStage: 'details',
    });
  });

  it('шаг 2: оба отклонённых черновика с замечаниями в базе для панели, в логе их нет', async () => {
    const s = createScenario();
    await firstTurn(s);

    await s.say(
      CLIENT_2,
      turn([PRICED_DRAFT, REVIEW_REJECTED], PROFILE_2, { problems: [REVIEW_REMARK] }),
    );

    const rejected = s.storage.rejectedDrafts.listForChat(s.chatId(), 10);
    expect(rejected.map(({ attempt, source, draft }) => ({ attempt, source, draft }))).toEqual([
      { attempt: 2, source: 'review', draft: REVIEW_REJECTED },
      { attempt: 1, source: 'code', draft: PRICED_DRAFT },
    ]);
    expect(rejected[0]?.remarks).toEqual([REVIEW_REMARK]);
    expect(rejected[1]?.remarks.join(' ')).toContain('цена');
    const logs = JSON.stringify(s.logs);
    expect(logs).not.toContain('2 000 000');
    expect(logs).not.toContain('Алматы');
    expect(logs).not.toContain(REVIEW_REMARK);
  });

  it('шаг 2: черновик из живого прогона («3000 позиций уже хороший ориентир») проходит и уходит как есть', async () => {
    const s = createScenario();
    await firstTurn(s);

    const second = await s.say(CLIENT_2, turn([LIVE_FALSE_POSITIVE], PROFILE_2));

    expect(second.outcome).toEqual({ kind: 'replied' });
    expect(second.toClient).toEqual([LIVE_FALSE_POSITIVE]);
    expect(s.storage.rejectedDrafts.listForChat(s.chatId(), 10)).toEqual([]);
  });

  it('третий вопрос цены без минимума ещё не передаёт, четвёртый передаёт с фразой о цене', async () => {
    const s = createScenario();
    await firstTurn(s);
    await s.say(CLIENT_2, turn([LIVE_FALSE_POSITIVE], PROFILE_2));

    const third = await s.say(
      'Запчасти. Ну так сколько стоит?',
      turn([{ outcome: 'hot', text: PRICE_PHRASE, aboutPrice: true }], {
        ...PROFILE_2,
        items: 'запчасти',
      }),
    );
    const fourth = await s.say(
      'Просто назовите цену.',
      turn(['Подскажите, из какого материала эти вещи?'], { ...PROFILE_2, items: 'запчасти' }),
    );

    expect(third.outcome).toEqual({ kind: 'replied' });
    expect(third.toManager).toEqual([]);
    expect(third.toClient).toEqual([questionText('monthlyIntake', true)]);
    expect(fourth.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(fourth.toClient).toEqual([PRICE_PHRASE]);
    const notice = fourth.toManager[0] ?? '';
    expect(notice).toContain(INFERRED_1C);
    expect(notice).toContain('Не удалось выяснить: материал, город, название компании');
  });

  it('минимум собран и клиент спрашивает цену: передача с полным списком собранного в уведомлении', async () => {
    const s = createScenario();
    await firstTurn(s);

    const second = await s.say(
      'Около 3000 позиций, металлические запчасти, склад в Алматы, мы ТОО Береке. Так сколько?',
      turn(
        [{ outcome: 'hot', text: PRICE_PHRASE, aboutPrice: true }],
        { ...PROFILE_2, items: 'запчасти', material: 'металл', city: 'Алматы' },
        { companyName: 'ТОО Береке' },
      ),
    );

    expect(second.outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(second.toClient).toEqual([PRICE_PHRASE]);
    expect(second.toManager).toHaveLength(1);
    const notice = second.toManager[0] ?? '';
    for (const line of [
      'Вещи: запчасти',
      'Материал: металл',
      'Город: Алматы',
      'Помещение: склад',
      // Уведомление приводит текст к NFKC: «м²» становится «м2».
      'Площадь: 5000 м2',
      'Число вещей: около 3000 позиций',
      'Что отмечать: ввоз и вывоз',
      INFERRED_1C,
      'Для оценки цены собрано: какие вещи, материал, примерное число вещей, тип помещения, город, есть ли 1С (вероятно), название компании',
      'Не удалось выяснить: всё выяснено',
      'Компания: не определена, клиент назвал «ТОО Береке»',
    ]) {
      expect(notice).toContain(line);
    }
  });
});
