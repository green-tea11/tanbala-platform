import { notImplemented } from './shared/todo.js';

/** Что точка входа передаёт в main. */
export interface MainOptions {
  /** Переменные окружения после загрузки .env. Разбирает их только config/env.ts. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Абсолютный путь к корню проекта: от него считаются пути из .env. */
  readonly root: string;
}

/** Запущенное приложение. */
export interface RunningApp {
  /** Корректная остановка: WhatsApp, очередь сообщений, панель, база. */
  stop(): Promise<void>;
}

/**
 * Собирает и запускает приложение: здесь создаются все зависимости (composition root).
 * TODO(этап 2): порядок: loadConfig (с config/models.json), логгер, база и миграции, знания, LLM, конвейер, затем WhatsApp (onEvent нужен до первого события), затем панель.
 * TODO(этап 2): при WA_ENABLED=false к WhatsApp не подключаться и QR не показывать, только предупреждение в лог.
 * TODO(этап 3): если ключ Claude пуст, LLM не создавать: вызовов API нет, агент отвечает LlmResult 'disabled', чаты отмечаются для менеджера.
 * TODO(этап 2): собрать AppStateRepo (db/repos/app-state.ts) и передать в whatsapp/connection.ts: отсечка сообщений до привязки номера.
 * TODO(этап 2): собрать PairingGuard (db/repos/pairing-attempts.ts, копия счётчика в файле .pairing-attempts.json в корне проекта) и передать в whatsapp/connection.ts: не больше двух привязок по QR за 24 часа, третью запрещает код; WA_ENABLED=false по-прежнему главный выключатель.
 * TODO(этап 8): переход TEST_MODE true => false: записать момент перехода в app_state как границу (сообщения чатов не из списка до неё не обрабатывать); до перехода предупредить менеджеров; как не ответить поверх менеджера в живых чатах рабочего номера: вопрос владельцу перед запуском.
 * TODO(этап 2): закрытый режим: AppConfig.testMode.enabled => allowlist передать в whatsapp/connection.ts (ClassifyContext.testAllowlist) и в messaging/outbox.ts; выключен => null. При TEST_MODE=true и пустом списке в лог предупреждение: бот не отвечает никому.
 * TODO(этап 2): простой: AppConfig.backlogMaxAgeHours в мс передать в whatsapp/connection.ts; собрать BacklogRepo (db/repos/backlog.ts) и pipeline/backlog.ts: события 'stale' в add, onOfflineQueueDone в flush.
 * TODO(этап 3): собрать CallBudget (db/repos/call-budget.ts, лимиты из AppConfig.limits) и передать в адаптеры Anthropic и OpenRouter: дневной предохранитель расходов.
 * TODO(этап 2): stop закрывает WhatsApp, дожидается очереди сообщений, закрывает панель и базу; паузы прерывает AbortSignal.
 */
export function main(options: MainOptions): Promise<RunningApp> {
  return notImplemented('этап 2', 'main.main');
}
