import { BadRequestException } from '@nestjs/common';
import { IsOptional } from 'class-validator';
import { IsHalfDozenBottles, IsHalfDozenStep, dozenToBottles } from '../common/pack-quantity';

/** Quantity by the dozen. `quantity` (bottles) is still accepted but must be a multiple of 6. */
export class PackQuantityDto {
  /** Bottle count (legacy). Must be a multiple of 6. */
  @IsOptional() @IsHalfDozenBottles() quantity?: number;
  /** Dozen count in 0.5 steps (preferred). */
  @IsOptional() @IsHalfDozenStep() dozen?: number;
}

/** Resolves a PackQuantityDto to a stored bottle count (always a multiple of 6). */
export function resolveQuantityEach(dto: PackQuantityDto, field = 'quantity'): number {
  if (dto.quantity !== undefined && dto.quantity > 0) {
    if (!Number.isSafeInteger(dto.quantity) || dto.quantity % 6 !== 0) {
      throw new BadRequestException(`${field} must be in half-dozen steps (multiples of 6 bottles)`);
    }
    return dto.quantity;
  }
  const dozen = dto.dozen ?? 0;
  if (dozen <= 0) {
    throw new BadRequestException(`${field} must be greater than zero`);
  }
  try {
    return dozenToBottles(dozen, field);
  } catch (e) {
    throw new BadRequestException((e as Error).message);
  }
}
