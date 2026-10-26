import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  createPanelContext,
  currentSession,
  isSecureRequest,
  redirectTo,
  sendHtml,
  withSession,
} from '../../../src/panel/context.js';
import { createHarness, MINUTE_MS } from './harness.js';

function requestWith(cookie: string | undefined): FastifyRequest {
  return { headers: cookie === undefined ? {} : { cookie }, protocol: 'http' } as FastifyRequest;
}

function fakeReply(): { readonly reply: FastifyReply; readonly redirect: Mock } {
  const redirect = vi.fn(() => 'redirected');
  return { reply: { redirect } as unknown as FastifyReply, redirect };
}

describe('currentSession', () => {
  it('находит сессию по cookie, а срок считает по часам панели', () => {
    const h = createHarness();
    const context = createPanelContext(h.deps);
    const session = context.sessions.create(h.deps.clock.now());

    expect(currentSession(context, requestWith(`tanbala_sid=${session.id}`))?.csrf).toBe(
      session.csrf,
    );
    h.advance(3 * 60 * MINUTE_MS);
    expect(currentSession(context, requestWith(`tanbala_sid=${session.id}`))).toBeNull();
  });

  it('нет cookie или чужой ID: null', () => {
    const context = createPanelContext(createHarness().deps);

    expect(currentSession(context, requestWith(undefined))).toBeNull();
    expect(currentSession(context, requestWith('tanbala_sid=чужой'))).toBeNull();
  });
});

describe('withSession', () => {
  it('сессия есть: обработчик получает её вместе с запросом и ответом', () => {
    const context = createPanelContext(createHarness().deps);
    const session = context.sessions.create(context.deps.clock.now());
    const { reply } = fakeReply();
    const request = requestWith(`tanbala_sid=${session.id}`);
    const handler = vi.fn(() => reply);

    const result = withSession(context, handler)(request, reply);

    expect(result).toBe(reply);
    expect(handler).toHaveBeenCalledWith(
      request,
      reply,
      expect.objectContaining({ id: session.id }),
    );
  });

  it('сессии нет (истекла за время запроса): переход на вход, обработчик не вызывается', () => {
    const context = createPanelContext(createHarness().deps);
    const { reply, redirect } = fakeReply();
    const handler = vi.fn(() => reply);

    const result = withSession(context, handler)(requestWith('tanbala_sid=истекла'), reply);

    expect(result).toBe('redirected');
    expect(redirect).toHaveBeenCalledWith('/login', 303);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('isSecureRequest', () => {
  it('только запрос по HTTPS', () => {
    expect(isSecureRequest({ protocol: 'https' } as FastifyRequest)).toBe(true);
    expect(isSecureRequest({ protocol: 'http' } as FastifyRequest)).toBe(false);
  });
});

describe('sendHtml', () => {
  it('ставит статус, тип содержимого и отправляет страницу', () => {
    const send = vi.fn(() => 'sent');
    const type = vi.fn(() => ({ send }));
    const code = vi.fn(() => ({ type }));

    const result = sendHtml({ code } as unknown as FastifyReply, 422, '<p>страница</p>');

    expect(result).toBe('sent');
    expect(code).toHaveBeenCalledWith(422);
    expect(type).toHaveBeenCalledWith('text/html; charset=utf-8');
    expect(send).toHaveBeenCalledWith('<p>страница</p>');
  });
});

describe('redirectTo', () => {
  it('перенаправление 303: браузер повторяет запрос методом GET', () => {
    const { reply, redirect } = fakeReply();

    expect(redirectTo(reply, '/chats/5?notice=sent')).toBe('redirected');
    expect(redirect).toHaveBeenCalledWith('/chats/5?notice=sent', 303);
  });
});
