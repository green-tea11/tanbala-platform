import { z } from 'zod';
import type { ClientProfile, InterestAssessment, InterestLevel } from '../domain/types.js';
import { cleanLine } from './clean-text.js';
import { profileText } from './profile.js';

/** Поля выжимки короткие: они идут менеджеру в уведомление и в панель, а модель пишет их по словам клиента. */
const MAX_FIELD_CHARS = 200;
const MAX_REASON_CHARS = 300;

/** Ничего не выяснено: блок данных не пустой, и модель знает, что все поля пока null. */
const NOTHING_KNOWN = 'В выжимке пока ничего нет: клиент ещё ничего о себе не рассказал.';

/**
 * Схема ответа оценки интереса: плоский объект (уровень, поля ClientProfile, причина), все поля обязательны.
 * Невыясненное поле null. describe() стоит до nullable(): SDK пишет поле как anyOf [тип, null] без $defs и $ref
 * (после nullable() он вынес бы тип в $defs).
 * Без transform: вход и выход совпадают. В InterestAssessment её переводит normalizeInterest.
 */
export const interestSchema = z.object({
  level: z.enum(['cold', 'warm', 'hot']).describe('Уровень интереса клиента: cold, warm или hot.'),
  business: z
    .string()
    .describe('Тип бизнеса со слов клиента; null, если клиент не говорил.')
    .nullable(),
  area: z.string().describe('Площадь со слов клиента; null, если клиент не говорил.').nullable(),
  scope: z
    .string()
    .describe(
      'Что учитывать, со слов клиента: только ввоз и вывоз или где лежит каждая вещь; иначе null.',
    )
    .nullable(),
  itemCount: z
    .string()
    .describe('Примерное число вещей со слов клиента; null, если клиент не говорил.')
    .nullable(),
  has1C: z
    .boolean()
    .describe('true или false, если клиент сказал, есть ли у него 1С; иначе null.')
    .nullable(),
  problem: z
    .string()
    .describe('Какую проблему клиент хочет решить, со слов клиента; null, если не говорил.')
    .nullable(),
  specifics: z.string().describe('Особенности со слов клиента; null, если их нет.').nullable(),
  reason: z.string().describe('Одна короткая фраза: почему выбран этот уровень.'),
});

/** Ответ модели до нормализации. */
export interface RawInterest {
  readonly level: InterestLevel;
  readonly business: string | null;
  readonly area: string | null;
  readonly scope: string | null;
  readonly itemCount: string | null;
  readonly has1C: boolean | null;
  readonly problem: string | null;
  readonly specifics: string | null;
  readonly reason: string;
}

/** Новое значение поля после cleanLine; модель ничего не дала или остался пустой текст => прежнее значение. */
function textField(fresh: string | null, previous: string | null): string | null {
  const cleaned = fresh === null ? '' : cleanLine(fresh, MAX_FIELD_CHARS);
  return cleaned === '' ? previous : cleaned;
}

/**
 * Нормализует оценку интереса. Поля выжимки: cleanLine (одна строка, до 200 знаков), пустое значение => прежнее.
 * Известное раньше сохраняется, даже если модель его потеряла (она переписывает выжимку целиком, а окно истории
 * короткое): null значит «клиент не говорил», стирать выясненное он не может. Исправление клиента модель
 * присылает новым значением, и оно заменяет прежнее; has1C false не считается пустым. reason до 300 знаков,
 * может остаться пустой: оценка из-за этого не теряется.
 */
export function normalizeInterest(raw: RawInterest, previous: ClientProfile): InterestAssessment {
  return {
    level: raw.level,
    profile: {
      business: textField(raw.business, previous.business),
      area: textField(raw.area, previous.area),
      scope: textField(raw.scope, previous.scope),
      itemCount: textField(raw.itemCount, previous.itemCount),
      has1C: raw.has1C ?? previous.has1C,
      problem: textField(raw.problem, previous.problem),
      specifics: textField(raw.specifics, previous.specifics),
    },
    reason: cleanLine(raw.reason, MAX_REASON_CHARS),
  };
}

/**
 * Данные вызова оценки: уровень, который система хранит сейчас (если конвейер его передал), и текущая выжимка
 * (profileText). Блок есть всегда, даже при пустой выжимке: последняя реплика user не остаётся без данных.
 */
export function interestCallData(profile: ClientProfile, level: InterestLevel | undefined): string {
  const levelLine =
    level === undefined ? null : `Уровень интереса, который система хранит сейчас: ${level}.`;
  return [levelLine, profileText(profile) ?? NOTHING_KNOWN]
    .filter((line) => line !== null)
    .join('\n');
}
