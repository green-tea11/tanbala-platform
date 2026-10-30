import type { LeadsApi } from '../backends/leads.js';
import {
  sectionOf,
  unavailableSection,
  type BackendFailure,
  type BackendResult,
} from '../backends/result.js';
import type { ObjectData } from '../backends/schemas.js';
import type { WaApi } from '../backends/wa.js';

export interface CardDeps {
  readonly leads: LeadsApi;
  readonly wa: WaApi;
}

/** Итог сборки карточки: тело ответа или сбой главного приложения (его маршрут переводит в статус). */
export type CardOutcome<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly failure: BackendFailure };

const CONFIRMED_LABEL = 'подтверждена клиентом';
const CANDIDATE_LABEL = 'не подтверждено';
const DELETED_TEXT = 'Компании нет в почтовой базе (удалена?): данные — только из сводки бота.';

function isNotFound(failure: BackendFailure): boolean {
  return failure.kind === 'rejected' && failure.status === 404;
}

/** Данные почты о компании для карточки клиента: карточка, «нет в базе» или раздел «недоступно». */
function leadsPart(result: BackendResult<ObjectData>) {
  if (result.ok) return result.data;
  if (isNotFound(result.failure)) return { notFound: true as const, message: DELETED_TEXT };
  return unavailableSection(result.failure);
}

/**
 * Единая карточка клиента: карточка чата от бота и карточка компании от почты. Компания — только подтверждённая
 * клиентом (confirmed.id); если её нет, а есть кандидат, его карточка с заметной пометкой «не подтверждено».
 */
export async function buildClientCard(deps: CardDeps, chatId: number) {
  const chat = await deps.wa.chat(chatId);
  if (!chat.ok) return { ok: false, failure: chat.failure } as const;
  const confirmedId = chat.data.company?.confirmed?.id ?? null;
  const candidateId = chat.data.company?.candidate?.id ?? null;
  const companyId = confirmedId ?? candidateId;
  if (companyId === null) return { ok: true, body: { chat: chat.data, company: null } } as const;
  const confirmed = confirmedId !== null;
  const card = await deps.leads.company(companyId);
  return {
    ok: true,
    body: {
      chat: chat.data,
      company: {
        id: companyId,
        confirmed,
        label: confirmed ? CONFIRMED_LABEL : CANDIDATE_LABEL,
        leads: leadsPart(card),
      },
    },
  } as const;
}

/** Карточка компании от почты и чаты WhatsApp, подтверждённо связанные с ней (раздел бота). */
export async function buildCompanyCard(deps: CardDeps, companyId: number) {
  const [card, links] = await Promise.all([
    deps.leads.company(companyId),
    deps.wa.companyLinks(companyId),
  ]);
  if (!card.ok) return { ok: false, failure: card.failure } as const;
  return {
    ok: true,
    body: { company: card.data, chats: sectionOf(links, (data) => ({ items: data.items })) },
  } as const;
}
