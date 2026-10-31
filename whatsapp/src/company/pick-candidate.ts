import type { CompanyCandidate, CompanyId } from '../domain/company.js';

/** Совпадение по названию ниже этой оценки не считается найденной компанией. */
const MIN_NAME_SCORE = 0.8;

/**
 * Для имени профиля WhatsApp (шаг в) строже: почта с 31.10.2026 даёт 0.85 названию, которое лишь начинается со слов
 * запроса («kusto» → «Kusto Logistics Management»). Имя аккаунта «Мадина» не должно находить «Мадина Тур»: нужно почти
 * то же название (ревью 31.10.2026).
 */
export const MIN_PROFILE_NAME_SCORE = 0.86;

/** Если вторая по оценке компания ближе к лучшей, чем на этот разрыв, выбор неоднозначен. */
const MIN_SCORE_GAP = 0.1;

/** Допуск на двоичные дроби: 0.9 - 0.8 в числах с плавающей точкой чуть меньше 0.1, хотя разрыв ровно 0.1. */
const SCORE_EPSILON = 1e-9;

/**
 * Выбор кандидата из ответа lookup. Отклонённые клиентом ID отбрасываются; лучший по match_score, при равенстве
 * с меньшим ID. Не нашли (null), если у лучшего совпадение по названию с оценкой ниже minNameScore (обычно 0.8) или
 * вторая компания ближе к лучшей, чем на 0.1: неоднозначно, спрашивать клиента о случайной компании нельзя. Это
 * касается и двух компаний с одним доменом или телефоном (у обеих оценка 1).
 */
export function pickCandidate(
  candidates: readonly CompanyCandidate[],
  rejectedIds: readonly CompanyId[],
  minNameScore: number = MIN_NAME_SCORE,
): CompanyCandidate | null {
  const [best, second] = candidates
    .filter((candidate) => !rejectedIds.includes(candidate.id))
    .toSorted((a, b) => b.matchScore - a.matchScore || a.id - b.id);
  if (best === undefined) return null;
  if (best.matchBy === 'name' && best.matchScore + SCORE_EPSILON < minNameScore) return null;
  const gap = second === undefined ? Number.POSITIVE_INFINITY : best.matchScore - second.matchScore;
  return gap + SCORE_EPSILON < MIN_SCORE_GAP ? null : best;
}
