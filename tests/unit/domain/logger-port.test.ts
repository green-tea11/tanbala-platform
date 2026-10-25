import type { SocketConfig } from 'baileys';
import type { FastifyBaseLogger } from 'fastify';
import type { Logger as PinoLogger } from 'pino';
import { describe, expectTypeOf, it } from 'vitest';
import type { Logger } from '../../../src/domain/ports.js';

// Проверка на этапе компиляции (npm run typecheck): один логгер pino годится всем адаптерам.
describe('порт Logger', () => {
  it('логгер pino 10 подходит порту Logger', () => {
    expectTypeOf<PinoLogger>().toExtend<Logger>();
  });

  it('порт Logger подходит логгеру Baileys (SocketConfig.logger)', () => {
    expectTypeOf<Logger>().toExtend<SocketConfig['logger']>();
  });

  it('порт Logger подходит логгеру Fastify (FastifyBaseLogger)', () => {
    expectTypeOf<Logger>().toExtend<FastifyBaseLogger>();
  });
});
