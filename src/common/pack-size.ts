import { BadRequestException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { DEFAULT_PACK_SIZE, assertPackStep } from './pack-quantity';

type Db = Prisma.TransactionClient | PrismaClient;

/** Bottles per dozen for a product (returnable products mirror their bottle type). */
export async function productPackSize(db: Db, productId: string): Promise<number> {
  const p = await db.product.findUnique({
    where: { id: productId },
    select: { unitsPerCase: true, bottleType: { select: { bottlesPerDozen: true } } },
  });
  if (!p) throw new BadRequestException('Invalid product');
  return p.bottleType?.bottlesPerDozen ?? p.unitsPerCase ?? DEFAULT_PACK_SIZE;
}

export async function bottleTypePackSize(db: Db, bottleTypeId: string): Promise<number> {
  const b = await db.bottleType.findUnique({
    where: { id: bottleTypeId },
    select: { bottlesPerDozen: true },
  });
  if (!b) throw new BadRequestException('Invalid bottle type');
  return b.bottlesPerDozen ?? DEFAULT_PACK_SIZE;
}

export async function assertProductStep(
  db: Db,
  productId: string,
  bottles: number,
  field = 'quantity',
  allowNegative = false,
): Promise<number> {
  const size = await productPackSize(db, productId);
  return assertPackStep(bottles, size, field, { allowNegative });
}

export async function assertBottleTypeStep(
  db: Db,
  bottleTypeId: string,
  bottles: number,
  field = 'quantity',
  allowNegative = false,
): Promise<number> {
  const size = await bottleTypePackSize(db, bottleTypeId);
  return assertPackStep(bottles, size, field, { allowNegative });
}
