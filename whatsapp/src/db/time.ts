/**
 * Проверяет время в мс UTC перед записью в базу: целое неотрицательное число в безопасном диапазоне.
 * Без проверки NaN в необязательной колонке молча превратился бы в NULL.
 */
export function assertTimeMs(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name}: ожидается целое число мс UTC не меньше нуля`);
  }
}
