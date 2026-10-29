import { describe, expect, it } from 'vitest';
import type { ChatIdentity, Jid, PhoneDigits } from '../../../src/domain/types.js';
import { isChatAllowlisted } from '../../../src/messaging/allowlist.js';

const PHONE = '77000000002' as PhoneDigits;
const PN = '77000000002@s.whatsapp.net' as Jid;
const LID = '100000000000002@lid' as Jid;
const ALLOWLIST: ReadonlySet<PhoneDigits> = new Set([PHONE]);

function identity(pnJid: Jid | null, replyJid: Jid = pnJid ?? LID): ChatIdentity {
  return { replyJid, lidJid: replyJid === LID ? LID : null, pnJid };
}

describe('messaging/allowlist: закрытый режим для outbox и конвейера', () => {
  it('режим выключен: любой чат', () => {
    expect(isChatAllowlisted(null, identity(null))).toBe(true);
  });

  it.each<[string, ChatIdentity, boolean]>([
    ['номер из списка', identity(PN), true],
    ['@lid с известным номером из списка', identity(PN, LID), true],
    ['номер не из списка', identity('77000000009@s.whatsapp.net' as Jid), false],
    ['только @lid, номер неизвестен', identity(null), false],
  ])('%s: %s', (_case, chat, expected) => {
    expect(isChatAllowlisted(ALLOWLIST, chat)).toBe(expected);
  });
});
