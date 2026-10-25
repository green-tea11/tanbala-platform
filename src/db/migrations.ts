import type Database from 'better-sqlite3';
import { notImplemented } from '../shared/todo.js';

/**
 * Применяет миграции схемы по номеру версии в PRAGMA user_version.
 * TODO(этап 2): chats (reply_jid уникальный, lid_jid и pn_jid, номер, push_name, статус bot или manager, кто и когда сменил статус, уровень интереса, время входящего).
 * TODO(этап 2): client_profiles 1:1 с chats (бизнес, площадь, что учитывать, число вещей, есть ли 1С, задача, особенности, готовый текст выжимки).
 * TODO(этап 2): messages с UNIQUE(chat_id, wa_id); автор client, bot, human_phone или human_panel; вид text, voice или other; для голосовых текст расшифровки.
 * TODO(этап 2): app_state (ключ, значение): linked_at_ms, момент первой привязки номера.
 * TODO(этап 3): outbound_ids (wa_id, jid, origin bot_reply, handoff_notice, voice_notice, manager_notify или panel, текст для getMessage, статус pending, sent или failed); запись создаётся ДО отправки.
 * TODO(этап 3): счётчики вызовов API по суткам (время Алматы): общий и по чатам, для дневного предохранителя.
 * TODO(этап 5): handoffs (причина, уровень, снимок выжимки, статус и ID уведомления); частичный уникальный индекс: не больше одной открытой передачи на чат.
 * TODO(этап 2): время INTEGER, мс UTC; сырые WAMessage не хранить: по mediaKey и directPath можно расшифровать медиа.
 */
export function runMigrations(db: Database.Database): void {
  notImplemented('этап 2', 'db/migrations.runMigrations');
}
