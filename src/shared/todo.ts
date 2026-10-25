/** Ошибка заготовки: функция объявлена, а её логика появится на указанном этапе плана. */
export class NotImplementedError extends Error {
  /** Этап из docs/PLAN.md, на котором функцию реализуют, например «этап 2». */
  readonly stage: string;
  /** Путь и имя функции, например «whatsapp/connection.startWhatsApp». */
  readonly feature: string;

  constructor(stage: string, feature: string) {
    super(`Не реализовано (${stage}): ${feature}`);
    this.name = 'NotImplementedError';
    this.stage = stage;
    this.feature = feature;
  }
}

/**
 * Бросает NotImplementedError. Тело каждой заготовки: `return notImplemented('этап N', 'путь.функция')`.
 * Тип never позволяет вернуть его из функции с любым типом результата.
 */
export function notImplemented(stage: string, feature: string): never {
  throw new NotImplementedError(stage, feature);
}
