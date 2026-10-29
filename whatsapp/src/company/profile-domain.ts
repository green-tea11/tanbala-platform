import { MAIL_DOMAINS, PLATFORM_DOMAINS } from './blocked-domains.js';

/** Самый длинный допустимый домен (RFC 1035): длиннее проект B отклонит запросом 400. */
const MAX_DOMAIN_CHARS = 253;

/** Есть ли в строке схема вида «https://»: если нет, перед разбором дописывается https://. */
const HAS_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

/**
 * Вид домена: метки из латиницы, цифр и дефисов (не с дефиса, не на дефис, до 63 знаков), зона от двух букв или
 * punycode xn--. Кириллический адрес URL приводит к punycode сам, поэтому русские буквы сюда не доходят.
 */
const DOMAIN = /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+(?:[a-z]{2,63}|xn--[a-z\d-]*[a-z\d])$/;

/** Что известно из бизнес-профиля: сайты и почта. Строки недоверенные. */
export interface ProfileContacts {
  readonly websites: readonly string[];
  readonly email: string | null;
}

/** Домен или любой его поддомен входит в список. */
function isListed(host: string, listed: readonly string[]): boolean {
  return listed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Домен из адреса сайта или из части адреса почты после «@»: hostname в нижнем регистре без «www.» и без точки
 * на конце, проверенный по виду домена. Не адрес и не домен => null.
 */
function hostOf(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  let hostname: string;
  try {
    hostname = new URL(HAS_SCHEME.test(text) ? text : `https://${text}`).hostname;
  } catch {
    return null;
  }
  const host = hostname.replace(/\.$/, '').replace(/^www\./, '');
  return host.length <= MAX_DOMAIN_CHARS && DOMAIN.test(host) ? host : null;
}

function siteDomain(website: string): string | null {
  const host = hostOf(website);
  return host === null || isListed(host, PLATFORM_DOMAINS) ? null : host;
}

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const host = hostOf(email.slice(at + 1));
  return host === null || isListed(host, MAIL_DOMAINS) ? null : host;
}

/**
 * Домен компании из бизнес-профиля WhatsApp (шаг а): сначала сайты по порядку, затем почта. Площадки и соцсети
 * (instagram.com, wa.me, taplink.cc и подобные) как сайт не годятся, общие почтовые сервисы (gmail.com, mail.ru и
 * подобные) как почта тоже. Подходящего домена нет => null.
 */
export function domainFromProfile(profile: ProfileContacts): string | null {
  const fromSite = profile.websites.map(siteDomain).find((domain) => domain !== null);
  if (fromSite !== undefined) return fromSite;
  return profile.email === null ? null : emailDomain(profile.email);
}
