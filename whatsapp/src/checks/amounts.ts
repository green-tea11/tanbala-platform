import { COUNT_NOUN, TIME_NOUN, UNIT_NOUN } from './rules.js';

// Суммы в тексте ответа и в заметке для бота (указание коллеги): сверка цены по значениям, а не по словам
// (ревью 29.10.2026). «1 500 000», «1,5 млн», «1500 тыс», «1.5 миллиона» и «500к» дают одно число. Текст заранее
// в нижнем регистре и после NFKC (code-checks.normalize). Квантификаторы ограничены сверху: ответ модели зависит
// от текста клиента. Пары «от/до» и период («в месяц», «за склад») не сверяются: их оценивает проверка Haiku.

/** Сумма в тексте: значение, место и есть ли рядом признак цены. */
export interface Amount {
  /** Значение числом; у суммы словом без цифр («миллион») NaN: ни с чем не совпадает. */
  readonly value: number;
  readonly index: number;
  readonly end: number;
  /**
   * Рядом валюта или процент, слово суммы (тыс, млн, к), слово цены («ориентир», «цена», «стоимость») или это граница
   * диапазона с такой суммой («от 1 500 000 до 2 000 000 тенге»): это цена, а не количество.
   */
  readonly priced: boolean;
}

const MULTIPLIER_WORD = String.raw`(?:тыс|млн|млрд|миллион|миллиард)\p{L}{0,8}`;

// Число: разряды через точку или запятую («1.500.000», «1,500,000», не меньше двух групп: «1.500» это дробь), через
// пробел («1 500 000») или подряд, затем, может быть, дробь («1,5»). Дробь только сразу после знака: «1500000. 3
// недели» это 1 500 000, а не 15 000 003 и не 1500000,3. Затем «к» вплотную или слово суммы.
const NUMBER_AMOUNT = new RegExp(
  String.raw`(?<![\p{Nd}\p{L}])(?<int>\p{Nd}{1,3}(?:\.\p{Nd}{3}){2,4}(?!\p{Nd})|\p{Nd}{1,3}(?:,\p{Nd}{3}){2,4}(?![\p{Nd}.])|\p{Nd}{1,3}(?: \p{Nd}{3}){1,4}(?!\p{Nd})|\p{Nd}{1,15})(?:[.,](?<frac>\p{Nd}{1,6}))?(?!\p{Nd})(?:(?<kilo>[кk])(?!\p{L})|\s{0,2}(?<mult>${MULTIPLIER_WORD})\.?)?`,
  'gu',
);

/** «Полтора миллиона», «полторы тысячи», «полутора миллионов». */
const HALF_AMOUNT = new RegExp(
  String.raw`(?<!\p{L})пол(?:тор|утор)\p{L}{0,3}\s{1,3}(${MULTIPLIER_WORD})`,
  'gu',
);

/** Сумма словом без цифр: «миллион», «пара миллионов». Значение неизвестно (NaN). «Тысяч» без цифр не сумма. */
const WORD_AMOUNT =
  /(?<!\p{Nd}\s{0,2})(?<!пол(?:тор|утор)\p{L}{0,3}\s{1,3})(?<!\p{L})(?:млн|млрд|миллион|миллиард)\p{L}{0,8}/gu;

/** Не сумма: «1С», номер версии после «1С» («1С 8.3»). */
const ONE_C_AFTER = /^\s{0,2}[сc](?!\p{L})/u;
const AFTER_ONE_C = /(?<!\p{L})1\s{0,2}[сc]\s{0,3}$/u;

/** Справа количество, единица длины или площади, срок или дата: не сумма. */
const QUANTITY_AFTER = new RegExp(
  String.raw`^\.?\s{0,3}(?:${COUNT_NOUN}|${UNIT_NOUN}|${TIME_NOUN})`,
  'u',
);

/** Валюта или процент справа и слева от числа. */
const CURRENCY_WORD = String.raw`(?:те[нң]ге|tenge|тг(?!\p{L})|тнг(?!\p{L})|₸|kzt|руб|rub|rur|₽|usd|\$|долл|бакс|eur|€|евро(?!\p{L})|юан|cny|сом(?:а|ов)?(?!\p{L})|у\.\s?е|%|процент|пайыз)`;
const CURRENCY_AFTER = new RegExp(String.raw`^\s{0,3}${CURRENCY_WORD}`, 'u');
const CURRENCY_BEFORE = /(?:[$€₸₽]|usd|kzt|eur|rub)\s{0,2}$/u;

/** Слово цены слева, между ним и числом не больше 15 знаков без цифр и знаков конца: «ориентир от 1 500 000». */
const PRICE_WORD_BEFORE =
  /(?<!\p{L})(?:ориентир|вилк|цен|стоимост|стоит|стоят|бюджет|обойд|выйдет|бағ)\p{L}{0,8}[^\p{Nd}.!?\n;]{0,15}$/u;

/** Граница диапазона: «1 500 000 до 2 000 000», «5-10». */
const RANGE_AFTER = /^\s{0,3}(?:до|[-‐‑–—])\s{0,3}$/u;

/** Сколько знаков слева и справа смотреть на признаки суммы: длинный текст не копируется целиком. */
const LOOK_BEHIND_CHARS = 40;
const LOOK_AHEAD_CHARS = 40;

