import type { CompanyPrompt, CompanySummary } from '../domain/company.js';

/**
 * Можно ли спросить о компании в этом ответе: кандидат ещё не спрошен или блок о компании разрешает вопрос о названии.
 * Так безопасный вопрос знакомства решает, спрашивать ли название (pipeline/safe-questions.ts).
 */
export function companyAskable(prompt: CompanyPrompt | undefined): boolean {
  if (prompt?.kind === 'candidate') return true;
  return prompt?.kind === 'unknown' && prompt.askName;
}

/** Название компании клиента: подтверждённая клиентом, иначе со слов клиента; нет => null. */
export function companyNameOf(summary: CompanySummary | null): string | null {
  if (summary === null) return null;
  const name = summary.status === 'confirmed' ? summary.name : summary.statedName;
  const trimmed = name?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
