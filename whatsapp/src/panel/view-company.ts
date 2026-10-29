import type {
  CandidateSource,
  CompanyPain,
  CompanySummary,
  ResearchState,
} from '../domain/company.js';
import { companyCardHref } from '../handoff/card-link.js';
import { cleanText, markup, type Fragment, type SafeHtml } from './html.js';
import { timeTag } from './view-parts.js';

/** Что о компании клиента не удалось прочитать: подробности только в логе. */
const NOT_READ = 'Данные о компании не прочитаны. Подробности записаны в лог бота.';

const STATUS_LABELS: Readonly<Record<CompanySummary['status'], string>> = {
  confirmed: 'подтверждена клиентом',
  candidate: 'кандидат, клиент не подтвердил',
  unknown: 'не определена',
  off: 'функция выключена',
};

/** Как найден кандидат: шаги определения компании и проверка в почтовом проекте. */
const SOURCE_LABELS: Readonly<Record<CandidateSource, string>> = {
  profile_domain: 'по сайту или почте из бизнес-профиля',
  phone: 'по номеру',
  profile_name: 'по имени профиля',
  message: 'по названию со слов клиента',
  logo: 'по логотипу на фото профиля',
  research: 'по проверке почтового проекта',
};

type FailReason = Extract<ResearchState, { readonly status: 'failed' }>['reason'];

/** Почему проверка новой компании не удалась; null и not_found (проект B не знает задачу) это ошибка. */
const FAIL_LABELS: Readonly<Record<NonNullable<FailReason>, string>> = {
  not_in_2gis: 'не найдена в 2ГИС',
  city_unsupported: 'город не поддерживается',
  rate_limited: 'дневной лимит проверок',
  budget_exhausted: 'бюджет проверок исчерпан',
  timeout: 'не дождались результата',
  not_found: 'ошибка',
  error: 'ошибка',
};

const PAIN_SOURCE_LABELS: Readonly<Record<NonNullable<CompanyPain['source']>, string>> = {
  site: 'сайт',
  '2gis': '2ГИС',
};

/** Недоверенный текст для вывода: без скрытых символов; нет значения или пусто => null (строки не будет). */
function textOf(value: string | null): string | null {
  const text = value === null ? '' : cleanText(value).trim();
  return text === '' ? null : text;
}

/** Строка списка фактов; значения нет => строки нет. */
function row(label: string, value: Fragment): SafeHtml {
  return value === null ? markup`` : markup`<dt>${label}</dt><dd>${value}</dd>`;
}

/** Ссылка на карточку: только по http и https (handoff/card-link.ts, то же правило, что в уведомлении). */
function cardLink(url: string | null): SafeHtml | null {
  const href = companyCardHref(url);
  if (href === null) return null;
  return markup`<a href="${href}" target="_blank" rel="noopener noreferrer">Карточка в почтовом проекте</a>`;
}

function emailedLabel(emailed: boolean | null): string | null {
  if (emailed === null) return null;
  return emailed ? 'да' : 'нет';
}

function researchLabel(research: ResearchState | null): Fragment {
  if (research === null) return null;
  if (research.status === 'done') return 'завершена, компания найдена';
  if (research.status === 'failed') return FAIL_LABELS[research.reason ?? 'error'];
  return markup`идёт с ${timeTag(research.startedAtMs)}`;
}

/** Боль из справки: сама боль, ниже цитата и источник, если они есть. */
function briefPainItem(pain: CompanyPain): SafeHtml {
  const evidence = textOf(pain.evidence);
  const details = [
    evidence === null ? null : `«${evidence}»`,
    pain.source === null ? null : `источник: ${PAIN_SOURCE_LABELS[pain.source]}`,
  ].filter((part) => part !== null);
  return markup`<li>${textOf(pain.pain) ?? 'без названия'}${details.length === 0 ? null : markup`<div class="muted">${details.join(', ')}</div>`}</li>`;
}

function painList(items: readonly SafeHtml[]): SafeHtml | null {
  return items.length === 0 ? null : markup`<ul class="pains">${items}</ul>`;
}

function confirmedPainList(pains: readonly string[]): SafeHtml | null {
  const texts = pains.map(textOf).filter((text) => text !== null);
  return painList(texts.map((text) => markup`<li>${text}</li>`));
}

function companyRows(summary: CompanySummary): readonly SafeHtml[] {
  const { candidateSource } = summary;
  return [
    row('Статус', STATUS_LABELS[summary.status]),
    row('Название', textOf(summary.name)),
    row('Город', textOf(summary.city)),
    row('Рубрика', textOf(summary.rubric)),
    row('Как найден кандидат', candidateSource === null ? null : SOURCE_LABELS[candidateSource]),
    row('Почтовый проект', cardLink(summary.cardUrl)),
    row('Писали на почту', emailedLabel(summary.emailed)),
    row('Проверка новой компании', researchLabel(summary.research)),
    row('Боли из справки', painList(summary.briefPains.map(briefPainItem))),
    row('Боли, подтверждённые клиентом', confirmedPainList(summary.confirmedPains)),
    row('Название со слов клиента', summary.name === null ? textOf(summary.statedName) : null),
  ];
}

/**
 * Раздел «Компания» карточки чата: статус определения, название, город, рубрика, как найден кандидат, ссылка на
 * карточку в почтовом проекте (только http и https, rel="noopener noreferrer"), писали ли мы на почту, проверка
 * новой компании, боли из справки с цитатой и источником, боли, подтверждённые клиентом, и название со слов клиента,
 * пока компания не найдена. Строки без значения не выводятся. Все тексты недоверенные (клиент, модель, сайты и
 * 2ГИС): без скрытых символов, экранирует markup``. summary null: сводку прочитать не удалось.
 */
export function renderCompanySection(summary: CompanySummary | null): SafeHtml {
  return markup`<section class="card" aria-labelledby="company-title">
<h2 id="company-title">Компания</h2>
${summary === null ? markup`<p class="muted">${NOT_READ}</p>` : markup`<dl class="facts">${companyRows(summary)}</dl>`}
</section>`;
}
