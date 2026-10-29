import { describe, expect, it, vi, type Mock } from 'vitest';
import type { CompanyFetch } from '../../../src/company-api/directory.js';
import { emptyCompanyState } from '../../../src/db/repos/chat-companies.js';
import type {
  ChatCompaniesRepo,
  ChatCompanyState,
  CompanyId,
  LogoReader,
} from '../../../src/domain/company.js';
import type { Clock, ImageInput, WhatsAppContacts } from '../../../src/domain/ports.js';
import type { Chat, ChatId, InboundMessage, Jid, WaMessageId } from '../../../src/domain/types.js';
import {
  assembleCompany,
  type CompanyConfig,
  type CompanySetup,
} from '../../../src/pipeline/company-setup.js';
import { createFakeLogger, type LogEntry } from '../../helpers/fake-logger.js';

// Сборка определения компании: выключенный и включённый внутренний API, профиль WhatsApp и логотип, которые
// подключаются позже. Сети нет: fetch поддельный, WhatsApp и модель тоже.

const NOW = Date.UTC(2026, 9, 28, 9, 0, 0);
const CHAT_ID = 5 as ChatId;
const JID = '77010000002@s.whatsapp.net' as Jid;
const BASE_URL = 'http://127.0.0.1:8000';
const TOKEN = 'internal-token-0123456789-0123456789-abcdef';
const EMAIL_UI_URL = 'https://mail.example.kz';
const PHOTO: ImageInput = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' };
const CLOCK: Clock = { now: () => NOW, sleep: () => Promise.resolve() };
const OFF: CompanyConfig = { companyApi: null, emailUiUrl: null };
const ON: CompanyConfig = {
  companyApi: { baseUrl: BASE_URL, token: TOKEN },
  emailUiUrl: EMAIL_UI_URL,
};

const CHAT: Chat = {
  id: CHAT_ID,
  identity: { replyJid: JID, lidJid: null, pnJid: JID },
  pushName: null,
  control: { status: 'bot', by: null },
  level: 'cold',
  profile: {
    business: null,
    area: null,
    scope: null,
    itemCount: null,
    has1C: null,
    oneCName: null,
    problem: null,
    specifics: null,
    problemAgreed: false,
  },
};

const MESSAGE: InboundMessage = {
  waId: 'WA-1' as WaMessageId,
  identity: CHAT.identity,
  pushName: null,
  content: { kind: 'text', text: 'Здравствуйте' },
  tsMs: NOW,
};

/** Бизнес-аккаунт, бесплатные шаги пройдены, компания не найдена: следующий шаг логотип. */
const LOGO_STEP: ChatCompanyState = {
  ...emptyCompanyState(CHAT_ID),
  profileKind: 'business',
  freeStepsAtMs: NOW - 60_000,
};

interface Harness {
  readonly setup: CompanySetup;
  readonly logs: LogEntry[];
  readonly states: Map<ChatId, ChatCompanyState>;
  readonly fetch: Mock<CompanyFetch>;
  readonly contacts: {
    readonly businessProfile: Mock<WhatsAppContacts['businessProfile']>;
    readonly profilePhoto: Mock<WhatsAppContacts['profilePhoto']>;
  };
}

function memoryRepo(states: Map<ChatId, ChatCompanyState>): ChatCompaniesRepo {
  return {
    get: (chatId) => states.get(chatId) ?? emptyCompanyState(chatId),
    save: (state) => {
      states.set(state.chatId, state);
    },
    countResearchStarts: (sinceMs) =>
      [...states.values()].filter(
        (state) => state.researchStartedAtMs !== null && state.researchStartedAtMs > sinceMs,
      ).length,
  };
}

