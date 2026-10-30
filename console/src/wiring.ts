import { createBackendClient, type FetchLike } from './backends/client.js';
import { createLeadsApi, type LeadsApi } from './backends/leads.js';
import { createWaApi, type WaApi } from './backends/wa.js';
import type { ConsoleConfig } from './config/env.js';
import type { Clock } from './shared/clock.js';
import type { Logger } from './shared/logger.js';

export interface Backends {
  readonly leads: LeadsApi;
  readonly wa: WaApi;
}

/** Клиенты почты и бота по настройкам: у каждого свой адрес, токен, очередь и кэш. */
export function createBackends(
  config: Pick<ConsoleConfig, 'leads' | 'wa'>,
  fetch: FetchLike,
  clock: Clock,
  logger: Logger,
): Backends {
  const log = logger.child({ module: 'backends' });
  const leadsClient = createBackendClient({
    name: 'leads',
    ...config.leads,
    fetch,
    clock,
    logger: log,
  });
  const waClient = createBackendClient({ name: 'wa', ...config.wa, fetch, clock, logger: log });
  return { leads: createLeadsApi(leadsClient, log), wa: createWaApi(waClient, log) };
}
