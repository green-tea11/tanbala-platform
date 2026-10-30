import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createScryptHasher } from '../../src/auth/passwords.js';
import { createSessionService } from '../../src/auth/sessions.js';
import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  runUserCommand,
  type CliIo,
} from '../../src/cli/commands.js';
import {
  applyKeys,
  createPasswordReader,
  PromptCancelled,
  type TtyInput,
} from '../../src/cli/password-prompt.js';
import { CLI_ACTOR, createAuditRepo } from '../../src/db/audit.js';
import { IN_MEMORY, openDatabase, type Db } from '../../src/db/connection.js';
import { createSessionsRepo } from '../../src/db/sessions.js';
import { createUsersRepo } from '../../src/db/users.js';
import { createFakeClock, FAST_SCRYPT } from '../helpers/harness.js';

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

function setup() {
  const db = openDatabase(IN_MEMORY);
  const clock = createFakeClock();
  const hasher = createScryptHasher(FAST_SCRYPT);
  const run = async (
    args: string[],
    passwords: string[] = [],
    interactive = false,
  ): Promise<Run> => {
    const out: string[] = [];
    const err: string[] = [];
    const queue = [...passwords];
    const io: CliIo = {
      interactive,
      readPassword: () => Promise.resolve(queue.shift() ?? ''),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    };
    const code = await runUserCommand(args, { db, hasher, clock, io });
    return { code, out, err };
  };
  return { db, clock, hasher, run };
}

function sessionFor(db: Db, name: string, clock: ReturnType<typeof createFakeClock>): void {
  const user = createUsersRepo(db).findByName(name);
  if (user === null) throw new Error('нет пользователя');
  createSessionService(createSessionsRepo(db), clock).start(user.id, {
    ip: '1.1.1.1',
    userAgent: 'x',
  });
}

