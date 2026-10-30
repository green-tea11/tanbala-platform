import type { PasswordHasher } from '../auth/passwords.js';
import { isValidUserName, passwordProblem } from '../auth/policy.js';
import { CLI_ACTOR, createAuditRepo, type AuditRepo } from '../db/audit.js';
import type { Db } from '../db/connection.js';
import { createSessionsRepo } from '../db/sessions.js';
import { createUsersRepo, ROLES, UserExistsError, type Role, type UsersRepo } from '../db/users.js';
import type { Clock } from '../shared/clock.js';

/** Ввод и вывод команды: в тестах подменяются. */
export interface CliIo {
  /** Пароль без эха (или строка из stdin, если это не терминал). */
  readPassword(prompt: string): Promise<string>;
  /** Нужно ли просить пароль второй раз (только в терминале). */
  readonly interactive: boolean;
  out(line: string): void;
  err(line: string): void;
}

export interface CliDeps {
  readonly db: Db;
  readonly hasher: PasswordHasher;
  readonly clock: Clock;
  readonly io: CliIo;
}

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

export const USAGE = [
  'Использование: node dist/cli.js user <команда>',
  '  add <имя> [owner|manager]   завести пользователя (пароль спросит без эха); без роли первый —',
  '                              владелец, остальные — менеджеры',
  '  passwd <имя>                сменить пароль (сессии пользователя закроются)',
  '  role <имя> <owner|manager>  сменить роль (сессии закроются)',
  '  disable <имя>               отключить (сессии закроются)',
  '  enable <имя>                включить',
  '  list                        список пользователей',
  '  revoke <имя>                закрыть все сессии пользователя',
  'Имя: строчная латиница, цифры, точка, подчёркивание, дефис, до 32 символов. Пароль: от 9 до 256 символов.',
].join('\n');

const HELP_WORDS: ReadonlySet<string> = new Set(['--help', '-h', 'help']);

const ROLE_LABELS: Readonly<Record<Role, string>> = { owner: 'владелец', manager: 'менеджер' };

interface Command {
  readonly users: UsersRepo;
  readonly audit: AuditRepo;
  readonly deps: CliDeps;
}

function isRole(value: string | undefined): value is Role {
  return ROLES.some((role) => role === value);
}

function fail(io: CliIo, message: string, code = EXIT_ERROR): number {
  io.err(message);
  return code;
}

function record(command: Command, action: string, name: string): void {
  command.audit.write(
    { actor: CLI_ACTOR, action, target: `user:${name}` },
    command.deps.clock.now(),
  );
}

/** Новый пароль: дважды в терминале, проверка длины. Не годится: null (причина уже выведена). */
async function askNewPassword(io: CliIo): Promise<string | null> {
  const password = await io.readPassword('Пароль: ');
  const problem = passwordProblem(password);
  if (problem !== null) {
    io.err(`${problem}.`);
    return null;
  }
  if (io.interactive && (await io.readPassword('Повторите пароль: ')) !== password) {
    io.err('Пароли не совпали.');
    return null;
  }
  return password;
}

/** Роль нового пользователя: названная явно; без неё первый пользователь — владелец, остальные — менеджеры. */
function roleForNewUser(command: Command, given: string | undefined): Role | null {
  if (given === undefined) return command.users.list().length === 0 ? 'owner' : 'manager';
  return isRole(given) ? given : null;
}

async function addUser(command: Command, name: string, given: string | undefined): Promise<number> {
  const { io, hasher, clock } = command.deps;
  const role = roleForNewUser(command, given);
  if (role === null) return fail(io, 'Роль: owner или manager.', EXIT_USAGE);
  if (command.users.findByName(name) !== null) return fail(io, `Пользователь ${name} уже есть.`);
  const password = await askNewPassword(io);
  if (password === null) return EXIT_ERROR;
  try {
    command.users.create({ name, role, passwordHash: await hasher.hash(password) }, clock.now());
  } catch (error: unknown) {
    if (error instanceof UserExistsError) return fail(io, `Пользователь ${name} уже есть.`);
    throw error;
  }
  record(command, 'user_add', name);
  io.out(`Пользователь ${name} заведён, роль: ${ROLE_LABELS[role]}.`);
  return EXIT_OK;
}

