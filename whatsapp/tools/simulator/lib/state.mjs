// Состояние бота из временной базы симулятора: отдельное соединение только на чтение (база в режиме WAL).

function parseJsonField(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Строка без пустых полей (NULL и пустые JSON-массивы), чтобы дамп читался. */
function compact(row) {
  if (row === undefined || row === null) return null;
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== null && value !== '' && value !== '[]'),
  );
}

export function openState(Database, dbPath) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    db = new Database(dbPath, { fileMustExist: true });
  }
  const chatOf = (phone) => db.prepare('SELECT * FROM chats WHERE phone = ?').get(phone) ?? null;

  return {
    chatId(phone) {
      return chatOf(phone)?.id ?? null;
    },
    outbound(waId) {
      return db.prepare('SELECT origin, chat_id FROM outbound_ids WHERE wa_id = ?').get(waId) ?? null;
    },
    companyState(chatId) {
      const row = db.prepare('SELECT state FROM chat_companies WHERE chat_id = ?').get(chatId);
      return row === undefined ? null : parseJsonField(row.state);
    },
    /** Снимок после хода. sinceDraftId: отклонённые черновики новее этого ID (по ходу). */
    snapshot(phone, sinceDraftId) {
      const chat = chatOf(phone);
      const apiUsage = db.prepare('SELECT day, chat_id, count FROM api_usage ORDER BY day, chat_id').all();
      if (chat === null) return { chat: null, apiUsage, lastDraftId: sinceDraftId };
      const id = chat.id;
      const drafts = db
        .prepare('SELECT id, attempt, source, draft, remarks, at_ms FROM rejected_drafts WHERE chat_id = ? AND id > ? ORDER BY id')
        .all(id, sinceDraftId)
        .map((row) => ({ ...row, remarks: parseJsonField(row.remarks) }));
      const lastDraftId = drafts.length === 0 ? sinceDraftId : drafts.at(-1).id;
      return {
        chat: {
          id,
          status: chat.status,
          status_by: chat.status_by,
          interest_level: chat.interest_level,
          last_stage: chat.last_stage,
          told_facts: parseJsonField(chat.told_facts),
          price_asks: chat.price_asks,
          refused_answers: chat.refused_answers,
          refused_streak: chat.refused_streak,
          bot_note: chat.bot_note,
        },
        company: this.companyState(id),
        profile: compact(db.prepare('SELECT * FROM client_profiles WHERE chat_id = ?').get(id)),
        handoffs: db
          .prepare('SELECT id, reason, level, opened_at_ms, resolved_at_ms, snapshot FROM handoffs WHERE chat_id = ? ORDER BY id')
          .all(id)
          .map((row) => ({ ...row, open: row.resolved_at_ms === null, snapshot: parseJsonField(row.snapshot) })),
        notifications: db
          .prepare('SELECT id, kind, status, attempts, text, created_at_ms FROM manager_notifications ORDER BY id')
          .all(),
        messages: db
          .prepare('SELECT author, kind, answered, COUNT(*) AS n FROM messages WHERE chat_id = ? GROUP BY author, kind, answered')
          .all(id),
        rejectedDrafts: drafts,
        apiUsage,
        lastDraftId,
      };
    },
    close() {
      db.close();
    },
  };
}
