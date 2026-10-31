/** FlowStock: dozen = exactly 12 individual units (not supplier case size). */

export const UNITS_PER_DOZEN = 12;

export const MAX_PACK_QUANTITY = 1_000_000;

export type QuantityInput = {
  dozen: number;
  each: number;
  unitsPerDozen: number;
};

export function assertWholeNonNegative(n: number, field = 'quantity'): number {
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${field}: must be a nonnegative number`);
  }
  if (!Number.isInteger(n)) {
    throw new Error(`Invalid ${field}: must be a whole number`);
  }
  if (n > MAX_PACK_QUANTITY) {
    throw new Error(`Invalid ${field}: exceeds maximum`);
  }
  return n;
}

export function assertUnitsPerDozen(unitsPerDozen: number): number {
  if (unitsPerDozen !== UNITS_PER_DOZEN) {
    throw new Error('unitsPerDozen must be 12 for a standard dozen');
  }
  return unitsPerDozen;
}

export function toEach(input: QuantityInput): number {
  const upc = assertUnitsPerDozen(input.unitsPerDozen);
  const dozen = assertWholeNonNegative(input.dozen, 'dozen');
  const each = assertWholeNonNegative(input.each, 'each');
  const total = dozen * upc + each;
  if (total > MAX_PACK_QUANTITY) {
    throw new Error('Total quantity exceeds maximum');
  }
  return total;
}

export function fromEach(
  total: number,
  unitsPerDozen = UNITS_PER_DOZEN,
): { dozen: number; each: number } {
  assertUnitsPerDozen(unitsPerDozen);
  const abs = assertWholeNonNegative(Math.abs(Math.trunc(total)), 'total');
  return {
    dozen: Math.floor(abs / unitsPerDozen),
    each: abs % unitsPerDozen,
  };
}

export function projectBottleInternal(
  internalBefore: number,
  issuedEach: number,
  returnedEach: number,
): number {
  return internalBefore + issuedEach - returnedEach;
}
