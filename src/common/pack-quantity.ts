import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';

/**
 * FlowStock works by the dozen, and the size of a "dozen" is configurable.
 * - Each BottleType has `bottlesPerDozen` (12, 24, …). Returnable products copy
 *   it into `Product.unitsPerCase`; non-returnable products set their own.
 * - Quantities are STORED as single bottles and must be whole half-dozen steps
 *   (multiples of bottlesPerDozen / 2).
 * - Prices (sellingPrice, defaultCost, unitPrice, unitCost, replacementPrice)
 *   are PER DOZEN of that product / bottle type. Money = price × bottles / size.
 */
export const UNITS_PER_DOZEN = 12;
export const DEFAULT_PACK_SIZE = 12;
export const MAX_PACK_SIZE = 1000;

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

export function isValidPackSize(size: unknown): size is number {
  return (
    typeof size === 'number' &&
    Number.isInteger(size) &&
    size >= 2 &&
    size <= MAX_PACK_SIZE &&
    size % 2 === 0
  );
}

/** A dozen size must be an even whole number (so half a dozen is whole bottles). */
export function assertPackSize(size: number, field = 'bottlesPerDozen'): number {
  if (!isValidPackSize(size)) {
    throw new BadRequestException(`${field} must be an even whole number between 2 and ${MAX_PACK_SIZE}`);
  }
  return size;
}

export function halfDozen(size: number): number {
  return assertPackSize(size) / 2;
}

export function isPackStep(bottles: number, size: number, allowNegative = false): boolean {
  if (!Number.isInteger(bottles)) return false;
  if (!allowNegative && bottles < 0) return false;
  if (Math.abs(bottles) > MAX_PACK_QUANTITY) return false;
  return Math.abs(bottles) % halfDozen(size) === 0;
}

/** Throws a 400 unless `bottles` is a whole number of half dozens for this dozen size. */
export function assertPackStep(
  bottles: number,
  size: number,
  field = 'quantity',
  opts: { allowNegative?: boolean; label?: string } = {},
): number {
  if (!isPackStep(bottles, size, opts.allowNegative ?? false)) {
    const what = opts.label ? ` for ${opts.label}` : '';
    throw new BadRequestException(
      `${field} must be in half-dozen steps${what} (multiples of ${halfDozen(size)} bottles; 1 dozen = ${size})`,
    );
  }
  return bottles;
}

/** 2.5 dozen of a 24-bottle dozen → 60 bottles. Only 0.5 dozen steps are allowed. */
export function dozenToBottles(dozen: number, size = DEFAULT_PACK_SIZE, field = 'dozen'): number {
  assertPackSize(size);
  if (!Number.isFinite(dozen) || dozen < 0) {
    throw new Error(`Invalid ${field}: must be a nonnegative number`);
  }
  if (!Number.isInteger(dozen * 2)) {
    throw new Error(`${field} must be in half-dozen steps (e.g. 1, 1.5, 2)`);
  }
  const bottles = Math.round(dozen * size);
  if (bottles > MAX_PACK_QUANTITY) {
    throw new Error('Total quantity exceeds maximum');
  }
  return bottles;
}

export function bottlesToDozen(bottles: number, size = DEFAULT_PACK_SIZE): number {
  return bottles / size;
}

/** Money for `bottles` at a per-dozen `price`, rounded to cents. */
export function perDozenTotal(
  price: Prisma.Decimal.Value,
  bottles: number,
  size = DEFAULT_PACK_SIZE,
): Prisma.Decimal {
  return new Prisma.Decimal(price).mul(bottles).div(assertPackSize(size)).toDecimalPlaces(2);
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

/** class-validator: an even whole dozen size (12, 24, …). */
export function IsPackSize(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isPackSize',
      validator: {
        validate: (value) => isValidPackSize(value),
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must be an even whole number between 2 and ${MAX_PACK_SIZE}`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}
