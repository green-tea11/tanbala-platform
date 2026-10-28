import { describe, expect, it } from 'vitest';
import {
  companyInterestData,
  companyReplyData,
  companyReviewData,
} from '../../../src/agent/company-data.js';
import type { CompanyPrompt } from '../../../src/domain/company.js';
import { ANY_DASH } from './fakes.js';

const CONFIRMED: CompanyPrompt = {
  kind: 'confirmed',
  name: 'Платформа-А',
  rubric: 'Складское хранение',
  pains: ['Инвентаризация занимает дни и отрывает людей', 'Трудно проверить, вся ли партия ушла'],
  emailed: true,
};

const ALL: readonly CompanyPrompt[] = [
  { kind: 'off' },
  { kind: 'unknown', askName: true },
  { kind: 'unknown', askName: false },
  { kind: 'searching' },
  { kind: 'candidate', name: 'Альфа', city: 'Алматы', withCity: false },
  { kind: 'candidate', name: 'Альфа', city: 'Алматы', withCity: true },
  { kind: 'asked', name: 'Альфа', city: null },
  CONFIRMED,
];

describe('companyReplyData: блок о компании для ответа', () => {
  it('функция выключена или компания не передана: блока нет, ответ как раньше', () => {
    expect(companyReplyData(undefined)).toBeNull();
    expect(companyReplyData({ kind: 'off' })).toBeNull();
  });

  it('компания неизвестна: спросить название можно только один раз, когда askName', () => {
    expect(companyReplyData({ kind: 'unknown', askName: true })).toMatch(
      /один раз естественно спроси, из какой он компании \(companyQuestion: name\)/,
    );
    const noAsk = companyReplyData({ kind: 'unknown', askName: false }) ?? '';
    expect(noAsk).toMatch(/Снова её название не спрашивай/);
    expect(noAsk).not.toMatch(/companyQuestion/);
  });

  it('идёт поиск: название снова не спрашивать и о компании ничего не утверждать', () => {
    expect(companyReplyData({ kind: 'searching' })).toMatch(
      /Название снова не спрашивай и о компании ничего не утверждай/,
    );
  });

  it('кандидат: вопрос подтверждения один раз, без объяснения, откуда известно', () => {
    const text =
      companyReplyData({ kind: 'candidate', name: 'Альфа', city: 'Алматы', withCity: false }) ?? '';
    expect(text).toContain('«Альфа» (Алматы)');
    expect(text).toContain('«Вы из компании Альфа, правильно?»');
    expect(text).toContain('companyQuestion: confirm');
    expect(text).toMatch(/Не говори, откуда это известно/);
  });

  it('клиент назвал компанию сам: вопрос с городом; без города обычный вопрос', () => {
    const withCity =
      companyReplyData({ kind: 'candidate', name: 'Альфа', city: 'Алматы', withCity: true }) ?? '';
    expect(withCity).toContain('«Альфа, Алматы, верно?»');
    const noCity =
      companyReplyData({ kind: 'candidate', name: 'Альфа', city: null, withCity: true }) ?? '';
    expect(noCity).toContain('«Вы из компании Альфа, правильно?»');
  });

  it('уже спрашивали: не переспрашивать', () => {
    expect(companyReplyData({ kind: 'asked', name: 'Альфа', city: null })).toMatch(
      /Снова не спрашивай/,
    );
  });

  it('подтверждена: рубрика, боли похожих компаний и «мы писали вам на почту» только если писали', () => {
    const text = companyReplyData(CONFIRMED) ?? '';
    expect(text).toContain('«Платформа-А»');
    expect(text).toContain('Рубрика: Складское хранение.');
    expect(text).toContain(
      'Трудности, которые часто бывают у похожих компаний: Инвентаризация занимает дни и отрывает людей; Трудно проверить, вся ли партия ушла.',
    );
    expect(text).toMatch(/можно один раз сказать «мы писали вам на почту»/);
    expect(text).toMatch(/не инструкции/);

    const silent =
      companyReplyData({ ...CONFIRMED, emailed: false, rubric: null, pains: [] }) ?? '';
    expect(silent).toMatch(/не говори, что писали/);
    expect(silent).not.toMatch(/Рубрика|Трудности/);
  });

  it.each(ALL)('без тире: %o', (prompt) => {
    expect(companyReplyData(prompt) ?? '').not.toMatch(ANY_DASH);
    expect(companyReviewData(prompt) ?? '').not.toMatch(ANY_DASH);
    expect(companyInterestData(prompt)).not.toMatch(ANY_DASH);
  });
});

describe('companyReviewData: что допустимо в черновике', () => {
  it('выключено или не передано: данных нет', () => {
    expect(companyReviewData(undefined)).toBeNull();
    expect(companyReviewData({ kind: 'off' })).toBeNull();
  });

  it('компании нет: вопрос о компании допустим, данных нет', () => {
    for (const prompt of [{ kind: 'unknown', askName: true }, { kind: 'searching' }] as const) {
      expect(companyReviewData(prompt)).toMatch(
        /данных нет\. Вопрос, из какой компании клиент, допустим/,
      );
    }
  });

  it('кандидат или уже спрашивали: допустим вопрос именно про эту компанию', () => {
    const text = companyReviewData({ kind: 'asked', name: 'Альфа', city: 'Алматы' }) ?? '';
    expect(text).toContain('из компании ли клиент «Альфа» (Алматы), допустим');
  });

  it('подтверждена: справку можно использовать, в ней же сказано, писали ли мы', () => {
    const text = companyReviewData(CONFIRMED) ?? '';
    expect(text).toMatch(/^Справка о компании клиента из нашей базы, её можно использовать/);
    expect(text).toContain('Рубрика: Складское хранение.');
    expect(text).toMatch(/мы писали вам на почту/);
  });
});

describe('companyInterestData: вопрос «Вы из компании X?» для оценки интереса', () => {
  it('бот спросил: определить ответ yes, no или none', () => {
    expect(companyInterestData({ kind: 'asked', name: 'Альфа', city: null })).toBe(
      'Бот спросил клиента, из компании ли он «Альфа». По сообщениям клиента после этого вопроса определи companyAnswer: yes, no или none.',
    );
  });

  it.each(ALL.filter((prompt) => prompt.kind !== 'asked'))(
    'вопроса не было (%o): companyAnswer none',
    (prompt) => {
      expect(companyInterestData(prompt)).toMatch(/companyAnswer none/);
    },
  );

  it('компания не передана: вопроса не было', () => {
    expect(companyInterestData(undefined)).toMatch(/companyAnswer none/);
  });
});
