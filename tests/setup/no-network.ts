import net from 'node:net';

// Защита бюджета: в тестах любая попытка выйти в сеть (Anthropic, OpenRouter, WhatsApp) падает.
// Подмена прямым присваиванием, а не vi.spyOn: restoreMocks не должен её снимать.
const NETWORK_BLOCKED = 'Сеть в тестах запрещена: используйте моки';

globalThis.fetch = (): Promise<Response> => Promise.reject(new Error(NETWORK_BLOCKED));

net.Socket.prototype.connect = function blockedConnect(): never {
  throw new Error(NETWORK_BLOCKED);
};
