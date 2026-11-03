import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsNumberString, IsOptional, IsString, Min, ValidateIf } from 'class-validator';
import { PackagingKind, Prisma, Role, StockKind, StockReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory';
import { StockReceivingService } from '../inventory/stock-receiving.service';
import { CurrentUser, Roles } from '../common/auth';
import { assertProductPackaging, normalizePackagingKind } from './packaging';

function formatStockNote(defaultNote: string, stockNote?: string, supplierName?: string) {
  const parts: string[] = [];
  const note = stockNote?.trim();
  if (note) parts.push(note);
  else parts.push(defaultNote);
  const supplier = supplierName?.trim();
  if (supplier) parts.push(`Supplier: ${supplier}`);
  return parts.join(' · ');
}

class ProductDto {
  @IsString() name!: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsEnum(PackagingKind) packagingKind?: PackagingKind;
  @ValidateIf((o) => normalizePackagingKind(o.packagingKind) === PackagingKind.RETURNABLE && !o.bottleName)
  @IsString()
  bottleTypeId?: string;
  @ValidateIf((o) => normalizePackagingKind(o.packagingKind) === PackagingKind.RETURNABLE && !o.bottleTypeId)
  @IsString()
  bottleName?: string;
  @IsNumberString() sellingPrice!: string;
  @IsNumberString() defaultCost!: string;
  @IsInt() @Min(1) unitsPerCase!: number;
  @IsOptional() @IsInt() @Min(0) initialQuantity?: number;
  /** When set with returnable product, fill from warehouse empties instead of supplier/adjustment. */
  @IsOptional() @IsInt() @Min(0) initialFromExistingEmpties?: number;
  @IsOptional() @IsString() initialSupplierId?: string;
  @IsOptional() @IsNumberString() initialUnitCost?: string;
  @IsOptional() @IsBoolean() syncEmptyBottleStock?: boolean;
  @IsOptional() @IsString() supplierName?: string;
  @IsOptional() @IsString() stockNote?: string;
}

class UpdateProductDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsEnum(PackagingKind) packagingKind?: PackagingKind;
  @IsOptional() @IsString() bottleTypeId?: string;
  @IsOptional() @IsNumberString() sellingPrice?: string;
  @IsOptional() @IsNumberString() defaultCost?: string;
  @IsOptional() @IsInt() @Min(1) unitsPerCase?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() addStock?: number;
  /** Supplier-bottled full drinks added on edit. Same meaning as create. */
  @IsOptional() @IsInt() @Min(0) initialQuantity?: number;
  /** Full drinks filled from warehouse empties on edit. Same meaning as create. */
  @IsOptional() @IsInt() @Min(0) initialFromExistingEmpties?: number;
  @IsOptional() @IsString() initialSupplierId?: string;
  @IsOptional() @IsNumberString() initialUnitCost?: string;
  @IsOptional() @IsString() stockNote?: string;
  @IsOptional() @IsBoolean() syncEmptyBottleStock?: boolean;
  @IsOptional() @IsString() supplierName?: string;
}

@ApiTags('Products') @ApiBearerAuth() @Roles(Role.OWNER, Role.CASHIER) @Controller('products')
export class ProductsController {
  constructor(
    private db: PrismaService,
    private inventory: InventoryService,
    private stockReceiving: StockReceivingService,
  ) {}

  @Get()
  async list(@Query('search') search?: string) {
    const [products, balances] = await Promise.all([
      this.db.product.findMany({
        where: search ? { name: { contains: search, mode: 'insensitive' } } : {},
        include: { bottleType: true },
        orderBy: { name: 'asc' },
      }),
      this.db.stockBalance.findMany({ where: { kind: StockKind.FULL_DRINK } }),
    ]);
    const stock = new Map(balances.map((b) => [b.productId, b.quantity]));
    return products.map((p) => ({ ...p, stock: stock.get(p.id) ?? 0 }));
  }

