// Форматы панели: время по Алматы (UTC+5, как у бота и почты), деньги, номера, длительности.

const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function almatyParts(ms: number): { day: string; time: string } {
  const shifted = new Date(ms + ALMATY_OFFSET_MS).toISOString();
  return { day: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}

function parse(isoText: string | null | undefined): number | null {
  if (!isoText) return null;
  const ms = Date.parse(isoText);
  return Number.isNaN(ms) ? null : ms;
}

/** «11:42», «вчера 18:05», «28.10 09:15», «28.10.2025». */
export function clockTime(isoText: string | null | undefined, now = Date.now()): string {
  const ms = parse(isoText);
  if (ms === null) return '—';
  const { day, time } = almatyParts(ms);
  const today = almatyParts(now).day;
  const yesterday = almatyParts(now - DAY).day;
  if (day === today) return time;
  if (day === yesterday) return `вчера ${time}`;
  const [year, month, date] = day.split('-');
  if (year === today.slice(0, 4)) return `${date}.${month} ${time}`;
  return `${date}.${month}.${year}`;
}

/** Длительность ожидания: «4 мин», «1 ч 12 мин», «3 дн». */
export function waitDuration(minutes: number): string {
  if (minutes < 1) return 'меньше минуты';
  if (minutes < 60) return `${Math.floor(minutes)} мин`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = Math.floor(minutes % 60);
    return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
  }
  return `${Math.floor(minutes / (24 * 60))} дн`;
}

export function minutesSince(isoText: string | null | undefined, now = Date.now()): number {
  const ms = parse(isoText);
  return ms === null ? 0 : Math.max(0, (now - ms) / MINUTE);
}

/** «16 мин назад», «3 ч назад», «вчера 18:05». */
export function relativeTime(isoText: string | null | undefined, now = Date.now()): string {
  const minutes = minutesSince(isoText, now);
  if (parse(isoText) === null) return '—';
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${Math.floor(minutes)} мин назад`;
  if (minutes < 12 * 60) return `${Math.floor(minutes / 60)} ч назад`;
  return clockTime(isoText, now);
}

/** Деньги API: «$0.43», меньше цента — «< $0.01», нет цены — «—». */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value > 0 && value < 0.005) return '< $0.01';
  return `$${value.toFixed(2)}`;
}

/** Целое с узким пробелом между тысячами: «1 284 000». */
export function count(value: number): string {
  return Math.round(value).toLocaleString('ru-RU').replace(/\s/g, ' ');
}

/** 77015550112 → «+7 701 555 01 12»; null → null. */
export function phoneLabel(digits: string | null | undefined): string | null {
  if (!digits) return null;
  const match = /^(7)(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(digits);
  return match ? `+${match[1]} ${match[2]} ${match[3]} ${match[4]} ${match[5]}` : `+${digits}`;
}

/** Ссылки на номер собираются только из цифр (PLAN §3). */
export function telHref(digits: string | null | undefined): string | null {
  return digits && /^\d{10,15}$/.test(digits) ? `tel:+${digits}` : null;
}

export function waHref(digits: string | null | undefined): string | null {
  return digits && /^\d{10,15}$/.test(digits) ? `https://wa.me/${digits}` : null;
}

/** Внешняя ссылка из чужих данных: только http(s), без логина в адресе, иначе null. */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Имя клиента или понятная замена. */
export function nameOf(name: string | null | undefined): string {
  return name && name.trim() !== '' ? name : 'Без имени';
}

/** Первая буква для кружка-инициала. */
export function initialOf(name: string | null | undefined): string {
  const first = (name ?? '').trim().charAt(0);
  return first === '' ? '?' : first.toUpperCase();
}

/** Стабильный оттенок человека (по id): только бледная подложка инициала, не данные. */
export function personHue(id: number): number {
  const HUES = [205, 150, 30, 340, 95, 265, 10, 180];
  return HUES[Math.abs(id) % HUES.length] ?? 205;
}

/** Подпись поля внутри фразы: первая буква строчная, сокращения («1С», «ИНН») как есть. */
export function lowerFirst(label: string): string {
  return /^(\d|[A-ZА-ЯЁ]{2})/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}
