import { describe, expect, it } from 'vitest';
import type { Chat, Jid, StoredMessage } from '../../../src/domain/types.js';
import {
  chatIdOf,
  createHarness,
  makeChat,
  makeMessage,
  makeNotification,
  MINUTE_MS,
  T0,
  type Harness,
} from './harness.js';

const PAGE_SIZE = 30;
const HISTORY_SIZE = 50;

/** Текст страницы без разметки и лишних пробелов. */
function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rowsOf(body: string): string[] {
  return body.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
}

async function getPage(h: Harness, url: string): Promise<string> {
  const { cookie } = await h.login();
  const response = await h.request({ url, cookie });
  expect(response.statusCode, url).toBe(200);
  return response.body;
}

const lidChat = (id: number): Chat =>
  makeChat(id, {
    pushName: null,
    identity: {
      replyJid: '100000000000009@lid' as Jid,
      lidJid: '100000000000009@lid' as Jid,
      pnJid: null,
    },
  });

describe('панель: список чатов', () => {
  function seeded(): Harness {
    const h = createHarness({
      data: {
        chats: [
          makeChat(1, {
            pushName: 'Алия',
            control: { status: 'manager', by: 'bot' },
            level: 'hot',
          }),
          lidChat(2),
          makeChat(3, { level: 'warm' }),
        ],
      },
    });
    h.data.handoffs.set(1, { reason: 'hot', level: 'hot', openedAtMs: T0 });
    h.data.lastMessageAt.set(1, Date.UTC(2026, 9, 26, 10, 0));
    h.data.lastMessageAt.set(3, Date.UTC(2026, 9, 25, 20, 30));
    return h;
  }

  it('строки в порядке репозитория: имя ссылкой, номер, статус, уровень, время по Алматы, причина передачи', async () => {
    const page = await getPage(seeded(), '/chats');

    expect(page).toContain('<h1>Чаты</h1>');
    const [header, first, second, third] = rowsOf(page);
    expect(plain(header ?? '')).toBe(
      'Клиент Статус Уровень Последнее сообщение Передача менеджеру',
    );
    expect(first).toContain('<a href="/chats/1">Алия</a>');
    expect(plain(first ?? '')).toBe(
      'Алия +77000000001 Менеджер горячий 26.10.2026 15:00 горячий клиент',
    );
    expect(plain(second ?? '')).toBe('без имени номер скрыт Бот холодный нет сообщений');
    expect(plain(third ?? '')).toBe('Клиент 3 +77000000003 Бот тёплый 26.10.2026 01:30');
  });

  it('читает первую страницу по 30 чатов и общее число для страниц', async () => {
    const h = seeded();

    await getPage(h, '/chats');

    expect(h.chats.listForPanel).toHaveBeenCalledWith({ limit: PAGE_SIZE, offset: 0 });
    expect(h.chats.countForPanel).toHaveBeenCalledWith({});
  });

  it('фильтр по статусу уходит в репозиторий и держится в ссылках; чужое значение игнорируется', async () => {
    const h = seeded();
    const page = await getPage(h, '/chats?status=manager');

    expect(h.chats.listForPanel).toHaveBeenCalledWith({
      status: 'manager',
      limit: PAGE_SIZE,
      offset: 0,
    });
    expect(h.chats.countForPanel).toHaveBeenCalledWith({ status: 'manager' });
    expect(rowsOf(page)).toHaveLength(2);
    expect(page).toContain('<a href="/chats?status=bot">');
    expect(page).toContain('<a href="/chats?status=manager" aria-current="page">');
    expect(page).toContain('<a href="/chats">Все</a>');

    const h2 = seeded();
    await getPage(h2, '/chats?status=hacker');
    expect(h2.chats.listForPanel).toHaveBeenCalledWith({ limit: PAGE_SIZE, offset: 0 });
  });

  it('страницы: смещение по номеру страницы, ссылки назад и вперёд хранят фильтр', async () => {
    const chats = Array.from({ length: 65 }, (_, index) =>
      makeChat(index + 1, { control: { status: 'manager', by: 'bot' } }),
    );
    const h = createHarness({ data: { chats } });

    const page = await getPage(h, '/chats?status=manager&page=2');

    expect(h.chats.listForPanel).toHaveBeenCalledWith({
      status: 'manager',
      limit: PAGE_SIZE,
      offset: PAGE_SIZE,
    });
    expect(plain(page)).toContain('Страница 2 из 3');
    expect(plain(page)).toContain('Всего чатов: 65');
    expect(page).toContain('<a href="/chats?status=manager" rel="prev">');
    expect(page).toContain('<a href="/chats?status=manager&amp;page=3" rel="next">');
    expect(rowsOf(page)).toHaveLength(1 + PAGE_SIZE);
  });

  it.each(['abc', '0', '-1', '1.5', '1e3', '9999999999', ' 2', ''])(
    'номер страницы «%s» неверен: показывается первая',
    async (value) => {
      const h = seeded();

      await getPage(h, `/chats?page=${encodeURIComponent(value)}`);

      expect(h.chats.listForPanel).toHaveBeenCalledWith({ limit: PAGE_SIZE, offset: 0 });
    },
  );

  it('страница за пределами списка пуста, но со ссылкой назад', async () => {
    const h = seeded();

    const page = await getPage(h, '/chats?page=5');

    expect(plain(page)).toContain('На этой странице чатов нет');
    expect(page).toContain('rel="prev"');
  });

  it('нет ни одного чата: понятное сообщение', async () => {
    const page = await getPage(createHarness(), '/chats');

    expect(plain(page)).toContain('Чатов пока нет');
    expect(rowsOf(page)).toEqual([]);
  });

  it('повторяющийся параметр запроса не ломает страницу', async () => {
    const h = seeded();

    await getPage(h, '/chats?status=bot&status=manager&page=1&page=2');

    expect(h.chats.listForPanel).toHaveBeenCalledWith({ limit: PAGE_SIZE, offset: 0 });
  });

  it('всё из WhatsApp экранируется: имя с разметкой и скрытыми символами', async () => {
    const h = createHarness({
      data: { chats: [makeChat(1, { pushName: '<img src=x onerror=alert(1)>‮кто' })] },
    });

    const page = await getPage(h, '/chats');

    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;кто');
    expect(page).not.toMatch(/<img|‮/);
  });
});

