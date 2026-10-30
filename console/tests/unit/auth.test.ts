import { describe, expect, it } from 'vitest';
import { createHashGate, createLoginLimiter } from '../../src/auth/login-limiter.js';
import { createScryptHasher, DEFAULT_SCRYPT, parseHash } from '../../src/auth/passwords.js';
import { isValidUserName, normalizeUserName, passwordProblem } from '../../src/auth/policy.js';

describe('пароли scrypt', () => {
  it('рабочие параметры: N=2^15, r=8, p=1, формат scrypt$N$r$p$соль$хэш, ключ 64 байта', async () => {
    const hasher = createScryptHasher();
    const stored = await hasher.hash('правильный-пароль');
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    expect(DEFAULT_SCRYPT).toEqual({ N: 32768, r: 8, p: 1 });
    expect(await hasher.verify('правильный-пароль', stored)).toBe(true);
    expect(await hasher.verify('неправильный', stored)).toBe(false);
  });

  it('соль каждый раз новая; параметры проверки берутся из хэша', async () => {
    const fast = createScryptHasher({ N: 1024, r: 8, p: 1 });
    const first = await fast.hash('пароль-один');
    expect(first).not.toBe(await fast.hash('пароль-один'));
    expect(await createScryptHasher().verify('пароль-один', first)).toBe(true);
  });

  it('пароль сравнивается в форме NFC', async () => {
    const hasher = createScryptHasher({ N: 1024, r: 8, p: 1 });
    const stored = await hasher.hash('пароль-й');
    expect(await hasher.verify('пароль-й', stored)).toBe(true);
  });

  it('испорченный хэш или параметры вне границ: false без расчёта часами', async () => {
    const hasher = createScryptHasher({ N: 1024, r: 8, p: 1 });
    const key = 'A'.repeat(86);
    for (const stored of [
      '',
      'bcrypt$1$2$3$4$5',
      `scrypt$1000$8$1$AAAA$${key}`,
      `scrypt$${2 ** 20}$8$1$AAAA$${key}`,
      `scrypt$1024$99$1$AAAA$${key}`,
      `scrypt$1024$8$1$AA!A$${key}`,
      'scrypt$1024$8$1$AAAA$AAAA',
      `scrypt$1024$8$1$AAAA$${key}$лишнее`,
    ]) {
      expect(parseHash(stored)).toBeNull();
      expect(await hasher.verify('x', stored)).toBe(false);
    }
  });

  it('подставная проверка всегда false', async () => {
    expect(await createScryptHasher({ N: 1024, r: 8, p: 1 }).verifyDummy('что угодно')).toBe(false);
  });
});

describe('правила имени и пароля', () => {
  it('имя', () => {
    expect(isValidUserName('aigerim.k_2-x')).toBe(true);
    expect(isValidUserName('Aigerim')).toBe(false);
    expect(isValidUserName('')).toBe(false);
    expect(isValidUserName('a'.repeat(33))).toBe(false);
    expect(normalizeUserName('  Owner ')).toBe('owner');
  });

  it('пароль от 9 до 256 символов Unicode', () => {
    expect(passwordProblem('12345678')).toBe('Пароль короче 9 символов');
    expect(passwordProblem('123456789')).toBeNull();
    expect(passwordProblem('😀'.repeat(256))).toBeNull();
    expect(passwordProblem('я'.repeat(257))).toBe('Пароль длиннее 256 символов');
  });
});

describe('ограничитель входа', () => {
  const MINUTE = 60_000;

  it('попытка засчитывается при допуске; пока проверка идёт — busy для адреса и имени', () => {
    const limiter = createLoginLimiter();
    const first = limiter.admit('1.1.1.1', 'owner', 0);
    expect(first.ok).toBe(true);
    expect(limiter.admit('1.1.1.1', 'other', 0)).toEqual({ ok: false, reason: 'busy' });
    expect(limiter.admit('2.2.2.2', 'owner', 0)).toEqual({ ok: false, reason: 'busy' });
    if (first.ok) first.ticket.failed();
    expect(limiter.admit('1.1.1.1', 'other', 0).ok).toBe(true);
  });

  it('5 неудач за 10 минут на адрес; место освобождается, когда старая выходит из окна', () => {
    const limiter = createLoginLimiter();
    for (let index = 0; index < 5; index += 1) {
      const admission = limiter.admit('1.1.1.1', `name${index}`, index * MINUTE);
      if (admission.ok) admission.ticket.failed();
    }
    expect(limiter.admit('1.1.1.1', 'x', 5 * MINUTE)).toEqual({
      ok: false,
      reason: 'limited',
      retryAfterMs: 5 * MINUTE,
    });
    expect(limiter.admit('1.1.1.1', 'x', 10 * MINUTE + 1).ok).toBe(true);
  });

  it('успех и отмена возвращают попытку; повторный вызов ticket ничего не меняет', () => {
    const limiter = createLoginLimiter({ ipMax: 1 });
    const first = limiter.admit('1.1.1.1', 'owner', 0);
    if (!first.ok) throw new Error('нет допуска');
    first.ticket.succeeded();
    first.ticket.failed();
    const second = limiter.admit('1.1.1.1', 'owner', 0);
    if (!second.ok) throw new Error('нет допуска');
    second.ticket.cancelled();
    const third = limiter.admit('1.1.1.1', 'owner', 0);
    if (!third.ok) throw new Error('нет допуска');
    third.ticket.failed();
    expect(limiter.admit('1.1.1.1', 'owner', 0)).toMatchObject({ ok: false, reason: 'limited' });
  });

  it('помнит не больше maxKeys ключей', () => {
    const limiter = createLoginLimiter({ ipMax: 1, nameMax: 100, maxKeys: 2 });
    for (const ip of ['a', 'b', 'c']) {
      const admission = limiter.admit(ip, 'n', 0);
      if (admission.ok) admission.ticket.failed();
    }
    expect(limiter.admit('a', 'n', 0).ok).toBe(true);
  });
});

describe('семафор расчётов хэша', () => {
  it('2 сразу, 4 в очереди, остальным отказ без расчёта', async () => {
    const gate = createHashGate();
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const work = () =>
      new Promise<number>((resolve) => {
        running += 1;
        peak = Math.max(peak, running);
        releases.push(() => {
          running -= 1;
          resolve(1);
        });
      });
    const results = Array.from({ length: 8 }, () => gate.run(work));
    await Promise.resolve();
    expect(peak).toBe(2);
    while (releases.length > 0 || running > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const settled = await Promise.all(results);
    expect(settled.filter((result) => result.ok)).toHaveLength(6);
    expect(settled.filter((result) => !result.ok)).toHaveLength(2);
    expect(peak).toBe(2);
  });

  it('ошибка работы освобождает место', async () => {
    const gate = createHashGate({ maxActive: 1, maxQueued: 0 });
    await expect(gate.run(() => Promise.reject(new Error('сбой')))).rejects.toThrow('сбой');
    expect(await gate.run(() => Promise.resolve(5))).toEqual({ ok: true, value: 5 });
  });
});