function after(text: string, end: number): string {
  return text.slice(end, end + LOOK_AHEAD_CHARS);
}

/** Множитель слова суммы (MULTIPLIER_WORD): тысяча, миллиард или миллион. */
function multiplierOf(word: string): number {
  if (word.startsWith('тыс')) return 1e3;
  return word.startsWith('млрд') || word.startsWith('миллиард') ? 1e9 : 1e6;
}

/**
 * Найденное число: значение до множителя (base), множитель (scale: 1 без слова суммы), место. Значение суммы
 * base * scale.
 */
interface Raw {
  readonly base: number;
  readonly scale: number;
  readonly index: number;
  readonly end: number;
}

function numberAmounts(text: string): Raw[] {
  return [...text.matchAll(NUMBER_AMOUNT)].flatMap((match) => {
    const groups = match.groups ?? {};
    const int = groups['int'] ?? '';
    const end = match.index + match[0].length;
    const plain = groups['frac'] === undefined && groups['mult'] === undefined;
    const isOneC = int === '1' && plain && groups['kilo'] === undefined;
    if (isOneC && ONE_C_AFTER.test(after(text, end))) return [];
    if (AFTER_ONE_C.test(text.slice(Math.max(0, match.index - 8), match.index))) return [];
    const base = Number(`${int.replace(/\D/gu, '')}.${groups['frac'] ?? '0'}`);
    const mult = groups['mult'];
    const scale =
      groups['kilo'] === undefined ? (mult === undefined ? 1 : multiplierOf(mult)) : 1e3;
    return [{ base, scale, index: match.index, end }];
  });
}

/**
 * «Полтора миллиона» и суммы словом без цифр. Слово суммы после числа или после «полтора» сюда не попадает: это
 * исключают ретроспективные проверки WORD_AMOUNT, поэтому одна сумма не считается дважды.
 */
function wordAmounts(text: string): Raw[] {
  const half: Raw[] = [...text.matchAll(HALF_AMOUNT)].map((match) => ({
    base: 1.5,
    scale: multiplierOf(match[1] ?? ''),
    index: match.index,
    end: match.index + match[0].length,
  }));
  const words: Raw[] = [...text.matchAll(WORD_AMOUNT)].map((match) => ({
    base: Number.NaN,
    scale: multiplierOf(match[0]),
    index: match.index,
    end: match.index + match[0].length,
  }));
  return [...half, ...words];
}

/** Признак цены у самой суммы: слово суммы, валюта или процент рядом, слово цены слева. */
function ownPriced(text: string, raw: Raw): boolean {
  if (raw.scale !== 1) return true;
  const before = text.slice(Math.max(0, raw.index - LOOK_BEHIND_CHARS), raw.index);
  return (
    CURRENCY_AFTER.test(after(text, raw.end)) ||
    CURRENCY_BEFORE.test(before) ||
    PRICE_WORD_BEFORE.test(before)
  );
}

/** Левая граница диапазона перед raw: следующая сумма стоит сразу после «до» или «-». */
function isRangeTo(text: string, raw: Raw, next: Raw | undefined): next is Raw {
  if (next === undefined) return false;
  return RANGE_AFTER.test(text.slice(raw.end, Math.min(next.index, raw.end + LOOK_AHEAD_CHARS)));
}

/**
 * Суммы текста по порядку: без «1С» и версии 1С, без количеств, единиц длины и площади, сроков и дат. Левая граница
 * диапазона берёт у правой признак цены («от 1 500 000 до 2 000 000 тенге») и множитель, если своего нет и без него она
 * меньше правой («1,5–2 млн» это 1 500 000 и 2 000 000, а «от 500 000 до 2 млн» остаётся 500 000).
 */
export function amountsOf(text: string): readonly Amount[] {
  const raws = [...numberAmounts(text), ...wordAmounts(text)]
    .filter((raw) => !QUANTITY_AFTER.test(after(text, raw.end)))
    .sort((a, b) => a.index - b.index);
  const amounts = new Array<Amount>(raws.length);
  for (let i = raws.length - 1; i >= 0; i -= 1) {
    const raw = raws[i] as Raw;
    const next = raws[i + 1];
    const ranged = isRangeTo(text, raw, next);
    const inherits = ranged && raw.scale === 1 && next.scale !== 1 && raw.base < next.base;
    const scale = inherits ? next.scale : raw.scale;
    const priced = ownPriced(text, raw) || (ranged && amounts[i + 1]?.priced === true);
    amounts[i] = { value: raw.base * scale, index: raw.index, end: raw.end, priced };
  }
  return amounts;
}

/**
 * Значения сумм-цен текста (заметки для бота): только с признаком цены (amountsOf priced). Текст любой: здесь он
 * приводится к виду amountsOf (NFKC, нижний регистр, «ё» как «е»). Пусто: в тексте нет цены.
 */
export function priceAmountsOf(text: string): readonly number[] {
  const lower = text.normalize('NFKC').toLowerCase().replaceAll('ё', 'е');
  return amountsOf(lower).flatMap((amount) => (amount.priced ? [amount.value] : []));
}

/** Одно и то же значение: дробь «1,1 млн» не должна разойтись с 1 100 000 из-за двоичной записи. NaN не равно ничему. */
export function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}
