import { IsEnum, IsNumberString, IsOptional, IsString, ValidateIf, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PackQuantityDto, resolveQuantityEach } from './quantity.dto';

export enum ReceiveFullMode {
  FROM_EXISTING_EMPTIES = 'FROM_EXISTING_EMPTIES',
  WITH_BOTTLES = 'WITH_BOTTLES',
  MIXED_SOURCE = 'MIXED_SOURCE',
}

export class SourcePackDto extends PackQuantityDto {}

/** Root-level dozen/quantity supported via PackQuantityDto fields on this class. Unit cost is per dozen. */
export class ReceiveFullDto extends PackQuantityDto {
  @IsString() productId!: string;
  @IsEnum(ReceiveFullMode) mode!: ReceiveFullMode;

  @IsOptional() @ValidateNested() @Type(() => SourcePackDto) fromExisting?: SourcePackDto;
  @IsOptional() @ValidateNested() @Type(() => SourcePackDto) withSupplier?: SourcePackDto;

  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsNumberString() unitCost?: string;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() receivedAt?: string;
  @IsOptional() @IsString() idempotencyKey?: string;
}

export function resolveReceiveQuantities(dto: ReceiveFullDto): {
  fromExistingEmpties: number;
  withSupplierBottles: number;
} {
  if (dto.mode === ReceiveFullMode.MIXED_SOURCE) {
    const fromExistingEmpties = dto.fromExisting ? resolveQuantityEach(dto.fromExisting) : 0;
    const withSupplierBottles = dto.withSupplier ? resolveQuantityEach(dto.withSupplier) : 0;
    return { fromExistingEmpties, withSupplierBottles };
  }
  const q = resolveQuantityEach(dto);
  if (dto.mode === ReceiveFullMode.FROM_EXISTING_EMPTIES) {
    return { fromExistingEmpties: q, withSupplierBottles: 0 };
  }
  return { fromExistingEmpties: 0, withSupplierBottles: q };
}