describe('панель: страница чата', () => {
  function seeded(): Harness {
    const chat = makeChat(1, {
      pushName: 'Алия',
      control: { status: 'manager', by: 'bot' },
      level: 'hot',
      profile: {
        business: 'Склад одежды',
        area: '500 кв. м',
        scope: null,
        itemCount: '10 тысяч',
        has1C: true,
        oneCName: null,
        problem: 'Теряются вещи',
        specifics: null,
        problemAgreed: false,
        items: null,
        packaging: null,
        material: null,
        city: null,
        premises: null,
        turnover: null,
        currentTracking: null,
      },
    });
    const messages: StoredMessage[] = [
      makeMessage(1, 1, { author: 'client', text: 'Здравствуйте' }),
      makeMessage(2, 1, { author: 'bot', text: 'Добрый день' }),
      makeMessage(3, 1, { author: 'human_panel', text: 'Это менеджер' }),
      makeMessage(4, 1, { author: 'human_phone', text: 'Написал с телефона' }),
      makeMessage(5, 1, { author: 'client', kind: 'voice', text: null }),
      makeMessage(6, 1, { author: 'client', kind: 'voice', text: 'Расшифровка голоса' }),
      makeMessage(7, 1, { author: 'client', kind: 'other', text: null }),
      makeMessage(8, 2, { text: 'Чужой чат' }),
    ];
    const h = createHarness({ data: { chats: [chat, makeChat(2)], messages } });
    h.data.handoffs.set(1, {
      reason: 'hot',
      level: 'hot',
      openedAtMs: Date.UTC(2026, 9, 26, 9, 0),
    });
    h.data.notifications.push(
      makeNotification(1, {
        kind: 'handoff',
        status: 'no_manager',
        text: 'Передан горячий клиент',
        createdAtMs: Date.UTC(2026, 9, 26, 9, 5),
      }),
    );
    return h;
  }

  it('переписка по порядку: автор, время по Алматы и текст; чужих чатов нет', async () => {
    const page = await getPage(seeded(), '/chats/1');

    const messages = (page.match(/<li class="msg[\s\S]*?<\/li>/g) ?? []).map(plain);
    expect(messages).toEqual([
      'Клиент 26.10.2026 15:01 Здравствуйте',
      'Бот 26.10.2026 15:02 Добрый день',
      'Менеджер из панели 26.10.2026 15:03 Это менеджер',
      'Менеджер с телефона 26.10.2026 15:04 Написал с телефона',
      'Клиент 26.10.2026 15:05 [голосовое сообщение, расшифровки нет]',
      'Клиент 26.10.2026 15:06 Расшифровка голоса',
      'Клиент 26.10.2026 15:07 [сообщение другого вида]',
    ]);
    expect(page).not.toContain('Чужой чат');
  });

  it('заголовок: имя и номер; карточка: статус, уровень и выжимка с пометкой «не выяснили»', async () => {
    const page = await getPage(seeded(), '/chats/1');
    const text = plain(page);

    expect(page).toContain('<h1>Алия</h1>');
    expect(text).toContain('+77000000001');
    expect(text).toContain('Ведёт менеджер (передал бот)');
    expect(text).toContain('Уровень интереса горячий');
    expect(text).toContain('Бизнес Склад одежды');
    expect(text).toContain('Площадь 500 кв. м');
    expect(text).toContain('Что отмечать не выяснили');
    expect(text).toContain('Число вещей 10 тысяч');
    expect(text).toContain('1С есть');
    expect(text).toContain('Что мешает Теряются вещи');
    expect(text).toContain('Особенности не выяснили');
    expect(text).toContain('Согласие, что трудность есть не выяснили');
  });

  it('какая 1С и согласие, что трудность есть, видны в карточке', async () => {
    const h = createHarness({
      data: {
        chats: [
          makeChat(1, {
            profile: {
              business: null,
              area: null,
              scope: null,
              itemCount: null,
              has1C: true,
              oneCName: '1С:Управление торговлей',
              problem: null,
              specifics: null,
              problemAgreed: true,
              items: null,
              packaging: null,
              material: null,
              city: null,
              premises: null,
              turnover: null,
              currentTracking: null,
            },
          }),
        ],
      },
    });

    const text = plain(await getPage(h, '/chats/1'));

    expect(text).toContain('1С есть, 1С:Управление торговлей');
    expect(text).toContain('Согласие, что трудность есть да');
  });

  it('1С: нет и не выяснили различаются', async () => {
    const h = createHarness({
      data: {
        chats: [
          makeChat(1, {
            profile: {
              business: null,
              area: null,
              scope: null,
              itemCount: null,
              has1C: false,
              oneCName: null,
              problem: null,
              specifics: null,
              problemAgreed: false,
              items: null,
              packaging: null,
              material: null,
              city: null,
              premises: null,
              turnover: null,
              currentTracking: null,
            },
          }),
          makeChat(2),
        ],
      },
    });

    expect(plain(await getPage(h, '/chats/1'))).toContain('1С нет');
    expect(plain(await getPage(h, '/chats/2'))).toContain('1С не выяснили');
  });

  it('открытая передача и последнее уведомление в карточке', async () => {
    const h = seeded();
    const text = plain(await getPage(h, '/chats/1'));

    expect(h.handoffs.findOpen).toHaveBeenCalledWith(chatIdOf(1));
    expect(h.notifications.latestForChat).toHaveBeenCalledWith(chatIdOf(1));
    expect(text).toContain('Открытая передача горячий клиент, уровень горячий, с 26.10.2026 14:00');
    expect(text).toContain(
      'Последнее уведомление менеджеру передача чата, номер менеджера не задан, только в панели, 26.10.2026 14:05',
    );
    expect(text).toContain('Передан горячий клиент');
  });

  it('нет открытой передачи и уведомлений: так и написано', async () => {
    const h = createHarness({ data: { chats: [makeChat(1)] } });

    const text = plain(await getPage(h, '/chats/1'));

    expect(text).toContain('Открытая передача нет');
    expect(text).toContain('Последнее уведомление менеджеру нет');
  });

  it('чат у менеджера: есть форма ответа и кнопка «Вернуть боту»; оба с токеном CSRF', async () => {
    const page = await getPage(seeded(), '/chats/1');

    expect(page).toMatch(/<form method="post" action="\/chats\/1\/reply">/);
    expect(page).toMatch(/<textarea[^>]*name="text"[^>]*maxlength="4096"[^>]*required/);
    expect(page).toMatch(/<form method="post" action="\/chats\/1\/return">[\s\S]*Вернуть боту/);
    expect(page.match(/name="csrf" value="[A-Za-z0-9_-]{43}"/g)).toHaveLength(3);
  });

  it('чат у бота: форма ответа есть с предупреждением, кнопки возврата нет', async () => {
    const h = createHarness({ data: { chats: [makeChat(1)] } });

    const page = await getPage(h, '/chats/1');

    expect(page).toContain('action="/chats/1/reply"');
    expect(page).not.toContain('action="/chats/1/return"');
    expect(plain(page)).toContain('чат перейдёт к менеджеру, бот в нём замолчит');
  });

  it('показывает последние 50 сообщений и ссылку «Показать раньше» на предыдущие', async () => {
    const messages = Array.from({ length: 60 }, (_, index) => makeMessage(index + 1, 1));
    const h = createHarness({ data: { chats: [makeChat(1)], messages } });

    const page = await getPage(h, '/chats/1');

    expect(h.messages.history).toHaveBeenCalledWith(chatIdOf(1), { limit: HISTORY_SIZE + 1 });
    expect((page.match(/<li class="msg/g) ?? []).length).toBe(HISTORY_SIZE);
    expect(page).toContain('<a href="/chats/1?before=11">Показать раньше</a>');
    expect(plain(page)).not.toContain('Сообщение 10 ');
    expect(plain(page)).toContain('Сообщение 11 ');
    expect(plain(page)).toContain('Сообщение 60 ');
  });

  it('«Показать раньше» открывает предыдущий кусок; у начала переписки ссылки нет, есть возврат к последним', async () => {
    const messages = Array.from({ length: 60 }, (_, index) => makeMessage(index + 1, 1));
    const h = createHarness({ data: { chats: [makeChat(1)], messages } });

    const page = await getPage(h, '/chats/1?before=11');

    expect(h.messages.history).toHaveBeenCalledWith(chatIdOf(1), {
      limit: HISTORY_SIZE + 1,
      beforeId: 11,
    });
    expect((page.match(/<li class="msg/g) ?? []).length).toBe(10);
    expect(page).not.toContain('Показать раньше');
    expect(page).toContain('<a href="/chats/1">К последним сообщениям</a>');
  });

  it('короткая переписка: ссылки «Показать раньше» нет', async () => {
    const page = await getPage(seeded(), '/chats/1');

    expect(page).not.toContain('Показать раньше');
    expect(page).not.toContain('К последним сообщениям');
  });

  it('пустая переписка', async () => {
    const h = createHarness({ data: { chats: [makeChat(1)] } });

    expect(plain(await getPage(h, '/chats/1'))).toContain('Сообщений пока нет');
  });

  it.each(['abc', '0', '-1', '1.5', '1e3', '99999999999999999999', '00001'])(
    'адрес чата «%s» неверен: 404 без обращения к базе',
    async (id) => {
      const h = seeded();
      const { cookie } = await h.login();

      const response = await h.request({ url: `/chats/${id}`, cookie });

      expect(response.statusCode).toBe(404);
      expect(h.chats.getById).not.toHaveBeenCalled();
    },
  );

  it('чата нет: 404 с понятным текстом', async () => {
    const h = seeded();
    const { cookie } = await h.login();

    const response = await h.request({ url: '/chats/999', cookie });

    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('Чат не найден');
  });

  it('неверное значение before игнорируется', async () => {
    const h = seeded();

    await getPage(h, '/chats/1?before=abc');

    expect(h.messages.history).toHaveBeenCalledWith(chatIdOf(1), { limit: HISTORY_SIZE + 1 });
  });

  it.each([
    ['sent', 'Сообщение отправлено клиенту'],
    ['returned', 'Чат возвращён боту'],
    ['returned_answering', 'Чат возвращён боту: бот ответит на сообщения клиента без ответа'],
    ['already_bot', 'Чат уже ведёт бот'],
    ['duplicate', 'Это сообщение уже отправлено'],
  ])('пометка после действия notice=%s', async (notice, text) => {
    const page = await getPage(seeded(), `/chats/1?notice=${notice}`);

    expect(plain(page)).toContain(text);
  });

  it('чужое значение notice не попадает на страницу', async () => {
    const page = await getPage(seeded(), '/chats/1?notice=%3Cscript%3Ealert(1)%3C/script%3E');

    expect(page).not.toContain('alert(1)');
    expect(page).not.toContain('class="notice');
  });

  it('текст из WhatsApp и выжимка экранируются; разметка не выполняется', async () => {
    const attack = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    const h = createHarness({
      data: {
        chats: [
          makeChat(1, {
            pushName: attack,
            profile: {
              business: attack,
              area: attack,
              scope: attack,
              itemCount: attack,
              has1C: null,
              oneCName: null,
              problem: attack,
              specifics: attack,
              problemAgreed: false,
              items: null,
              packaging: null,
              material: null,
              city: null,
              premises: null,
              turnover: null,
              currentTracking: null,
            },
          }),
        ],
        messages: [makeMessage(1, 1, { text: attack })],
      },
    });
    h.data.notifications.push(makeNotification(1, { text: attack }));

    const page = await getPage(h, '/chats/1');

    expect(page).not.toMatch(/<script|<img/i);
    expect(page).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('переносы строк сохраняются стилем, а не разметкой', async () => {
    const h = createHarness({
      data: { chats: [makeChat(1)], messages: [makeMessage(1, 1, { text: 'строка 1\nстрока 2' })] },
    });

    const page = await getPage(h, '/chats/1');

    expect(page).toContain('строка 1\nстрока 2');
    expect(page).not.toContain('<br');
  });
});

describe('панель: уведомления менеджеру', () => {
  function seeded(): Harness {
    const h = createHarness({ data: { chats: [makeChat(1)] } });
    h.data.notifications.push(
      makeNotification(1, { kind: 'handoff', status: 'sent', text: 'Первое', attempts: 1 }),
      makeNotification(2, {
        kind: 'backlog',
        chatId: null,
        status: 'no_manager',
        text: 'Список чатов',
        attempts: 1,
      }),
      makeNotification(3, {
        kind: 'limit',
        status: 'failed',
        text: 'Лимит\nвторая строка',
        attempts: 2,
      }),
    );
    return h;
  }

  it('новые сверху: вид, статус по-русски, время, чат ссылкой, текст целиком', async () => {
    const page = await getPage(seeded(), '/notifications');

    const [header, first, second, third] = rowsOf(page);
    expect(page).toContain('<h1>Уведомления менеджеру</h1>');
    expect(plain(header ?? '')).toBe('Время Вид Статус Чат Текст');
    expect(plain(first ?? '')).toBe(
      '26.10.2026 15:03 лимит вызовов API сбой отправки, попыток: 2 Чат 1 Лимит вторая строка',
    );
    expect(first).toContain('<a href="/chats/1">Чат 1</a>');
    expect(plain(second ?? '')).toBe(
      '26.10.2026 15:02 чаты за время простоя номер менеджера не задан, только в панели нет Список чатов',
    );
    expect(plain(third ?? '')).toBe(
      '26.10.2026 15:01 передача чата отправлено менеджеру Чат 1 Первое',
    );
    expect(page).toContain('Лимит\nвторая строка');
  });

  it('читает первую страницу по 30 штук и общее число', async () => {
    const h = seeded();

    await getPage(h, '/notifications');

    expect(h.notifications.listRecent).toHaveBeenCalledWith({ limit: PAGE_SIZE, offset: 0 });
    expect(h.notifications.countAll).toHaveBeenCalled();
  });

  it('страницы: смещение, ссылки назад и вперёд', async () => {
    const h = createHarness();
    for (let id = 1; id <= 65; id += 1) h.data.notifications.push(makeNotification(id));

    const page = await getPage(h, '/notifications?page=2');

    expect(h.notifications.listRecent).toHaveBeenCalledWith({
      limit: PAGE_SIZE,
      offset: PAGE_SIZE,
    });
    expect(plain(page)).toContain('Страница 2 из 3');
    expect(page).toContain('<a href="/notifications" rel="prev">');
    expect(page).toContain('<a href="/notifications?page=3" rel="next">');
  });

  it('пока уведомлений нет: понятное сообщение', async () => {
    const page = await getPage(createHarness(), '/notifications');

    expect(plain(page)).toContain('Уведомлений пока нет');
  });

  it('в навигации есть переход к уведомлениям и выход', async () => {
    const page = await getPage(seeded(), '/chats');

    expect(page).toContain('<a href="/chats"');
    expect(page).toContain('<a href="/notifications"');
    expect(page).toMatch(/<form method="post" action="\/logout">[\s\S]*Выйти/);
  });
});

describe('панель: время', () => {
  it('время сообщения в элементе time с ISO в UTC и подписью по Алматы', async () => {
    const h = createHarness({
      data: { chats: [makeChat(1)], messages: [makeMessage(1, 1, { tsMs: T0 + 30 * MINUTE_MS })] },
    });

    const page = await getPage(h, '/chats/1');

    expect(page).toContain('<time datetime="2026-10-26T10:30:00.000Z">26.10.2026 15:30</time>');
  });
});

describe('панель: заметка для бота (решение владельца 29.10.2026)', () => {
  it('чат у менеджера: в форме возврата поле заметки до 1000 символов; подсказка: бот может пересказать её клиенту', async () => {
    const h = createHarness({
      data: { chats: [makeChat(1, { control: { status: 'manager', by: 'bot' } })] },
    });

    const page = await getPage(h, '/chats/1');

    expect(page).toMatch(
      /<form method="post" action="\/chats\/1\/return">[\s\S]*<textarea id="return-note" name="note" maxlength="1000"[\s\S]*<\/form>/,
    );
    expect(page).toContain('<label for="return-note">Заметка для бота</label>');
    // Подсказка не обещает, что клиент ничего из заметки не узнает (ревью 29.10.2026): бот пересказывает её клиенту.
    expect(page).not.toContain('клиент её не увидит');
    expect(page).toContain('Бот может пересказать заметку клиенту своими словами');
    expect(page).toContain('Скидки, маржу и внутренние указания сюда не пишите');
  });

  it('карточка показывает заметку экранированной; нет заметки: «нет»', async () => {
    const attack = '<script>alert(1)</script> ориентир от 500 000 тенге';
    const h = createHarness({
      data: {
        chats: [makeChat(1), makeChat(2)],
        notes: new Map([[1, { text: attack, atMs: T0 }]]),
      },
    });

    const withNote = await getPage(h, '/chats/1');
    const without = plain(await getPage(h, '/chats/2'));

    expect(withNote).not.toContain('<script>');
    expect(withNote).toContain('&lt;script&gt;alert(1)&lt;/script&gt; ориентир от 500 000 тенге');
    expect(plain(withNote)).toContain('Заметка для бота');
    expect(without).toContain('Заметка для бота нет');
  });
});
