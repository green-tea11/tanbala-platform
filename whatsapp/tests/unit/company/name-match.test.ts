import { describe, expect, it } from 'vitest';
import {
  confidentNameMatch,
  MIN_CONFIRM_SIMILARITY,
  nameSimilarity,
  sameCity,
} from '../../../src/company/name-match.js';

// Похожесть названий и совпадение городов для подтверждения компании без вопроса (решение владельца 30.10.2026).

describe('nameSimilarity', () => {
  it.each([
    ['АО «Т-Банк»', 'Т-Банк'],
    ['Т-Банк, банк', 'т банк'],
    ['ТОО Ромашка', 'ромашка'],
    ['ТОО «ЁЛКА»', 'Елка'],
    ['ТБанк', 'Т-Банк'],
    ['LLP Alpha Group', 'Alpha Group Ltd.'],
  ])('«%s» и «%s»: одно и то же название (1)', (first, second) => {
    expect(nameSimilarity(first, second)).toBe(1);
  });

  it('старое и новое название бренда не похожи', () => {
    expect(nameSimilarity('Тинькофф', 'АО «Т-Банк»')).toBeLessThan(MIN_CONFIRM_SIMILARITY);
  });

  it('одна буква на десять: похожесть ровно на пороге 0.9', () => {
    expect(nameSimilarity('Платформа-А', 'Платформа-Б')).toBeCloseTo(0.9, 10);
    expect(nameSimilarity('Платформа-А', 'Платформа-Б')).toBeGreaterThanOrEqual(
      MIN_CONFIRM_SIMILARITY,
    );
  });

  it('часть названия не считается тем же названием', () => {
    expect(nameSimilarity('Платформа', 'Платформа-А Логистика')).toBeLessThan(
      MIN_CONFIRM_SIMILARITY,
    );
  });

  it('пустое после нормализации название ни с чем не совпадает', () => {
    expect(nameSimilarity('ТОО', 'ТОО')).toBe(0);
    expect(nameSimilarity('', 'Т-Банк')).toBe(0);
  });

  it('порядок не важен', () => {
    expect(nameSimilarity('Береке', 'Береке Строй')).toBe(nameSimilarity('Береке Строй', 'Береке'));
  });
});

describe('sameCity', () => {
  it.each([
    ['Алматы', 'алматы'],
    ['г. Алматы', 'Алматы'],
    ['город Астана', 'Астана'],
    ['almaty', 'Алматы'],
    ['Ust-Kamenogorsk', 'Усть-Каменогорск'],
    ['Алма-Ата', 'Алматы'],
  ])('«%s» и «%s»: один город', (first, second) => {
    expect(sameCity(first, second)).toBe(true);
  });

  it.each([
    ['Астана', 'Алматы'],
    ['Алматы', null],
    ['', ''],
    ['г.', 'г.'],
  ])('«%s» и «%s»: не один город', (first, second) => {
    expect(sameCity(first, second)).toBe(false);
  });
});

describe('confidentNameMatch (ревью этапа 3)', () => {
  it.each([
    ['Автопарк 12', 'Автопарк 13'],
    ['Магазин №125', 'Магазин №126'],
    ['Ромашка 2000', 'Ромашка 2001'],
    ['Рахат', 'Рахат 2'],
    ['Т-Банк', 'Т-Банки'],
  ])('«%s» и «%s» не одна компания', (client, card) => {
    expect(confidentNameMatch(client, card)).toBe(false);
  });

  it.each([
    ['Т-Банк', 'АО «Т-Банк»'],
    ['ТБанк', 'Т-Банк, банк'],
    ['Алматы Логистик Групп', 'ТОО «Алматы Логистик Груп»'],
    ['Автопарк 12', 'ТОО «Автопарк 12»'],
  ])('«%s» и «%s» одна компания', (client, card) => {
    expect(confidentNameMatch(client, card)).toBe(true);
  });
});
