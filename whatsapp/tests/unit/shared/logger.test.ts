import type { SocketConfig } from 'baileys';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../../../src/domain/ports.js';
import { createLogger } from '../../../src/shared/logger.js';

type LogRecord = Record<string, unknown>;

const HIDDEN = '[скрыто]';
const PHONE = '77011234567';
const PN_JID = `${PHONE}@s.whatsapp.net`;
const DEVICE_JID = `${PHONE}:12@s.whatsapp.net`;
const LID_JID = '123456789012345@lid';

/** Логгер, который пишет строки JSON в память. */
function capture(level = 'info'): { logger: Logger; lines: string[]; records: () => LogRecord[] } {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    destination: {
      write: (line: string): void => {
        lines.push(line);
      },
    },
  });
  const records = (): LogRecord[] => lines.map((line) => JSON.parse(line) as LogRecord);
  return { logger, lines, records };
}

/** Тот же логгер глазами Baileys: строка первым аргументом и подстановки. */
function asBaileys(logger: Logger): SocketConfig['logger'] {
  return logger;
}

describe('shared/logger createLogger: основа', () => {
  it('пишет JSON с уровнем, текстом и контекстом', () => {
    const { logger, records } = capture();

    logger.info({ chatId: 7, event: 'client' }, 'сообщение сохранено');

    expect(records()).toEqual([
      expect.objectContaining({
        level: 30,
        chatId: 7,
        event: 'client',
        msg: 'сообщение сохранено',
      }),
    ]);
  });

  it('не пишет записи ниже своего уровня', () => {
    const { logger, records } = capture('warn');

    logger.info({}, 'не видно');
    logger.debug({}, 'тоже не видно');
    logger.warn({}, 'видно');

    expect(records().map((record) => record.msg)).toEqual(['видно']);
  });

  it('неизвестный уровень: ошибка при создании', () => {
    expect(() =>
      createLogger({ level: 'verbose', destination: { write: () => undefined } }),
    ).toThrow(/level/);
  });

  it('без приёмника пишет в stdout (уровень silent ничего не выводит)', () => {
    const logger = createLogger({ level: 'silent' });

    expect(logger.level).toBe('silent');
    expect(() => logger.error({}, 'тишина')).not.toThrow();
  });
});

describe('shared/logger createLogger: redact', () => {
  it('скрывает ключи, пароль, текст, имя из профиля и номер на верхнем уровне', () => {
    const { logger, lines, records } = capture();

    logger.info({
      apiKey: 'sk-ant-secret',
      adminPassword: 'пароль-панели',
      text: 'текст клиента',
      pushName: 'Иван',
      phone: '7701',
      chatId: 3,
    });

    expect(records()[0]).toMatchObject({
      apiKey: HIDDEN,
      adminPassword: HIDDEN,
      text: HIDDEN,
      pushName: HIDDEN,
      phone: HIDDEN,
      chatId: 3,
    });
    expect(lines.join('')).not.toMatch(/sk-ant-secret|пароль-панели|текст клиента|Иван/);
  });

  it('скрывает токен, сайты, почту и домен компании (данные почтового проекта) на любой глубине', () => {
    const { logger, lines, records } = capture();

    logger.info({
      token: 'internal-token-value',
      websites: ['https://sklad.kz'],
      email: 'ivan@sklad.kz',
      domain: 'sklad.kz',
      endpoint: 'lookup',
      profile: { kind: 'business', Websites: ['https://other.kz'], nested: { Domain: 'other.kz' } },
    });

    expect(records()[0]).toMatchObject({
      token: HIDDEN,
      websites: HIDDEN,
      email: HIDDEN,
      domain: HIDDEN,
      endpoint: 'lookup',
      profile: { kind: 'business', Websites: HIDDEN, nested: { Domain: HIDDEN } },
    });
    expect(lines.join('')).not.toMatch(/internal-token-value|sklad\.kz|other\.kz/);
  });

  it('скрывает номера TEST_ALLOWLIST и в рабочем режиме (workingMode.allowlist), граница видна', () => {
    const { logger, records } = capture();

    logger.info({ workingMode: { sinceMs: 5, allowlist: ['77011234567'] }, allowlist: ['7702'] });

    expect(records()[0]).toMatchObject({
      workingMode: { sinceMs: 5, allowlist: HIDDEN },
      allowlist: HIDDEN,
    });
  });

  it('скрывает чувствительные ключи и глубже, в любом регистре', () => {
    const { logger, lines } = capture();

    logger.info({ message: { content: { kind: 'text', Text: 'привет' }, PushName: 'Анна' } });

    expect(lines.join('')).not.toMatch(/привет|Анна/);
    expect(lines.join('')).toContain('"kind":"text"');
  });
});

