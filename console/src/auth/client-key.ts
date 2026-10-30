import { isIPv4, isIPv6 } from 'node:net';

const IPV4_MAPPED = '::ffff:';
const GROUPS = 8;
const PREFIX_GROUPS = 4;

/** Восемь групп адреса IPv6 (сокращение «::» раскрыто). */
function expandIpv6(address: string): string[] {
  const [left = '', right] = address.split('::');
  const leftParts = left === '' ? [] : left.split(':');
  if (right === undefined) return leftParts;
  const rightParts = right === '' ? [] : right.split(':');
  const missing = Math.max(0, GROUPS - leftParts.length - rightParts.length);
  return [...leftParts, ...Array.from({ length: missing }, () => '0'), ...rightParts];
}

/**
 * Ключ ограничителя входа по адресу клиента: IPv4 как есть (и из вида ::ffff:a.b.c.d), IPv6 — по сети /64:
 * провайдер выдаёт клиенту целую /64, и смена адреса внутри неё не должна давать новые попытки.
 */
export function limiterKey(ip: string): string {
  const address = (ip.split('%')[0] ?? '').toLowerCase();
  if (address.startsWith(IPV4_MAPPED) && isIPv4(address.slice(IPV4_MAPPED.length))) {
    return address.slice(IPV4_MAPPED.length);
  }
  if (!isIPv6(address)) return address;
  const prefix = expandIpv6(address)
    .slice(0, PREFIX_GROUPS)
    .map((group) => Number.parseInt(group, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}
