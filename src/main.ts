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
 * TODO(этап 3): собрать CallBudget (db/repos/call-budget.ts, лимиты из AppConfig.limits) и передать в адаптеры Anthropic и OpenRouter: дневной предохранитель расходов.
 * TODO(этап 2): stop закрывает WhatsApp, дожидается очереди сообщений, закрывает панель и базу; паузы прерывает AbortSignal.
 */
export function main(options: MainOptions): Promise<RunningApp> {
  return notImplemented('этап 2', 'main.main');
}
