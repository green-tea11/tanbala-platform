import type { ChatCompaniesRepo, CompanyDirectory, LogoReader } from '../domain/company.js';
import type { Clock, Logger, WhatsAppContacts } from '../domain/ports.js';
import type { Chat, Jid } from '../domain/types.js';

/** Включённый внутренний API: у выключенного ядру делать нечего, сервис отвечает без обращений наружу. */
export type ActiveDirectory = Extract<CompanyDirectory, { readonly enabled: true }>;

/** Всё, чем пользуются шаги определения компании (кроме адреса интерфейса, он нужен только сводке). */
export interface CompanyEnv {
  readonly directory: ActiveDirectory;
  readonly contacts: WhatsAppContacts;
  readonly logo: LogoReader;
  readonly repo: ChatCompaniesRepo;
  readonly clock: Pick<Clock, 'now'>;
  readonly logger: Logger;
}

/** Адрес для запросов профиля WhatsApp: номер, иначе @lid, иначе адрес, с которого пишет клиент. */
export function contactJid(chat: Chat): Jid {
  return chat.identity.pnJid ?? chat.identity.lidJid ?? chat.identity.replyJid;
}
