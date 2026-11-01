import type {
  ChatCandidate,
  ChatCompanyState,
  CompanyPrompt,
  ConfirmedCompany,
} from '../domain/company.js';
import { shortCompanyName } from './name-match.js';
import { mayAskOfficialName } from './official-name.js';
import { promptPains, promptRubric } from './pains.js';
import { isRunning } from './transitions.js';

/** Функция выключена (внутренний API не настроен): блока о компании в промпте нет. */
export const OFF_PROMPT: CompanyPrompt = Object.freeze({ kind: 'off' });

/**
 * Кандидата, найденного по словам клиента или проверкой новой компании, спрашивают с городом («X, Алматы, верно?»):
 * название клиент назвал сам, и город помогает различить одноимённые компании. Кандидат по профилю WhatsApp,
 * номеру или логотипу: спрашивают только название.
 */
function candidatePrompt(candidate: ChatCandidate): CompanyPrompt {
  const name = shortCompanyName(candidate.name);
  if (candidate.askedAtMs !== null) {
    return { kind: 'asked', name, city: candidate.city, awaitingAnswer: candidate.awaitingAnswer };
  }
  return {
    kind: 'candidate',
    name,
    city: candidate.city,
    withCity: candidate.source === 'message' || candidate.source === 'research',
  };
}

/**
 * Подтверждённая компания: название без хвоста карточки 2ГИС и город карточки (пункт 5 задания 01.11.2026), из справки
 * только рубрика и боли (без цитат, источников и цифр), справки нет => пусто. emailTold: мы писали компании, и бот уже
 * сказал клиенту о письме.
 */
function confirmedPrompt(confirmed: ConfirmedCompany, emailToldAtMs: number | null): CompanyPrompt {
  const emailed = confirmed.brief?.emailed ?? false;
  return {
    kind: 'confirmed',
    name: shortCompanyName(confirmed.name),
    city: confirmed.city,
    rubric: promptRubric(confirmed.brief),
    pains: promptPains(confirmed.brief),
    emailed,
    emailTold: emailed && emailToldAtMs !== null,
  };
}

/**
 * Шаг е (вопрос о названии) идёт последним: бесплатные шаги а, б, в пройдены, у бизнес-аккаунта закрыт и шаг д
 * (логотип), а ни бот не спрашивал, ни клиент не называл компанию.
 */
function mayAskName(state: ChatCompanyState): boolean {
  if (state.nameAskedAtMs !== null || state.statedName !== null) return false;
  if (state.freeStepsAtMs === null) return false;
  return state.profileKind !== 'business' || state.logoCheckedAtMs !== null;
}

/**
 * Блок о компании для вызовов ответа, проверки и оценки интереса. Порядок: подтверждённая компания, кандидат
 * (спрошенный и нет), идущая проверка новой компании, проверка ничего не нашла (один раз спросить официальное
 * название), официальное название уже спрашивали (о компании больше не спрашивать), иначе компания неизвестна
 * (название можно один раз спросить, когда остальные шаги пройдены).
 */
export function buildPrompt(state: ChatCompanyState): CompanyPrompt {
  const { confirmed, candidate, research } = state;
  if (confirmed !== null) return confirmedPrompt(confirmed, state.emailToldAtMs);
  if (candidate !== null) return candidatePrompt(candidate);
  if (isRunning(research)) return { kind: 'searching' };
  if (mayAskOfficialName(state)) return { kind: 'ask_official' };
  if (state.officialNameAskedAtMs !== null) return { kind: 'not_found' };
  return { kind: 'unknown', askName: mayAskName(state) };
}