async function changePassword(command: Command, name: string): Promise<number> {
  const { io, hasher, clock } = command.deps;
  if (command.users.findByName(name) === null) return fail(io, `Пользователя ${name} нет.`);
  const password = await askNewPassword(io);
  if (password === null) return EXIT_ERROR;
  command.users.setPassword(name, await hasher.hash(password), clock.now());
  record(command, 'user_passwd', name);
  io.out(`Пароль ${name} изменён, его сессии закрыты.`);
  return EXIT_OK;
}

function changeRole(command: Command, name: string, role: string | undefined): number {
  const { io, clock } = command.deps;
  if (!isRole(role)) return fail(io, 'Роль: owner или manager.', EXIT_USAGE);
  if (!command.users.setRole(name, role, clock.now())) return fail(io, `Пользователя ${name} нет.`);
  record(command, 'user_role', name);
  io.out(`Роль ${name}: ${ROLE_LABELS[role]}. Его сессии закрыты.`);
  return EXIT_OK;
}

function setActive(command: Command, name: string, active: boolean): number {
  const { io, clock } = command.deps;
  if (!command.users.setActive(name, active, clock.now())) {
    return fail(io, `Пользователя ${name} нет.`);
  }
  record(command, active ? 'user_enable' : 'user_disable', name);
  io.out(
    active ? `Пользователь ${name} включён.` : `Пользователь ${name} отключён, его сессии закрыты.`,
  );
  return EXIT_OK;
}

function revoke(command: Command, name: string): number {
  const { io, db } = command.deps;
  const user = command.users.findByName(name);
  if (user === null) return fail(io, `Пользователя ${name} нет.`);
  const closed = createSessionsRepo(db).deleteForUser(user.id);
  record(command, 'user_revoke', name);
  io.out(`Закрыто сессий ${name}: ${closed}.`);
  return EXIT_OK;
}

function list(command: Command): number {
  const users = command.users.list();
  if (users.length === 0) {
    command.deps.io.out('Пользователей нет. Заведите владельца: user add <имя> owner');
    return EXIT_OK;
  }
  users.forEach((user) => {
    const state = user.active ? 'активен' : 'отключён';
    const created = new Date(user.createdAt).toISOString().slice(0, 10);
    command.deps.io.out(`${user.name}\t${ROLE_LABELS[user.role]}\t${state}\tс ${created}`);
  });
  return EXIT_OK;
}

async function dispatch(command: Command, action: string, name: string, extra: string | undefined) {
  switch (action) {
    case 'add':
      return addUser(command, name, extra);
    case 'passwd':
      return changePassword(command, name);
    case 'role':
      return changeRole(command, name, extra);
    case 'disable':
      return setActive(command, name, false);
    case 'enable':
      return setActive(command, name, true);
    case 'revoke':
      return revoke(command, name);
    default:
      return fail(command.deps.io, USAGE, EXIT_USAGE);
  }
}

/** Команда «user …»: пользователи консоли заводятся и меняются только так, на сервере. Код выхода. */
export async function runUserCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const [scope, action, name, extra, ...rest] = args;
  const command: Command = {
    users: createUsersRepo(deps.db),
    audit: createAuditRepo(deps.db),
    deps,
  };
  if (HELP_WORDS.has(scope ?? '') || (scope === 'user' && HELP_WORDS.has(action ?? ''))) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  if (scope !== 'user' || action === undefined) return fail(deps.io, USAGE, EXIT_USAGE);
  if (action === 'list') return list(command);
  if (name === undefined || rest.length > 0) return fail(deps.io, USAGE, EXIT_USAGE);
  if (!isValidUserName(name)) {
    return fail(
      deps.io,
      'Имя: строчная латиница, цифры, «.», «_», «-», до 32 символов.',
      EXIT_USAGE,
    );
  }
  return dispatch(command, action, name, extra);
}
