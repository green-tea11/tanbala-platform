import net from 'node:net';

// Тесты только на моках: любая попытка выйти в сеть (почта, бот, что угодно) падает, порты не открываются.
// Подмена прямым присваиванием, а не vi.spyOn: restoreMocks не должен её снимать.
const NETWORK_BLOCKED = 'Сеть в тестах запрещена: используйте моки';

globalThis.fetch = (): Promise<Response> => Promise.reject(new Error(NETWORK_BLOCKED));

net.Socket.prototype.connect = function blockedConnect(): never {
  throw new Error(NETWORK_BLOCKED);
};

net.Server.prototype.listen = function blockedListen(): never {
  throw new Error('Порты в тестах не открываются: используйте inject');
};
