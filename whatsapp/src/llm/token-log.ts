import type { Clock, TokenLog } from '../domain/ports.js';
import type { TokenUsage, TokenUsageEntry, UsageSource } from '../domain/types.js';

/**
 * Лог расхода API в файл TOKEN_LOG_PATH: одна строка JSON (TokenUsage) на вызов.
 * appendLine и clock передаются параметрами, чтобы тесты обходились без диска и без реального времени.
 * appendLine дописывает строку в конец файла как есть: строка уже кончается переводом строки
 * (в рабочем режиме подходит fs.promises.appendFile). Ошибку записи record не глотает: её логирует вызывающий.
 * Время ставит сам лог (clock.now() в ISO 8601 UTC), дальше провайдер, тип вызова, модель, токены
 * (input, output, cacheRead, cacheWrite), ID чата и успех. Поля выбираются поимённо: только числа, модель
 * и ID чата, без текста сообщений, номеров и ключей, даже если в запись попало лишнее.
 * TODO(этап 8): ротация файла на VPS.
 */
export function createJsonlTokenLog(
  path: string,
  appendLine: (path: string, line: string) => Promise<void>,
  clock: Clock,
): TokenLog {
  return {
    record: (entry: TokenUsageEntry): Promise<void> =>
      appendLine(path, `${JSON.stringify(toUsageLine(entry, clock.now()))}\n`),
  };
}

function toUsageLine(entry: TokenUsageEntry, nowMs: number): TokenUsage {
  return {
    ts: new Date(nowMs).toISOString(),
    ...sourceOf(entry),
    model: entry.model,
    input: entry.input,
    output: entry.output,
    cacheRead: entry.cacheRead,
    cacheWrite: entry.cacheWrite,
    chatId: entry.chatId,
    ok: entry.ok,
  };
}

/** Провайдер и вызов парой: так тип не даёт записать расшифровку от имени Anthropic. */
function sourceOf(entry: TokenUsageEntry): UsageSource {
  return entry.provider === 'anthropic'
    ? { provider: 'anthropic', purpose: entry.purpose }
    : { provider: 'openrouter', purpose: entry.purpose };
}
