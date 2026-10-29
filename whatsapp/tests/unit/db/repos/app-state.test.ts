import { describe, expect, it } from 'vitest';
import { createAppStateRepo } from '../../../../src/db/repos/app-state.js';
import { useMigratedDb } from '../fixture.js';

const LINKED_AT = 1_761_400_000_000;

describe('createAppStateRepo', () => {
  it('пока номер не привязан, момента привязки нет', () => {
    const repo = createAppStateRepo(useMigratedDb());

    expect(repo.getLinkedAtMs()).toBeNull();
  });

  it('setLinkedAtMs записывает момент, новая привязка его перезаписывает', () => {
    const repo = createAppStateRepo(useMigratedDb());

    repo.setLinkedAtMs(LINKED_AT);
    expect(repo.getLinkedAtMs()).toBe(LINKED_AT);

    repo.setLinkedAtMs(LINKED_AT + 60_000);
    expect(repo.getLinkedAtMs()).toBe(LINKED_AT + 60_000);
  });

  it('момент хранится в базе: его видит новый экземпляр репозитория', () => {
    const db = useMigratedDb();
    createAppStateRepo(db).setLinkedAtMs(LINKED_AT);

    expect(createAppStateRepo(db).getLinkedAtMs()).toBe(LINKED_AT);
    expect(db.prepare('SELECT count(*) FROM app_state').pluck().get()).toBe(1);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'отклоняет неверное время %s и ничего не пишет',
    (value) => {
      const repo = createAppStateRepo(useMigratedDb());

      expect(() => {
        repo.setLinkedAtMs(value);
      }).toThrow(RangeError);
      expect(repo.getLinkedAtMs()).toBeNull();
    },
  );

  it.each(['вчера', '', '12.5', '1e12', '-5', '9007199254740993'])(
    'испорченное значение «%s» в базе: явная ошибка, а не случайная граница',
    (stored) => {
      const db = useMigratedDb();
      db.prepare("INSERT INTO app_state (key, value) VALUES ('linked_at_ms', ?)").run(stored);

      expect(() => createAppStateRepo(db).getLinkedAtMs()).toThrow(/linked_at_ms/);
    },
  );
});

describe('createAppStateRepo: флаг неполной истории', () => {
  it('пока список чатов первой синхронизации не терялся, флага нет', () => {
    expect(createAppStateRepo(useMigratedDb()).getHistoryIncomplete()).toBeNull();
  });

  it('markHistoryIncomplete ставит флаг с моментом сбоя; повтор момент первого сбоя не сдвигает', () => {
    const repo = createAppStateRepo(useMigratedDb());

    repo.markHistoryIncomplete(LINKED_AT + 1000);
    repo.markHistoryIncomplete(LINKED_AT + 5000);

    expect(repo.getHistoryIncomplete()).toBe(LINKED_AT + 1000);
  });

  it('флаг хранится в базе отдельно от момента привязки', () => {
    const db = useMigratedDb();
    const repo = createAppStateRepo(db);
    repo.setLinkedAtMs(LINKED_AT);

    repo.markHistoryIncomplete(LINKED_AT + 1000);

    expect(createAppStateRepo(db).getHistoryIncomplete()).toBe(LINKED_AT + 1000);
    expect(repo.getLinkedAtMs()).toBe(LINKED_AT);
  });

  it.each([-1, 1.5, Number.NaN])('отклоняет неверное время %s и флаг не ставит', (value) => {
    const repo = createAppStateRepo(useMigratedDb());

    expect(() => {
      repo.markHistoryIncomplete(value);
    }).toThrow(RangeError);
    expect(repo.getHistoryIncomplete()).toBeNull();
  });

  it('испорченное значение флага в базе: явная ошибка с названием ключа', () => {
    const db = useMigratedDb();
    db.prepare(
      "INSERT INTO app_state (key, value) VALUES ('history_incomplete_at_ms', 'да')",
    ).run();

    expect(() => createAppStateRepo(db).getHistoryIncomplete()).toThrow(/history_incomplete_at_ms/);
  });
});

describe('createAppStateRepo: граница рабочего режима (этап 8)', () => {
  const SWITCHED_AT = LINKED_AT + 86_400_000;

  it('пока бот не переходил в рабочий режим, границы нет', () => {
    expect(createAppStateRepo(useMigratedDb()).getWorkingSinceMs()).toBeNull();
  });

  it('setWorkingSinceMs пишет границу отдельно от привязки и флага, повтор её перезаписывает', () => {
    const db = useMigratedDb();
    const repo = createAppStateRepo(db);
    repo.setLinkedAtMs(LINKED_AT);
    repo.markHistoryIncomplete(LINKED_AT + 1000);

    repo.setWorkingSinceMs(SWITCHED_AT);
    expect(createAppStateRepo(db).getWorkingSinceMs()).toBe(SWITCHED_AT);
    repo.setWorkingSinceMs(SWITCHED_AT + 1);

    expect(repo.getWorkingSinceMs()).toBe(SWITCHED_AT + 1);
    expect(repo.getLinkedAtMs()).toBe(LINKED_AT);
    expect(repo.getHistoryIncomplete()).toBe(LINKED_AT + 1000);
  });

  it('clearWorkingSince снимает границу и говорит, была ли она; привязку не трогает', () => {
    const repo = createAppStateRepo(useMigratedDb());
    repo.setLinkedAtMs(LINKED_AT);
    repo.setWorkingSinceMs(SWITCHED_AT);

    expect(repo.clearWorkingSince()).toBe(true);
    expect(repo.getWorkingSinceMs()).toBeNull();
    expect(repo.clearWorkingSince()).toBe(false);
    expect(repo.getLinkedAtMs()).toBe(LINKED_AT);
  });

  it.each([-1, 1.5, Number.NaN])('отклоняет неверное время %s и границу не пишет', (value) => {
    const repo = createAppStateRepo(useMigratedDb());

    expect(() => {
      repo.setWorkingSinceMs(value);
    }).toThrow(RangeError);
    expect(repo.getWorkingSinceMs()).toBeNull();
  });

  it('испорченное значение границы в базе: явная ошибка с названием ключа', () => {
    const db = useMigratedDb();
    db.prepare("INSERT INTO app_state (key, value) VALUES ('working_since_ms', 'завтра')").run();

    expect(() => createAppStateRepo(db).getWorkingSinceMs()).toThrow(/working_since_ms/);
  });
});
