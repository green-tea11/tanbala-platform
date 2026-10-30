import { DAY_MS } from './time.js';

/** Подтверждённая связь чат → компания от бота. */
export interface CompanyLink {
  readonly chatId: number;
  readonly companyId: number;
  readonly name: string | null;
  readonly firstClientMessageAt: string | null;
}

/** Компания из digest почты: первое настоящее письмо (тестовые отправки не считаются). */
export interface CompanyDigest {
  readonly id: number;
  readonly name: string | null;
  readonly firstLetterAt: string | null;
}

export interface AfterLetterItem {
  readonly chatId: number;
  readonly companyId: number;
  readonly chatName: string | null;
  readonly companyName: string | null;
  readonly firstLetterAt: string;
  readonly firstClientMessageAt: string;
  /** Через сколько полных дней после письма клиент написал. */
  readonly daysAfter: number;
}

/** Пояснение к разделу: настоящих отправок пока нет, у импорта дата — день импорта. */
export const AFTER_LETTER_NOTE =
  'Настоящих отправок писем пока нет; у импортированных писем дата — день импорта, а не день письма. Раздел почти пуст.';

/**
 * «Писали в WhatsApp после письма»: первое сохранённое сообщение клиента в чате с подтверждённой компанией позже
 * первого настоящего письма этой компании. Кандидаты (не подтверждено) сюда не попадают: связи от бота только
 * подтверждённые. Свежие сверху.
 */
export function wroteAfterLetter(
  links: readonly CompanyLink[],
  digest: ReadonlyMap<number, CompanyDigest>,
): AfterLetterItem[] {
  return links
    .flatMap((link): AfterLetterItem[] => {
      const company = digest.get(link.companyId);
      const letterAt = company?.firstLetterAt ?? null;
      const clientAt = link.firstClientMessageAt;
      if (letterAt === null || clientAt === null) return [];
      const gapMs = Date.parse(clientAt) - Date.parse(letterAt);
      if (!(gapMs > 0)) return [];
      return [
        {
          chatId: link.chatId,
          companyId: link.companyId,
          chatName: link.name,
          companyName: company?.name ?? null,
          firstLetterAt: letterAt,
          firstClientMessageAt: clientAt,
          daysAfter: Math.floor(gapMs / DAY_MS),
        },
      ];
    })
    .sort((a, b) => Date.parse(b.firstClientMessageAt) - Date.parse(a.firstClientMessageAt));
}
