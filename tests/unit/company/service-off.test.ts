import { describe, expect, it } from 'vitest';
import type { CompanyMention } from '../../../src/domain/company.js';
import { makeChat } from '../handoff/fakes.js';
import {
  CHAT_ID,
  makeBrief,
  makeChatCandidate,
  makeConfirmed,
  makeState,
  NOW,
} from './builders.js';
import { createHarness, makeMessage } from './fakes.js';

// Внутренний API выключен (INTERNAL_API_TOKEN пуст): бот работает как раньше, ничего не запрашивает, но боли клиента
// из оценки интереса всё равно запоминаются для уведомления и панели.

const MENTION: CompanyMention = {
  name: 'Платформа-А',
  city: 'Алматы',
  answer: 'yes',
  pains: ['Пересорт при приёмке', 'Долгая инвентаризация'],
};

describe('сервис компании: функция выключена', () => {
  it('prepare: блок off, ни API, ни WhatsApp, ни модель не вызываются, состояние не пишется', async () => {
    const h = createHarness({
      directory: 'off',
      contacts: { profile: { kind: 'business', websites: ['sklad.kz'], email: null } },
    });

    const turn = await h.service.prepare(makeChat(), [
      makeMessage({ pushName: 'ТОО Альфа', verifiedName: 'ТОО Альфа' }),
    ]);

    expect(turn).toEqual({ prompt: { kind: 'off' }, awaitingAnswer: false });
    expect(h.directory.calls).toEqual([]);
    expect(h.contacts.calls).toEqual([]);
    expect(h.logo.calls).toEqual([]);
    expect(h.repo.saves).toEqual([]);
  });

  it('prepare остаётся off, даже если в базе осталось состояние от времени, когда API был включён', async () => {
    const h = createHarness({
      directory: 'off',
      state: makeState({ confirmed: makeConfirmed(), candidate: makeChatCandidate() }),
    });

    const turn = await h.service.prepare(makeChat(), []);

    expect(turn).toEqual({ prompt: { kind: 'off' }, awaitingAnswer: false });
    expect(h.repo.saves).toEqual([]);
  });

  it('applyAssessment без оценки компании: off, в базу ничего не пишется', async () => {
    const h = createHarness({ directory: 'off' });

    await expect(h.service.applyAssessment(CHAT_ID, null)).resolves.toEqual({ kind: 'off' });

    expect(h.repo.saves).toEqual([]);
  });

  it('applyAssessment сохраняет боли клиента и возвращает off', async () => {
    const h = createHarness({ directory: 'off' });

    const prompt = await h.service.applyAssessment(CHAT_ID, MENTION);

    expect(prompt).toEqual({ kind: 'off' });
    expect(h.repo.current().confirmedPains).toEqual([
      'Пересорт при приёмке',
      'Долгая инвентаризация',
    ]);
    expect(h.repo.saves).toHaveLength(1);
    expect(h.directory.calls).toEqual([]);
  });

  it('applyAssessment объединяет боли с прежними без повторов', async () => {
    const h = createHarness({
      directory: 'off',
      state: makeState({ confirmedPains: ['Пересорт при приёмке', 'Старая боль'] }),
    });

    await h.service.applyAssessment(CHAT_ID, {
      ...MENTION,
      pains: ['ПЕРЕСОРТ при приёмке', 'Новая'],
    });

    expect(h.repo.current().confirmedPains).toEqual([
      'Старая боль',
      'ПЕРЕСОРТ при приёмке',
      'Новая',
    ]);
  });

  it('applyAssessment не записывает название, город и ответ: пишутся только боли', async () => {
    const h = createHarness({ directory: 'off' });

    await h.service.applyAssessment(CHAT_ID, MENTION);

    expect(h.repo.current()).toEqual(
      makeState({ confirmedPains: ['Пересорт при приёмке', 'Долгая инвентаризация'] }),
    );
  });

  it('identifyAfterReply ничего не делает даже при названии со слов клиента', async () => {
    const h = createHarness({
      directory: 'off',
      state: makeState({ statedName: 'Платформа-А', profileKind: 'business', freeStepsAtMs: NOW }),
    });

    await h.service.identifyAfterReply(makeChat());

    expect(h.directory.calls).toEqual([]);
    expect(h.contacts.calls).toEqual([]);
    expect(h.logo.calls).toEqual([]);
    expect(h.repo.saves).toEqual([]);
  });

  it.each(['confirm', 'name', 'none'] as const)('markAsked(%s) ничего не пишет', (question) => {
    const h = createHarness({
      directory: 'off',
      state: makeState({ candidate: makeChatCandidate() }),
    });

    h.service.markAsked(CHAT_ID, question, 'Вы из компании Платформа-А?');

    expect(h.repo.saves).toEqual([]);
  });

  it('summary: статус off, о компании ничего, боли клиента из базы', () => {
    const h = createHarness({
      directory: 'off',
      emailUiUrl: 'http://127.0.0.1:8000',
      state: makeState({
        confirmed: makeConfirmed({ brief: makeBrief(), briefAtMs: NOW }),
        confirmedPains: ['Пересорт при приёмке'],
        statedName: 'Платформа-А',
      }),
    });

    expect(h.service.summary(CHAT_ID)).toEqual({
      status: 'off',
      companyId: null,
      name: null,
      city: null,
      rubric: null,
      candidateSource: null,
      cardUrl: null,
      confirmedPains: ['Пересорт при приёмке'],
      briefPains: [],
      emailed: null,
      research: null,
      statedName: null,
    });
  });

  it('summary чата без записи: off и пустые боли', () => {
    const h = createHarness({ directory: 'off' });

    expect(h.service.summary(CHAT_ID)).toMatchObject({ status: 'off', confirmedPains: [] });
  });

  it('сбой базы при сохранении болей пробрасывается отказом промиса, а не пропадает', async () => {
    const h = createHarness({ directory: 'off' });
    const failure = new Error('база недоступна');
    h.repo.failNext('save', failure);

    await expect(h.service.applyAssessment(CHAT_ID, MENTION)).rejects.toBe(failure);
  });

  it('сбой базы при чтении болей тоже отказ промиса', async () => {
    const h = createHarness({ directory: 'off' });
    const failure = new Error('база недоступна');
    h.repo.failNext('get', failure);

    await expect(h.service.applyAssessment(CHAT_ID, MENTION)).rejects.toBe(failure);
  });
});
