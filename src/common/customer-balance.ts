import { Prisma } from '@prisma/client';

/** Internal: sales − payments. Positive = customer owes the business. */
export function moneyOutstandingFromTotals(
  salesTotal: Prisma.Decimal,
  paymentsTotal: Prisma.Decimal,
): Prisma.Decimal {
  return salesTotal.sub(paymentsTotal);
}

export function toDisplayMoney(internal: Prisma.Decimal | number): number {
  const n = typeof internal === 'number' ? internal : Number(internal);
  return -n;
}

export function toDisplayBottle(internal: number): number {
  if (Math.abs(internal) < 0.001) return 0;
  return -internal;
}
