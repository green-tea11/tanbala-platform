import { describe, expect, it } from 'vitest';
import { pickCandidate } from '../../../src/company/pick-candidate.js';
import { companyIdOf, makeCandidate } from './builders.js';

function byName(id: number, matchScore: number) {
  return makeCandidate({
    id: companyIdOf(id),
    matchBy: 'name',
    matchScore,
    name: `Компания ${id}`,
  });
}

describe('pickCandidate: общие правила', () => {
  it('пустой список: не нашли', () => {
    expect(pickCandidate([], [])).toBeNull();
  });

  it('один кандидат по домену с оценкой 1: он и выбран', () => {
    const candidate = makeCandidate();

    expect(pickCandidate([candidate], [])).toBe(candidate);
  });

  it('один кандидат по телефону: он и выбран', () => {
    const candidate = makeCandidate({ matchBy: 'phone' });

    expect(pickCandidate([candidate], [])).toBe(candidate);
  });

  it('отклонённые клиентом ID отбрасываются до выбора', () => {
    const rejected = makeCandidate({ id: companyIdOf(8) });
    const other = byName(9, 0.85);

    expect(pickCandidate([rejected, other], [companyIdOf(8)])).toBe(other);
  });

  it('все кандидаты отклонены: не нашли', () => {
    expect(pickCandidate([makeCandidate()], [companyIdOf(8)])).toBeNull();
  });

  it('отклонённая компания не считается «вторым» кандидатом: неоднозначности нет', () => {
    const rejectedClose = byName(1, 0.89);
    const best = byName(2, 0.9);

    expect(pickCandidate([best, rejectedClose], [companyIdOf(1)])).toBe(best);
  });

  it('порядок в списке не важен: лучший по оценке', () => {
    const best = makeCandidate({ id: companyIdOf(5), matchBy: 'name', matchScore: 0.9 });
    const weak = byName(6, 0.7);

    expect(pickCandidate([weak, best], [])).toBe(best);
    expect(pickCandidate([best, weak], [])).toBe(best);
  });

  it('входной список не меняется', () => {
    const list = [byName(6, 0.7), byName(5, 0.9)];
    const copy = [...list];

    pickCandidate(list, []);

    expect(list).toEqual(copy);
  });
});

describe('pickCandidate: поиск по названию', () => {
  it('оценка ниже 0.8: не нашли', () => {
    expect(pickCandidate([byName(1, 0.79)], [])).toBeNull();
    expect(pickCandidate([byName(1, 0.63)], [])).toBeNull();
  });

  it('оценка ровно 0.8 и выше принимается', () => {
    const exact = byName(1, 0.8);
    const high = byName(2, 0.9);

    expect(pickCandidate([exact], [])).toBe(exact);
    expect(pickCandidate([high], [])).toBe(high);
  });

  it('второй ближе чем на 0.1 к лучшему: неоднозначно, не нашли', () => {
    expect(pickCandidate([byName(1, 0.9), byName(2, 0.85)], [])).toBeNull();
    expect(pickCandidate([byName(1, 0.9), byName(2, 0.81)], [])).toBeNull();
    expect(pickCandidate([byName(1, 0.9), byName(2, 0.9)], [])).toBeNull();
  });

  it('второй дальше чем на 0.1 или ровно на 0.1: лучший выбирается', () => {
    const best = byName(1, 0.9);

    expect(pickCandidate([best, byName(2, 0.8)], [])).toBe(best);
    expect(pickCandidate([best, byName(2, 0.7)], [])).toBe(best);
    expect(pickCandidate([best, byName(2, 0.63)], [])).toBe(best);
  });

  it('разрыв ровно 0.1 не считается неоднозначностью, несмотря на дробную арифметику', () => {
    const best = byName(1, 0.9);
    const domain = makeCandidate({ id: companyIdOf(3), matchBy: 'domain', matchScore: 1 });

    expect(0.9 - 0.8).toBeLessThan(0.1);
    expect(1 - 0.9).toBeLessThan(0.1);
    expect(pickCandidate([best, byName(2, 0.8)], [])).toBe(best);
    expect(pickCandidate([domain, byName(2, 0.9)], [])).toBe(domain);
  });

  it('порог 0.8 тоже без погрешности дробей: 0.799 ниже порога, 0.8 нет', () => {
    expect(pickCandidate([byName(1, 0.799)], [])).toBeNull();
    expect(pickCandidate([byName(1, 0.8)], [])).not.toBeNull();
  });

  it('лучший ниже 0.8, а второй ещё ниже: не нашли', () => {
    expect(pickCandidate([byName(1, 0.78), byName(2, 0.64)], [])).toBeNull();
  });

  it('три кандидата: сравнение лучшего только со вторым', () => {
    const best = byName(1, 0.9);

    expect(pickCandidate([best, byName(2, 0.7), byName(3, 0.69)], [])).toBe(best);
    expect(pickCandidate([best, byName(2, 0.88), byName(3, 0.7)], [])).toBeNull();
  });
});

describe('pickCandidate: поиск по домену и телефону', () => {
  it('оценка 1 при совпадении по домену выше порога названия: порог не применяется', () => {
    const domain = makeCandidate({ matchBy: 'domain', matchScore: 1 });

    expect(pickCandidate([domain], [])).toBe(domain);
  });

  it('две компании с одним доменом (обе 1): неоднозначно, не нашли', () => {
    const first = makeCandidate({ id: companyIdOf(8) });
    const second = makeCandidate({ id: companyIdOf(9) });

    expect(pickCandidate([first, second], [])).toBeNull();
    expect(pickCandidate([second, first], [])).toBeNull();
  });

  it('вторая компания с отклонённым ID не мешает единственной нормальной', () => {
    const rejected = makeCandidate({ id: companyIdOf(8), matchBy: 'phone' });
    const good = makeCandidate({ id: companyIdOf(9), matchBy: 'phone' });

    expect(pickCandidate([rejected, good], [companyIdOf(8)])).toBe(good);
  });
});
