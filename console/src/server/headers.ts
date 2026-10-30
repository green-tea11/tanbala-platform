/** Политика содержимого SPA: только свои скрипты, стили и запросы; никогда 'unsafe-inline'. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** Возможности браузера, которые панели не нужны. */
const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
].join(', ');

const HSTS_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export const NO_STORE = 'no-store';
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const JSON_TYPE = 'application/json; charset=utf-8';

/**
 * Заголовки безопасности каждого ответа, в том числе ошибок: CSP, nosniff, запрет фреймов, Referrer-Policy
 * same-origin, Permissions-Policy, изоляция окна и ресурсов; HSTS только по HTTPS.
 */
export function securityHeaders(secure: boolean): Readonly<Record<string, string>> {
  return {
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'permissions-policy': PERMISSIONS_POLICY,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    ...(secure ? { 'strict-transport-security': `max-age=${HSTS_MAX_AGE_SECONDS}` } : {}),
  };
}
