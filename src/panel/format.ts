import type {
  Author,
  ChatControl,
  ChatIdentity,
  HandoffReason,
  InterestLevel,
  ManagerNotificationKind,
  ManagerNotificationStatus,
} from '../domain/types.js';
import { jidToPhone } from '../whatsapp/jid.js';
import { cleanText } from './html.js';

/** Весь Казахстан с 01.03.2024 живёт по UTC+5 без летнего времени: смещение Алматы постоянное. */
const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;
const UNKNOWN_TIME = 'время неизвестно';
const HIDDEN_PHONE = 'номер скрыт';
const NO_NAME = 'без имени';

/** Уровень интереса клиента (раздел плана «Передача менеджеру»). */
export const LEVEL_LABELS: Readonly<Record<InterestLevel, string>> = {
  cold: 'холодный',
  warm: 'тёплый',
  hot: 'горячий',
};

/** Почему чат ушёл менеджеру (HandoffReason). */
export const HANDOFF_REASON_LABELS: Readonly<Record<HandoffReason, string>> = {
  hot: 'горячий клиент',
  no_answer: 'нет ответа в знаниях',
  check_failed: 'проверка ответа не пройдена',
  asked_human: 'клиент просит живого человека',
  complaint: 'жалоба клиента',
  human_took_over: 'подключился человек',
  llm_error: 'сбой модели',
  limit: 'исчерпан лимит вызовов API',
};

/** Вид уведомления менеджеру. */
export const NOTIFICATION_KIND_LABELS: Readonly<Record<ManagerNotificationKind, string>> = {
  handoff: 'передача чата',
  limit: 'лимит вызовов API',
  backlog: 'чаты за время простоя',
};

/** Судьба уведомления менеджеру. */
export const NOTIFICATION_STATUS_LABELS: Readonly<Record<ManagerNotificationStatus, string>> = {
  pending: 'ожидает отправки',
  sent: 'отправлено менеджеру',
  no_manager: 'номер менеджера не задан, только в панели',
  skipped_limit: 'часовой лимит уведомлений исчерпан, только в панели',
  failed: 'сбой отправки',
};

/** Автор сообщения в переписке. */
export const AUTHOR_LABELS: Readonly<Record<Author, string>> = {
  client: 'Клиент',
  bot: 'Бот',
  human_phone: 'Менеджер с телефона',
  human_panel: 'Менеджер из панели',
};

/** Время для страницы: ДД.ММ.ГГГГ ЧЧ:ММ по Алматы. Не время (NaN, бесконечность): понятная замена. */
export function formatAlmatyTime(ms: number): string {
  if (!Number.isFinite(ms)) return UNKNOWN_TIME;
  const local = new Date(ms + ALMATY_OFFSET_MS);
  const two = (value: number): string => String(value).padStart(2, '0');
  const date = `${two(local.getUTCDate())}.${two(local.getUTCMonth() + 1)}.${local.getUTCFullYear()}`;
  return `${date} ${two(local.getUTCHours())}:${two(local.getUTCMinutes())}`;
}

/** Номер клиента с плюсом или «номер скрыт», если у чата только адрес @lid. */
export function phoneLabel(identity: ChatIdentity): string {
  const phone = identity.pnJid === null ? null : jidToPhone(identity.pnJid);
  return phone === null ? HIDDEN_PHONE : `+${phone}`;
}

/** Имя из профиля WhatsApp для вывода: недоверенный текст без скрытых символов; нет имени => «без имени». */
export function nameLabel(pushName: string | null): string {
  const name = pushName === null ? '' : cleanText(pushName).trim();
  return name === '' ? NO_NAME : name;
}

/** Кто ведёт чат и кто это решил. */
export function controlLabel(control: ChatControl): string {
  if (control.status === 'bot') {
    return control.by === 'panel' ? 'Ведёт бот (возвращён из панели)' : 'Ведёт бот';
  }
  const by = { bot: 'передал бот', phone: 'написал с телефона', panel: 'ответил из панели' };
  return `Ведёт менеджер (${by[control.by]})`;
}
