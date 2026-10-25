import { notImplemented } from '../shared/todo.js';

/**
 * Можно ли слушать этот адрес на ПК: только литерал 127.0.0.1, как в плане.
 * ::1, localhost, 0.0.0.0 и :: считаются чужими.
 * TODO(этап 6): точное сравнение строк, без DNS.
 */
export function isLoopback(host: string): boolean {
  return notImplemented('этап 6', 'panel/guard.isLoopback');
}

/**
 * Правило плана: пока проект на ПК, панель слушает только 127.0.0.1; с паролем admin на другом адресе не запускается.
 * Бросает ошибку, если запуск запрещён.
 * TODO(этап 6): слабый пароль (admin без учёта регистра и пробелов по краям, пустой) => разрешён только 127.0.0.1.
 * TODO(этап 6): минимум 16 символов для пароля не на ПК: предложение, подтвердить у владельца (в плане «сложный пароль»).
 */
export function assertPanelStartAllowed(input: { host: string; password: string }): void {
  notImplemented('этап 6', 'panel/guard.assertPanelStartAllowed');
}

/**
 * Проверка заголовка Host на каждом запросе: защита от DNS rebinding и от входа с паролем admin за Caddy.
 * TODO(этап 6): при слабом пароле принимать только Host «127.0.0.1:PORT» и «localhost:PORT»: за Caddy на VPS Host будет доменом, и вход не откроется без отдельного флага.
 * TODO(этап 6): при сильном пароле белый список из настроек (домен панели); нет заголовка => отказ.
 */
export function hostHeaderAllowed(input: {
  hostHeader: string | undefined;
  port: number;
  password: string;
}): boolean {
  return notImplemented('этап 6', 'panel/guard.hostHeaderAllowed');
}

/**
 * Сравнение пароля за постоянное время.
 * TODO(этап 6): timingSafeEqual по SHA-256 от обоих значений, чтобы длина не утекала по времени ответа.
 */
export function passwordMatches(input: string, expected: string): boolean {
  return notImplemented('этап 6', 'panel/guard.passwordMatches');
}
