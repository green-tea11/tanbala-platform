import { describe, expect, it } from 'vitest';
import { createSessionStore } from '../../../src/panel/sessions.js';

const T0 = 1_761_400_000_000;
const MINUTE = 60_000;
const BASE64URL = /^[A-Za-z0-9_-]{43}$/;

describe('createSessionStore', () => {
  const options = { idleTtlMs: 10 * MINUTE, maxLifetimeMs: 60 * MINUTE, maxSessions: 3 };

  it('создаёт сессию с непредсказуемым ID и своим токеном CSRF; каждый вход получает новый ID', () => {
    const store = createSessionStore(options);

    const first = store.create(T0);
    const second = store.create(T0);

    expect(first.id).toMatch(BASE64URL);
    expect(first.csrf).toMatch(BASE64URL);
    expect(first.csrf).not.toBe(first.id);
    expect(second.id).not.toBe(first.id);
    expect(second.csrf).not.toBe(first.csrf);
    expect(first.createdAtMs).toBe(T0);
    expect(first.expiresAtMs).toBe(T0 + 10 * MINUTE);
  });

  it('находит живую сессию; неизвестный, пустой и отсутствующий ID это отсутствие сессии', () => {
    const store = createSessionStore(options);
    const session = store.create(T0);

    expect(store.find(session.id, T0 + 1)?.csrf).toBe(session.csrf);
    expect(store.find('нет-такой', T0)).toBeNull();
    expect(store.find('', T0)).toBeNull();
    expect(store.find(null, T0)).toBeNull();
    expect(store.find('__proto__', T0)).toBeNull();
  });

  it('простой сдвигает срок: за 10 минут без запросов сессия истекает, активная живёт дольше', () => {
    const store = createSessionStore(options);
    const justAlive = store.create(T0);
    const expired = store.create(T0);
    const active = store.create(T0);

    expect(store.find(active.id, T0 + 9 * MINUTE)).not.toBeNull();
    expect(store.find(active.id, T0 + 18 * MINUTE)).not.toBeNull();
    expect(store.find(justAlive.id, T0 + 10 * MINUTE - 1)).not.toBeNull();
    expect(store.find(expired.id, T0 + 10 * MINUTE)).toBeNull();
  });

  it('предельный срок жизни не продлить никакой активностью', () => {
    const store = createSessionStore(options);
    const session = store.create(T0);

    for (let minute = 5; minute < 60; minute += 5) {
      expect(store.find(session.id, T0 + minute * MINUTE)).not.toBeNull();
    }
    expect(store.find(session.id, T0 + 60 * MINUTE)).toBeNull();
  });

  it('продление не меняет выданную сессию: возвращается новый объект', () => {
    const store = createSessionStore(options);
    const created = store.create(T0);

    const found = store.find(created.id, T0 + 5 * MINUTE);

    expect(found).not.toBe(created);
    expect(created.expiresAtMs).toBe(T0 + 10 * MINUTE);
    expect(found?.expiresAtMs).toBe(T0 + 15 * MINUTE);
    expect(Object.isFrozen(found)).toBe(true);
  });

  it('destroy закрывает сессию; повторный вызов и чужой ID безвредны', () => {
    const store = createSessionStore(options);
    const session = store.create(T0);

    store.destroy(session.id);
    store.destroy(session.id);
    store.destroy('нет-такой');

    expect(store.find(session.id, T0)).toBeNull();
  });

  it('число сессий ограничено: лишняя вытесняет самую старую, истёкшие уходят первыми', () => {
    const store = createSessionStore(options);
    const [a, b, c] = [store.create(T0), store.create(T0 + 1), store.create(T0 + 2)];
    const d = store.create(T0 + 3);

    expect(store.find(a.id, T0 + 4)).toBeNull();
    for (const kept of [b, c, d]) expect(store.find(kept.id, T0 + 4)).not.toBeNull();

    const later = T0 + 30 * MINUTE;
    const fresh = store.create(later);
    expect(store.find(fresh.id, later)).not.toBeNull();
    expect(store.find(d.id, later)).toBeNull();
  });

  it('значения по умолчанию: простой около двух часов, предел жизни около полусуток', () => {
    const store = createSessionStore();
    const session = store.create(T0);

    expect(session.expiresAtMs - T0).toBe(2 * 60 * MINUTE);
    expect(store.find(session.id, T0 + 2 * 60 * MINUTE - 1)).not.toBeNull();
  });
});
