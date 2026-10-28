import type {
  ChatCandidate,
  ChatCompanyState,
  CompanyPrompt,
  ConfirmedCompany,
} from '../domain/company.js';
import { promptPains } from './pains.js';
import { isRunning } from './transitions.js';

/** Функция выключена (внутренний API не настроен): блока о компании в промпте нет. */
export const OFF_PROMPT: CompanyPrompt = Object.freeze({ kind: 'off' });

/**
 * Кандидата, найденного по словам клиента или проверкой новой компании, спрашивают с городом («X, Алматы, верно?»):
 * название клиент назвал сам, и город помогает различить одноимённые компании. Кандидат по профилю WhatsApp,
 * номеру или логотипу: спрашивают только название.
 */
function candidatePrompt(candidate: ChatCandidate): CompanyPrompt {
  if (candidate.askedAtMs !== null) {
    return { kind: 'asked', name: candidate.name, city: candidate.city };
  }
  return {
    kind: 'candidate',
    name: candidate.name,
    city: candidate.city,
    withCity: candidate.source === 'message' || candidate.source === 'research',
  };
}

/** Подтверждённая компания: из справки только рубрика и боли (без цитат, источников и цифр), справки нет => пусто. */
function confirmedPrompt(confirmed: ConfirmedCompany): CompanyPrompt {
  return {
    kind: 'confirmed',
    name: confirmed.name,
    rubric: confirmed.brief?.rubric ?? null,
    pains: promptPains(confirmed.brief),
    emailed: confirmed.brief?.emailed ?? false,
  };
}

/**
 * Блок о компании для вызовов ответа, проверки и оценки интереса. Порядок: подтверждённая компания, кандидат
 * (спрошенный и нет), идущая проверка новой компании, иначе компания неизвестна (название можно один раз спросить,
 * если ни бот не спрашивал, ни клиент не называл).
 */
export function buildPrompt(state: ChatCompanyState): CompanyPrompt {
  const { confirmed, candidate, research } = state;
  if (confirmed !== null) return confirmedPrompt(confirmed);
  if (candidate !== null) return candidatePrompt(candidate);
  if (isRunning(research)) return { kind: 'searching' };
  return { kind: 'unknown', askName: state.nameAskedAtMs === null && state.statedName === null };
}
