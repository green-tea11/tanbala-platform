import { describe, expect, it } from 'vitest';
import type { ConversationContext } from '../../../src/agent/agent.js';
import { normalizeDraft, runCodeChecks } from '../../../src/checks/code-checks.js';
import type {
  ChatId,
  ClientProfile,
  PhoneDigits,
  StoredMessage,
} from '../../../src/domain/types.js';
import {
  CAP_HANDOFF_TEXT,
  CLIENT_MESSAGES_FOR_HANDOFF,
  MINIMUM_HANDOFF_TEXT,
} from '../../../src/handoff/minimum.js';
import { HOT_PRICE_HANDOFF_TEXT } from '../../../src/messaging/outbox.js';
import {
  answerPartOf,
  autoHandoffOf,
  autoHandoffPhrase,
  clientAsksNow,
  clientMessageCount,
} from '../../../src/pipeline/auto-handoff.js';
import { priceSituation } from '../../../src/pipeline/price-gate.js';

// Передача без вопроса цены (решение владельца 29.10.2026 вечером): минимум собран и чат ещё ни разу не передавался =>
// ход кончается передачей hot. Ответ модели answer превращается в сообщение передачи: из него остаётся только ответ из
// знаний (без вопросов, без фразы об ориентире), если клиент что-то спросил.

const CHAT_ID = 1 as ChatId;

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
  turnover: null,
  currentTracking: null,
  has1C: null,
  oneCName: null,
  problem: null,
  specifics: null,
  problemAgreed: false,
  inferred: [],
};

const FULL: ClientProfile = {
  ...EMPTY,
  business: 'склады и отгрузки',
  items: 'товар',
  packaging: 'паллеты и коробки',
  material: 'металл есть, жидкостей нет',
  itemCount: 'около 5000 в месяц',
  premises: 'склад',
  city: 'Алматы',
  has1C: true,
};

function message(id: number, author: StoredMessage['author'], text: string): StoredMessage {
  return { id, chatId: CHAT_ID, author, kind: 'text', text, tsMs: id };
}

function context(
  profile: ClientProfile,
  extra: Partial<ConversationContext> = {},
): ConversationContext {
  return { chatId: CHAT_ID, history: [], profile, companyName: 'tyri', ...extra };
}

function due(ctx: ConversationContext) {
  const price = priceSituation(ctx, null, { ok: true, value: { outcome: 'answer', text: 'Да.' } });
  return autoHandoffOf(ctx, price);
}

describe('pipeline/auto-handoff: когда ход кончается передачей', () => {
  it('минимум собран, передач не было: передача по минимуму', () => {
    expect(due(context(FULL))).toBe('minimum');
    expect(due(context(FULL, { progress: { priceAsks: 0, refused: false } }))).toBe('minimum');
  });

  it('чат уже передавался (любая причина, в том числе возврат с заметкой или без): сам не передаёт', () => {
    const progress = { priceAsks: 0, refused: false, handedOff: true };
    expect(due(context(FULL, { progress }))).toBeNull();
    expect(due(context(FULL, { progress, note: { text: 'узнай 1С', atMs: 1 } }))).toBeNull();
  });

  it('минимума нет: передачи нет', () => {
    expect(due(context({ ...FULL, city: null }))).toBeNull();
    expect(
      due(context(FULL, { companyName: null, company: { kind: 'unknown', askName: true } })),
    ).toBeNull();
  });
});

describe('pipeline/auto-handoff: пятое сообщение клиента без минимума (решение владельца 29.10.2026 вечером)', () => {
  /** Переписка: n сообщений клиента, после каждого, кроме последнего, ответ бота. */
  function dialog(clientMessages: number): StoredMessage[] {
    return Array.from({ length: clientMessages }, (_, index) => [
      message(index * 2 + 1, 'client', `сообщение ${index + 1}`),
      ...(index + 1 < clientMessages ? [message(index * 2 + 2, 'bot', 'Подскажите?')] : []),
    ]).flat();
  }

  it('предел пять сообщений клиента; считаются только сообщения клиента', () => {
    expect(CLIENT_MESSAGES_FOR_HANDOFF).toBe(5);
    expect(clientMessageCount(dialog(5))).toBe(5);
    expect(clientMessageCount([message(1, 'bot', 'а'), message(2, 'human_phone', 'б')])).toBe(0);
  });

  it('пятое сообщение, минимума нет, передач не было: передача по пределу', () => {
    expect(due(context(EMPTY, { history: dialog(5) }))).toBe('message_cap');
    expect(due(context(EMPTY, { history: dialog(7) }))).toBe('message_cap');
  });

  it('четвёртое сообщение: ещё нет; минимум собран: передача по минимуму, а не по пределу', () => {
    expect(due(context(EMPTY, { history: dialog(4) }))).toBeNull();
    expect(due(context(FULL, { history: dialog(5) }))).toBe('minimum');
  });

  it('чат уже передавался: предел не действует', () => {
    const progress = { priceAsks: 0, refused: false, handedOff: true };
    expect(due(context(EMPTY, { history: dialog(6), progress }))).toBeNull();
  });

  it('фраза передачи по пределу «Спасибо! Уточню у коллеги и вернусь к вам.», при вопросе цены фраза о цене', () => {
    expect(CAP_HANDOFF_TEXT).toBe('Спасибо! Уточню у коллеги и вернусь к вам.');
    expect(autoHandoffPhrase('message_cap', false)).toBe(CAP_HANDOFF_TEXT);
    expect(autoHandoffPhrase('message_cap', true)).toBe(HOT_PRICE_HANDOFF_TEXT);
    expect(
      runCodeChecks(normalizeDraft(CAP_HANDOFF_TEXT), {
        ownPhone: '' as PhoneDigits,
        clientText: '',
      }),
    ).toEqual([]);
  });
});

