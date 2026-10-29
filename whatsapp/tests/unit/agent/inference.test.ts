import { describe, expect, it } from 'vitest';
import { normalizeInterest, type RawInterest } from '../../../src/agent/interest.js';
import { profileEntries, profileText } from '../../../src/agent/profile.js';
import { buildSystem } from '../../../src/agent/prompts.js';
import type { ClientProfile } from '../../../src/domain/types.js';
import { minimumReport } from '../../../src/handoff/minimum.js';
import { formatManagerNotification } from '../../../src/handoff/notification.js';
import type { ChatId } from '../../../src/domain/types.js';
import { EMPTY_PROFILE, KNOWLEDGE } from './fakes.js';

// Выводы из слов клиента с пометкой «вероятно» (пункт 4 задания 29.10.2026): «С 1С интегрируется?» значит
// «1С: вероятно есть, конфигурация не выяснена», а не «не выяснено». Вывод считается выясненным для минимума, пока
// клиент не скажет иначе.

const NOTHING: RawInterest = {
  level: 'warm',
  business: null,
  items: null,
  packaging: null,
  material: null,
  city: null,
  premises: null,
  area: null,
  scope: null,
  itemCount: null,
  turnover: null,
  currentTracking: null,
  has1C: null,
  problem: null,
  specifics: null,
  reason: 'по разговору',
  inferred: [],
};

describe('normalizeInterest: выводы с пометкой', () => {
  it('«С 1С интегрируется?»: 1С вероятно есть, поле в inferred', () => {
    const { profile } = normalizeInterest(
      { ...NOTHING, has1C: true, premises: 'склад', inferred: ['has1C'] },
      EMPTY_PROFILE,
    );

    expect(profile.has1C).toBe(true);
    expect(profile.premises).toBe('склад');
    expect(profile.inferred).toEqual(['has1C']);
  });

  it('клиент сказал прямо: пометка снимается', () => {
    const before: ClientProfile = { ...EMPTY_PROFILE, has1C: true, inferred: ['has1C'] };

    const { profile } = normalizeInterest({ ...NOTHING, has1C: true, inferred: [] }, before);

    expect(profile.inferred).toEqual([]);
  });

  it('клиент опроверг вывод: новое значение без пометки', () => {
    const before: ClientProfile = { ...EMPTY_PROFILE, has1C: true, inferred: ['has1C'] };

    const { profile } = normalizeInterest({ ...NOTHING, has1C: false }, before);

    expect(profile.has1C).toBe(false);
    expect(profile.inferred).toEqual([]);
  });

  it('модель поле не прислала: прежнее значение и прежняя пометка остаются', () => {
    const before: ClientProfile = {
      ...EMPTY_PROFILE,
      has1C: true,
      material: 'металл',
      inferred: ['has1C'],
    };

    const { profile } = normalizeInterest(NOTHING, before);

    expect(profile.has1C).toBe(true);
    expect(profile.material).toBe('металл');
    expect(profile.inferred).toEqual(['has1C']);
  });

  it('сказанное прямо вывод модели не понижает: значение и «известно» остаются', () => {
    const before: ClientProfile = { ...EMPTY_PROFILE, city: 'Алматы', inferred: [] };

    const { profile } = normalizeInterest(
      { ...NOTHING, city: 'Астана', inferred: ['city'] },
      before,
    );

    expect(profile.city).toBe('Алматы');
    expect(profile.inferred).toEqual([]);
  });

  it('пометка на поле без значения не ставится; подделка без поля inferred: выводов нет', () => {
    const marked = normalizeInterest(
      { ...NOTHING, inferred: ['material', 'has1C'] },
      EMPTY_PROFILE,
    );
    const withoutField: RawInterest = Object.fromEntries(
      Object.entries(NOTHING).filter(([key]) => key !== 'inferred'),
    ) as unknown as RawInterest;
    const legacy = normalizeInterest({ ...withoutField, has1C: true }, EMPTY_PROFILE);

    expect(withoutField).not.toHaveProperty('inferred');

    expect(marked.profile.inferred).toEqual([]);
    expect(legacy.profile.inferred).toEqual([]);
  });

  it('пометки по порядку полей выжимки, без повторов', () => {
    const { profile } = normalizeInterest(
      {
        ...NOTHING,
        has1C: true,
        items: 'запчасти',
        material: 'металл',
        inferred: ['has1C', 'material', 'material'],
      },
      EMPTY_PROFILE,
    );

    expect(profile.inferred).toEqual(['material', 'has1C']);
  });
});

describe('выжимка словами: пометка «вероятно»', () => {
  const INFERRED_1C: ClientProfile = { ...EMPTY_PROFILE, has1C: true, inferred: ['has1C'] };

  it('1С по выводу: «вероятно есть, конфигурация не выяснена»', () => {
    const entry = profileEntries(INFERRED_1C).find((item) => item.label === '1С');

    expect(entry?.value).toBe('вероятно есть, конфигурация не выяснена');
  });

  it('1С со слов клиента: «есть, конфигурация не выяснена», с названием «есть, УТ 11»', () => {
    const known = profileEntries({ ...EMPTY_PROFILE, has1C: true });
    const named = profileEntries({ ...EMPTY_PROFILE, has1C: true, oneCName: 'УТ 11' });

    expect(known.find((item) => item.label === '1С')?.value).toBe('есть, конфигурация не выяснена');
    expect(named.find((item) => item.label === '1С')?.value).toBe('есть, УТ 11');
  });

  it('текстовое поле по выводу: «вероятно» перед значением', () => {
    const entries = profileEntries({
      ...EMPTY_PROFILE,
      material: 'металл',
      inferred: ['material'],
    });

    expect(entries.find((item) => item.label === 'Материал')?.value).toBe('вероятно металл');
  });

  it('данные вызова: пометка в значении и пояснение в заголовке', () => {
    const text = profileText(INFERRED_1C) ?? '';

    expect(text).toContain('1С: вероятно есть, конфигурация не выяснена');
    expect(text).toContain('«вероятно» перед значением: вывод из слов клиента');
  });

  it('уведомление менеджеру: «1С: вероятно есть», в собранном минимуме «(вероятно)»', () => {
    const text = formatManagerNotification({
      reason: 'hot',
      name: null,
      phone: null,
      level: 'warm',
      profile: INFERRED_1C,
      chatId: 1 as ChatId,
    });

    expect(text).toContain('1С: вероятно есть, конфигурация не выяснена');
    expect(text).toContain('Для оценки цены собрано: есть ли 1С (вероятно)');
    expect(text).toContain('«вероятно»: вывод из его слов');
  });

  it('вывод считается собранным для минимума', () => {
    const report = minimumReport({ profile: INFERRED_1C, companyName: null });

    expect(report.collected).toBe('есть ли 1С (вероятно)');
    expect(report.missing).not.toContain('есть ли 1С');
  });
});

describe('промпт оценки интереса: выводы с пометкой', () => {
  const text = buildSystem(KNOWLEDGE, 'interest').at(-1)?.text ?? '';

  it('выводить из слов клиента и помечать в inferred, пример с 1С', () => {
    expect(text).toContain('«С 1С интегрируется?»');
    expect(text).toMatch(/inferred: [^\n]*вывел из слов клиента/);
    expect(text).not.toContain('догадками не дополняй');
  });

  it('промпт ответа: значение «вероятно» считается выясненным, можно уточнить', () => {
    const reply = buildSystem(KNOWLEDGE, 'reply').at(-1)?.text ?? '';

    expect(reply).toContain('Значение выжимки с пометкой «вероятно» считается выясненным');
  });
});
