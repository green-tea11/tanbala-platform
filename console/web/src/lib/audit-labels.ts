// Журнал действий (Система) словами: коды действий и итогов из console/src (context.record) и ответов почты и бота.
// Незнакомый код показывается как есть.

const ACTIONS: Readonly<Record<string, string>> = {
  login: 'вход',
  login_failed: 'неверный пароль',
  login_blocked: 'вход заблокирован',
  login_busy: 'вход занят',
  logout: 'выход',
  request_denied: 'запрос отклонён',
  maintenance: 'обслуживание',
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

const OUTCOMES: Readonly<Record<string, string>> = {
  sent: 'отправлено',
  approved: 'одобрено',
  rejected: 'отклонено',
  saved: 'сохранено',
  blocked: 'в «не писать»',
  cleared: 'снято',
  imported: 'добавлено',
  started: 'запущен',
  returned: 'возвращён',
  returned_answering: 'возвращён, бот отвечает',
  already_bot: 'уже у бота',
  whatsapp_not_open: 'WhatsApp не подключён',
  conflict: 'отказ: занято',
  not_found: 'не найдено',
  budget_exhausted: 'бюджет исчерпан',
  unavailable: 'служба не ответила',
};

const TARGETS: Readonly<Record<string, string>> = { chat: 'чат', draft: 'письмо', run: 'запуск', company: 'компания', user: '' };

export function auditAction(code: string): string {
  return ACTIONS[code] ?? code;
}

/** «run:7» — «запуск №7»; известный итог словами, иначе код как есть. */
export function auditOutcome(code: string | null): string {
  if (code === null) return '—';
  return OUTCOMES[code] ?? auditTarget(code);
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
