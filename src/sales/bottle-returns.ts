import { BadRequestException } from '@nestjs/common';
import { PackagingKind, Prisma } from '@prisma/client';

/** Bottle types that may be returned (active + linked to at least one returnable product). */
export async function compatibleReturnBottleTypeIds(
  tx: Prisma.TransactionClient,
): Promise<Set<string>> {
  const products = await tx.product.findMany({
    where: { active: true, packagingKind: PackagingKind.RETURNABLE, bottleTypeId: { not: null } },
    select: { bottleTypeId: true },
  });
  const ids = new Set<string>();
  for (const p of products) {
    if (p.bottleTypeId) ids.add(p.bottleTypeId);
  }
  return ids;
}

export async function assertCompatibleBottleReturns(
  tx: Prisma.TransactionClient,
  returned: Map<string, number>,
): Promise<void> {
  if (!returned.size) return;
  const allowed = await compatibleReturnBottleTypeIds(tx);
  const ids = [...returned.keys()];
  const active = await tx.bottleType.findMany({
    where: { id: { in: ids }, active: true },
    select: { id: true },
  });
  if (active.length !== ids.length) {
    throw new BadRequestException('Invalid or inactive bottle type');
  }
  for (const id of ids) {
    if (!allowed.has(id)) {
      throw new BadRequestException('Bottle type is not used by any returnable product');
    }
  }
}
