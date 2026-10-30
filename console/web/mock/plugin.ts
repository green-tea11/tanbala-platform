import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { clientFixture, homeFixture } from './fixtures';

// Заглушка /api для `npm run dev`: отвечает формами docs/API.md, действия принимает и ничего не делает.
// ?state=… в адресе страницы переключает крайние случаи (wa-down, leads-down, empty) для проверки вида.

const CSRF = 'dev-csrf-token';

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function stateOf(req: IncomingMessage): string {
  const referer = req.headers.referer ?? '';
  try {
    return new URL(referer).searchParams.get('state') ?? '';
  } catch {
    return '';
  }
}

const WA_DOWN = { unavailable: true, reason: 'unavailable', source: 'wa', message: 'Бот не запущен или недоступен.' };
const LEADS_DOWN = { unavailable: true, reason: 'unavailable', source: 'leads', message: 'Почта не запущена или недоступна.' };

function homeFor(state: string) {
  const home = homeFixture(Date.now());
  if (state === 'wa-down') {
    return { ...home, botStatus: WA_DOWN, attention: WA_DOWN, afterLetter: WA_DOWN, mode: { ...home.mode, bot: { code: 'unavailable', text: 'Бот не запущен или недоступен' } }, spend: { ...home.spend, bot: WA_DOWN, botCalls: WA_DOWN } };
  }
  if (state === 'leads-down') {
    return { ...home, leadsSummary: LEADS_DOWN, afterLetter: LEADS_DOWN, mode: { ...home.mode, leads: { code: 'unavailable', text: 'Почта не запущена или недоступна' } }, spend: { ...home.spend, leads: LEADS_DOWN, leadsBudget: LEADS_DOWN } };
  }
  if (state === 'empty') {
    return {
      ...home,
      attention: { handoffs: [], hot: [], waiting: [], backlog: { pending: 0 }, newHandoffs: 0, counts: { handoffs: { total: 0, truncated: false }, hot: { total: 0, truncated: false }, waiting: { total: 0, truncated: false, staleExcluded: 0 } } },
      leadsSummary: { ...home.leadsSummary, activeRun: null, research: { today: 0, perDay: 20, active: [] }, overview: { ...home.leadsSummary.overview, lettersPending: 0 } },
      afterLetter: { items: [], total: 0, newCount: 0, linksTruncated: false, note: home.afterLetter.note },
    };
  }
  return home;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function handle(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  if (!path.startsWith('/api/')) return false;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/api/session') {
    send(res, 200, { user: { name: 'owner', role: 'owner' }, csrfToken: CSRF });
    return true;
  }
  if (method === 'GET' && path === '/api/home') {
    send(res, 200, homeFor(stateOf(req)));
    return true;
  }
  const client = /^\/api\/clients\/(\d{1,9})$/.exec(path);
  if (method === 'GET' && client) {
    if (stateOf(req) === 'wa-down') {
      send(res, 200, WA_DOWN);
      return true;
    }
    const card = clientFixture(Date.now(), Number(client[1]));
    if (card === null) send(res, 404, { error: 'not_found', message: 'Чат не найден.' });
    else send(res, 200, card);
    return true;
  }
  if (method === 'POST') {
    void readBody(req).then((body) => {
      if (req.headers['x-csrf-token'] !== CSRF) {
        send(res, 403, { error: 'csrf', message: 'Страница устарела. Обновите её и повторите.' });
        return;
      }
      if (/\/reply$/.test(path)) {
        send(res, 200, { result: 'sent', message: 'Сообщение отправлено клиенту' });
      } else if (/\/return$/.test(path)) {
        send(res, 200, { result: 'returned_answering', message: 'Чат возвращён боту: бот ответит на сообщения клиента без ответа', resumed: 1 });
      } else if (path === '/api/seen') {
        const ids = (body as { ids?: unknown[] } | null)?.ids ?? [];
        send(res, 200, { result: 'seen', kind: 'handoff', count: ids.length });
      } else {
        send(res, 404, { error: 'not_found', message: 'Нет такого адреса.' });
      }
    });
    return true;
  }
  send(res, 404, { error: 'not_found', message: 'Нет такого адреса.' });
  return true;
}

export function mockApi(): Plugin {
  return {
    name: 'tanbala-mock-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!handle(req, res)) next();
      });
    },
  };
}