describe('shared/logger createLogger: маскировка JID и номеров', () => {
  it.each([PN_JID, DEVICE_JID, LID_JID, `${PHONE}@c.us`, '120363012345678901@g.us'])(
    'JID в тексте записи заменяется: %s',
    (jid) => {
      const { logger, lines, records } = capture();

      logger.warn({}, `нет ответа от ${jid}, повтор`);

      expect(records()[0]?.msg).toBe(`нет ответа от ${HIDDEN}, повтор`);
      expect(lines.join('')).not.toContain(jid);
    },
  );

  it('7 и больше цифр подряд заменяются, 6 цифр остаются', () => {
    const { logger, records } = capture();

    logger.info({}, 'код 1234567, порт 123456');

    expect(records()[0]?.msg).toBe(`код ${HIDDEN}, порт 123456`);
  });

  it('адрес сервера без пользователя не трогается', () => {
    const { logger, records } = capture();

    logger.info({}, 'запрос к @s.whatsapp.net');

    expect(records()[0]?.msg).toBe('запрос к @s.whatsapp.net');
  });

  it('строки во вложенных объектах и массивах маскируются, числа нет', () => {
    const { logger, lines, records } = capture();

    logger.warn({
      attrs: { from: PN_JID, id: 'ABC' },
      stanza: `<message from="${LID_JID}" t="1761400000">`,
      ids: [PHONE, 'short'],
      timestampMs: 1761400000123,
    });

    expect(records()[0]).toMatchObject({
      attrs: { from: HIDDEN, id: 'ABC' },
      stanza: `<message from="${HIDDEN}" t="${HIDDEN}">`,
      ids: [HIDDEN, 'short'],
      timestampMs: 1761400000123,
    });
    expect(lines.join('')).not.toContain(PHONE);
  });

  it('исходный объект контекста не меняется', () => {
    const { logger } = capture();
    const context = { attrs: { from: PN_JID }, text: 'текст' };

    logger.info(context, 'событие');

    expect(context).toEqual({ attrs: { from: PN_JID }, text: 'текст' });
  });

  it('строка первым аргументом и подстановки (так пишет Baileys) маскируются', () => {
    const { logger, records } = capture();
    const baileys = asBaileys(logger);

    baileys.warn(`соединение ${PN_JID} закрыто`);
    baileys.info('чат %s', LID_JID);

    expect(records().map((record) => record.msg)).toEqual([
      `соединение ${HIDDEN} закрыто`,
      `чат ${HIDDEN}`,
    ]);
  });
});

