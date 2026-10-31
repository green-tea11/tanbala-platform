// Журнал действий (Система) словами: коды действий и итогов из console/src (context.record), отказы почты и бота.
// Незнакомый код показывается как есть.

const ACTIONS: Readonly<Record<string, string>> = {
  login: 'вход',
  login_failed: 'неудачный вход',
  logout: 'выход',
  session_revoke: 'закрыта сессия',
  session_revoke_all: 'закрыты все сессии',
  run_start: 'запуск поиска',
  letter_approve: 'одобрено письмо',
  letter_reject: 'отклонено письмо',
  letter_edit: 'правка письма',
  letter_send_test: 'тестовое письмо',
  company_block: '«не писать» компании',
  company_whatsapp_clear: 'снята отметка WhatsApp',
  history_import_written: 'импорт «уже писали»',
  history_import_refused: 'импорт «не писать»',
  chat_reply: 'ответ клиенту',
  chat_return: 'возврат боту',
  user_add: 'заведён пользователь',
  user_passwd: 'сменён пароль',
  user_role: 'сменена роль',
  user_enable: 'пользователь включён',
  user_disable: 'пользователь отключён',
  user_revoke: 'закрыты сессии пользователя',
};

export interface AuditOutcome {
  readonly text: string;
  /** Действие не выполнено или итог неизвестен: строка красным. */
  readonly bad: boolean;
}

const DONE: Readonly<Record<string, string>> = {
  sent: 'отправлено',
  approved: 'одобрено',
  rejected: 'отклонено',
  saved: 'сохранено',
  blocked: 'в «не писать»',
  cleared: 'снято',
  revoked: 'закрыта',
  returned: 'возвращён',
  returned_answering: 'возвращён, бот отвечает',
  already_bot: 'уже у бота',
};

const FAILED: Readonly<Record<string, string>> = {
  duplicate: 'повтор, не отправлено',
  refused: 'отказ',
  conflict: 'сейчас невозможно',
  not_found: 'не найдено',
  bad_request: 'неверный запрос',
  too_large: 'слишком длинно',
  rate_limited: 'слишком часто',
  test_limit: 'лимит тестов на сегодня',
  budget_exhausted: 'бюджет исчерпан',
  whatsapp_not_open: 'WhatsApp не подключён',
  send_failed: 'не отправлено',
  return_failed: 'не возвращён',
  backend_unavailable: 'служба не ответила',
  backend_auth: 'служба не приняла токен',
  unknown_outcome: 'итог неизвестен',
};

/** Итоги с числом: «added:5» — «добавлено 5», «closed:3» — «закрыто 3». */
const COUNTED: Readonly<Record<string, string>> = { added: 'добавлено', closed: 'закрыто' };

const TARGETS: Readonly<Record<string, string>> = { chat: 'чат', draft: 'письмо', run: 'запуск', company: 'компания', session: 'сессия', user: '' };

export function auditAction(code: string): string {
  return ACTIONS[code] ?? code;
}

export function auditOutcome(code: string | null): AuditOutcome {
  if (code === null) return { text: '—', bad: false };
  const done = DONE[code];
  if (done !== undefined) return { text: done, bad: false };
  const failed = FAILED[code];
  if (failed !== undefined) return { text: failed, bad: true };
  const [kind, count] = code.split(':');
  const counted = kind === undefined ? undefined : COUNTED[kind];
  if (counted !== undefined && count !== undefined && /^\d+$/.test(count)) return { text: `${counted} ${count}`, bad: false };
  // «run:7» и прочие ссылки на объект; незнакомый код — красным, если похож на сбой.
  return { text: auditTarget(code), bad: /fail|denied|refused|error/.test(code) };
}

/** «draft:14» — «письмо №14», «user:bogdan» — «bogdan». */
export function auditTarget(code: string | null): string {
  if (code === null) return '—';
  const [kind, ...rest] = code.split(':');
  const value = rest.join(':');
  const label = kind === undefined ? undefined : TARGETS[kind];
  if (label === undefined || value === '') return code;
  if (label === '') return value;
  return /^\d+$/.test(value) ? `${label} №${value}` : `${label} ${value}`;
}
