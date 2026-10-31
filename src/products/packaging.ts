import { BadRequestException } from '@nestjs/common';
import { PackagingKind } from '@prisma/client';

export function normalizePackagingKind(kind?: PackagingKind): PackagingKind {
  return kind === PackagingKind.NONE ? PackagingKind.NONE : PackagingKind.RETURNABLE;
}

export function assertProductPackaging(
  packagingKind: PackagingKind,
  bottleTypeId: string | null | undefined,
): void {
  const returnable = packagingKind === PackagingKind.RETURNABLE;
  if (returnable && !bottleTypeId) {
    throw new BadRequestException('Returnable products require a bottle type');
  }
  if (!returnable && bottleTypeId) {
    throw new BadRequestException('Unit-only products cannot have a bottle type');
  }
}
