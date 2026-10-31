import type Database from 'better-sqlite3';
import type { ChatCandidate, CompanyId, ConfirmedCompany } from '../../domain/company.js';
import {
  parseStoredCompanyState,
  serializeCompanyState,
  type StoredCompanyState,
} from './chat-companies.js';

/** Вид аккаунта известен: бизнес-профиль получен (неудачный запрос и «ещё не спрашивали» не в счёт). */
function knowsProfile(state: StoredCompanyState): boolean {
  return state.profileKind === 'business' || state.profileKind === 'personal';
}

/** Более позднее из двух времён; пустое не затирает известное. */
function laterTime(first: number | null, second: number | null): number | null {
  if (first === null) return second;
  if (second === null) return first;
  return Math.max(first, second);
}

/**
 * Кандидат после слияния: из более свежей записи, а если там его нет, из другой. Кандидата нет, если компания
 * подтверждена хотя бы в одной записи или клиент отклонил его хотя бы в одной.
 */
function mergedCandidate(
  fresher: StoredCompanyState,
  older: StoredCompanyState,
  confirmed: ConfirmedCompany | null,
  rejectedIds: readonly CompanyId[],
): ChatCandidate | null {
  const candidate = fresher.candidate ?? older.candidate;
  if (candidate === null || confirmed !== null || rejectedIds.includes(candidate.id)) return null;
  return candidate;
}

/**
 * Слияние состояний определения компании двух чатов одного человека по полям (fresher: запись, записанная позже).
 * Отклонённые компании объединяются; подтверждённая компания и проверка новой компании из записи, где они есть (в
 * обеих: из более свежей); отметка запуска проверки наибольшая; счётчики по максимуму. Остальное из более свежей
 * записи, но пустое там (null, пустой список болей, неизвестный вид аккаунта) не затирает известное в другой: иначе
 * после слияния бот снова прошёл бы платный шаг логотипа или второй раз спросил бы название. Бизнес-профиль берётся
 * парой (вид аккаунта и домен), название со слов клиента тоже парой с его вариантами. Входные состояния не меняются; поля сверх состояния (ID чата) идут из fresher.
 */
export function mergeCompanyStates<T extends StoredCompanyState>(
  fresher: T,
  older: StoredCompanyState,
): T {
  const profile = knowsProfile(fresher) || !knowsProfile(older) ? fresher : older;
  const rejectedIds = [...new Set([...older.rejectedIds, ...fresher.rejectedIds])];
  const confirmed = fresher.confirmed ?? older.confirmed;
  const named = fresher.statedName === null ? older : fresher;
  const researched = fresher.research === null ? older : fresher;
  return {
    ...fresher,
    profileKind: profile.profileKind,
    profileDomain: profile.profileDomain,
    profileRequests: Math.max(fresher.profileRequests, older.profileRequests),
    freeStepsAtMs: fresher.freeStepsAtMs ?? older.freeStepsAtMs,
    logoCheckedAtMs: fresher.logoCheckedAtMs ?? older.logoCheckedAtMs,
    statedName: named.statedName,
    statedAliases: named.statedAliases,
    statedCity: fresher.statedCity ?? older.statedCity,
    lookedUpName: fresher.lookedUpName ?? older.lookedUpName,
    candidate: mergedCandidate(fresher, older, confirmed, rejectedIds),
    rejectedIds,
    confirmed,
    briefFailures: Math.max(fresher.briefFailures, older.briefFailures),
    nameAskedAtMs: fresher.nameAskedAtMs ?? older.nameAskedAtMs,
    research: researched.research,
    researchName: researched.researchName,
    researchStartedAtMs: laterTime(fresher.researchStartedAtMs, older.researchStartedAtMs),
    officialNameAskedAtMs: fresher.officialNameAskedAtMs ?? older.officialNameAskedAtMs,
    emailToldAtMs: fresher.emailToldAtMs ?? older.emailToldAtMs,
    officialResearchStartedAtMs: laterTime(
      fresher.officialResearchStartedAtMs,
      older.officialResearchStartedAtMs,
    ),
    adoptFailures: Math.max(fresher.adoptFailures, older.adoptFailures),
    confirmedPains:
      fresher.confirmedPains.length > 0 ? fresher.confirmedPains : older.confirmedPains,
  };
}

/** Строка chat_companies: текст состояния и время записи. */
interface StateRow {
  readonly state: string;
  readonly updated_at: number;
}

/**
 * Текст и время записи слитого состояния. Целы обе записи: слияние по полям (mergeCompanyStates), свежее та, что
 * записана позже, при равном времени запись оставшегося чата. Испорчена одна: остаётся целая. Испорчены обе: остаётся
 * запись оставшегося чата как есть (чтение даст пустое состояние с предупреждением). Время записи наибольшее.
 */
function mergedRow(own: StateRow, absorbed: StateRow): StateRow {
  const updatedAt = Math.max(own.updated_at, absorbed.updated_at);
  const ownState = parseStoredCompanyState(own.state);
  const absorbedState = parseStoredCompanyState(absorbed.state);
  if (absorbedState === null) return { state: own.state, updated_at: updatedAt };
  if (ownState === null) return { state: absorbed.state, updated_at: updatedAt };
  const [fresher, older] =
    absorbed.updated_at > own.updated_at ? [absorbedState, ownState] : [ownState, absorbedState];
  return {
    state: serializeCompanyState(mergeCompanyStates(fresher, older)),
    updated_at: updatedAt,
  };
}

/**
 * Готовит перенос состояния определения компании при слиянии чатов: у оставшегося чата записи нет => запись слитого
 * переходит к нему как есть (ID чата в JSON нет); записи у обоих => одна запись, слитая по полям (mergedRow), запись
 * слитого удаляется. Вызывается внутри транзакции слияния чатов, до удаления строки слитого чата.
 */
export function createCompanyStateMerger(
  db: Database.Database,
): (survivor: number, absorbed: number) => void {
  const select = db.prepare<[number], StateRow>(
    'SELECT state, updated_at FROM chat_companies WHERE chat_id = ?',
  );
  const move = db.prepare<{ survivor: number; absorbed: number }>(
    'UPDATE chat_companies SET chat_id = @survivor WHERE chat_id = @absorbed',
  );
  const update = db.prepare<{ chatId: number; state: string; updatedAt: number }>(
    'UPDATE chat_companies SET state = @state, updated_at = @updatedAt WHERE chat_id = @chatId',
  );
  const remove = db.prepare<[number]>('DELETE FROM chat_companies WHERE chat_id = ?');
  return (survivor, absorbed) => {
    const absorbedRow = select.get(absorbed);
    if (absorbedRow === undefined) return;
    const ownRow = select.get(survivor);
    if (ownRow === undefined) {
      move.run({ survivor, absorbed });
      return;
    }
    const merged = mergedRow(ownRow, absorbedRow);
    update.run({ chatId: survivor, state: merged.state, updatedAt: merged.updated_at });
    remove.run(absorbed);
  };
}
