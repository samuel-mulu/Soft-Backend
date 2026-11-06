import { BadRequestException } from '@nestjs/common';
import { IsInt, IsOptional, Min } from 'class-validator';
import { IsHalfDozenStep, assertPackStep, dozenToBottles } from '../common/pack-quantity';

/**
 * Quantity by the dozen. `quantity` is a bottle count; `dozen` is converted with the
 * dozen size of the product / bottle type. Either way the result must be a half-dozen step.
 */
export class PackQuantityDto {
  /** Bottle count. Must be a half-dozen step for the item's dozen size. */
  @IsOptional() @IsInt() @Min(1) quantity?: number;
  /** Dozen count in 0.5 steps (converted with the item's dozen size). */
  @IsOptional() @IsHalfDozenStep() dozen?: number;
}

/** Resolves a PackQuantityDto to a stored bottle count for a dozen of `size` bottles. */
export function resolveQuantityEach(dto: PackQuantityDto, size: number, field = 'quantity'): number {
  let bottles: number;
  if (dto.quantity !== undefined && dto.quantity > 0) {
    bottles = dto.quantity;
  } else {
    const dozen = dto.dozen ?? 0;
    if (dozen <= 0) {
      throw new BadRequestException(`${field} must be greater than zero`);
    }
    try {
      bottles = dozenToBottles(dozen, size, field);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }
  return assertPackStep(bottles, size, field);
}
