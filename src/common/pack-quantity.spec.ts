import {
  UNITS_PER_DOZEN,
  assertWholeNonNegative,
  fromEach,
  projectBottleInternal,
  toEach,
} from './pack-quantity';
import { toDisplayBottle } from './customer-balance';

describe('pack-quantity (backend)', () => {
  it('converts dozen to each', () => {
    expect(toEach({ dozen: 2, each: 0, unitsPerDozen: 12 })).toBe(24);
    expect(toEach({ dozen: 1, each: 6, unitsPerDozen: 12 })).toBe(18);
  });

  it('fromEach breakdown', () => {
    expect(fromEach(14)).toEqual({ dozen: 1, each: 2 });
  });

  it('rejects invalid input', () => {
    expect(() => assertWholeNonNegative(-1)).toThrow();
    expect(() => toEach({ dozen: 1, each: 0, unitsPerDozen: 10 })).toThrow();
  });

  it('bottle projection scenarios', () => {
    expect(projectBottleInternal(0, 24, 24)).toBe(0);
    expect(toDisplayBottle(projectBottleInternal(0, 10, 15))).toBe(5);
    expect(projectBottleInternal(20, 10, 35)).toBe(-5);
    expect(toDisplayBottle(-5)).toBe(5);
  });

  it('UNITS_PER_DOZEN is 12', () => {
    expect(UNITS_PER_DOZEN).toBe(12);
  });
});
