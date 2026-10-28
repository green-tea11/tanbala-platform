import { describe, expect, it } from 'vitest';
import type { CompanyMention, CompanyPrompt, CompanyTurn } from '../../../src/domain/company.js';
import type {
  InterestAssessment,
  LlmResult,
  PhoneDigits,
  ReplyDraft,
} from '../../../src/domain/types.js';
import type { PipelineDeps, PipelineOutcome } from '../../../src/pipeline/handle-inbound.js';
import {
  ANSWER,
  answer,
  batchOf,
  CHAT_ID,
  chatWith,
  EMPTY_PROFILE,
  levels,
  run,
  SEND_STEPS,
  setup,
  text,
  voice,
  type Harness,
} from './inbound-harness.js';

// Конвейер и сервис компании: порядок вызовов prepare, оценки, applyAssessment, черновика, markAsked и
// identifyAfterReply. Сервис поддельный (стенд inbound-harness.ts), его вызовы пишутся в общий журнал calls.

const ASKED: CompanyPrompt = { kind: 'asked', name: 'ТОО Склад', city: 'Алматы' };
const CANDIDATE: CompanyPrompt = {
  kind: 'candidate',
  name: 'ТОО Склад',
  city: 'Алматы',
  withCity: false,
};
const CONFIRMED: CompanyPrompt = {
  kind: 'confirmed',
  name: 'ТОО Склад',
  rubric: 'Склады',
  pains: ['Пересорт при отгрузке'],
  emailed: false,
};
const SEARCHING: CompanyPrompt = { kind: 'searching' };
const AWAITING: CompanyTurn = { prompt: ASKED, awaitingAnswer: true };
const USUAL: CompanyTurn = { prompt: CANDIDATE, awaitingAnswer: false };

const YES: CompanyMention = { name: null, city: null, answer: 'yes', pains: ['Пересорт'] };
const NAMED: CompanyMention = { name: 'ТОО Склад', city: 'Алматы', answer: 'none', pains: [] };

function assessedWith(company: CompanyMention): LlmResult<InterestAssessment> {
  return {
    ok: true,
    value: { level: 'cold', profile: EMPTY_PROFILE, reason: 'по разговору', company },
  };
}

function asking(question: 'confirm' | 'name', value: string = ANSWER): LlmResult<ReplyDraft> {
  return { ok: true, value: { outcome: 'answer', text: value, companyQuestion: question } };
}

/** Вызовы сервиса компании в общий журнал; applyAssessment отдаёт applied. */
function journal(h: Harness, turn: CompanyTurn, applied: CompanyPrompt): void {
  h.company.prepare.mockImplementation(() => {
    h.calls.push('prepare');
    return Promise.resolve(turn);
  });
  h.company.applyAssessment.mockImplementation((_chatId, mention) => {
    h.calls.push(`apply:${mention?.answer ?? 'null'}`);
    return Promise.resolve(applied);
  });
  h.company.markAsked.mockImplementation((_chatId, question) => {
    h.calls.push(`asked:${question}`);
  });
  h.company.identifyAfterReply.mockImplementation(() => {
    h.calls.push('identify');
    return Promise.resolve();
  });
}

function companyUntouched(h: Harness): void {
  expect(h.company.prepare).not.toHaveBeenCalled();
  expect(h.company.applyAssessment).not.toHaveBeenCalled();
  expect(h.company.markAsked).not.toHaveBeenCalled();
  expect(h.company.identifyAfterReply).not.toHaveBeenCalled();
}

