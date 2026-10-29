import type { ReviewedText } from '../domain/types.js';
import { ESTIMATE_LATER, type MinimumField } from '../handoff/minimum.js';

export { ESTIMATE_LATER } from '../handoff/minimum.js';

/** Поля квалификации клиента, о которых бот может спросить фиксированным вопросом: минимум и остальное. */
export type QuestionField =
  | MinimumField
  | 'business'
  | 'packaging'
  | 'area'
  | 'turnover'
  | 'currentTracking'
  | 'problem'
  | 'oneCName';

/**
 * Фиксированные вопросы клиенту без модели (решение 29.10.2026): один вопрос, без фактов о Tanbala, цен, сроков и
 * обещаний, поэтому проходят проверки кодом (это проверяют тесты) и к ReviewedText приводятся здесь, как проверенный
 * текст модели. Те же вопросы для модели в третьем лице: handoff/minimum.ts (QUESTIONS).
 */
export const SAFE_QUESTION_TEXTS: Readonly<Record<QuestionField, string>> = {
  items: 'Подскажите, какие вещи нужно учитывать?',
  material: 'Подскажите, из какого материала эти вещи: есть ли среди них металл или жидкости?',
  itemCount: 'Подскажите, сколько примерно вещей нужно учитывать?',
  premises: 'Подскажите, где хранятся вещи: склад, открытая площадка или магазин?',
  city: 'Подскажите, в каком городе ваш объект?',
  has1C: 'Подскажите, у вас есть 1С и какая?',
  company: 'Подскажите, как называется ваша компания?',
  business: 'Подскажите, чем занимается ваша компания?',
  packaging: 'Подскажите, как лежат вещи: в коробках, на паллетах или поштучно?',
  area: 'Подскажите, какая примерно площадь помещения?',
  turnover: 'Подскажите, как часто вещи приходят и уходят?',
  currentTracking: 'Подскажите, как вы сейчас ведёте учёт?',
  problem: 'Подскажите, что в нынешнем учёте мешает больше всего?',
  oneCName: 'Подскажите, какая у вас конфигурация 1С?',
};

/** Все поля с вопросами. */
export const QUESTION_FIELDS = Object.keys(SAFE_QUESTION_TEXTS) as readonly QuestionField[];

/** Фиксированный вопрос о поле; на ходу с вопросом цены перед ним фраза об ориентире. */
export function safeQuestion(field: QuestionField, aboutPrice: boolean): ReviewedText {
  const question = SAFE_QUESTION_TEXTS[field];
  return (aboutPrice ? `${ESTIMATE_LATER} ${question}` : question) as ReviewedText;
}
