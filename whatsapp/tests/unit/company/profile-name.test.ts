import { describe, expect, it } from 'vitest';
import { profileNameForSearch } from '../../../src/company/profile-name.js';

type Kind = 'business' | 'personal' | 'unknown' | null;

function nameOf(
  fields: { verifiedName?: string | null; pushName?: string | null },
  profileKind: Kind = 'personal',
): string | null {
  return profileNameForSearch({
    verifiedName: fields.verifiedName ?? null,
    pushName: fields.pushName ?? null,
    profileKind,
  });
}

describe('profileNameForSearch: подтверждённое имя', () => {
  it('verifiedName берётся первым, даже у личного аккаунта и при заполненном pushName', () => {
    expect(nameOf({ verifiedName: 'Платформа-А', pushName: 'Иван' }, 'personal')).toBe(
      'Платформа-А',
    );
  });

  it('verifiedName обрезается по краям', () => {
    expect(nameOf({ verifiedName: '  Платформа-А \n' })).toBe('Платформа-А');
  });

  it('пустой verifiedName не считается: берётся правило для pushName', () => {
    expect(nameOf({ verifiedName: '   ', pushName: 'ТОО Альфа' })).toBe('ТОО Альфа');
    expect(nameOf({ verifiedName: '', pushName: 'Иван' })).toBeNull();
  });
});

describe('profileNameForSearch: имя профиля pushName', () => {
  it('бизнес-аккаунт: pushName годится как есть', () => {
    expect(nameOf({ pushName: 'Магазин у дома' }, 'business')).toBe('Магазин у дома');
  });

  it('личный аккаунт без признака компании: не искать', () => {
    expect(nameOf({ pushName: 'Иван Петров' }, 'personal')).toBeNull();
    expect(nameOf({ pushName: 'Иван Петров' }, 'unknown')).toBeNull();
    expect(nameOf({ pushName: 'Иван Петров' }, null)).toBeNull();
  });

  it.each([
    'ТОО Альфа',
    'Альфа ТОО',
    'ИП Иванов',
    'АО Бета',
    'ООО Гамма',
    'ЗАО Дельта',
    'ОАО Эпсилон',
    'Alpha LLP',
    'Beta LLC',
    'Gamma Ltd',
    'Delta JSC',
    'Epsilon Inc',
    'Zeta GmbH',
  ])('признак компании: форма собственности отдельным словом (%s)', (pushName) => {
    expect(nameOf({ pushName }, 'personal')).toBe(pushName);
  });

  it('форма собственности распознаётся без учёта регистра и рядом со знаками', () => {
    expect(nameOf({ pushName: 'тоо альфа' })).toBe('тоо альфа');
    expect(nameOf({ pushName: 'Gamma LTD.' })).toBe('Gamma LTD.');
    expect(nameOf({ pushName: 'ТОО«Альфа»' })).toBe('ТОО«Альфа»');
    expect(nameOf({ pushName: 'Alpha, inc' })).toBe('Alpha, inc');
  });

  it.each(['Ипполит Сидоров', 'Каос Дмитрий', 'Инкогнито', 'Ltdx Бета', 'Мария Ао1'])(
    'форма собственности внутри слова не считается признаком (%s)',
    (pushName) => {
      expect(nameOf({ pushName }, 'personal')).toBeNull();
    },
  );

  it.each(['«Альфа» Иван', 'Иван "Альфа"', 'Склад «Север» Алматы'])(
    'признак компании: имя в кавычках (%s)',
    (pushName) => {
      expect(nameOf({ pushName }, 'personal')).toBe(pushName);
    },
  );

  it.each(['Иван «»', 'Иван ""', 'Иван "Альфа', 'Иван «Альфа', 'Иван Альфа»'])(
    'пустые или незакрытые кавычки не признак (%s)',
    (pushName) => {
      expect(nameOf({ pushName }, 'personal')).toBeNull();
    },
  );

  it('пустой pushName и отсутствие обоих имён: не искать, даже у бизнес-аккаунта', () => {
    expect(nameOf({ pushName: '   ' }, 'business')).toBeNull();
    expect(nameOf({}, 'business')).toBeNull();
  });
});

describe('profileNameForSearch: длина', () => {
  it('имя длиннее 200 знаков обрезается до 200', () => {
    const long = 'Ж'.repeat(300);

    expect(nameOf({ pushName: long }, 'business')).toBe('Ж'.repeat(200));
    expect(nameOf({ verifiedName: long })).toBe('Ж'.repeat(200));
  });

  it('имя ровно в 200 знаков остаётся целым', () => {
    expect(nameOf({ verifiedName: 'Ж'.repeat(200) })).toBe('Ж'.repeat(200));
  });
});