  private txOptions = { timeout: 45_000, maxWait: 15_000 };

  /** Same three receive modes as product create: empties, supplier bottles, or both. */
  private async applyFullReceive(
    tx: Prisma.TransactionClient,
    input: {
      productId: string;
      bottleTypeId: string | null;
      fromExisting: number;
      withSupplier: number;
      supplierId?: string;
      unitCost?: string;
      note: string;
      userId: string;
      syncEmptyBottleStock?: boolean;
      syncReason: StockReason;
    },
  ) {
    if (input.fromExisting > 0 || input.withSupplier > 0) {
      const mode =
        input.fromExisting > 0 && input.withSupplier > 0
          ? 'MIXED_SOURCE'
          : input.fromExisting > 0
            ? 'FROM_EXISTING_EMPTIES'
            : 'WITH_BOTTLES';
      await this.stockReceiving.receiveFull(tx, {
        productId: input.productId,
        mode,
        fromExistingEmpties: input.fromExisting,
        withSupplierBottles: input.withSupplier,
        supplierId: input.supplierId || undefined,
        unitCost: input.unitCost || undefined,
        note: input.note,
        userId: input.userId,
      });
    }
    if (input.syncEmptyBottleStock && input.bottleTypeId && input.withSupplier > 0) {
      await this.inventory.change(tx, {
        kind: StockKind.EMPTY_BOTTLE,
        bottleTypeId: input.bottleTypeId,
        delta: input.withSupplier,
        reason: input.syncReason,
        note: `Synced from product stock · ${input.note}`,
        userId: input.userId,
      });
    }
  }

  @Roles(Role.OWNER) @Post()
  async create(@Body() dto: ProductDto, @CurrentUser() user: { id: string }) {
    const packagingKind = normalizePackagingKind(dto.packagingKind);
    if (packagingKind === PackagingKind.NONE) {
      if (dto.bottleTypeId || dto.bottleName?.trim()) {
        throw new BadRequestException('Unit-only products cannot specify bottle packaging');
      }
      if (dto.syncEmptyBottleStock) {
        throw new BadRequestException('Empty bottle stock sync applies only to returnable products');
      }
    }

    const product = await this.db.$transaction(async (tx) => {
      let bottleTypeId: string | null = null;
      if (packagingKind === PackagingKind.RETURNABLE) {
        bottleTypeId = dto.bottleTypeId ?? null;
        if (!bottleTypeId) {
          const name = dto.bottleName?.trim();
          if (!name) throw new BadRequestException('Choose a bottle type or enter a new bottle name');
          const bottle = await tx.bottleType.create({ data: { name } });
          bottleTypeId = bottle.id;
        }
      }
      assertProductPackaging(packagingKind, bottleTypeId);

      const created = await tx.product.create({
        data: {
          name: dto.name,
          sku: dto.sku,
          packagingKind,
          bottleTypeId,
          sellingPrice: dto.sellingPrice,
          defaultCost: dto.defaultCost,
          unitsPerCase: dto.unitsPerCase,
        },
        include: { bottleType: true },
      });
      const fromExisting = dto.initialFromExistingEmpties ?? 0;
      const withSupplier = dto.initialQuantity ?? 0;
      const note = formatStockNote('Initial stock', dto.stockNote, dto.supplierName);
      await this.applyFullReceive(tx, {
        productId: created.id,
        bottleTypeId,
        fromExisting,
        withSupplier,
        supplierId: dto.initialSupplierId,
        unitCost: dto.initialUnitCost,
        note,
        userId: user.id,
        syncEmptyBottleStock: dto.syncEmptyBottleStock,
        syncReason: StockReason.OPENING,
      });
      return created;
    }, this.txOptions);
    const balance = await this.db.stockBalance.findUnique({
      where: { kind_productId: { kind: StockKind.FULL_DRINK, productId: product.id } },
    });
    return { ...product, stock: balance?.quantity ?? 0 };
  }

