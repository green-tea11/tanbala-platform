// Тексты для человека: итоги действий по коду исхода (как в старых панелях, console/docs/FEATURES.md) и отказы.

/** Итоги действий бота: WA-25 и контракт CONSOLE_API, раздел 3. */
export const BOT_RESULT_MESSAGES = {
  sent: 'Сообщение отправлено клиенту',
  duplicate: 'Это сообщение уже отправлено',
  returned: 'Чат возвращён боту',
  returned_answering: 'Чат возвращён боту: бот ответит на сообщения клиента без ответа',
  already_bot: 'Чат уже ведёт бот: заметка не сохранена',
} as const;

/** Итоги действий почты: DONE_MESSAGES из leads/tanbala_leads/web/labels.py. */
export const LEADS_RESULT_MESSAGES = {
  approved: 'Письмо одобрено. Компаниям письма пока не отправляются.',
  rejected: 'Письмо отклонено. Компания вернулась к статусу «Почта проверена».',
  saved: 'Изменения сохранены, проверки пройдены заново.',
  blocked: 'Готово: компания и её домен в списке «не писать». Письма им не уйдут.',
  cleared:
    'Отметки WhatsApp сняты: предупреждения нет, компания обычная и может попасть в рассылку.',
} as const;

/** Тексты отказов консоли по коду ошибки; у отказа почты или бота главнее их собственный текст. */
export const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  bad_request: 'Неверный запрос.',
  no_session: 'Нужно войти: сессия закончилась или её нет.',
  forbidden: 'Недостаточно прав для этого действия.',
  bad_origin: 'Запрос пришёл не со страницы панели. Обновите страницу.',
  csrf: 'Страница устарела. Обновите её и повторите действие.',
  bad_host: 'Запрос отклонён.',
  https_required: 'Панель открывается только по HTTPS.',
  not_found: 'Не найдено.',
  conflict: 'Действие сейчас невозможно.',
  too_large: 'Слишком большой запрос.',
  unsupported_media_type: 'Панель принимает только JSON.',
  refused: 'Действие отклонено.',
  invalid_credentials: 'Неверное имя или пароль.',
  rate_limited: 'Слишком много попыток. Подождите и повторите.',
  busy: 'Сервер занят проверкой входа. Повторите через несколько секунд.',
  budget_exhausted: 'Дневной лимит расходов на API исчерпан.',
  test_limit: 'Тестовых отправок за сегодня больше нет (30 в сутки).',
  send_failed: 'Не отправлено.',
  db_unavailable: 'База данных почты недоступна.',
  whatsapp_unavailable: 'WhatsApp не подключён.',
  not_configured: 'Отправка не настроена.',
  backend_auth: 'Почта или бот не приняли токен консоли: проверьте токены в .env.',
  backend_unavailable: 'Приложение недоступно, действие не выполнено.',
  internal: 'Внутренняя ошибка консоли. Подробности записаны в журнал.',
};

/** Ответ бота 502 при ответе клиенту: чат уже ушёл менеджеру, отправка не удалась. */
export const BOT_SEND_FAILED = 'Не отправлено. Чат уже у менеджера, бот в нём молчит.';

export const UNAVAILABLE_MESSAGES = {
  wa: 'Бот не запущен или недоступен.',
  leads: 'Почта недоступна.',
} as const;

export function errorMessage(code: string): string {
  // Object.hasOwn: код от приложения может быть «constructor» или «__proto__».
  const known = Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : undefined;
  return known ?? ERROR_MESSAGES['bad_request'] ?? '';
}
