import { describe, expect, it, vi, type Mock } from 'vitest';
import type {
  AudioClip,
  Chat,
  ChatId,
  LlmResult,
  PhoneDigits,
  ReplyDraft,
  ReviewedText,
  ReviewResult,
  WaMessageId,
} from '../../../src/domain/types.js';
import type { HandOffRequest } from '../../../src/handoff/handoff.js';
import type { SendBlocked } from '../../../src/messaging/outbox.js';
import {
  SEND_RETRY_DELAY_MS,
  type PipelineDeps,
  type PipelineOutcome,
} from '../../../src/pipeline/handle-inbound.js';
import { MAX_AUDIO_BYTES } from '../../../src/voice/transcriber.js';
import {
  ALLOWLIST,
  answer,
  ANSWER,
  assessed,
  batchOf,
  CHAT_ID,
  chatWith,
  CHECKED_STEPS,
  EMPTY_PROFILE,
  handoffAnswer,
  HISTORY,
  HOT_TEXT,
  JID,
  levels,
  MIME,
  NOW,
  picture,
  REPLY_STEPS,
  run,
  SECOND_HOT_TEXT,
  SEND_STEPS,
  setup,
  text,
  TYPING_MS,
  voice,
  type JoinStep,
} from './inbound-harness.js';

// Конвейер на поддельных зависимостях (стенд inbound-harness.ts): порядок шагов виден по журналу calls.

describe('pipeline/handle-inbound: статус, закрытый режим и пустые пачки', () => {
  it('чат ведёт менеджер: бот молчит, не отмечает прочитанным и не зовёт LLM', async () => {
    const h = setup({ status: 'manager' });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(h.calls).toEqual([]);
  });

  it('чата с этим ID нет (слит с другим): ищется по адресу; не нашёлся => молчит', async () => {
    const survivor: Chat = { ...chatWith('bot'), id: 9 as ChatId };
    const found = setup({ status: null, found: survivor });
    const lost = setup({ status: null, found: null });

    await expect(run(found, batchOf([text('A1')]))).resolves.toEqual({ kind: 'replied' });
    expect(found.outbox.sendBotReply).toHaveBeenCalledWith(survivor.id, ANSWER, 'A1');
    await expect(run(lost, batchOf([text('A1')]))).resolves.toEqual({
      kind: 'silent',
      reason: 'no_chat',
    });
    expect(lost.calls).toEqual([]);
  });

  it.each<[string, ReadonlySet<PhoneDigits>, Chat]>([
    ['номер не из списка', new Set(['77000000009' as PhoneDigits]), chatWith('bot')],
    [
      'только @lid, номер неизвестен',
      ALLOWLIST,
      { ...chatWith('bot'), identity: { replyJid: JID, lidJid: JID, pnJid: null } },
    ],
  ])(
    'закрытый режим (%s): до оплачиваемых вызовов отказ, без расшифровки, прочтения и LLM',
    async (_case, testAllowlist, chat) => {
      const h = setup({ status: null, found: chat, testAllowlist });

      const outcome = await run(h, batchOf([voice('V1'), text('A1')]));

      expect(outcome).toEqual({ kind: 'blocked', reason: 'skipped_test_mode' });
      expect(h.calls).toEqual([]);
    },
  );

  it('пачка без текста и голосовых (картинка) или пустая: без LLM и без отметки прочтения', async () => {
    const h = setup();

    await expect(run(h, batchOf([picture('P1')]))).resolves.toEqual({
      kind: 'silent',
      reason: 'no_text',
    });
    await expect(run(h, batchOf([]))).resolves.toEqual({ kind: 'silent', reason: 'no_text' });
    expect(h.calls).toEqual([]);
  });

  it.each<[JoinStep, string[]]>([
    ['read', ['read:A1']],
    ['draft', ['read:A1', ...CHECKED_STEPS]],
  ])('человек подключился (шаг %s): статус перечитан, дальше бот молчит', async (joinOn, steps) => {
    const h = setup({ joinOn });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(h.calls).toEqual(steps);
  });
});