  @Roles(Role.OWNER) @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateProductDto, @CurrentUser() user: { id: string }) {
    const fromExisting = dto.initialFromExistingEmpties ?? 0;
    const withSupplier = dto.initialQuantity ?? 0;
    const receiving = fromExisting > 0 || withSupplier > 0;
    if (receiving && dto.addStock !== undefined && dto.addStock !== 0) {
      throw new BadRequestException('Send a receive or a stock adjustment, not both');
    }

    const product = await this.db.$transaction(async (tx) => {
      const existing = await tx.product.findUniqueOrThrow({ where: { id } });
      const {
        addStock,
        stockNote,
        syncEmptyBottleStock,
        supplierName,
        packagingKind,
        bottleTypeId,
        initialQuantity: _initialQuantity,
        initialFromExistingEmpties: _initialFromExistingEmpties,
        initialSupplierId,
        initialUnitCost,
        ...rest
      } = dto;
      void _initialQuantity;
      void _initialFromExistingEmpties;

      const nextKind = packagingKind !== undefined ? normalizePackagingKind(packagingKind) : existing.packagingKind;
      let nextBottleTypeId = existing.bottleTypeId;
      if (packagingKind !== undefined || bottleTypeId !== undefined) {
        if (nextKind === PackagingKind.NONE) {
          nextBottleTypeId = null;
        } else {
          nextBottleTypeId = bottleTypeId ?? existing.bottleTypeId;
          if (!nextBottleTypeId) {
            throw new BadRequestException('Returnable products require a bottle type');
          }
        }
      }
      assertProductPackaging(nextKind, nextBottleTypeId);

      if (syncEmptyBottleStock && nextKind === PackagingKind.NONE) {
        throw new BadRequestException('Empty bottle stock sync applies only to returnable products');
      }

      const updated = await tx.product.update({
        where: { id },
        data: {
          ...rest,
          ...(packagingKind !== undefined ? { packagingKind: nextKind } : {}),
          ...(packagingKind !== undefined || bottleTypeId !== undefined
            ? { bottleTypeId: nextBottleTypeId }
            : {}),
        },
        include: { bottleType: true },
      });
      const note = formatStockNote('Stock update', stockNote, supplierName);
      if (receiving) {
        if (updated.packagingKind !== PackagingKind.RETURNABLE || !updated.bottleTypeId) {
          throw new BadRequestException('Receive modes apply only to returnable products with a bottle type');
        }
        await this.applyFullReceive(tx, {
          productId: id,
          bottleTypeId: updated.bottleTypeId,
          fromExisting,
          withSupplier,
          supplierId: initialSupplierId,
          unitCost: initialUnitCost,
          note,
          userId: user.id,
          syncEmptyBottleStock,
          syncReason: StockReason.ADJUSTMENT_IN,
        });
      } else if (addStock !== undefined && addStock !== 0) {
        await this.inventory.change(tx, {
          kind: StockKind.FULL_DRINK,
          productId: id,
          delta: addStock,
          reason: addStock > 0 ? StockReason.ADJUSTMENT_IN : StockReason.ADJUSTMENT_OUT,
          note,
          userId: user.id,
        });
        if (syncEmptyBottleStock && updated.bottleTypeId) {
          await this.inventory.change(tx, {
            kind: StockKind.EMPTY_BOTTLE,
            bottleTypeId: updated.bottleTypeId,
            delta: addStock,
            reason: addStock > 0 ? StockReason.ADJUSTMENT_IN : StockReason.ADJUSTMENT_OUT,
            note: `Synced from product stock · ${note}`,
            userId: user.id,
          });
        }
      }
      return updated;
    }, this.txOptions);
    const balance = await this.db.stockBalance.findUnique({
      where: { kind_productId: { kind: StockKind.FULL_DRINK, productId: id } },
    });
    return { ...product, stock: balance?.quantity ?? 0 };
  }
}
