import {
  UNITS_PER_DOZEN,
  assertPackSize,
  assertPackStep,
  assertWholeNonNegative,
  bottlesToDozen,
  dozenToBottles,
  halfDozen,
  isPackStep,
  isValidPackSize,
  perDozenTotal,
} from './pack-quantity';

describe('pack-quantity (backend, configurable dozen)', () => {
  it('converts dozen to bottles for 12- and 24-bottle dozens', () => {
    expect(dozenToBottles(2)).toBe(24);
    expect(dozenToBottles(2.5)).toBe(30);
    expect(dozenToBottles(2, 24)).toBe(48);
    expect(dozenToBottles(0.5, 24)).toBe(12);
  });

  it('rejects dozen values that are not half-dozen steps', () => {
    expect(() => dozenToBottles(1.3)).toThrow(/half-dozen/);
    expect(() => dozenToBottles(-1)).toThrow();
  });

  it('half-dozen step depends on dozen size', () => {
    expect(halfDozen(12)).toBe(6);
    expect(halfDozen(24)).toBe(12);
    expect(isPackStep(18, 12)).toBe(true);
    expect(isPackStep(18, 24)).toBe(false);
    expect(isPackStep(36, 24)).toBe(true);
    expect(isPackStep(-12, 24)).toBe(false);
    expect(isPackStep(-12, 24, true)).toBe(true);
    expect(() => assertPackStep(7, 12)).toThrow(/half-dozen/);
    expect(assertPackStep(12, 24)).toBe(12);
  });

  it('validates dozen sizes', () => {
    expect(isValidPackSize(12)).toBe(true);
    expect(isValidPackSize(24)).toBe(true);
    expect(isValidPackSize(13)).toBe(false);
    expect(isValidPackSize(0)).toBe(false);
    expect(() => assertPackSize(7)).toThrow();
  });

  it('bottles to dozen', () => {
    expect(bottlesToDozen(30)).toBe(2.5);
    expect(bottlesToDozen(60, 24)).toBe(2.5);
  });

  it('per-dozen money totals use the dozen size', () => {
    expect(perDozenTotal('310', 24).toString()).toBe('620');
    expect(perDozenTotal('300', 30).toString()).toBe('750');
    expect(perDozenTotal('480', 60, 24).toString()).toBe('1200');
    expect(perDozenTotal('25.25', 6).toString()).toBe('12.63');
  });

  it('rejects invalid whole numbers', () => {
    expect(() => assertWholeNonNegative(-1)).toThrow();
  });

  it('default dozen is 12', () => {
    expect(UNITS_PER_DOZEN).toBe(12);
  });
});