function sessionCount(db: Db): number {
  return (db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n;
}

describe('команда user', () => {
  it('add: имя, роль, пароль без эха дважды в терминале; хэш scrypt; запись в журнал', async () => {
    const { db, run, hasher } = setup();
    const result = await run(
      ['user', 'add', 'owner', 'owner'],
      ['пароль-владельца', 'пароль-владельца'],
      true,
    );
    expect(result).toEqual({
      code: EXIT_OK,
      out: ['Пользователь owner заведён, роль: владелец.'],
      err: [],
    });
    const user = createUsersRepo(db).findByName('owner');
    expect(user?.role).toBe('owner');
    expect(await hasher.verify('пароль-владельца', user?.passwordHash ?? '')).toBe(true);
    const [entry] = createAuditRepo(db).page(1, 1).items;
    expect(entry).toMatchObject({ actor: CLI_ACTOR, action: 'user_add', target: 'user:owner' });
    expect(JSON.stringify(entry)).not.toContain('пароль');
  });

  it('add: пароли не совпали, короткий, повтор имени, неверная роль, неверное имя', async () => {
    const { run } = setup();
    expect(
      (await run(['user', 'add', 'a', 'owner'], ['пароль-один', 'пароль-два'], true)).err,
    ).toEqual(['Пароли не совпали.']);
    expect((await run(['user', 'add', 'a', 'owner'], ['короткий'])).err).toEqual([
      'Пароль короче 9 символов.',
    ]);
    expect((await run(['user', 'add', 'a', 'manager'], ['пароль-один'])).code).toBe(EXIT_OK);
    expect((await run(['user', 'add', 'a', 'manager'], ['пароль-один'])).code).toBe(EXIT_ERROR);
    expect((await run(['user', 'add', 'b', 'admin'])).code).toBe(EXIT_USAGE);
    expect((await run(['user', 'add', 'Bad Name', 'owner'])).code).toBe(EXIT_USAGE);
  });

  it('passwd, role, disable закрывают сессии; enable включает', async () => {
    const { db, run, clock } = setup();
    await run(['user', 'add', 'aigerim', 'manager'], ['пароль-менеджера']);
    sessionFor(db, 'aigerim', clock);
    expect((await run(['user', 'passwd', 'aigerim'], ['новый-пароль-1'])).code).toBe(EXIT_OK);
    expect(sessionCount(db)).toBe(0);
    sessionFor(db, 'aigerim', clock);
    expect((await run(['user', 'role', 'aigerim', 'owner'])).out).toEqual([
      'Роль aigerim: владелец. Его сессии закрыты.',
    ]);
    expect(sessionCount(db)).toBe(0);
    sessionFor(db, 'aigerim', clock);
    expect((await run(['user', 'disable', 'aigerim'])).code).toBe(EXIT_OK);
    expect(sessionCount(db)).toBe(0);
    expect(createUsersRepo(db).findByName('aigerim')?.active).toBe(false);
    expect((await run(['user', 'enable', 'aigerim'])).code).toBe(EXIT_OK);
    expect(createUsersRepo(db).findByName('aigerim')?.active).toBe(true);
  });

  it('revoke и list', async () => {
    const { db, run, clock } = setup();
    expect((await run(['user', 'list'])).out[0]).toContain('Пользователей нет');
    await run(['user', 'add', 'owner', 'owner'], ['пароль-владельца']);
    sessionFor(db, 'owner', clock);
    sessionFor(db, 'owner', clock);
    expect((await run(['user', 'revoke', 'owner'])).out).toEqual(['Закрыто сессий owner: 2.']);
    expect((await run(['user', 'list'])).out).toEqual(['owner\tвладелец\tактивен\tс 2026-10-30']);
  });

  it('нет такого пользователя и неверные аргументы', async () => {
    const { run } = setup();
    for (const args of [
      ['user', 'passwd', 'ghost'],
      ['user', 'role', 'ghost', 'owner'],
      ['user', 'disable', 'ghost'],
      ['user', 'revoke', 'ghost'],
    ]) {
      expect((await run(args, ['пароль-какой-то'])).code).toBe(EXIT_ERROR);
    }
    expect((await run(['user', 'role', 'ghost', 'boss'])).code).toBe(EXIT_USAGE);
    expect((await run([])).code).toBe(EXIT_USAGE);
    expect((await run(['users', 'list'])).code).toBe(EXIT_USAGE);
    expect((await run(['user', 'add'])).code).toBe(EXIT_USAGE);
    expect((await run(['user', 'drop', 'owner'])).code).toBe(EXIT_USAGE);
    expect((await run(['user', 'add', 'a', 'owner', 'лишнее'])).code).toBe(EXIT_USAGE);
  });
});

describe('ввод пароля без эха', () => {
  it('символы, Backspace, Enter; Ctrl+C прерывает', () => {
    expect(applyKeys('', 'абв')).toEqual({ buffer: 'абв', done: false });
    expect(applyKeys('аб😀', '\u007f\u007fг\r')).toEqual({ buffer: 'аг', done: true });
    expect(() => applyKeys('', '\u0003')).toThrow(PromptCancelled);
  });

  it('терминал: сырой режим включается и выключается, эха нет', async () => {
    const input = new PassThrough() as PassThrough & TtyInput & { isTTY: boolean };
    const modes: boolean[] = [];
    Object.assign(input, { isTTY: true, setRawMode: (mode: boolean) => modes.push(mode) });
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk.toString()));
    const reader = createPasswordReader(input, output);
    expect(reader.interactive).toBe(true);
    const pending = reader.read('Пароль: ');
    input.write('секрет-123\r');
    expect(await pending).toBe('секрет-123');
    expect(modes).toEqual([true, false]);
    expect(written.join('')).toBe('Пароль: \n');
    const cancelled = reader.read('Пароль: ');
    input.write('\u0003');
    await expect(cancelled).rejects.toThrow(PromptCancelled);
  });

  it('не терминал: строка из stdin; конец ввода — отказ', async () => {
    const input = new PassThrough();
    const reader = createPasswordReader(input, new PassThrough());
    expect(reader.interactive).toBe(false);
    input.end('пароль-из-канала\n');
    expect(await reader.read('')).toBe('пароль-из-канала');
    await expect(reader.read('')).rejects.toThrow(PromptCancelled);
  });
});