describe('pipeline/handle-inbound: ответ', () => {
  it('answer: прочтение, «печатает» с паузой по тексту, ответ на последнее сообщение, «отвечено»', async () => {
    const h = setup();

    const outcome = await run(h, batchOf([text('A1'), picture('P2')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.calls).toEqual(['read:A1,P2', ...REPLY_STEPS('P2')]);
    // Блок о компании из company.prepare: выключенное определение даёт off, агент тогда работает как раньше.
    expect(h.contexts).toEqual([
      {
        chatId: CHAT_ID,
        history: HISTORY,
        profile: EMPTY_PROFILE,
        level: 'cold',
        company: { kind: 'off' },
      },
    ]);
    expect(h.logs).toContainEqual({
      level: 'info',
      context: { chatId: CHAT_ID, outcome: 'replied' },
    });
  });

  it('новые сообщения, пока писался черновик: перегенерация один раз, без «печатает» для старого', async () => {
    const h = setup({ drafts: [answer('Первый черновик'), answer()] });

    const outcome = await run(h, batchOf([text('A1')], [[text('A2')], [text('A3')]]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.calls).toEqual(['read:A1', 'draft', 'assess', 'read:A2', ...REPLY_STEPS('A2')]);
    expect(h.outbox.sendBotReply).toHaveBeenCalledTimes(1);
  });

  it('новое сообщение во время «печатает»: черновик перегенерируется, уходит один ответ', async () => {
    const h = setup({ drafts: [answer('Первый черновик'), answer()] });

    const outcome = await run(h, batchOf([text('A1')], [[], [text('A2')]]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.calls).toEqual([
      'read:A1',
      ...CHECKED_STEPS,
      'typing:on',
      `sleep:${TYPING_MS + 1}`,
      'typing:off',
      'read:A2',
      ...REPLY_STEPS('A2'),
    ]);
  });

  it.each<[string, Awaited<ReturnType<PipelineDeps['outbox']['sendBotReply']>>, PipelineOutcome]>([
    ['уже отвечено', 'skipped_no_inbound', { kind: 'silent', reason: 'duplicate' }],
    ['чат у менеджера', 'skipped_manager', { kind: 'silent', reason: 'manager_mode' }],
    [
      'лимит исходящих',
      'skipped_limit' satisfies SendBlocked,
      { kind: 'blocked', reason: 'skipped_limit' },
    ],
  ])('outbox не отправил (%s): итог без «отвечено»', async (_case, result, expected) => {
    const h = setup();
    h.outbox.sendBotReply.mockResolvedValue(result);

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual(expected);
    expect(h.calls).not.toContain('answered:A1');
  });

  it('без закрытого режима ответ проходит те же проверки и уходит', async () => {
    const h = setup({ testAllowlist: null });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.calls).toEqual(['read:A1', ...REPLY_STEPS('A1')]);
  });

  it('сбой отметки прочтения и «печатает» не мешает ответу: пишется в лог', async () => {
    const h = setup();
    h.inbox.markRead.mockRejectedValue(new Error('сокет закрыт'));
    h.setTyping.mockRejectedValue(new Error('сокет закрыт'));

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.outbox.sendBotReply).toHaveBeenCalledTimes(1);
    expect(levels(h, 'warn')).toHaveLength(3);
  });

  it('пауза прервана (остановка): «печатает» снимается, ответ не уходит, сбой наружу', async () => {
    const h = setup();
    h.deps.clock.sleep = () => Promise.reject(new Error('Пауза прервана'));

    await expect(run(h, batchOf([text('A1')]))).rejects.toThrow('Пауза прервана');

    expect(h.calls).toEqual(['read:A1', ...CHECKED_STEPS, 'typing:on', 'typing:off']);
  });
});

describe('pipeline/handle-inbound: сбой отправки исключением', () => {
  it('ответ не ушёл (сокет закрыт при переподключении): один повтор после паузы', async () => {
    const h = setup();
    h.outbox.sendBotReply.mockRejectedValueOnce(new Error('Connection Closed'));

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.outbox.sendBotReply).toHaveBeenCalledTimes(2);
    expect(h.calls).toContain(`sleep:${SEND_RETRY_DELAY_MS}`);
    expect(h.calls).toContain('answered:A1');
  });

  it('и повтор не ушёл: клиент остался без ответа, ошибка в лог без номера и текста', async () => {
    const h = setup();
    h.outbox.sendBotReply.mockRejectedValue(new Error('Connection Closed'));

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'send_failed' });
    expect(h.outbox.sendBotReply).toHaveBeenCalledTimes(2);
    expect(levels(h, 'error')).toEqual([{ chatId: CHAT_ID, errorName: 'Error' }]);
    expect(h.calls).not.toContain('answered:A1');
  });

  it('фраза про голосовое не ушла: клиент остался без ответа', async () => {
    const h = setup();
    h.outbox.sendVoiceNotice.mockRejectedValue(new Error('Connection Closed'));

    const outcome = await run(h, batchOf([voice('V1')]));

    expect(outcome).toEqual({ kind: 'send_failed' });
    expect(levels(h, 'error')).toHaveLength(1);
  });
});

