import type { SessionRecord } from '../db/sessions.js';

/**
 * Кому открыт маршрут. public — без сессии (вход, выход, статика, /healthz); manager — любой вошедший
 * (менеджер и владелец); owner — только владелец. Маршрут без объявленного доступа отклоняется всегда.
 */
export type Access = 'public' | 'manager' | 'owner';

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    /** Сессия запроса к /api (хук onRequest); нет сессии или не /api: null. */
    auth: SessionRecord | null;
  }
}
