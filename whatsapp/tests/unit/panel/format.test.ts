import { describe, expect, it } from 'vitest';
import type { ChatControl, ChatIdentity, Jid } from '../../../src/domain/types.js';
import {
  AUTHOR_LABELS,
  controlLabel,
  formatAlmatyTime,
  HANDOFF_REASON_LABELS,
  LEVEL_LABELS,
  NOTIFICATION_KIND_LABELS,
  NOTIFICATION_STATUS_LABELS,
  nameLabel,
  phoneLabel,
} from '../../../src/panel/format.js';

const identity = (replyJid: string, pnJid: string | null): ChatIdentity => ({
  replyJid: replyJid as Jid,
  lidJid: null,
  pnJid: pnJid as Jid | null,
});

describe('formatAlmatyTime', () => {
  it('время по Алматы (UTC+5 круглый год): ДД.ММ.ГГГГ ЧЧ:ММ', () => {
    expect(formatAlmatyTime(Date.UTC(2026, 9, 26, 10, 0))).toBe('26.10.2026 15:00');
    expect(formatAlmatyTime(Date.UTC(2026, 0, 5, 3, 7))).toBe('05.01.2026 08:07');
  });

  it('переход через полночь меняет дату, а год и месяц переходят вместе', () => {
    expect(formatAlmatyTime(Date.UTC(2026, 9, 26, 20, 30))).toBe('27.10.2026 01:30');
    expect(formatAlmatyTime(Date.UTC(2026, 11, 31, 19, 59))).toBe('01.01.2027 00:59');
  });

  it('значение не время: понятная замена, а не NaN на странице', () => {
    expect(formatAlmatyTime(Number.NaN)).toBe('время неизвестно');
    expect(formatAlmatyTime(Number.POSITIVE_INFINITY)).toBe('время неизвестно');
  });
});

describe('phoneLabel', () => {
  it('номер из адреса с номером, с плюсом и без суффикса устройства', () => {
    expect(phoneLabel(identity('77001234567@s.whatsapp.net', '77001234567@s.whatsapp.net'))).toBe(
      '+77001234567',
    );
    expect(phoneLabel(identity('100@lid', '77001234567:3@s.whatsapp.net'))).toBe('+77001234567');
  });

  it('номера нет (только @lid): «номер скрыт»', () => {
    expect(phoneLabel(identity('100000000000001@lid', null))).toBe('номер скрыт');
  });
});

describe('nameLabel', () => {
  it('имя из профиля очищается от скрытых символов', () => {
    expect(nameLabel('Алия‮')).toBe('Алия');
  });

  it('нет имени или оно пустое после очистки: «без имени»', () => {
    expect(nameLabel(null)).toBe('без имени');
    expect(nameLabel('  ')).toBe('без имени');
    expect(nameLabel('‮')).toBe('без имени');
  });
});

describe('controlLabel', () => {
  const cases: readonly (readonly [ChatControl, string])[] = [
    [{ status: 'bot', by: null }, 'Ведёт бот'],
    [{ status: 'bot', by: 'panel' }, 'Ведёт бот (возвращён из панели)'],
    [{ status: 'manager', by: 'bot' }, 'Ведёт менеджер (передал бот)'],
    [{ status: 'manager', by: 'phone' }, 'Ведёт менеджер (написал с телефона)'],
    [{ status: 'manager', by: 'panel' }, 'Ведёт менеджер (ответил из панели)'],
  ];

  it.each(cases)('%j: %s', (control, label) => {
    expect(controlLabel(control)).toBe(label);
  });
});

describe('подписи на русском', () => {
  it('уровни, поводы передачи, виды и статусы уведомлений, авторы покрыты', () => {
    expect(Object.keys(LEVEL_LABELS).sort()).toEqual(['cold', 'hot', 'warm']);
    expect(Object.keys(HANDOFF_REASON_LABELS).sort()).toEqual([
      'asked_human',
      'check_failed',
      'complaint',
      'hot',
      'human_took_over',
      'limit',
      'llm_error',
      'no_answer',
    ]);
    expect(Object.keys(NOTIFICATION_KIND_LABELS).sort()).toEqual(['backlog', 'handoff', 'limit']);
    expect(Object.keys(NOTIFICATION_STATUS_LABELS).sort()).toEqual([
      'failed',
      'no_manager',
      'pending',
      'sent',
      'skipped_limit',
    ]);
    expect(Object.keys(AUTHOR_LABELS).sort()).toEqual([
      'bot',
      'client',
      'human_panel',
      'human_phone',
    ]);
  });

  it('все подписи по-русски, без тире', () => {
    const all = [
      ...Object.values(LEVEL_LABELS),
      ...Object.values(HANDOFF_REASON_LABELS),
      ...Object.values(NOTIFICATION_KIND_LABELS),
      ...Object.values(NOTIFICATION_STATUS_LABELS),
      ...Object.values(AUTHOR_LABELS),
    ];

    for (const label of all) {
      expect(label).toMatch(/[а-яё]/i);
      expect(label).not.toMatch(/[‐-―−]/);
    }
  });
});
