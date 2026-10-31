import { describe, expect, it } from 'vitest';
import type { ClientProfile } from '../../../src/domain/types.js';
import {
  createScenario,
  json,
  nothingFound,
  type ApiAnswer,
  type ApiCall,
} from './company-scenarios-harness.js';
import type { InterestScript, LlmScript, ReplyScript } from './scripted-llm.js';

// Решения владельца 30.10.2026 о компании клиента на моках (живой тест 30.10: «Тинькофф, банки», в 2ГИС бренд уже
// «Т-Банк»). Реплики клиента идут через очередь склейки, конвейер, настоящие агент, сервис компании, клиент
// внутреннего API и базу; поддельные только модель, WhatsApp и проект B. Проверяется видимое: что ушло клиенту, какие
// запросы ушли бы в API и что система передала модели в блоке данных.

const T_BANK_ID = 77;
const T_BANK = 'Т-Банк';
const PAIN_ARCHIVE = 'Нужное дело в архиве ищут перебором полок';
const PAIN_INVENTORY = 'Инвентаризация занимает дни и отрывает людей от работы';
const EVIDENCE = 'Архив кредитных дел в отделениях';

const INTRO =
  'Здравствуйте! Мы в Tanbala ставим учёт на RFID-метках под ключ. Расскажите, из какой вы компании и чем она занимается?';
const HOOK =
  'Спасибо! В банках на хранении обычно много всего, архив с делами, запас техники и расходников, и ручной пересчёт отнимает у сотрудников дни. С метками на это уходят часы, достаточно пройти вдоль полок со сканером. Вы уже знаете, как работает RFID и что мы предлагаем?';
const EXPLAIN =
  'Всё просто. На каждый товар на хранении клеится метка. Антенны на входе и выходе считывают метки и сами отмечают, что пришло и что ушло, всю партию сразу. Данные уходят в вашу 1С, интеграцию делает наш сотрудник. Расскажите, что у вас лежит на хранении и как сейчас проходит проверка?';

const BANK: Partial<ClientProfile> = { business: 'банк' };

function turn(reply: ReplyScript, interest: InterestScript = {}): LlmScript {
  return { replies: [reply], interests: [{ level: 'warm', ...interest }] };
}

function answer(
  text: string,
  stage: 'intro' | 'hook' | 'explain' | 'details',
  companyQuestion: 'none' | 'name' = 'none',
): ReplyScript {
  return { outcome: 'answer', text, stage, companyQuestion };
}

function tBankBrief(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: T_BANK_ID,
    name: T_BANK,
    city: 'Алматы',
    rubric: 'Банки',
    segment: 'Офис, компания с большим имуществом',
    fit: 'yes',
    fit_score: 70,
    reason: 'Много отделений и архив',
    pains: [
      { pain: PAIN_ARCHIVE, evidence: EVIDENCE, source: 'site' },
      { pain: PAIN_INVENTORY, evidence: 'Склад расходников', source: '2gis' },
    ],
    emailed: false,
    emailed_at: null,
    email_subject: null,
    ...overrides,
  };
}

/** Проект B знает Т-Банк в Алматы только под новым названием: по «Тинькофф» поиск пуст. */
function tBankLookup(query: Readonly<Record<string, string>>): ApiAnswer {
  if (query['name'] !== T_BANK) return nothingFound();
  return json(200, {
    candidates: [
      {
        id: T_BANK_ID,
        name: T_BANK,
        city: 'Алматы',
        rubric: 'Банки',
        match_by: 'name',
        match_score: 0.9,
        emailed: false,
      },
    ],
  });
}

function requestLines(calls: readonly ApiCall[]): string[] {
  return calls.map((call) => `${call.method} ${call.path} ${JSON.stringify(call.query)}`);
}

describe('31.10: «Тинькофф, банки», в базе почты бренд «Т-Банк»', () => {
  it('поиск по «Тинькофф» пуст, по варианту «Т-Банк» найден: компания подтверждена без вопроса, следующий ответ видит боли справки', async () => {
    const s = createScenario({
      api: {
        lookup: tBankLookup,
        brief: (id) =>
          id === T_BANK_ID ? json(200, tBankBrief()) : json(404, { error: 'not_found' }),
      },
    });

    await s.say('Здравствуйте', turn(answer(INTRO, 'intro', 'name')));
    const named = await s.say(
      'Тинькофф, банки',
      turn(answer(HOOK, 'hook'), {
        companyName: 'Тинькофф',
        companyAliases: [T_BANK, 'Tinkoff'],
        profile: BANK,
      }),
    );
    const next = await s.say('Нет, расскажите подробнее', turn(answer(EXPLAIN, 'explain')));

    // Ответ на «Тинькофф, банки» писался до поиска: о компании не спрашивать, боль из consult.md по бизнесу.
    expect(named.toClient).toEqual([HOOK]);
    expect(requestLines(named.api)).toEqual([
      'GET /internal/lookup {"name":"Тинькофф"}',
      `GET /internal/lookup {"name":"${T_BANK}"}`,
      `GET /internal/companies/${T_BANK_ID}/brief {}`,
    ]);
    expect(s.state()).toMatchObject({
      statedName: 'Тинькофф',
      statedAliases: [T_BANK, 'Tinkoff'],
      candidate: null,
      confirmed: { id: T_BANK_ID, name: T_BANK, city: 'Алматы' },
    });
    // Следующий ответ: справка уже есть, вопроса «Т-Банк, Алматы, верно?» нет.
    expect(next.api).toEqual([]);
    const data = next.data('reply');
    expect(data).toContain(`Компания клиента: «${T_BANK}».`);
    expect(data).toContain(
      `Трудности, которые часто бывают у похожих компаний: ${PAIN_ARCHIVE}; ${PAIN_INVENTORY}.`,
    );
    expect(data).not.toMatch(/верно\?|правильно\?|companyQuestion: confirm/u);
    expect(next.data('review')).not.toContain(EVIDENCE);
    expect(next.toClient).toEqual([EXPLAIN]);
    expect(s.company.service.summary(s.chatId())).toMatchObject({
      status: 'confirmed',
      companyId: T_BANK_ID,
    });
  });
});
