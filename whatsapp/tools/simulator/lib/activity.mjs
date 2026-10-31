// Учёт того, что бот сейчас делает: вызовы Claude, запросы fetch и паузы его часов (склейка пачки 4 с, «печатает»,
// повтор отправки). Ход считается законченным, когда ничего не идёт и всё тихо settleMs подряд.
import { setTimeout as delay } from 'node:timers/promises';

export function createActivity() {
  const counts = { llm: 0, fetch: 0, sleep: 0 };
  let lastAt = Date.now();
  return {
    touch() {
      lastAt = Date.now();
    },
    begin(kind) {
      counts[kind] += 1;
      lastAt = Date.now();
    },
    end(kind) {
      counts[kind] -= 1;
      lastAt = Date.now();
    },
    busy() {
      return counts.llm + counts.fetch + counts.sleep;
    },
    snapshot() {
      return { ...counts };
    },
    quietMs() {
      return Date.now() - lastAt;
    },
  };
}

/**
 * Часы бота (шов MainOptions.clock): now настоящее, sleep с учётом активности. timeScale сжимает все паузы
 * (склейку, «печатает», повтор), typing.skip пропускает только паузу «печатает» (sleep без signal, пока статус включён).
 */
export function createSimClock({ activity, timeScale, typing, onSkippedTyping }) {
  return {
    now: () => Date.now(),
    async sleep(ms, signal) {
      if (typing.skip && typing.isOn() && signal === undefined) {
        onSkippedTyping(ms);
        activity.touch();
        await delay(0);
        return;
      }
      activity.begin('sleep');
      try {
        await delay(Math.max(0, Math.round(ms * timeScale)), undefined, { signal });
      } finally {
        activity.end('sleep');
      }
    },
  };
}

/** Ждёт, пока бот закончит: ничего не идёт и тихо settleMs. Итог: ok и сколько ждали. */
export async function waitIdle(activity, { settleMs, timeoutMs }) {
  const startedAt = Date.now();
  for (;;) {
    if (activity.busy() === 0 && activity.quietMs() >= settleMs) {
      return { ok: true, waitedMs: Date.now() - startedAt };
    }
    if (Date.now() - startedAt > timeoutMs) {
      return { ok: false, waitedMs: Date.now() - startedAt, busy: activity.snapshot() };
    }
    await delay(100);
  }
}

export const realSleep = (ms) => delay(ms);
