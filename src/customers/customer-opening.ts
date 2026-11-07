import { BadRequestException } from '@nestjs/common';
import { BottleReason, Prisma } from '@prisma/client';
import { dozenToBottles } from '../common/pack-quantity';
import { bottleTypePackSize } from '../common/pack-size';

/** Locked reason for manual → digital customer opening balances. */
export const CUSTOMER_OPENING_NOTE = 'Initial from manual to digital';

export type OpeningDirection = 'OWES' | 'CREDIT';

export type OpeningBottleInput = {
  bottleTypeId: string;
  quantityDozen: number;
  direction: OpeningDirection;
};

type Db = Prisma.TransactionClient;

export function parseOpeningMoney(
  amountRaw: string | undefined,
  direction: OpeningDirection | undefined,
): Prisma.Decimal {
  if (amountRaw === undefined || amountRaw === null || String(amountRaw).trim() === '') {
    return new Prisma.Decimal(0);
  }
  const amount = new Prisma.Decimal(String(amountRaw).trim());
  if (!amount.isFinite() || amount.lt(0)) {
    throw new BadRequestException('Opening money amount must be zero or positive');
  }
  if (amount.eq(0)) return new Prisma.Decimal(0);
  const dir = direction ?? 'OWES';
  if (dir !== 'OWES' && dir !== 'CREDIT') {
    throw new BadRequestException('Opening money direction must be OWES or CREDIT');
  }
  return dir === 'CREDIT' ? amount.neg() : amount;
}

export async function createOpeningBottleMovements(
  tx: Db,
  input: {
    customerId: string;
    bottles: OpeningBottleInput[];
    userId: string;
  },
): Promise<void> {
  for (const row of input.bottles) {
    if (!row?.bottleTypeId?.trim()) {
      throw new BadRequestException('Opening bottle type is required');
    }
    const dir = row.direction;
    if (dir !== 'OWES' && dir !== 'CREDIT') {
      throw new BadRequestException('Opening bottle direction must be OWES or CREDIT');
    }
    const dozen = Number(row.quantityDozen);
    if (!Number.isFinite(dozen) || dozen < 0) {
      throw new BadRequestException('Opening bottle quantity must be zero or positive');
    }
    if (dozen === 0) continue;

    const bt = await tx.bottleType.findUnique({ where: { id: row.bottleTypeId } });
    if (!bt || !bt.active) throw new BadRequestException('Invalid or inactive bottle type for opening balance');

    const size = await bottleTypePackSize(tx, row.bottleTypeId);
    let bottles: number;
    try {
      bottles = dozenToBottles(dozen, size, 'openingBottles.quantityDozen');
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    if (bottles === 0) continue;

    const delta = dir === 'CREDIT' ? -bottles : bottles;
    await tx.bottleMovement.create({
      data: {
        customerId: input.customerId,
        bottleTypeId: row.bottleTypeId,
        delta,
        reason: BottleReason.ADJUSTMENT,
        note: CUSTOMER_OPENING_NOTE,
        createdById: input.userId,
      },
    });
  }
}
