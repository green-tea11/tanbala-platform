import type {
  AuthenticationState,
  SignalDataSet,
  SignalDataTypeMap,
  SignalKeyStore,
} from 'baileys';
import type { Logger } from '../domain/ports.js';
import type { LoadedAuthState } from './connection-types.js';

// Записи сессии WhatsApp во время пробы. useMultiFileAuthState пишет файлы асинхронно: и creds после creds.update,
// и ключи Signal через keys.set (Baileys сам вызывает его при обмене ключами). Выход процесса до конца записи может
// оставить файл ключа недописанным, и бот после пробы не расшифрует сообщения. Поэтому проба знает о каждой
// незаконченной записи и перед выходом ждёт все.

const CREDS_FAILED = 'Не удалось сохранить сессию WhatsApp';
const KEYS_FAILED = 'Не удалось сохранить ключи сессии WhatsApp';

/** Сессия для сокета пробы и учёт её записей. */
export interface ProbeAuthWrites {
  /**
   * Для сокета: тот же объект creds (Baileys меняет его на месте, saveCreds пишет его же) и ключи, у которых каждый
   * keys.set учитывается. clear не передаётся: у useMultiFileAuthState его нет, а проба сессию не стирает.
   */
  readonly state: AuthenticationState;
  /** creds.update: сохранить creds после уже начатых сохранений, по порядку. Сбой в лог, settled вернёт false. */
  saveCreds(): void;
  /** Ждёт все начатые записи creds и ключей, в том числе начатые во время ожидания; true, если ни одна не упала. */
  settled(): Promise<boolean>;
}

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Учёт записей сессии пробы. Запись ключа отдаётся Baileys как есть (её сбой Baileys видит, как и без пробы), а учёт
 * ловит сбой отдельно: в лог только имя ошибки, итог settled false. Ожидание не ограничено: срок ставит проба.
 */
export function trackAuthWrites(auth: LoadedAuthState, logger: Logger): ProbeAuthWrites {
  const pending = new Set<Promise<void>>();
  let failed = false;
  const track = (write: Promise<void>, message: string): Promise<void> => {
    const done = write
      .then(
        () => undefined,
        (error: unknown) => {
          failed = true;
          logger.error({ errorName: errorNameOf(error) }, message);
        },
      )
      .finally(() => {
        pending.delete(done);
      });
    pending.add(done);
    return done;
  };
  // Хвост цепочки creds не отклоняется никогда: следующее сохранение начнётся и после сбоя предыдущего.
  let credsTail: Promise<void> = Promise.resolve();
  return {
    state: {
      creds: auth.state.creds,
      keys: trackedKeys(auth.state.keys, (write) => track(write, KEYS_FAILED)),
    },
    saveCreds: () => {
      credsTail = track(
        credsTail.then(() => auth.saveCreds()),
        CREDS_FAILED,
      );
    },
    settled: async () => {
      while (pending.size > 0) await Promise.all(pending);
      return !failed;
    },
  };
}

/** Ключи с учётом записей: get как есть, set учитывается с первого же вызова (синхронный бросок тоже сбой записи). */
function trackedKeys(
  keys: SignalKeyStore,
  track: (write: Promise<void>) => Promise<void>,
): SignalKeyStore {
  return {
    get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => keys.get(type, ids),
    set: (data: SignalDataSet): Promise<void> => {
      const write = new Promise<void>((resolve) => {
        resolve(keys.set(data));
      });
      void track(write);
      return write;
    },
  };
}
