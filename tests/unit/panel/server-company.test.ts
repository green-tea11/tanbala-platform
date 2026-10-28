import { describe, expect, it } from 'vitest';
import type {
  CandidateSource,
  CompanyId,
  CompanySummary,
  ResearchJobId,
  ResearchState,
} from '../../../src/domain/company.js';
import { createHarness, makeChat, OFF_COMPANY, T0, type Harness } from './harness.js';

// Компании вымышленные; адрес почтового проекта условный.

const CARD_URL = 'https://mail.example.kz/companies/42';

const CONFIRMED: CompanySummary = {
  ...OFF_COMPANY,
  status: 'confirmed',
  companyId: 42 as CompanyId,
  name: 'Мебель Плюс',
  city: 'Алматы',
  rubric: 'Мебель на заказ',
  cardUrl: CARD_URL,
  confirmedPains: ['теряются вещи', 'долгая инвентаризация'],
  briefPains: [
    { pain: 'пересорт на складе', evidence: 'склад на 2000 м²', source: 'site' },
    { pain: 'долгая инвентаризация', evidence: 'инвентаризация раз в месяц', source: '2gis' },
  ],
  emailed: true,
};

const CANDIDATE: CompanySummary = {
  ...OFF_COMPANY,
  status: 'candidate',
  companyId: 7 as CompanyId,
  name: 'Склад Сервис',
  candidateSource: 'phone',
  cardUrl: 'http://127.0.0.1:8080/companies/7',
};

const UNKNOWN: CompanySummary = { ...OFF_COMPANY, status: 'unknown' };

const JOB = '00000000-0000-4000-8000-000000000001' as ResearchJobId;

/** Скрытые символы кодами: в исходнике их видно. */
const RTL_OVERRIDE = String.fromCodePoint(0x202e);
const BELL = String.fromCodePoint(0x07);
const ISOLATE = String.fromCodePoint(0x2066);

/** Текст без разметки и лишних пробелов. */
function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function harnessWith(company: CompanySummary | Error): Harness {
  const h = createHarness({ data: { chats: [makeChat(1)] } });
  h.data.companies.set(1, company);
  return h;
}

/** Раздел «Компания» страницы чата 1 как HTML. */
async function companySection(h: Harness): Promise<string> {
  const { cookie } = await h.login();
  const response = await h.request({ url: '/chats/1', cookie });
  expect(response.statusCode).toBe(200);
  const section = /<section class="card" aria-labelledby="company-title">[\s\S]*?<\/section>/.exec(
    response.body,
  );
  expect(section).not.toBeNull();
  return section?.[0] ?? '';
}

async function sectionText(company: CompanySummary | Error): Promise<string> {
  return plain(await companySection(harnessWith(company)));
}

