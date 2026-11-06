import {
  HALF_DOZEN,
  UNITS_PER_DOZEN,
  assertHalfDozenBottles,
  assertWholeNonNegative,
  bottlesToDozen,
  dozenToBottles,
  isHalfDozenBottles,
  perDozenTotal,
} from './pack-quantity';

describe('pack-quantity (backend, dozen-only)', () => {
  it('converts dozen to bottles in half-dozen steps', () => {
    expect(dozenToBottles(2)).toBe(24);
    expect(dozenToBottles(2.5)).toBe(30);
    expect(dozenToBottles(0.5)).toBe(6);
  });

  it('rejects dozen values that are not half-dozen steps', () => {
    expect(() => dozenToBottles(1.3)).toThrow(/half-dozen/);
    expect(() => dozenToBottles(-1)).toThrow();
  });

  it('validates bottle counts as multiples of 6', () => {
    expect(isHalfDozenBottles(30)).toBe(true);
    expect(isHalfDozenBottles(7)).toBe(false);
    expect(isHalfDozenBottles(-12)).toBe(false);
    expect(isHalfDozenBottles(-12, true)).toBe(true);
    expect(() => assertHalfDozenBottles(7)).toThrow(/half-dozen/);
    expect(assertHalfDozenBottles(18)).toBe(18);
  });

  it('bottles to dozen', () => {
    expect(bottlesToDozen(30)).toBe(2.5);
  });

  it('per-dozen money totals are exact for whole and half dozens', () => {
    expect(perDozenTotal('310', 24).toString()).toBe('620');
    expect(perDozenTotal('300', 30).toString()).toBe('750');
    expect(perDozenTotal('25.25', 6).toString()).toBe('12.63');
  });

  it('rejects invalid whole numbers', () => {
    expect(() => assertWholeNonNegative(-1)).toThrow();
  });

  it('constants', () => {
    expect(UNITS_PER_DOZEN).toBe(12);
    expect(HALF_DOZEN).toBe(6);
  });
});
