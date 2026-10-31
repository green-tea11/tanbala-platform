import { describe, expect, it } from 'vitest';
import { asksOfficialName, mayResearchOfficialName } from '../../../src/company/official-name.js';
import { jobIdOf, makeState, NOW } from './builders.js';

describe('asksOfficialName', () => {
  it.each([
    'Подскажите, как компания называется официально?',
    'А какое у компании ОФИЦИАЛЬНОЕ название?',
  ])('«%s»: вопрос об официальном названии', (text) => {
    expect(asksOfficialName(text)).toBe(true);
  });

  it('другой текст: нет', () => {
    expect(asksOfficialName('Подскажите, из какой вы компании?')).toBe(false);
  });
});

describe('mayResearchOfficialName', () => {
  const asked = makeState({
    statedName: 'Тинькофф Банк',
    researchName: 'тинькофф',
    officialNameAskedAtMs: NOW - 1000,
    research: { status: 'failed', reason: 'not_in_2gis', finishedAtMs: NOW - 2000 },
  });

  it('спросили официальное название, клиент назвал новое: можно', () => {
    expect(mayResearchOfficialName(asked, 'Тинькофф Банк')).toBe(true);
  });

  it.each(['queued', 'running'] as const)('проверка ещё идёт (%s): нельзя', (status) => {
    const running = {
      ...asked,
      research: { status, jobId: jobIdOf('job-1'), startedAtMs: NOW, checkedAtMs: NOW },
    };

    expect(mayResearchOfficialName(running, 'Тинькофф Банк')).toBe(false);
  });
});

describe('ревью этапа 3: вопрос об официальном названии только с «называ…»', () => {
  it('«Мы официально интегрируемся с 1С» не вопрос об официальном названии', () => {
    expect(
      asksOfficialName('Мы официально интегрируемся с 1С. Расскажите, что у вас на хранении?'),
    ).toBe(false);
  });

  it('«Подскажите, как компания называется официально?» вопрос', () => {
    expect(asksOfficialName('Подскажите, как компания называется официально?')).toBe(true);
  });
});