describe('pipeline/handle-inbound: передача менеджеру (через сервис передачи)', () => {
  it.each<[string, ReplyDraft, HandOffRequest]>([
    [
      'нет ответа в знаниях, текста нет',
      { outcome: 'no_answer', text: '' },
      { reason: 'no_answer', replyToWaId: 'A2' as WaMessageId },
    ],
    [
      'просит человека, текста нет',
      { outcome: 'asked_human', text: '' },
      { reason: 'asked_human', replyToWaId: 'A2' as WaMessageId },
    ],
    [
      'горячий клиент, текста нет',
      { outcome: 'hot', text: '' },
      { reason: 'hot', replyToWaId: 'A2' as WaMessageId },
    ],
    [
      'жалоба с просьбой не писать',
      { outcome: 'complaint', stopRequested: true },
      { reason: 'complaint', stopRequested: true, replyToWaId: 'A2' as WaMessageId },
    ],
  ])(
    '%s: handOff с причиной и ответом на последнее сообщение пачки',
    async (_case, draft, request) => {
      const h = setup({ drafts: [{ ok: true, value: draft }] });

      const outcome = await run(h, batchOf([text('A1'), text('A2')]));

      expect(outcome).toEqual({ kind: 'handed_off', reason: draft.outcome });
      expect(h.handOff).toHaveBeenCalledWith(CHAT_ID, request);
      expect(h.calls).toEqual([
        'read:A1,A2',
        'draft',
        'assess',
        'save:cold',
        // Передача hot: уровень hot дописывается в чат до передачи.
        ...(draft.outcome === 'hot' ? ['save:hot'] : []),
        `handoff:${draft.outcome}`,
        'answered:A2',
      ]);
    },
  );

  it('дневной лимит API: handOff limit со scope, без фразы клиенту и без «отвечено»', async () => {
    const h = setup({ drafts: [{ ok: false, failure: 'budget_exceeded', scope: 'chat' }] });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'limit' });
    expect(h.handOff).toHaveBeenCalledWith(CHAT_ID, { reason: 'limit', scope: 'chat' });
    expect(h.calls).toEqual(['read:A1', 'draft', 'assess', 'save:cold', 'handoff:limit']);
    expect(levels(h, 'warn')).toContainEqual({ chatId: CHAT_ID, scope: 'chat' });
  });

  it.each(['unavailable', 'invalid_output', 'refusal'] as const)(
    'сбой LLM (%s): handOff llm_error с ответом на последнее сообщение',
    async (failure) => {
      const h = setup({ drafts: [{ ok: false, failure }] });

      const outcome = await run(h, batchOf([text('A1')]));

      expect(outcome).toEqual({ kind: 'handed_off', reason: 'llm_error' });
      expect(h.handOff).toHaveBeenCalledWith(CHAT_ID, {
        reason: 'llm_error',
        replyToWaId: 'A1',
      });
      expect(h.calls).toEqual([
        'read:A1',
        'draft',
        'assess',
        'save:cold',
        'handoff:llm_error',
        'answered:A1',
      ]);
      expect(levels(h, 'warn')).toContainEqual({ chatId: CHAT_ID, failure });
    },
  );

  it.each<[string, LlmResult<ReplyDraft>]>([
    ['нет ответа', { ok: true, value: { outcome: 'no_answer', text: '' } }],
    ['лимит', { ok: false, failure: 'budget_exceeded', scope: 'global' }],
  ])(
    'чат ушёл менеджеру, пока шёл вызов LLM (%s): статус не перезаписан, фразы нет',
    async (_case, draft) => {
      const h = setup({ joinOn: 'draft', drafts: [draft] });

      const outcome = await run(h, batchOf([text('A1')]));

      expect(outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
      expect(h.calls).toEqual(['read:A1', 'draft', 'assess', 'save:cold']);
      expect(h.handOff).not.toHaveBeenCalled();
    },
  );

  it.each<[string, LlmResult<ReplyDraft>, string]>([
    ['с фразой клиенту', { ok: true, value: { outcome: 'asked_human', text: '' } }, 'asked_human'],
    ['лимит без фразы', { ok: false, failure: 'budget_exceeded', scope: 'global' }, 'limit'],
  ])(
    'передача не записана (%s): ошибка в лог без текста, итог handoff_failed, «отвечено» не ставится',
    async (_case, draft, reason) => {
      const h = setup({ drafts: [draft], handOffFails: new TypeError('база недоступна') });

      const outcome = await run(h, batchOf([text('A1')]));

      expect(outcome).toEqual({ kind: 'handoff_failed', reason });
      expect(levels(h, 'error')).toEqual([{ chatId: CHAT_ID, reason, errorName: 'TypeError' }]);
      expect(h.calls).not.toContain('answered:A1');
    },
  );
});