function useSetup(config: CompanyConfig, state?: ChatCompanyState): Harness {
  const logs: LogEntry[] = [];
  const states = new Map<ChatId, ChatCompanyState>();
  if (state !== undefined) states.set(state.chatId, state);
  const fetch = vi.fn<CompanyFetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify({ candidates: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  const setup = assembleCompany({
    config,
    logger: createFakeLogger(logs),
    clock: CLOCK,
    repo: memoryRepo(states),
    fetch,
  });
  const contacts = {
    businessProfile: vi.fn<WhatsAppContacts['businessProfile']>(() =>
      Promise.resolve({ kind: 'business', websites: ['https://sklad.kz'], email: null }),
    ),
    profilePhoto: vi.fn<WhatsAppContacts['profilePhoto']>(() => Promise.resolve(PHOTO)),
  };
  return { setup, logs, states, fetch, contacts };
}

function logoReader(name: string | null): Mock<LogoReader['readLogo']> {
  return vi.fn<LogoReader['readLogo']>(() => Promise.resolve({ ok: true, value: name }));
}

describe('pipeline/company-setup: внутренний API выключен', () => {
  it('одна строка в лог «выключено»; сервис отвечает off и никуда не ходит, даже после connect', async () => {
    const h = useSetup(OFF);
    h.setup.connect(h.contacts);

    const turn = await h.setup.service.prepare(CHAT, [MESSAGE]);
    await h.setup.service.identifyAfterReply(CHAT);

    expect(turn).toEqual({ prompt: { kind: 'off' }, awaitingAnswer: false });
    expect(h.setup.service.summary(CHAT_ID).status).toBe('off');
    expect(h.contacts.businessProfile).not.toHaveBeenCalled();
    expect(h.contacts.profilePhoto).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.logs).toEqual([
      {
        level: 'info',
        context: { companyApi: false },
        message: 'Определение компании клиента выключено: INTERNAL_API_TOKEN не задан',
      },
    ]);
  });
});

describe('pipeline/company-setup: внутренний API включён', () => {
  it('строка в лог «включено» без адреса и токена', () => {
    const h = useSetup(ON);

    expect(h.logs).toEqual([
      {
        level: 'info',
        context: { companyApi: true },
        message: 'Определение компании клиента включено: внутренний API почтового проекта',
      },
    ]);
    expect(JSON.stringify(h.logs)).not.toMatch(/127\.0\.0\.1|internal-token/);
  });

  it('после connect профиль собеседника берётся из подключения, запрос к API с адресом и токеном из настроек', async () => {
    const h = useSetup(ON);
    h.setup.connect(h.contacts);

    await h.setup.service.prepare(CHAT, [MESSAGE]);

    expect(h.contacts.businessProfile).toHaveBeenCalledWith(JID);
    const [url, init] = h.fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/internal/lookup?domain=sklad.kz`);
    expect(new Headers(init?.headers).get('X-Internal-Token')).toBe(TOKEN);
    expect(h.states.get(CHAT_ID)?.profileDomain).toBe('sklad.kz');
  });

  it('до connect профиль не запрашивается: failed без исключения, поиск идёт без домена', async () => {
    const h = useSetup(ON);

    await expect(h.setup.service.prepare(CHAT, [MESSAGE])).resolves.toMatchObject({
      awaitingAnswer: false,
    });

    expect(h.contacts.businessProfile).not.toHaveBeenCalled();
    expect(h.states.get(CHAT_ID)?.profileKind).toBe('unknown');
    expect(h.fetch.mock.calls.map(([url]) => url)).toEqual([
      `${BASE_URL}/internal/lookup?phone=77010000002`,
    ]);
  });

  it('новое подключение заменяет прежнее: запросы идут в текущее', async () => {
    const h = useSetup(ON);
    const first = vi.fn<WhatsAppContacts['businessProfile']>(() =>
      Promise.resolve({ kind: 'personal' }),
    );
    h.setup.connect({ businessProfile: first, profilePhoto: () => Promise.resolve(null) });
    h.setup.connect(h.contacts);

    await h.setup.service.prepare(CHAT, [MESSAGE]);

    expect(first).not.toHaveBeenCalled();
    expect(h.contacts.businessProfile).toHaveBeenCalledTimes(1);
  });

  it('логотип без агента (нет ключа Claude): модель не вызывается, шаг заканчивается сбоем disabled', async () => {
    const h = useSetup(ON, LOGO_STEP);
    h.setup.connect(h.contacts);

    await h.setup.service.identifyAfterReply(CHAT);

    expect(h.contacts.profilePhoto).toHaveBeenCalledTimes(1);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        context: { chatId: CHAT_ID, step: 'logo', failure: 'disabled' },
      }),
    );
    expect(h.states.get(CHAT_ID)?.logoCheckedAtMs).toBe(NOW);
  });

  it('после useLogo логотип читает агент: фото профиля из подключения', async () => {
    const h = useSetup(ON, LOGO_STEP);
    const readLogo = logoReader(null);
    h.setup.connect(h.contacts);
    h.setup.useLogo({ readLogo });

    await h.setup.service.identifyAfterReply(CHAT);

    expect(readLogo).toHaveBeenCalledWith(CHAT_ID, PHOTO);
  });

  it('до connect фото профиля нет: модель не вызывается, шаг логотипа отмечен пройденным', async () => {
    const h = useSetup(ON, LOGO_STEP);
    const readLogo = logoReader('ТОО Склад');
    h.setup.useLogo({ readLogo });

    await h.setup.service.identifyAfterReply(CHAT);

    expect(h.contacts.profilePhoto).not.toHaveBeenCalled();
    expect(readLogo).not.toHaveBeenCalled();
    expect(h.states.get(CHAT_ID)?.logoCheckedAtMs).toBe(NOW);
  });

  it('сводка для менеджера с адресом интерфейса почтового проекта (EMAIL_UI_URL)', () => {
    const confirmed: ChatCompanyState = {
      ...emptyCompanyState(CHAT_ID),
      confirmed: {
        id: 42 as CompanyId,
        name: 'ТОО Склад',
        city: 'Алматы',
        confirmedAtMs: NOW,
        brief: null,
        briefAtMs: null,
      },
    };
    const h = useSetup(ON, confirmed);

    expect(h.setup.service.summary(CHAT_ID)).toMatchObject({
      status: 'confirmed',
      cardUrl: `${EMAIL_UI_URL}/companies/42`,
    });
  });
});
