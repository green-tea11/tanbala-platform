import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasControlChars } from '../shared/text.js';
import type { AppContext } from './context.js';
import { IMMUTABLE, NO_STORE } from './headers.js';
import { isApiPath } from './hooks.js';
import { sendError } from './respond.js';
import { publicRoute } from './routes/define.js';

/** Типы файлов интерфейса: всё прочее — 404 (браузер не угадывает тип: nosniff). */
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

const HTML_TYPE = MIME_TYPES['.html'] ?? 'text/html; charset=utf-8';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ASSETS_PREFIX = '/assets/';
const INDEX = 'index.html';
/** Обратный слэш и сегменты «.» и «..»: путь за пределы папки не собрать. */
const FORBIDDEN_PATH = /\\|(^|\/)\.\.?(\/|$)/;

/** Страница, пока интерфейс не собран: без скриптов и стилей (CSP их и не пустит). */
export const PLACEHOLDER_PAGE = [
  '<!doctype html>',
  '<html lang="ru">',
  '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>Tanbala</title></head>',
  '<body><h1>Панель Tanbala</h1>',
  '<p>Сервер консоли работает, а интерфейс ещё не собран (нет web/dist).</p></body>',
  '</html>',
  '',
].join('\n');

function decodePath(url: string): string | null {
  const raw = url.split('?')[0] ?? '/';
  try {
    const decoded = decodeURIComponent(raw);
    return FORBIDDEN_PATH.test(decoded) || hasControlChars(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '' && !isAbsolute(path) && path.split(sep)[0] !== '..';
}

/** Файл из папки интерфейса или null: путь за пределы папки (в том числе по ссылке), не файл, слишком большой. */
async function readStaticFile(root: string, path: string): Promise<Buffer | null> {
  const target = resolve(join(root, path));
  if (!isInside(root, target)) return null;
  try {
    const real = await realpath(target);
    const realRoot = await realpath(root);
    const info = await stat(real);
    if (!isInside(realRoot, real) || !info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(real);
  } catch {
    return null;
  }
}

async function sendIndex(root: string, reply: FastifyReply): Promise<FastifyReply> {
  const page = await readStaticFile(root, INDEX);
  return reply
    .code(200)
    .type(HTML_TYPE)
    .header('cache-control', NO_STORE)
    .send(page ?? PLACEHOLDER_PAGE);
}

/** Нет такого маршрута /api: без сессии 403 no_session, с сессией 404. */
function apiNotFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return request.auth === null
    ? sendError(reply, 403, 'no_session')
    : sendError(reply, 404, 'not_found');
}

async function serve(
  root: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (isApiPath(request.url)) return apiNotFound(request, reply);
  const path = decodePath(request.url);
  if (path === null || path === '/internal' || path.startsWith('/internal/')) {
    return sendError(reply, 404, 'not_found');
  }
  const extension = extname(path).toLowerCase();
  // Адрес без расширения — экран SPA (/chats/12): всегда index.html, без сессии.
  if (extension === '' || path === '/') return sendIndex(root, reply);
  const type = MIME_TYPES[extension];
  const file = type === undefined ? null : await readStaticFile(root, path);
  if (type === undefined || file === null) return sendError(reply, 404, 'not_found');
  const cache = path.startsWith(ASSETS_PREFIX) ? IMMUTABLE : NO_STORE;
  return reply.code(200).type(type).header('cache-control', cache).send(file);
}

/**
 * Статика интерфейса из web/dist: фиксированная таблица типов, /assets/* (имена с хэшем) — immutable, остальное
 * no-store. Любой не-/api адрес без расширения отдаёт index.html без сессии (вход решает страница по /api/session).
 * Нет web/dist — маленькая страница-заглушка.
 */
export function registerStaticRoutes(app: FastifyInstance, context: AppContext): void {
  const root = resolve(context.deps.staticDir);
  publicRoute(app, 'GET', '/*', (request, reply) => serve(root, request, reply));
}
