import type { z } from 'zod';
import type { Logger } from '../shared/logger.js';
import type { BackendClient } from './client.js';
import { parsed } from './parsed.js';
import { consolePath, type BackendPath } from './paths.js';
import type { BackendResult } from './result.js';
import {
  anyObjectSchema,
  chatCardSchema,
  companyLinksSchema,
  listSchema,
  replyResultSchema,
  returnResultSchema,
  waAttentionSchema,
  waSpendSchema,
  waStatusSchema,
} from './schemas.js';

export interface ChatsQuery {
  readonly status?: 'bot' | 'manager';
  readonly level?: 'cold' | 'warm' | 'hot';
  readonly company?: 'confirmed' | 'candidate' | 'none';
  readonly waiting?: 1;
  readonly q?: string;
  readonly page?: number;
}

export interface NotificationsQuery {
  readonly status?: string;
  readonly page?: number;
}

type Result<S extends z.ZodType> = Promise<BackendResult<z.output<S>>>;

/** Бот (whatsapp): эндпоинты /internal/console/* на 127.0.0.1:3101 по контракту CONSOLE_API, раздел 3. */
export function createWaApi(client: BackendClient, logger: Logger) {
  const get = <S extends z.ZodType>(path: BackendPath, schema: S): Result<S> =>
    parsed(client.get(path), schema, { backend: 'wa', path, logger });
  const post = <S extends z.ZodType>(
    path: BackendPath,
    body: Readonly<Record<string, unknown>>,
    user: string,
    schema: S,
  ): Result<S> =>
    parsed(client.post(path, body, user), schema, { backend: 'wa', path, logger, action: true });

  return {
    status: () => get(consolePath(['status']), waStatusSchema),
    attention: () => get(consolePath(['attention']), waAttentionSchema),
    chats: (query: ChatsQuery) => get(consolePath(['chats'], { ...query }), listSchema),
    chat: (id: number) => get(consolePath(['chats', id]), chatCardSchema),
    messages: (id: number, before?: number) =>
      get(consolePath(['chats', id, 'messages'], { before }), anyObjectSchema),
    notifications: (query: NotificationsQuery) =>
      get(consolePath(['notifications'], { ...query }), listSchema),
    companyLinks: (companyId?: number) =>
      get(consolePath(['company-links'], { companyId }), companyLinksSchema),
    spend: (from: string, to: string) => get(consolePath(['spend'], { from, to }), waSpendSchema),
    reply: (id: number, text: string, user: string) =>
      post(consolePath(['chats', id, 'reply']), { text }, user, replyResultSchema),
    returnToBot: (id: number, note: string, user: string) =>
      post(consolePath(['chats', id, 'return']), { note }, user, returnResultSchema),
  };
}

export type WaApi = ReturnType<typeof createWaApi>;