describe('pipeline/handle-inbound: проверки, оценка интереса и повтор (этап 4)', () => {
  const DASHED = 'Учёт — это просто. Что вы храните?';
  const SECOND = 'Цена зависит от задачи. Что вы хотите учитывать?';

  it('оценка интереса hot сама чат не передаёт: черновик answer проходит проверки и уходит как обычный ответ', async () => {
    const h = setup({ assessment: assessed('hot') });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.calls).toEqual([
      'read:A1',
      'draft',
      'assess',
      'save:hot',
      'review',
      ...SEND_STEPS('A1'),
    ]);
    expect(h.handOff).not.toHaveBeenCalled();
    expect(h.reviewKinds).toEqual(['answer']);
  });

  it('горячий клиент по решению вызова ответа: сообщение прошло проверки, handOff hot с этим текстом, больше клиенту ничего', async () => {
    const h = setup({ drafts: [handoffAnswer('hot', HOT_TEXT)] });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(h.calls).toEqual([
      'read:A1',
      'draft',
      'assess',
      'save:cold',
      'review',
      'save:hot',
      'handoff:hot',
      'answered:A1',
    ]);
    expect(h.handOff).toHaveBeenCalledTimes(1);
    expect(h.handOff).toHaveBeenCalledWith(CHAT_ID, {
      reason: 'hot',
      replyToWaId: 'A1',
      text: HOT_TEXT as ReviewedText,
    });
    expect(h.reviewed).toEqual([HOT_TEXT]);
    expect(h.reviewKinds).toEqual(['handoff']);
    expect(h.outbox.sendBotReply).not.toHaveBeenCalled();
    expect(h.setTyping).not.toHaveBeenCalled();
  });

  it.each(['no_answer', 'asked_human'] as const)(
    '%s с текстом: проверки как у сообщения о передаче, handOff с причиной и этим текстом',
    async (reason) => {
      const h = setup({ drafts: [handoffAnswer(reason, HOT_TEXT)] });

      const outcome = await run(h, batchOf([text('A1'), text('A2')]));

      expect(outcome).toEqual({ kind: 'handed_off', reason });
      expect(h.handOff).toHaveBeenCalledWith(CHAT_ID, {
        reason,
        replyToWaId: 'A2',
        text: HOT_TEXT as ReviewedText,
      });
      expect(h.reviewKinds).toEqual(['handoff']);
    },
  );

  it('текст передачи не прошёл ревью дважды: handOff с той же причиной и без текста, клиенту фиксированная фраза', async () => {
    const failed: LlmResult<ReviewResult> = { ok: true, value: { ok: false, problems: ['срок'] } };
    const h = setup({
      drafts: [handoffAnswer('hot', HOT_TEXT), handoffAnswer('hot', SECOND_HOT_TEXT)],
      reviews: [failed],
    });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(h.handOff).toHaveBeenCalledWith(CHAT_ID, { reason: 'hot', replyToWaId: 'A1' });
    expect(h.feedbacks[1]).toEqual(['срок']);
    expect(h.reviewKinds).toEqual(['handoff', 'handoff']);
  });

  it('сбой ревью текста передачи: handOff с той же причиной и без текста', async () => {
    const h = setup({
      drafts: [handoffAnswer('asked_human', HOT_TEXT)],
      reviews: [{ ok: false, failure: 'unavailable' }],
    });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'asked_human' });
    expect(h.handOff).toHaveBeenCalledWith(CHAT_ID, { reason: 'asked_human', replyToWaId: 'A1' });
  });

  it('лимит API на ревью текста передачи: handOff limit без фразы клиенту', async () => {
    const h = setup({
      drafts: [handoffAnswer('hot', HOT_TEXT)],
      reviews: [{ ok: false, failure: 'budget_exceeded', scope: 'chat' }],
    });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'limit' });
    expect(h.handOff).toHaveBeenCalledWith(CHAT_ID, { reason: 'limit', scope: 'chat' });
  });

  it('новые сообщения, пока шла проверка текста передачи: пачка обрабатывается заново один раз, передача уходит с новым текстом', async () => {
    const h = setup({
      drafts: [handoffAnswer('hot', HOT_TEXT), handoffAnswer('hot', SECOND_HOT_TEXT)],
    });

    const outcome = await run(h, batchOf([text('A1')], [[], [text('A2')]]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(h.handOff).toHaveBeenCalledTimes(1);
    expect(h.handOff).toHaveBeenCalledWith(CHAT_ID, {
      reason: 'hot',
      replyToWaId: 'A2',
      text: SECOND_HOT_TEXT as ReviewedText,
    });
    expect(h.calls.filter((call) => call.startsWith('draft'))).toEqual(['draft', 'draft']);
  });

  it('человек подключился, пока шла проверка текста передачи: бот молчит, handOff не зовётся', async () => {
    const h = setup({ drafts: [handoffAnswer('hot', HOT_TEXT)], joinOn: 'draft' });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(h.handOff).not.toHaveBeenCalled();
  });

  it('горячий клиент с голосовым в пачке: фразы про голосовое нет, только сообщение передачи', async () => {
    const h = setup({ drafts: [handoffAnswer('hot', HOT_TEXT)] });

    const outcome = await run(h, batchOf([text('T1'), voice('V1')]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'hot' });
    expect(h.outbox.sendVoiceNotice).not.toHaveBeenCalled();
    expect(h.handOff).toHaveBeenCalledWith(CHAT_ID, {
      reason: 'hot',
      replyToWaId: 'V1',
      text: HOT_TEXT as ReviewedText,
    });
  });

  it('передача с текстом не записалась: ошибка в лог без текста, итог handoff_failed, «отвечено» не ставится', async () => {
    const h = setup({
      drafts: [handoffAnswer('hot', HOT_TEXT)],
      handOffFails: new TypeError('база недоступна'),
    });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'handoff_failed', reason: 'hot' });
    expect(levels(h, 'error')).toEqual([
      { chatId: CHAT_ID, reason: 'hot', errorName: 'TypeError' },
    ]);
    expect(JSON.stringify(h.logs)).not.toContain('интеграцию');
    expect(h.calls).not.toContain('answered:A1');
  });

  it('нарушение проверок кодом: повтор с замечаниями, клиенту уходит только второй черновик', async () => {
    const h = setup({ drafts: [answer(DASHED), answer(SECOND)] });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.calls).toEqual([
      'read:A1',
      'draft',
      'assess',
      'save:cold',
      'draft:retry',
      'review',
      'typing:on',
      `sleep:${TYPING_MS + 1}`,
      'typing:off',
      `reply:${SECOND}:A1`,
      'answered:A1',
    ]);
    expect(h.feedbacks[0]).toBeUndefined();
    expect(h.feedbacks[1]?.[0]).toContain('тире');
    expect(h.outbox.sendBotReply).toHaveBeenCalledTimes(1);
  });

  it('ревью не пропустило два раза: передача check_failed с фразой, текст модели не уходит', async () => {
    const failed: LlmResult<ReviewResult> = { ok: true, value: { ok: false, problems: ['срок'] } };
    const h = setup({ drafts: [answer(), answer(SECOND)], reviews: [failed] });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'check_failed' });
    expect(h.calls).toEqual([
      'read:A1',
      'draft',
      'assess',
      'save:cold',
      'review',
      'draft:retry',
      'review',
      'handoff:check_failed',
      'answered:A1',
    ]);
    expect(h.handOff).toHaveBeenCalledWith(CHAT_ID, { reason: 'check_failed', replyToWaId: 'A1' });
    expect(h.feedbacks[1]).toEqual(['срок']);
    expect(h.outbox.sendBotReply).not.toHaveBeenCalled();
  });

  it('уходит ровно тот текст, который проверен: после нормализации, и пауза считается по нему', async () => {
    const h = setup({ drafts: [answer('Учёт\u200B подбираем под задачу. Что вы храните?')] });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.reviewed).toEqual([ANSWER]);
    expect(h.calls).toContain(`reply:${ANSWER}:A1`);
    expect(h.calls).toContain(`sleep:${TYPING_MS}`);
  });

  it('сбой ревью: handOff llm_error, текст модели без проверки не уходит', async () => {
    const h = setup({ reviews: [{ ok: false, failure: 'unavailable' }] });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'llm_error' });
    expect(h.outbox.sendBotReply).not.toHaveBeenCalled();
    expect(h.handOff).toHaveBeenCalledWith(CHAT_ID, { reason: 'llm_error', replyToWaId: 'A1' });
  });

  it('лимит API на оценке интереса: handOff limit без фразы клиенту, ответ не уходит', async () => {
    const h = setup({ assessment: { ok: false, failure: 'budget_exceeded', scope: 'global' } });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'limit' });
    expect(h.calls).toEqual(['read:A1', 'draft', 'assess', 'handoff:limit']);
    expect(h.handOff).toHaveBeenCalledWith(CHAT_ID, { reason: 'limit', scope: 'global' });
    expect(levels(h, 'warn')).toContainEqual({ chatId: CHAT_ID, scope: 'global' });
  });

  it('сбой оценки интереса не останавливает ответ: он уходит после проверок, оценка не сохраняется', async () => {
    const h = setup({ assessment: { ok: false, failure: 'unavailable' } });

    const outcome = await run(h, batchOf([text('A1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.calls).toEqual(['read:A1', 'draft', 'assess', 'review', ...SEND_STEPS('A1')]);
  });
});

describe('pipeline/handle-inbound: голосовые', () => {
  type Transcribe = (clip: AudioClip, chatId: ChatId) => Promise<LlmResult<string>>;

  function transcriber(result: LlmResult<string> | Error): {
    readonly enabled: true;
    readonly transcribe: Mock<Transcribe>;
  } {
    return {
      enabled: true,
      transcribe: vi.fn<Transcribe>((clip, chatId) => {
        expect(clip.mimeType).toBe(MIME);
        expect(chatId).toBe(CHAT_ID);
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      }),
    };
  }

  it('расшифровка выключена, только голосовые: одна фраза на пачку, LLM не зовётся', async () => {
    const h = setup();

    const outcome = await run(h, batchOf([voice('V1'), voice('V2')]));

    expect(outcome).toEqual({ kind: 'voice_notice' });
    expect(h.calls).toEqual(['read:V1,V2', 'voice:V2', 'answered:V2']);
  });

  it('живая пачка с текстом и голосовым: черновик answer => фраза про голосовое, потом ответ', async () => {
    const h = setup();

    const outcome = await run(h, batchOf([text('T1'), voice('V1')]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.calls).toEqual(['read:T1,V1', ...CHECKED_STEPS, 'voice:V1', ...SEND_STEPS('V1')]);
  });

  it.each<[string, LlmResult<ReplyDraft>]>([
    ['нет ответа', { ok: true, value: { outcome: 'no_answer', text: '' } }],
    [
      'жалоба, просит не писать',
      { ok: true, value: { outcome: 'complaint', stopRequested: true } },
    ],
    ['сбой LLM', { ok: false, failure: 'unavailable' }],
  ])(
    'пачка с текстом и голосовым, черновик не answer (%s): фразы про голосовое нет',
    async (_case, draft) => {
      const h = setup({ drafts: [draft] });

      const outcome = await run(h, batchOf([text('T1'), voice('V1')]));

      expect(outcome).toMatchObject({ kind: 'handed_off' });
      expect(h.outbox.sendVoiceNotice).not.toHaveBeenCalled();
    },
  );

  it('пачка простоя (сообщения старше двух минут) с текстом: один ответ, без фразы про голосовое', async () => {
    const old = NOW - 3 * 60_000;
    const h = setup();

    const outcome = await run(h, batchOf([voice('V1', old), text('T1', old + 1)]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(h.outbox.sendVoiceNotice).not.toHaveBeenCalled();
  });

  it('фраза про голосовое: outbox ответил «чат у менеджера» => ответа нет', async () => {
    const h = setup();
    h.outbox.sendVoiceNotice.mockResolvedValue('skipped_manager');

    const outcome = await run(h, batchOf([text('T1'), voice('V1')]));

    expect(outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(h.outbox.sendBotReply).not.toHaveBeenCalled();
  });

  it('только голосовое: человек подключился во время прочтения => фразы нет', async () => {
    const h = setup({ joinOn: 'read' });

    const outcome = await run(h, batchOf([voice('V1')]));

    expect(outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(h.outbox.sendVoiceNotice).not.toHaveBeenCalled();
  });

  it('на голосовое уже ответили: фраза не ушла, «отвечено» не ставится', async () => {
    const h = setup();
    h.outbox.sendVoiceNotice.mockResolvedValue('skipped_no_inbound');

    const outcome = await run(h, batchOf([voice('V1')]));

    expect(outcome).toEqual({ kind: 'silent', reason: 'duplicate' });
    expect(h.outbox.sendVoiceNotice).toHaveBeenCalledWith(CHAT_ID, 'V1');
    expect(h.calls).toEqual(['read:V1']);
  });

  it.each([true, false])(
    'расшифровка (записана: %s): скачана с лимитом, сохранена в базе до черновика, история из базы',
    async (saved) => {
      const voiceOnly = transcriber({ ok: true, value: '  Сколько стоит учёт склада?  ' });
      const h = setup({ transcriber: voiceOnly, transcriptSaved: saved });

      const outcome = await run(h, batchOf([voice('V1')]));

      expect(outcome).toEqual({ kind: 'replied' });
      expect(h.inbox.downloadAudio).toHaveBeenCalledWith('V1', MAX_AUDIO_BYTES);
      expect(h.calls).toEqual([
        'download:V1',
        'transcript:V1:Сколько стоит учёт склада?',
        'read:V1',
        ...REPLY_STEPS('V1'),
      ]);
      expect(h.contexts[0]?.history).toBe(HISTORY);
      expect(levels(h, 'warn')).toHaveLength(saved ? 0 : 1);
    },
  );

  it('человек подключился во время расшифровки: ни прочтения, ни LLM', async () => {
    const h = setup({
      transcriber: transcriber({ ok: true, value: 'Здравствуйте' }),
      joinOn: 'transcribe',
    });

    const outcome = await run(h, batchOf([voice('V1')]));

    expect(outcome).toEqual({ kind: 'silent', reason: 'manager_mode' });
    expect(h.calls).toEqual(['download:V1', 'transcript:V1:Здравствуйте']);
  });

  it.each<[string, LlmResult<string> | Error]>([
    ['сбой расшифровки', { ok: false, failure: 'unavailable' }],
    ['пустая расшифровка', { ok: true, value: '   ' }],
    ['исключение расшифровки', new Error('сеть')],
  ])('%s: фраза про голосовое', async (_case, result) => {
    const h = setup({ transcriber: transcriber(result) });

    const outcome = await run(h, batchOf([voice('V1')]));

    expect(outcome).toEqual({ kind: 'voice_notice' });
    expect(h.calls).toEqual(['download:V1', 'read:V1', 'voice:V1', 'answered:V1']);
  });

  it('голосовое не скачалось (нет в памяти): фраза про голосовое, расшифровки нет', async () => {
    const voiceOnly = transcriber({ ok: true, value: 'текст' });
    const h = setup({ transcriber: voiceOnly });
    h.inbox.downloadAudio.mockRejectedValue(new Error('Голосовое не найдено в памяти'));

    const outcome = await run(h, batchOf([voice('V1')]));

    expect(outcome).toEqual({ kind: 'voice_notice' });
    expect(voiceOnly.transcribe).not.toHaveBeenCalled();
  });

  it('лимит на расшифровке: статус manager без фразы, LLM не зовётся', async () => {
    const h = setup({
      transcriber: transcriber({ ok: false, failure: 'budget_exceeded', scope: 'global' }),
    });

    const outcome = await run(h, batchOf([text('T1'), voice('V1')]));

    expect(outcome).toEqual({ kind: 'handed_off', reason: 'limit' });
    expect(h.calls).toEqual(['download:V1', 'handoff:limit']);
    expect(h.handOff).toHaveBeenCalledWith(CHAT_ID, { reason: 'limit', scope: 'global' });
  });

  it('перегенерация: уже расшифрованное не расшифровывается снова, фраза про голосовое одна', async () => {
    const voiceOnly = transcriber({ ok: true, value: 'Расскажите про учёт' });
    const h = setup({ transcriber: voiceOnly });

    const outcome = await run(h, batchOf([voice('V1')], [[text('T2')]]));

    expect(outcome).toEqual({ kind: 'replied' });
    expect(voiceOnly.transcribe).toHaveBeenCalledTimes(1);
    expect(h.outbox.sendVoiceNotice).not.toHaveBeenCalled();
    expect(h.outbox.sendBotReply).toHaveBeenCalledWith(CHAT_ID, ANSWER, 'T2');
  });
});
