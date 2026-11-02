import { BadRequestException } from '@nestjs/common';
import { IsInt, IsOptional, Min } from 'class-validator';
import { toEach } from '../common/pack-quantity';

export class PackQuantityDto {
  /** Legacy API: plain each count (still supported). */
  @IsOptional() @IsInt() @Min(1) quantity?: number;
  @IsOptional() @IsInt() @Min(0) each?: number;
  @IsOptional() @IsInt() @Min(0) dozen?: number;
}

export function resolveQuantityEach(dto: PackQuantityDto, field = 'quantity'): number {
  if (dto.quantity !== undefined && dto.quantity > 0) {
    if (!Number.isSafeInteger(dto.quantity)) throw new BadRequestException(`Invalid ${field}`);
    return dto.quantity;
  }
  const each = dto.each ?? 0;
  const dozen = dto.dozen ?? 0;
  if (each === 0 && dozen === 0) {
    throw new BadRequestException(`${field} must be greater than zero`);
  }
  try {
    const total = toEach({ dozen, each, unitsPerDozen: 12 });
    if (total <= 0 || !Number.isSafeInteger(total)) {
      throw new BadRequestException(`Invalid ${field}`);
    }
    return total;
  } catch {
    throw new BadRequestException(`Invalid ${field} (use whole dozens and units)`);
  }
}