describe('панель: раздел «Компания» карточки чата', () => {
  it('подтверждённая компания: все сведения, ссылка на карточку, боли из справки с цитатой и источником', async () => {
    const h = harnessWith(CONFIRMED);

    const section = await companySection(h);

    expect(h.company.summary).toHaveBeenCalledWith(1);
    expect(plain(section)).toBe(
      [
        'Компания',
        'Статус подтверждена клиентом',
        'Название Мебель Плюс',
        'Город Алматы',
        'Рубрика Мебель на заказ',
        'Почтовый проект Карточка в почтовом проекте',
        'Писали на почту да',
        'Боли из справки пересорт на складе «склад на 2000 м²», источник: сайт',
        'долгая инвентаризация «инвентаризация раз в месяц», источник: 2ГИС',
        'Боли, подтверждённые клиентом теряются вещи долгая инвентаризация',
      ].join(' '),
    );
    expect(section).toContain(
      `<a href="${CARD_URL}" target="_blank" rel="noopener noreferrer">Карточка в почтовом проекте</a>`,
    );
  });

  it('раздел стоит после карточки клиента и до переписки', async () => {
    const h = harnessWith(CONFIRMED);
    const { cookie } = await h.login();

    const page = (await h.request({ url: '/chats/1', cookie })).body;

    const card = page.indexOf('id="card-title"');
    const company = page.indexOf('id="company-title"');
    const history = page.indexOf('id="history-title"');
    expect(card).toBeGreaterThan(0);
    expect(company).toBeGreaterThan(card);
    expect(history).toBeGreaterThan(company);
  });

  it('кандидат: статус, как найден, ссылка; строк без значения нет', async () => {
    expect(await sectionText(CANDIDATE)).toBe(
      'Компания Статус кандидат, клиент не подтвердил Название Склад Сервис Как найден кандидат по номеру Почтовый проект Карточка в почтовом проекте',
    );
  });

  it.each<[CandidateSource, string]>([
    ['profile_domain', 'по сайту или почте из бизнес-профиля'],
    ['phone', 'по номеру'],
    ['profile_name', 'по имени профиля'],
    ['message', 'по названию со слов клиента'],
    ['logo', 'по логотипу на фото профиля'],
    ['research', 'по проверке почтового проекта'],
  ])('источник кандидата %s: «%s»', async (candidateSource, label) => {
    expect(await sectionText({ ...CANDIDATE, candidateSource })).toContain(
      `Как найден кандидат ${label}`,
    );
  });

  it('функция выключена: только статус', async () => {
    expect(await sectionText(OFF_COMPANY)).toBe('Компания Статус функция выключена');
  });

  it('по умолчанию (функция выключена) раздел тоже есть', async () => {
    const h = createHarness({ data: { chats: [makeChat(1)] } });

    expect(plain(await companySection(h))).toBe('Компания Статус функция выключена');
  });

  it('не определена: название со слов клиента и подтверждённые боли', async () => {
    const text = await sectionText({
      ...UNKNOWN,
      statedName: 'Ромашка',
      confirmedPains: ['теряются вещи'],
    });

    expect(text).toBe(
      'Компания Статус не определена Боли, подтверждённые клиентом теряются вещи Название со слов клиента Ромашка',
    );
  });

  it('название со слов клиента не показывается, если компания найдена', async () => {
    expect(await sectionText({ ...CANDIDATE, statedName: 'Ромашка' })).not.toContain('Ромашка');
  });

  it.each<[ResearchState, string]>([
    [{ status: 'queued', jobId: JOB, startedAtMs: T0, checkedAtMs: T0 }, 'идёт с 26.10.2026 15:00'],
    [
      { status: 'running', jobId: JOB, startedAtMs: T0, checkedAtMs: T0 },
      'идёт с 26.10.2026 15:00',
    ],
    [
      { status: 'done', companyId: 42 as CompanyId, finishedAtMs: T0 },
      'завершена, компания найдена',
    ],
    [{ status: 'failed', reason: 'not_in_2gis', finishedAtMs: T0 }, 'не найдена в 2ГИС'],
    [{ status: 'failed', reason: 'city_unsupported', finishedAtMs: T0 }, 'город не поддерживается'],
    [{ status: 'failed', reason: 'rate_limited', finishedAtMs: T0 }, 'дневной лимит проверок'],
    [
      { status: 'failed', reason: 'budget_exhausted', finishedAtMs: T0 },
      'бюджет проверок исчерпан',
    ],
    [{ status: 'failed', reason: 'timeout', finishedAtMs: T0 }, 'не дождались результата'],
    [{ status: 'failed', reason: 'not_found', finishedAtMs: T0 }, 'ошибка'],
    [{ status: 'failed', reason: 'error', finishedAtMs: T0 }, 'ошибка'],
    [{ status: 'failed', reason: null, finishedAtMs: T0 }, 'ошибка'],
  ])('проверка новой компании %j: «%s»', async (research, label) => {
    const text = await sectionText({ ...UNKNOWN, research });

    expect(text).toBe(`Компания Статус не определена Проверка новой компании ${label}`);
  });

  it('идущая проверка: время в элементе time', async () => {
    const research: ResearchState = {
      status: 'running',
      jobId: JOB,
      startedAtMs: T0,
      checkedAtMs: T0,
    };

    const section = await companySection(harnessWith({ ...UNKNOWN, research }));

    expect(section).toContain(`<time datetime="${new Date(T0).toISOString()}">`);
  });

  it('писали на почту: нет; справки нет (null): строки нет', async () => {
    expect(await sectionText({ ...CONFIRMED, emailed: false })).toContain('Писали на почту нет');
    expect(await sectionText({ ...CONFIRMED, emailed: null })).not.toContain('Писали на почту');
  });

  it('боль из справки без цитаты и источника, только с источником, пустая боль', async () => {
    const text = await sectionText({
      ...CONFIRMED,
      confirmedPains: [],
      briefPains: [
        { pain: 'пересорт', evidence: null, source: null },
        { pain: 'недостача', evidence: ' ', source: '2gis' },
        { pain: `${RTL_OVERRIDE} `, evidence: 'цитата', source: null },
      ],
    });

    expect(text).toMatch(
      /Боли из справки пересорт недостача источник: 2ГИС без названия «цитата»$/,
    );
    expect(text).not.toContain('Боли, подтверждённые клиентом');
  });

  it('пустые подтверждённые боли пропускаются; все пустые: строки нет', async () => {
    expect(await sectionText({ ...UNKNOWN, confirmedPains: [' ', 'теряются вещи'] })).toBe(
      'Компания Статус не определена Боли, подтверждённые клиентом теряются вещи',
    );
    expect(await sectionText({ ...UNKNOWN, confirmedPains: [' ', '\n'] })).toBe(
      'Компания Статус не определена',
    );
  });

  describe('ссылка на карточку', () => {
    it('cardUrl null: ссылки нет', async () => {
      const section = await companySection(harnessWith({ ...CONFIRMED, cardUrl: null }));

      expect(section).not.toContain('<a ');
      expect(plain(section)).not.toContain('Почтовый проект');
    });

    it.each([
      'javascript:alert(1)',
      'JavaScript:alert(document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://mail.example.kz/companies/42',
      '//evil.example/companies/42',
      'не адрес',
    ])('cardUrl «%s»: не http и не https, ссылки нет', async (cardUrl) => {
      const section = await companySection(harnessWith({ ...CONFIRMED, cardUrl }));

      expect(section).not.toContain('<a ');
      expect(section).not.toMatch(/javascript|data:|ftp:|evil/i);
    });

    it('кавычки и разметка в адресе не выходят из атрибута href', async () => {
      const section = await companySection(
        harnessWith({ ...CONFIRMED, cardUrl: 'https://mail.example.kz/companies/42"><script>x' }),
      );

      const links = section.match(/<a [^>]*>/g) ?? [];
      expect(links).toEqual([
        '<a href="https://mail.example.kz/companies/42%22%3E%3Cscript%3Ex" target="_blank" rel="noopener noreferrer">',
      ]);
      expect(section).not.toContain('<script');
    });
  });

  describe('экранирование недоверенных текстов', () => {
    const HOSTILE: CompanySummary = {
      ...CONFIRMED,
      name: '<script>alert(1)</script>',
      city: '"><img src=x onerror=alert(1)>',
      rubric: "Мебель' onmouseover='alert(1)",
      confirmedPains: ['<b>жирно</b>'],
      briefPains: [{ pain: '<i>боль</i>', evidence: '"цитата" & <u>ещё</u>', source: 'site' }],
    };

    it('имя с <script>, кавычки и разметка выводятся текстом', async () => {
      const section = await companySection(harnessWith(HOSTILE));

      expect(section).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(section).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
      expect(section).toContain('Мебель&#39; onmouseover=&#39;alert(1)');
      expect(section).toContain('&lt;b&gt;жирно&lt;/b&gt;');
      expect(section).toContain('&lt;i&gt;боль&lt;/i&gt;');
      expect(section).toContain('«&quot;цитата&quot; &amp; &lt;u&gt;ещё&lt;/u&gt;»');
      expect(section).not.toMatch(/<script|<img|<b>|<i>|<u>/);
    });

    it('скрытые символы (смена направления текста, управляющие) убираются', async () => {
      const text = await sectionText({
        ...UNKNOWN,
        statedName: `Ром${RTL_OVERRIDE}ашка${BELL}`,
        confirmedPains: [`боль${ISOLATE}`],
      });

      expect(text).toContain('Название со слов клиента Ромашка');
      expect(text).toContain('Боли, подтверждённые клиентом боль');
      for (const char of [RTL_OVERRIDE, BELL, ISOLATE]) expect(text).not.toContain(char);
    });

    it('CSP страницы чата прежняя: без скриптов и встроенных стилей', async () => {
      const h = harnessWith(HOSTILE);
      const { cookie } = await h.login();

      const response = await h.request({ url: '/chats/1', cookie });

      const csp = String(response.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|script-src/);
    });
  });

  describe('сводку прочитать не удалось', () => {
    it('страница открывается, в разделе пометка, в лог ID чата и имя ошибки без данных', async () => {
      const h = harnessWith(new RangeError('SQLITE_BUSY: Мебель Плюс'));
      const { cookie } = await h.login();

      const response = await h.request({ url: '/chats/1', cookie });

      expect(response.statusCode).toBe(200);
      expect(plain(response.body)).toContain(
        'Компания Данные о компании не прочитаны. Подробности записаны в лог бота.',
      );
      expect(response.body).toContain('id="history-title"');
      expect(h.logs()).toContainEqual(
        expect.objectContaining({
          action: 'company_summary_failed',
          chatId: 1,
          errorName: 'RangeError',
        }),
      );
      expect(h.rawLog()).not.toContain('Мебель');
    });

    it('брошена не ошибка: в лог тип значения', async () => {
      const h = createHarness({ data: { chats: [makeChat(1)] } });
      h.company.summary.mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- проверяем бросок не ошибки
        throw 'Мебель Плюс';
      });
      const { cookie } = await h.login();

      await h.request({ url: '/chats/1', cookie });

      expect(h.logs()).toContainEqual(
        expect.objectContaining({ action: 'company_summary_failed', errorName: 'string' }),
      );
      expect(h.rawLog()).not.toContain('Мебель');
    });
  });

  it('в лог панели не попадает ничего из сводки', async () => {
    const h = harnessWith(CONFIRMED);

    await companySection(h);

    for (const secret of ['Мебель', 'Алматы', 'mail.example.kz', 'теряются', 'пересорт']) {
      expect(h.rawLog()).not.toContain(secret);
    }
  });

  it('список чатов сводку о компании не читает', async () => {
    const h = harnessWith(CONFIRMED);
    const { cookie } = await h.login();
    h.company.summary.mockClear();

    await h.request({ url: '/chats', cookie });

    expect(h.company.summary).not.toHaveBeenCalled();
  });
});
