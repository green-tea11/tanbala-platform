import type { ChatCompanyState, CompanyId, CompanySummary } from '../domain/company.js';

/** Сводка без данных о компании: общая основа всех видов. */
function baseSummary(state: ChatCompanyState): CompanySummary {
  return {
    status: 'unknown',
    companyId: null,
    name: null,
    city: null,
    rubric: null,
    candidateSource: null,
    cardUrl: null,
    confirmedPains: state.confirmedPains,
    briefPains: [],
    emailed: null,
    research: state.research,
    statedName: state.statedName,
  };
}

/** Ссылка на карточку в интерфейсе почтового проекта: адрес без хвостовых «/», затем /companies/{id}. */
function cardUrlOf(emailUiUrl: string | null, id: CompanyId): string | null {
  const base = emailUiUrl?.trim().replace(/\/+$/, '') ?? '';
  return base === '' ? null : `${base}/companies/${id}`;
}

/**
 * Что о компании видят менеджер в уведомлении и панель. confirmed: подтверждённая компания (рубрика и боли из
 * справки, если она есть); candidate: найдена, клиент не подтвердил (рубрики и болей справки нет, источник
 * поиска виден); иначе unknown. emailUiUrl: адрес интерфейса почтового проекта (EMAIL_UI_URL) или null.
 */
export function buildSummary(state: ChatCompanyState, emailUiUrl: string | null): CompanySummary {
  const base = baseSummary(state);
  const { confirmed, candidate } = state;
  if (confirmed !== null) {
    return {
      ...base,
      status: 'confirmed',
      companyId: confirmed.id,
      name: confirmed.name,
      city: confirmed.city,
      rubric: confirmed.brief?.rubric ?? null,
      cardUrl: cardUrlOf(emailUiUrl, confirmed.id),
      briefPains: confirmed.brief?.pains ?? [],
      emailed: confirmed.brief?.emailed ?? null,
    };
  }
  if (candidate !== null) {
    return {
      ...base,
      status: 'candidate',
      companyId: candidate.id,
      name: candidate.name,
      city: candidate.city,
      candidateSource: candidate.source,
      cardUrl: cardUrlOf(emailUiUrl, candidate.id),
    };
  }
  return base;
}

/**
 * Сводка выключенной функции: статус off и ничего о компании. Боли клиента остаются: оценка интереса записывает их
 * и без внутреннего API.
 */
export function buildOffSummary(state: ChatCompanyState): CompanySummary {
  return {
    ...baseSummary(state),
    status: 'off',
    research: null,
    statedName: null,
  };
}
