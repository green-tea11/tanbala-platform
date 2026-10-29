import { formatAlmatyTime } from './format.js';
import { markup, type SafeHtml } from './html.js';

/** Время в элементе time: машиночитаемый ISO в UTC и подпись по Алматы. */
export function timeTag(ms: number): SafeHtml {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return markup`${formatAlmatyTime(Number.NaN)}`;
  return markup`<time datetime="${date.toISOString()}">${formatAlmatyTime(ms)}</time>`;
}

/** Сколько страниц у списка из total записей; пустой список это одна страница. */
export function pageCountOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Адрес страницы списка: параметры фильтра и номер страницы. Страница 1 без параметра page.
 * Значения параметров только свои (перечисления и числа), из адреса запроса сюда ничего чужого не попадает.
 */
export function listUrl(
  path: string,
  params: Readonly<Record<string, string>>,
  page: number,
): string {
  const query = new URLSearchParams(params);
  if (page > 1) query.set('page', String(page));
  const text = query.toString();
  return text === '' ? path : `${path}?${text}`;
}

export interface PagerModel {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly page: number;
  readonly pageCount: number;
}

/** Переходы между страницами списка; на единственной странице ничего не показывается. */
export function renderPager(model: PagerModel): SafeHtml {
  const { path, params, page, pageCount } = model;
  if (page <= 1 && pageCount <= 1) return markup``;
  // Страница за пределами списка ведёт назад к последней существующей.
  const previous = Math.min(page - 1, pageCount);
  return markup`<nav class="pager" aria-label="Страницы">
    ${page > 1 ? markup`<a href="${listUrl(path, params, previous)}" rel="prev">Назад</a>` : null}
    <span>Страница ${page} из ${pageCount}</span>
    ${page < pageCount ? markup`<a href="${listUrl(path, params, page + 1)}" rel="next">Вперёд</a>` : null}
  </nav>`;
}