describe('shared/logger createLogger: имена и узлы Baileys (уровень error)', () => {
  it('скрывает username, имена из профиля, vcard и узлы протокола по ключам', () => {
    const { logger, lines, records } = capture();

    logger.error(
      {
        key: { remoteJidUsername: 'ivan_petrov', participantUsername: 'anna_k', id: 'ABC' },
        username: 'ivan_petrov',
        attrs: { participant_username: 'anna_k', notify: 'Анна', type: 'read' },
        verifiedBizName: 'ИП Петров',
        vcard: 'BEGIN:VCARD\nFN:Иван Петров\nEND:VCARD',
        node: "<message notify='Иван Петров'/>",
        xml: '<message/>',
        fullErrorNode: { tag: 'error', attrs: { code: '479' } },
      },
      'ошибка обработки',
    );

    expect(records()[0]).toMatchObject({
      key: { remoteJidUsername: HIDDEN, participantUsername: HIDDEN, id: 'ABC' },
      username: HIDDEN,
      attrs: { participant_username: HIDDEN, notify: HIDDEN, type: 'read' },
      verifiedBizName: HIDDEN,
      vcard: HIDDEN,
      node: HIDDEN,
      xml: HIDDEN,
      fullErrorNode: HIDDEN,
    });
    expect(lines.join('')).not.toMatch(/ivan_petrov|anna_k|Анна|Петров/);
  });

  it('общий ключ name не скрывается: имена ошибок и модулей остаются', () => {
    const { logger, records } = capture();

    logger.warn({ name: 'TypeError', module: 'baileys' }, 'имя ошибки');

    expect(records()[0]).toMatchObject({ name: 'TypeError', module: 'baileys' });
  });

  it("в строке узла закрываются notify='...' и *username='...', остальные атрибуты остаются", () => {
    const { logger, lines, records } = capture();
    const baileys = asBaileys(logger);

    baileys.error(
      { payload: "<receipt notify='Иван Петров' participant_username='ivan_p' type='read'/>" },
      "узел <message username='anna_k' id='ABC'/>",
    );

    expect(records()[0]).toMatchObject({
      payload: `<receipt notify='${HIDDEN}' participant_username='${HIDDEN}' type='read'/>`,
      msg: `узел <message username='${HIDDEN}' id='ABC'/>`,
    });
    expect(lines.join('')).not.toMatch(/Иван|ivan_p|anna_k/);
  });

  it('апостроф внутри имени не оставляет в логе хвост имени', () => {
    const { logger, records } = capture();

    logger.error({}, "<message notify='Д'Артаньян' t='1'>\n<enc/>");

    expect(records()[0]?.msg).toBe(`<message notify='${HIDDEN}' t='1'>\n<enc/>`);
  });

  it('атрибут вне узла (без пробела, > или конца строки после кавычки) тоже закрывается', () => {
    const { logger, records } = capture();

    logger.error({}, "notify='Иван', повтор");

    expect(records()[0]?.msg).toBe(`notify='${HIDDEN}', повтор`);
  });
});

describe('shared/logger createLogger: ошибки', () => {
  it('Error первым аргументом: текст, стек и свои поля маскируются, тип сохраняется', () => {
    const { logger, lines, records } = capture();
    class SessionError extends Error {}
    const error = Object.assign(new SessionError(`сбой ${PN_JID}`), {
      code: 'E_SESSION',
      jid: LID_JID,
    });

    asBaileys(logger).error(error);

    const record = records()[0];
    expect(record?.msg).toBe(`сбой ${HIDDEN}`);
    expect(record?.err).toMatchObject({
      type: 'SessionError',
      message: `сбой ${HIDDEN}`,
      code: 'E_SESSION',
      jid: HIDDEN,
    });
    expect(lines.join('')).not.toContain(PHONE);
    expect(lines.join('')).not.toContain('123456789012345');
  });

  it('ошибка внутри контекста и её cause тоже маскируются', () => {
    const { logger, lines, records } = capture();
    const cause = new Error(`причина ${PHONE}`);
    const error = new Error(`внешняя ${LID_JID}`, { cause });

    logger.error({ err: error }, 'не удалось');

    // Сериализатор err в pino дописывает к message текст cause: обе части должны быть замаскированы.
    expect(records()[0]?.err).toMatchObject({
      message: expect.stringContaining(`внешняя ${HIDDEN}`) as unknown,
    });
    expect(lines.join('')).not.toContain(PHONE);
    expect(lines.join('')).not.toContain('123456789012345');
  });

  it('ошибка без стека тоже маскируется', () => {
    const { logger, records } = capture();
    const error = new Error(`сбой ${PN_JID}`);
    error.stack = undefined;

    logger.error({ err: error }, 'без стека');

    expect(records()[0]?.err).toMatchObject({ type: 'Error', message: `сбой ${HIDDEN}` });
  });
});

