import type { ApiLimits, LlmPurpose, PhoneDigits } from '../domain/types.js';
import { notImplemented } from '../shared/todo.js';

/** ID моделей для трёх вызовов LLM. Источник: config/models.json, меняется без правки кода. */
export type ModelsConfig = Readonly<Record<LlmPurpose, string>>;

/** Расшифровка голосовых через OpenRouter. Модель распознавания речи: открытый вопрос плана. */
export interface VoiceConfig {
  /** OPENROUTER_API_KEY: передаётся явно. */
  readonly apiKey: string;
  readonly model: string;
}

/**
 * Закрытый режим на рабочем номере (решение владельца, тестового номера нет): пока он включён, бот
 * обрабатывает только чаты с номеров из списка, остальные полностью игнорирует.
 */
export type TestMode =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly allowlist: ReadonlySet<PhoneDigits> };

/** Проверенные настройки приложения. Все пути абсолютные, от корня проекта. */
export interface AppConfig {
  /** VENMART_ANTHROPIC_KEY. null: ключ не задан, LLM выключен. */
  readonly anthropicKey: string | null;
  /** MANAGER_WHATSAPP. null: уведомлений нет, только отметка в панели. */
  readonly managerPhone: PhoneDigits | null;
  /** ADMIN_PASSWORD, по умолчанию admin. */
  readonly adminPassword: string;
  /** null: расшифровка голосовых выключена (нет ключа или модели). */
  readonly voice: VoiceConfig | null;
  /** WA_ENABLED. false: к WhatsApp не подключаться и QR не показывать. */
  readonly waEnabled: boolean;
  /** WHATSAPP_SESSION_DIR: папка сессии Baileys, полный доступ к номеру. */
  readonly waSessionDir: string;
  /** DATABASE_PATH: SQLite с перепиской (персональные данные). */
  readonly databasePath: string;
  /** TOKEN_LOG_PATH: лог расхода API. */
  readonly tokenLogPath: string;
  /** Папка knowledge/ с двумя файлами знаний. */
  readonly knowledgeDir: string;
  /** PANEL_HOST и PANEL_PORT. */
  readonly panel: { readonly host: string; readonly port: number };
  readonly models: ModelsConfig;
  /** API_DAILY_LIMIT и API_DAILY_LIMIT_PER_CHAT: дневной предохранитель расходов. */
  readonly limits: ApiLimits;
  /**
   * BACKLOG_MAX_AGE_HOURS: сообщения за время простоя не старше этого числа часов получают ответ,
   * о более старых менеджеру уходит одно уведомление со списком чатов.
   */
  readonly backlogMaxAgeHours: number;
  /** TEST_MODE и TEST_ALLOWLIST: закрытый режим на рабочем номере. */
  readonly testMode: TestMode;
}

/**
 * Собирает AppConfig из переменных окружения и config/models.json. Единственное место,
 * где разбираются переменные из .env: остальной код получает готовый AppConfig.
 * TODO(этап 2): схема zod; при ошибке назвать переменную, но не печатать её значение (там секреты).
 * TODO(этап 2): пути из .env считать от root, а не от текущей папки процесса; сессию, базу и лог разрешать только внутри data/ корня проекта.
 * TODO(этап 2): пустые VENMART_ANTHROPIC_KEY, OPENROUTER_API_KEY, MANAGER_WHATSAPP => null; MANAGER_WHATSAPP только цифры, приведение к PhoneDigits здесь.
 * TODO(этап 2): WA_ENABLED только «true» или «false», по умолчанию false.
 * TODO(этап 2): API_DAILY_LIMIT и API_DAILY_LIMIT_PER_CHAT: целые больше нуля; нет переменной => 500 и 100 (предохранитель не должен выключаться случайно); иное значение => отказ в запуске с названием переменной.
 * TODO(этап 2): BACKLOG_MAX_AGE_HOURS: целое больше нуля; нет переменной => 12; иное значение => отказ в запуске с названием переменной.
 * TODO(этап 2): TEST_MODE только «true» или «false»; нет переменной => true (безопаснее закрытый режим на рабочем номере).
 * TODO(этап 2): TEST_ALLOWLIST: номера через запятую, каждый после trim по /^77\d{9}$/, приведение к PhoneDigits здесь; неверный номер => отказ в запуске с позицией в списке (сам номер в лог не печатать: персональные данные).
 * TODO(этап 2): TEST_MODE=true и пустой TEST_ALLOWLIST => запуск с предупреждением в лог: бот не отвечает никому.
 * TODO(этап 3): ANTHROPIC_CUSTOM_HEADERS в окружении => отказать в запуске: SDK подмешивает эти заголовки после ключа и может его подменить.
 * TODO(этап 3): ANTHROPIC_BASE_URL в окружении => предупреждение в лог: baseURL передаём в SDK явно.
 * TODO(этап 3): стандартную переменную ключа SDK не читать никогда: ключ только из VENMART_ANTHROPIC_KEY.
 * TODO(этап 7): voice собирать, только когда есть и ключ OpenRouter, и модель.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  modelsJson: unknown,
  root: string,
): AppConfig {
  return notImplemented('этап 2', 'config/env.loadConfig');
}