describe('pipeline/auto-handoff: фраза передачи', () => {
  it('без вопроса цены «Спасибо, этого хватит...», при вопросе цены фраза о цене', () => {
    expect(MINIMUM_HANDOFF_TEXT).toBe(
      'Спасибо, этого хватит, чтобы коллега назвал ориентир. Уточню у коллеги и вернусь к вам.',
    );
    expect(autoHandoffPhrase('minimum', false)).toBe(MINIMUM_HANDOFF_TEXT);
    expect(autoHandoffPhrase('minimum', true)).toBe(HOT_PRICE_HANDOFF_TEXT);
  });

  it('фраза проходит проверки кодом', () => {
    const findings = runCodeChecks(normalizeDraft(MINIMUM_HANDOFF_TEXT), {
      ownPhone: '' as PhoneDigits,
      clientText: '',
    });
    expect(findings).toEqual([]);
  });
});

describe('pipeline/auto-handoff: спрашивает ли клиент что-то сейчас', () => {
  it.each([
    'Компания tyri, занимаемся складами и отгрузками как работает ваше оборудование',
    'А с 1С интегрируется?',
    'Расскажите подробнее',
    'Можно ли клеить на металл',
  ])('«%s»: вопрос', (text) => {
    expect(clientAsksNow([message(1, 'bot', 'Здравствуйте!'), message(2, 'client', text)])).toBe(
      true,
    );
  });

  it.each(['Да обычная 1с', 'Алматы', 'Метал имеется жидкости нет', 'Около 5000 тысяч в месяц'])(
    '«%s»: ответ без вопроса',
    (text) => {
      expect(clientAsksNow([message(1, 'bot', 'Какая 1С?'), message(2, 'client', text)])).toBe(
        false,
      );
    },
  );

  it('считаются только сообщения после последней реплики бота или менеджера', () => {
    const history = [
      message(1, 'client', 'Как это работает?'),
      message(2, 'bot', 'Есть ли у вас 1С?'),
      message(3, 'client', 'Да'),
    ];
    expect(clientAsksNow(history)).toBe(false);
    expect(clientAsksNow([...history, message(4, 'client', 'А сколько стоит?')])).toBe(true);
    expect(
      clientAsksNow([message(2, 'human_panel', 'Добрый день'), message(1, 'client', '?')]),
    ).toBe(false);
  });
});

describe('pipeline/auto-handoff: ответ из черновика answer', () => {
  it('остаются утверждения, без вопросов, фразы об ориентире и фраз передачи', () => {
    expect(
      answerPartOf(
        'Да, мы проводим интеграцию с вашей 1С. Ориентир коллега назовёт, когда поймём ваш объект. Какая у вас конфигурация?',
      ),
    ).toBe('Да, мы проводим интеграцию с вашей 1С.');
    expect(
      answerPartOf('Цена сильно зависит от объёма. Уточню у коллеги и вернусь к вам.'),
    ).toBeNull();
  });

  it('пустое вступление «Понятно» в ответ не идёт', () => {
    expect(answerPartOf('Понятно, у вас склад. Да, мы проводим интеграцию с вашей 1С.')).toBe(
      'Да, мы проводим интеграцию с вашей 1С.',
    );
  });

  it('только вопросы: ответа нет', () => {
    expect(answerPartOf('Подскажите, есть ли у вас 1С и какая?')).toBeNull();
    expect(answerPartOf('   ')).toBeNull();
  });
});