describe('pipeline/handle-inbound и компания: порядок хода', () => {
  it('бот ждёт ответа на «Вы из компании X?»: сначала оценка, затем applyAssessment, затем черновик с новым блоком', async () => {
    const h = setup({ assessment: assessedWith(YES) });
    journal(h, AWAITING, CONFIRMED);

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.calls).toEqual([
      'read:A1',
      'prepare',
      'assess',
      'apply:yes',
      'draft',
      'save:cold',
      'review',
      ...SEND_STEPS('A1'),
      'asked:none',
      'identify',
    ]);
    expect(h.company.applyAssessment).toHaveBeenCalledWith(CHAT_ID, YES);
    // Оценка видит вопрос о кандидате, ответ на «да» и его проверка уже видят справку.
    expect(h.assessContexts.map((context) => context.company)).toEqual([ASKED]);
    expect(h.contexts.map((context) => context.company)).toEqual([CONFIRMED]);
    expect(h.reviewContexts.map((context) => context.company)).toEqual([CONFIRMED]);
  });

  it('обычный ход: черновик и оценка параллельно, applyAssessment до решения, проверка с блоком черновика', async () => {
    const h = setup({ assessment: assessedWith(NAMED) });
    journal(h, USUAL, SEARCHING);

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.calls).toEqual([
      'read:A1',
      'prepare',
      'draft',
      'assess',
      'apply:none',
      'save:cold',
      'review',
      ...SEND_STEPS('A1'),
      'asked:none',
      'identify',
    ]);
    expect(h.company.prepare).toHaveBeenCalledWith(chatWith('bot'), [text('A1')]);
    expect(h.company.applyAssessment).toHaveBeenCalledWith(CHAT_ID, NAMED);
    // Новый блок после applyAssessment уйдёт в следующий ход: проверка судит с теми же данными, что и черновик.
    expect(h.contexts.map((context) => context.company)).toEqual([CANDIDATE]);
    expect(h.assessContexts.map((context) => context.company)).toEqual([CANDIDATE]);
    expect(h.reviewContexts.map((context) => context.company)).toEqual([CANDIDATE]);
  });

  it.each<[string, LlmResult<InterestAssessment>]>([
    [
      'оценка без данных о компании',
      { ok: true, value: { level: 'warm', profile: EMPTY_PROFILE, reason: 'r' } },
    ],
    ['сбой оценки', { ok: false, failure: 'unavailable' }],
  ])('%s: applyAssessment получает null, ответ уходит', async (_case, assessment) => {
    const h = setup({ assessment });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.company.applyAssessment).toHaveBeenCalledWith(CHAT_ID, null);
  });

  it('ждём ответа, а оценка упала исключением: предупреждение, applyAssessment(null), черновик всё равно пишется', async () => {
    const h = setup({ companyTurn: AWAITING });
    h.deps.agent.assessInterest = () => Promise.reject(new TypeError('сбой'));

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.company.applyAssessment).toHaveBeenCalledWith(CHAT_ID, null);
    expect(levels(h, 'warn')).toContainEqual({ chatId: CHAT_ID, errorName: 'TypeError' });
    expect(h.contexts.map((context) => context.company)).toEqual([ASKED]);
  });

  it('ждём ответа, а черновик упал исключением: оно уходит наружу, как без компании', async () => {
    const h = setup({ companyTurn: AWAITING });
    h.deps.agent.draftReply = () => Promise.reject(new Error('черновик упал'));

    await expect(run(h, batchOf([text('A1')]))).rejects.toThrow('черновик упал');
    expect(h.company.markAsked).not.toHaveBeenCalled();
    expect(h.company.identifyAfterReply).not.toHaveBeenCalled();
  });

  it('человек подключился, пока шёл prepare: статус перечитан, без LLM, вопроса и поиска', async () => {
    const h = setup({ joinOn: 'prepare' });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(h.calls).toEqual(['read:A1']);
    expect(h.company.prepare).toHaveBeenCalledTimes(1);
    expect(h.company.applyAssessment).not.toHaveBeenCalled();
    expect(h.company.identifyAfterReply).not.toHaveBeenCalled();
  });

  it('новые сообщения во время черновика: ход повторяется с prepare, поиск после ответа один', async () => {
    const h = setup({ drafts: [answer('Первый черновик'), answer()] });

    const outcome = await run(h, batchOf([text('A1')], [[text('A2')]]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.company.prepare).toHaveBeenCalledTimes(2);
    expect(h.company.prepare).toHaveBeenLastCalledWith(chatWith('bot'), [text('A1'), text('A2')]);
    expect(h.company.markAsked).toHaveBeenCalledTimes(1);
    expect(h.company.identifyAfterReply).toHaveBeenCalledTimes(1);
  });
});

describe('pipeline/handle-inbound и компания: закрытый режим', () => {
  it('чат вне TEST_ALLOWLIST: сервис компании не вызывается совсем', async () => {
    const h = setup({ testAllowlist: new Set(['77000000009' as PhoneDigits]) });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'blocked', reason: 'skipped_test_mode' });
    companyUntouched(h);
  });
});

