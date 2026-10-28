/** Ссылка на карточку компании открывается и идёт менеджеру только с этими протоколами. */
const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Адрес карточки компании в интерфейсе почтового проекта (CompanySummary.cardUrl) в разобранном виде, без пробелов
 * и переводов строк, или null: адреса нет, он не разбирается или он не http и не https. Одно правило для уведомления
 * менеджеру (handoff/notification.ts) и панели (panel/view-company.ts).
 */
export function companyCardHref(url: string | null): string | null {
  if (url === null || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  return WEB_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
}
