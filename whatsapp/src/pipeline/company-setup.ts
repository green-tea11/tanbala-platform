import { createCompanyDirectory, type CompanyFetch } from '../company-api/directory.js';
import { createCompanyService } from '../company/service.js';
import type { AppConfig } from '../config/env.js';
import type {
  ChatCompaniesRepo,
  CompanyDirectory,
  CompanyService,
  LogoReader,
} from '../domain/company.js';
import type { Clock, Logger, WhatsAppContacts } from '../domain/ports.js';
import type { LlmResult } from '../domain/types.js';

/** Настройки определения компании: внутренний API почтового проекта и адрес его интерфейса. */
export type CompanyConfig = Pick<AppConfig, 'companyApi' | 'emailUiUrl'>;

/** Из чего собирается определение компании. */
export interface CompanySetupContext {
  readonly config: CompanyConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Состояние определения компании по чатам (src/db/repos/chat-companies.ts). */
  readonly repo: ChatCompaniesRepo;
  /** Шов для тестов, в рабочем режиме не передаётся: fetch внутреннего API (по умолчанию глобальный). */
  readonly fetch?: CompanyFetch | undefined;
}

/** Определение компании: сервис есть с запуска, профиль WhatsApp и чтение логотипа подключаются позже. */
export interface CompanySetup {
  /** Один на всё приложение: конвейер ответов, сервис передачи и панель. */
  readonly service: CompanyService;
  /** Подключение WhatsApp создано: бизнес-профиль и фото профиля идут через него. */
  connect(contacts: WhatsAppContacts): void;
  /** Агент собран (есть ключ Claude): название с логотипа читает он. */
  useLogo(reader: LogoReader): void;
}

/** Профиль собеседника до подключения WhatsApp: как у шлюза без сокета, сбой значением и без обращения наружу. */
const NOT_CONNECTED_CONTACTS: WhatsAppContacts = {
  businessProfile: () => Promise.resolve({ kind: 'failed' }),
  profilePhoto: () => Promise.resolve(null),
};

/** Логотип без агента (нет ключа Claude): вызова модели нет, шаг д заканчивается сбоем disabled. */
const NO_LOGO_READER: LogoReader = {
  readLogo: (): Promise<LlmResult<string | null>> =>
    Promise.resolve({ ok: false, failure: 'disabled' }),
};

const ENABLED_TEXT = 'Определение компании клиента включено: внутренний API почтового проекта';
const DISABLED_TEXT = 'Определение компании клиента выключено: INTERNAL_API_TOKEN не задан';

/**
 * Собирает определение компании один раз на приложение. Внутренний API выключен (config.companyApi null) =>
 * directory { enabled: false }: сервис всё равно создаётся и отвечает блоком off, бот работает как раньше. Иначе клиент
 * company-api/directory.ts с адресом и токеном из настроек. Сервису нужен профиль собеседника из WhatsApp и агент для
 * логотипа, а они появляются позже (подключение после запуска WhatsApp, агент только с ключом Claude), поэтому он
 * получает обёртки со ссылкой на текущий шлюз и текущего агента: до connect профиль даёт failed и null, до useLogo
 * логотип даёт disabled. В лог одна строка, включено ли определение компании, без адреса и токена.
 */
export function assembleCompany(context: CompanySetupContext): CompanySetup {
  const { config, logger, clock } = context;
  let contacts: WhatsAppContacts = NOT_CONNECTED_CONTACTS;
  let logo: LogoReader = NO_LOGO_READER;
  const directory = directoryOf(context);
  logger.info({ companyApi: directory.enabled }, directory.enabled ? ENABLED_TEXT : DISABLED_TEXT);
  const service = createCompanyService({
    directory,
    contacts: {
      businessProfile: (jid) => contacts.businessProfile(jid),
      profilePhoto: (jid, maxBytes) => contacts.profilePhoto(jid, maxBytes),
    },
    logo: { readLogo: (chatId, photo) => logo.readLogo(chatId, photo) },
    repo: context.repo,
    clock,
    logger,
    emailUiUrl: config.emailUiUrl,
  });
  return {
    service,
    connect: (current) => {
      contacts = current;
    },
    useLogo: (reader) => {
      logo = reader;
    },
  };
}

function directoryOf(context: CompanySetupContext): CompanyDirectory {
  const { companyApi } = context.config;
  if (companyApi === null) return { enabled: false };
  return createCompanyDirectory({
    baseUrl: companyApi.baseUrl,
    token: companyApi.token,
    fetch: context.fetch,
    clock: context.clock,
    logger: context.logger,
  });
}
