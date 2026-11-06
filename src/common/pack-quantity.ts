import { Prisma } from '@prisma/client';
import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';

/**
 * FlowStock works by the dozen.
 * - Quantities are STORED as single bottles (1 dozen = 12) but must always be
 *   whole half-dozen steps (multiples of 6 bottles).
 * - Prices (sellingPrice, defaultCost, unitPrice, unitCost, replacementPrice)
 *   are PER DOZEN. Money = price × bottles / 12.
 */
export const UNITS_PER_DOZEN = 12;
export const HALF_DOZEN = 6;

export const MAX_PACK_QUANTITY = 1_000_000;

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

export function isHalfDozenBottles(n: unknown, allowNegative = false): boolean {
  if (typeof n !== 'number' || !Number.isInteger(n)) return false;
  if (!allowNegative && n < 0) return false;
  if (Math.abs(n) > MAX_PACK_QUANTITY) return false;
  return Math.abs(n) % HALF_DOZEN === 0;
}

/** Throws unless `n` bottles is a whole, non-negative number of half dozens. */
export function assertHalfDozenBottles(n: number, field = 'quantity'): number {
  assertWholeNonNegative(n, field);
  if (n % HALF_DOZEN !== 0) {
    throw new Error(`${field} must be in half-dozen steps (multiples of ${HALF_DOZEN} bottles)`);
  }
  return n;
}

/** 2.5 dozen → 30 bottles. Only 0.5 dozen steps are allowed. */
export function dozenToBottles(dozen: number, field = 'dozen'): number {
  if (!Number.isFinite(dozen) || dozen < 0) {
    throw new Error(`Invalid ${field}: must be a nonnegative number`);
  }
  if (!Number.isInteger(dozen * 2)) {
    throw new Error(`${field} must be in half-dozen steps (e.g. 1, 1.5, 2)`);
  }
  const bottles = Math.round(dozen * UNITS_PER_DOZEN);
  if (bottles > MAX_PACK_QUANTITY) {
    throw new Error('Total quantity exceeds maximum');
  }
  return bottles;
}

export function bottlesToDozen(bottles: number): number {
  return bottles / UNITS_PER_DOZEN;
}

/** Money for `bottles` at a per-dozen `price`, rounded to cents. */
export function perDozenTotal(price: Prisma.Decimal.Value, bottles: number): Prisma.Decimal {
  return new Prisma.Decimal(price)
    .mul(bottles)
    .div(UNITS_PER_DOZEN)
    .toDecimalPlaces(2);
}

/** class-validator: value is a bottle count in half-dozen steps (multiple of 6). */
export function IsHalfDozenBottles(
  opts: { allowNegative?: boolean } = {},
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isHalfDozenBottles',
      validator: {
        validate: (value) => isHalfDozenBottles(value, opts.allowNegative ?? false),
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must be in half-dozen steps (multiples of ${HALF_DOZEN} bottles)`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}

/** class-validator: value is a dozen count in 0.5 steps. */
export function IsHalfDozenStep(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isHalfDozenStep',
      validator: {
        validate: (value) =>
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value >= 0 &&
          Number.isInteger(value * 2),
        defaultMessage: buildMessage(
          (eachPrefix) => `${eachPrefix}$property must be in half-dozen steps (e.g. 1, 1.5, 2)`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}