describe('shared/logger createLogger: необычные значения', () => {
  it('циклическая ссылка не роняет запись', () => {
    const { logger, records } = capture();
    const tree: Record<string, unknown> = { tag: 'iq' };
    tree.self = tree;

    expect(() => logger.info({ tree }, 'цикл')).not.toThrow();
    expect(records()[0]?.tree).toEqual({ tag: 'iq', self: expect.any(String) as unknown });
  });

  it('слишком глубокая вложенность скрывается целиком', () => {
    const { logger, lines } = capture();
    let deep: Record<string, unknown> = { leaf: 'лист' };
    for (let level = 0; level < 15; level += 1) {
      deep = { next: deep };
    }

    logger.info({ deep });

    expect(lines.join('')).not.toContain('лист');
    expect(lines.join('')).toContain(HIDDEN);
  });

  it('объекты с toJSON (protobuf Baileys, Date) маскируются по своему JSON', () => {
    const { logger, records } = capture();
    class MessageKey {
      readonly jid: string;
      constructor(jid: string) {
        this.jid = jid;
      }
      toJSON(): Record<string, unknown> {
        return { remote: this.jid, fromMe: false };
      }
    }

    logger.info({ key: new MessageKey(PN_JID), at: new Date(Date.UTC(2026, 9, 25)) });

    expect(records()[0]).toMatchObject({
      key: { remote: HIDDEN, fromMe: false },
      at: '2026-10-25T00:00:00.000Z',
    });
  });

  it('экземпляры классов без toJSON маскируются по своим полям, байты не трогаются', () => {
    const { logger, records } = capture();
    class Contact {
      readonly id = PN_JID;
    }

    logger.info({ contact: new Contact(), bytes: new Uint8Array([1, 2]) });

    expect(records()[0]).toMatchObject({ contact: { id: HIDDEN }, bytes: { 0: 1, 1: 2 } });
  });

  it('если маскировка не удалась, пишется заглушка, а не исходные данные', () => {
    const { logger, lines } = capture();
    const hostile = {
      get broken(): never {
        throw new Error('getter');
      },
      jid: PN_JID,
    };
    Object.defineProperty(hostile, 'broken', { enumerable: true });

    expect(() => logger.info(hostile, `секрет ${PHONE}`)).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines.join('')).not.toContain(PHONE);
  });
});

describe('shared/logger createLogger: дочерние логгеры', () => {
  it('child со своим уровнем: логгер Baileys на warn не пишет info и маскирует строки', () => {
    const { logger, records } = capture('debug');
    const baileys = logger.child({ module: 'baileys' }, { level: 'warn' });

    baileys.info({}, 'протокол');
    baileys.warn({}, `ошибка расшифровки от ${PN_JID}`);

    expect(baileys.level).toBe('warn');
    expect(records()).toEqual([
      expect.objectContaining({ module: 'baileys', msg: `ошибка расшифровки от ${HIDDEN}` }),
    ]);
  });

  it('потомки потомков наследуют маскировку и redact', () => {
    const { logger, lines } = capture();
    const grandchild = asBaileys(logger.child({ module: 'baileys' }, { level: 'warn' })).child({
      msgId: 'ABC',
    });

    grandchild.warn({ text: 'текст клиента' }, `повтор для ${LID_JID}`);

    expect(lines.join('')).not.toMatch(/текст клиента|123456789012345/);
    expect(lines.join('')).toContain('"msgId":"ABC"');
  });

  it('чувствительные ключи в привязках child скрываются', () => {
    const { logger, lines } = capture();

    logger.child({ phone: PHONE, jid: PN_JID }).info({}, 'привязки');

    expect(lines.join('')).not.toContain(PHONE);
  });
});
