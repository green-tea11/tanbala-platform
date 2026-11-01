import { describe, expect, it, vi } from 'vitest';
import type { ConversationContext } from '../../../src/agent/agent.js';
import type { CompanyPrompt } from '../../../src/domain/company.js';
import type { Logger } from '../../../src/domain/ports.js';
import type {
  ChatId,
  ClientProfile,
  InterestAssessment,
  LlmResult,
  ReplyDraft,
} from '../../../src/domain/types.js';
import {
  draftWithCompany,
  withCompanyFacts,
  type CompanyDraftDeps,
} from '../../../src/pipeline/company-turn.js';

// Подтверждённая компания дополняет выжимку (пункт 5 задания 01.11.2026, ревью H1): город карточки и рубрика в
// пустые поля с пометкой «вероятно», иначе этап, недостающее и финал ждали бы город, а бот спрашивал бы его снова.

const CHAT_ID = 3 as ChatId;

const EMPTY: ClientProfile = {
  business: null,
  items: null,
  packaging: null,
  material: null,
  city: null,
  premises: null,
  area: null,
  scope: null,
  itemCount: null,
  monthlyIntake: null,
  turnover: null,
  passages: null,
  shelfRecount: null,
  currentTracking: null,
  has1C: null,
  oneCName: null,
  problem: null,
  specifics: null,
  problemAgreed: false,
  inferred: [],
};

const CONFIRMED: CompanyPrompt = {
  kind: 'confirmed',
  name: 'Kusto Logistics Management',
  city: 'Алматы',
  rubric: 'Логистические услуги',
  pains: [],
  emailed: false,
  emailTold: false,
};

const ASKED: CompanyPrompt = {
  kind: 'asked',
  name: 'Kusto Logistics Management',
  city: 'Алматы',
  awaitingAnswer: true,
};

describe('withCompanyFacts', () => {
  it('пустые город и бизнес: город карточки и рубрика с пометкой «вероятно»', () => {
    expect(withCompanyFacts(EMPTY, CONFIRMED)).toEqual({
      ...EMPTY,
      business: 'Логистические услуги',
      city: 'Алматы',
      inferred: ['business', 'city'],
    });
  });

  it('слова клиента главнее: заполненное поле и его пометка не меняются', () => {
    const said: ClientProfile = {
      ...EMPTY,
      business: 'логистика',
      city: 'Астана',
      inferred: ['passages'],
    };

    expect(withCompanyFacts(said, CONFIRMED)).toBe(said);
  });

  it('пустое из одних пробелов тоже пустое; пометка не дублируется', () => {
    const blank: ClientProfile = { ...EMPTY, business: 'склад', city: '  ', inferred: ['city'] };

    expect(withCompanyFacts(blank, CONFIRMED)).toEqual({
      ...blank,
      city: 'Алматы',
      inferred: ['city'],
    });
  });

  it.each<CompanyPrompt>([
    ASKED,
    { kind: 'off' },
    { kind: 'searching' },
    { ...CONFIRMED, city: null, rubric: null },
    { ...CONFIRMED, city: ' ', rubric: '' },
  ])('компания не подтверждена или дать нечего ($kind): та же выжимка', (prompt) => {
    expect(withCompanyFacts(EMPTY, prompt)).toBe(EMPTY);
  });
});

function silentLogger(): Logger {
  const noop = (): void => undefined;
  const logger: Logger = {
    level: 'silent',
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    silent: noop,
    child: () => logger,
  };
  return logger;
}

function setup(assessment: LlmResult<InterestAssessment>, applied: CompanyPrompt) {
  const draftReply = vi.fn<CompanyDraftDeps['agent']['draftReply']>(() =>
    Promise.resolve<LlmResult<ReplyDraft>>({
      ok: true,
      value: { outcome: 'answer', text: 'Вопрос?' },
    }),
  );
  const deps: CompanyDraftDeps = {
    agent: {
      draftReply,
      reviewDraft: () => Promise.resolve({ ok: true, value: { ok: true } }),
      assessInterest: () => Promise.resolve(assessment),
    },
    logger: silentLogger(),
    company: { applyAssessment: () => Promise.resolve(applied) },
  };
  return { deps, draftReply };
}

const BASE: ConversationContext = { chatId: CHAT_ID, history: [], profile: EMPTY };

describe('draftWithCompany: клиент подтвердил компанию', () => {
  it('«да»: выжимка оценки (её и сохранят) и выжимка до хода дополнены городом и рубрикой, черновик их видит', async () => {
    const said = { ...EMPTY, items: 'товары клиентов' };
    const { deps, draftReply } = setup(
      { ok: true, value: { level: 'warm', profile: said, reason: 'r' } },
      CONFIRMED,
    );

    const { context, drafted } = await draftWithCompany(deps, BASE, {
      prompt: ASKED,
      awaitingAnswer: true,
    });

    const filled = { business: 'Логистические услуги', city: 'Алматы' };
    expect(drafted.assessment).toEqual({
      ok: true,
      value: {
        level: 'warm',
        profile: { ...said, ...filled, inferred: ['business', 'city'] },
        reason: 'r',
      },
    });
    expect(context).toEqual({
      ...BASE,
      company: CONFIRMED,
      profile: { ...EMPTY, ...filled, inferred: ['business', 'city'] },
    });
    expect(draftReply).toHaveBeenCalledWith({
      ...context,
      profile: { ...said, ...filled, inferred: ['business', 'city'] },
    });
  });

  it('оценка не получилась, компания подтверждена раньше: выжимка до хода дополнена, черновик с пометкой', async () => {
    const { deps, draftReply } = setup({ ok: false, failure: 'unavailable' }, CONFIRMED);

    const { context } = await draftWithCompany(deps, BASE, {
      prompt: CONFIRMED,
      awaitingAnswer: false,
    });

    expect(context.profile).toMatchObject({ city: 'Алматы', inferred: ['business', 'city'] });
    expect(draftReply).toHaveBeenCalledWith({ ...context, profileStale: true });
  });

  it('компания не подтверждена: выжимка как есть', async () => {
    const assessment: LlmResult<InterestAssessment> = {
      ok: true,
      value: { level: 'cold', profile: EMPTY, reason: 'r' },
    };
    const { deps } = setup(assessment, ASKED);

    const { context, drafted } = await draftWithCompany(deps, BASE, {
      prompt: ASKED,
      awaitingAnswer: true,
    });

    expect(drafted.assessment).toBe(assessment);
    expect(context.profile).toBe(EMPTY);
  });
});