describe('pipeline/handle-inbound и компания: вопрос о компании запоминается только после отправки', () => {
  it.each(['confirm', 'name'] as const)(
    'ответ с вопросом %s ушёл: markAsked с ним после «отвечено»',
    async (question) => {
      const h = setup({ drafts: [asking(question)] });
      journal(h, USUAL, CANDIDATE);

      await run(h, batchOf([text('A1')]));

      expect(h.company.markAsked).toHaveBeenCalledWith(CHAT_ID, question);
      expect(h.calls.slice(-3)).toEqual(['answered:A1', `asked:${question}`, 'identify']);
    },
  );

  it('повтор после проверки: запоминается вопрос того черновика, чей текст ушёл', async () => {
    const h = setup({
      drafts: [asking('confirm'), asking('name')],
      reviews: [
        { ok: true, value: { ok: false, problems: ['Нет в знаниях'] } },
        { ok: true, value: { ok: true } },
      ],
    });

    await run(h, batchOf([text('A1')]));

    expect(h.company.markAsked.mock.calls).toEqual([[CHAT_ID, 'name']]);
  });

  it.each<[string, Awaited<ReturnType<PipelineDeps['outbox']['sendBotReply']>>, PipelineOutcome]>([
    ['уже отвечено', 'skipped_no_inbound', { kind: 'silent', reason: 'duplicate' }],
    ['чат у менеджера', 'skipped_manager', { kind: 'silent', reason: 'manager_mode' }],
    ['лимит исходящих', 'skipped_limit', { kind: 'blocked', reason: 'skipped_limit' }],
  ])('ответ не ушёл (%s): ни markAsked, ни поиска', async (_case, result, expected) => {
    const h = setup({ drafts: [asking('confirm')] });
    h.outbox.sendBotReply.mockResolvedValue(result);

    await expect(run(h, batchOf([text('A1')]))).resolves.toEqual(expected);

    expect(h.company.markAsked).not.toHaveBeenCalled();
    expect(h.company.identifyAfterReply).not.toHaveBeenCalled();
  });

  it('отправка упала и после повтора: ни markAsked, ни поиска', async () => {
    const h = setup({ drafts: [asking('confirm')] });
    h.outbox.sendBotReply.mockRejectedValue(new Error('Connection Closed'));

    await expect(run(h, batchOf([text('A1')]))).resolves.toEqual({ kind: 'send_failed' });

    expect(h.company.markAsked).not.toHaveBeenCalled();
    expect(h.company.identifyAfterReply).not.toHaveBeenCalled();
  });
});

describe('pipeline/handle-inbound и компания: поиск после ответа', () => {
  it('итог replied: identifyAfterReply с текущим чатом', async () => {
    const h = setup();

    await run(h, batchOf([text('A1')]));

    expect(h.company.identifyAfterReply).toHaveBeenCalledWith(chatWith('bot'));
  });

  it('исключение поиска: предупреждение с ID чата и именем ошибки, итог replied', async () => {
    const h = setup();
    h.company.identifyAfterReply.mockRejectedValue(new TypeError('база недоступна'));

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(levels(h, 'warn')).toEqual([{ chatId: CHAT_ID, errorName: 'TypeError' }]);
    expect(JSON.stringify(h.logs)).not.toContain('база недоступна');
  });

  it('чат исчез после ответа (слит, по адресу не найден): поиска нет, итог replied', async () => {
    const h = setup();
    const { getById } = h.deps.chats;
    let gone = false;
    h.deps.chats.getById = (id) => (gone ? null : getById(id));
    h.outbox.sendBotReply.mockImplementation(() => {
      gone = true;
      return Promise.resolve('sent');
    });

    await expect(run(h, batchOf([text('A1')]))).resolves.toEqual({ kind: 'replied' });
    expect(h.company.identifyAfterReply).not.toHaveBeenCalled();
  });

  it.each<[string, LlmResult<ReplyDraft>, PipelineOutcome]>([
    [
      'передача hot',
      { ok: true, value: { outcome: 'hot', text: '' } },
      { kind: 'handed_off', reason: 'hot' },
    ],
    [
      'лимит API',
      { ok: false, failure: 'budget_exceeded', scope: 'chat' },
      { kind: 'handed_off', reason: 'limit' },
    ],
  ])('%s: поиска после хода нет, вопрос не запоминается', async (_case, draft, expected) => {
    const h = setup({ drafts: [draft] });

    await expect(run(h, batchOf([text('A1')]))).resolves.toEqual(expected);

    expect(h.company.applyAssessment).toHaveBeenCalledTimes(1);
    expect(h.company.markAsked).not.toHaveBeenCalled();
    expect(h.company.identifyAfterReply).not.toHaveBeenCalled();
  });

  it('только голосовое без расшифровки: фраза про голосовое, сервис компании не вызывается', async () => {
    const h = setup();

    await expect(run(h, batchOf([voice('V1')]))).resolves.toEqual({ kind: 'voice_notice' });

    companyUntouched(h);
  });

  it('чат ведёт менеджер: сервис компании не вызывается', async () => {
    const h = setup({ status: 'manager' });

    await run(h, batchOf([text('A1')]));

    companyUntouched(h);
  });
});
