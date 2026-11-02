import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Role, StockKind, StockReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../common/auth';
import { InventoryService } from './inventory.service';
import { PackQuantityDto, resolveQuantityEach } from './quantity.dto';
import { ledgerTotalsByBottleType } from '../customers/bottle-ledger-metrics';
import { ReceiveFullDto, resolveReceiveQuantities } from './receive-full.dto';
import { StockReceivingService } from './stock-receiving.service';

class AdjustmentDto {
  @IsEnum(StockKind) kind!: StockKind;
  @IsOptional() @IsString() productId?: string;
  @IsOptional() @IsString() bottleTypeId?: string;
  @IsInt() delta!: number;
  @IsString() note!: string;
}

class ReceiveEmptyDto extends PackQuantityDto {
  @IsString() bottleTypeId!: string;
  @IsString() note!: string;
  @IsOptional() @IsString() idempotencyKey?: string;
}

class ConvertDto extends PackQuantityDto {
  @IsString() productId!: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() idempotencyKey?: string;
}

enum BreakageKind {
  EMPTY = 'EMPTY',
  FULL = 'FULL',
  CUSTOMER_BROKEN = 'CUSTOMER_BROKEN',
}

class BreakageDto extends PackQuantityDto {
  @IsEnum(BreakageKind) kind!: BreakageKind;
  @IsString() bottleTypeId!: string;
  @IsOptional() @IsString() productId?: string;
  @IsOptional() @IsString() customerId?: string;
  @IsString() reason!: string;
  @IsOptional() @IsBoolean() waiveBottleLiability?: boolean;
  @IsOptional() @IsString() idempotencyKey?: string;
}

class FullCountDto {
  @IsString() productId!: string;
  @IsInt() @Min(0) quantity!: number;
}

class ReconcileDto {
  @IsString() bottleTypeId!: string;
  @IsInt() @Min(0) countedEmpty!: number;
  @IsInt() @Min(0) countedDamaged!: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => FullCountDto) fullCounts!: FullCountDto[];
  @IsString() note!: string;
  @IsOptional() @IsString() idempotencyKey?: string;
}

@ApiTags('Inventory')
@ApiBearerAuth()
@Roles(Role.OWNER, Role.CASHIER)
@Controller('inventory')
export class InventoryController {
  constructor(
    private db: PrismaService,
    private inventory: InventoryService,
    private stockReceiving: StockReceivingService,
  ) {}

  @Get('empty-bottle-summary')
  async emptyBottleSummary() {
    const [bottleTypes, balances, customerGrouped] = await Promise.all([
      this.db.bottleType.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
      this.db.stockBalance.findMany({
        where: { kind: { in: [StockKind.EMPTY_BOTTLE, StockKind.DAMAGED_BOTTLE] } },
      }),
      this.db.bottleMovement.groupBy({ by: ['bottleTypeId', 'customerId'], _sum: { delta: true } }),
    ]);
    const warehouse = new Map<string, number>();
    const damaged = new Map<string, number>();
    for (const r of balances) {
      if (r.kind === StockKind.EMPTY_BOTTLE) warehouse.set(r.bottleTypeId!, r.quantity);
      if (r.kind === StockKind.DAMAGED_BOTTLE) damaged.set(r.bottleTypeId!, r.quantity);
    }
    const ledger = ledgerTotalsByBottleType(customerGrouped);
    const rows = bottleTypes.map((b) => {
      const l = ledger.get(b.id) ?? { netInternal: 0, obligations: 0, credits: 0 };
      return {
        bottleTypeId: b.id,
        name: b.name,
        warehouse: warehouse.get(b.id) ?? 0,
        damaged: damaged.get(b.id) ?? 0,
        customerLedgerNetInternal: l.netInternal,
        customerObligationsInternal: l.obligations,
        customerCreditsInternal: l.credits,
      };
    });
    return {
      totals: {
        warehouse: rows.reduce((s, r) => s + r.warehouse, 0),
        damaged: rows.reduce((s, r) => s + r.damaged, 0),
      },
      rows,
      disclaimer:
        'Customer ledger figures are accounting obligations, not verified physical bottle counts.',
    };
  }

  /** Read-only physical warehouse totals (empty, full drinks, damaged). */
  @Get('warehouse-summary')
  async warehouseSummary() {
    const [bottleTypes, balances] = await Promise.all([
      this.db.bottleType.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
      this.db.stockBalance.findMany({
        include: { product: { select: { id: true, name: true, bottleTypeId: true, active: true } } },
      }),
    ]);

    const emptyByType = new Map<string, number>();
    const damagedByType = new Map<string, number>();
    const fullByType = new Map<string, number>();
    const fullProducts: {
      productId: string;
      name: string;
      bottleTypeId: string | null;
      quantity: number;
    }[] = [];

    for (const b of balances) {
      if (b.kind === StockKind.EMPTY_BOTTLE && b.bottleTypeId) {
        emptyByType.set(b.bottleTypeId, b.quantity);
      }
      if (b.kind === StockKind.DAMAGED_BOTTLE && b.bottleTypeId) {
        damagedByType.set(b.bottleTypeId, b.quantity);
      }
      if (b.kind === StockKind.FULL_DRINK && b.productId && b.product?.active !== false) {
        fullProducts.push({
          productId: b.productId,
          name: b.product!.name,
          bottleTypeId: b.product!.bottleTypeId,
          quantity: b.quantity,
        });
        if (b.product!.bottleTypeId) {
          fullByType.set(
            b.product!.bottleTypeId,
            (fullByType.get(b.product!.bottleTypeId) ?? 0) + b.quantity,
          );
        }
      }
    }

    fullProducts.sort((a, b) => a.name.localeCompare(b.name));

    const rows = bottleTypes.map((bt) => ({
      bottleTypeId: bt.id,
      name: bt.name,
      capacityLabel: bt.capacityLabel,
      empty: emptyByType.get(bt.id) ?? 0,
      damaged: damagedByType.get(bt.id) ?? 0,
      fullDrinks: fullByType.get(bt.id) ?? 0,
    }));

    const nonReturnableFull = balances
      .filter(
        (b) =>
          b.kind === StockKind.FULL_DRINK &&
          b.product?.active !== false &&
          !b.product?.bottleTypeId,
      )
      .map((b) => ({
        productId: b.productId!,
        name: b.product!.name,
        quantity: b.quantity,
      }));

    const totalEmpty = rows.reduce((s, r) => s + r.empty, 0);
    const totalDamaged = rows.reduce((s, r) => s + r.damaged, 0);
    const totalFull =
      rows.reduce((s, r) => s + r.fullDrinks, 0) +
      nonReturnableFull.reduce((s, p) => s + p.quantity, 0);

    return {
      totals: { empty: totalEmpty, damaged: totalDamaged, fullDrinks: totalFull },
      rows,
      fullProducts,
      nonReturnableFull,
      disclaimer:
        'Physical warehouse stock only. Customer bottle ledger is shown separately under Customers and Bottle returns.',
    };
  }

  @Get('bottle-types/:id/summary')
  async bottleTypeSummary(@Param('id') id: string) {
    const bottleType = await this.db.bottleType.findUnique({ where: { id } });
    if (!bottleType) throw new BadRequestException('Bottle type not found');

    const [products, balances, movements, customerGrouped, compensations] = await Promise.all([
      this.db.product.findMany({
        where: { bottleTypeId: id, active: true },
        orderBy: { name: 'asc' },
      }),
      this.db.stockBalance.findMany({
        where: {
          OR: [
            { kind: StockKind.FULL_DRINK, product: { bottleTypeId: id } },
            { bottleTypeId: id, kind: { in: [StockKind.EMPTY_BOTTLE, StockKind.DAMAGED_BOTTLE] } },
          ],
        },
        include: { product: true },
      }),
      this.db.stockMovement.findMany({
        where: { OR: [{ bottleTypeId: id }, { product: { bottleTypeId: id } }] },
        include: { product: true, inventoryOperation: true },
        orderBy: { createdAt: 'desc' },
        take: 80,
      }),
      this.db.bottleMovement.groupBy({ by: ['customerId'], where: { bottleTypeId: id }, _sum: { delta: true } }),
      this.db.bottleCompensation.findMany({
        where: { bottleTypeId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { customer: true, payments: true },
      }),
    ]);

    const fullByProduct = products.map((p) => {
      const bal = balances.find((b) => b.kind === StockKind.FULL_DRINK && b.productId === p.id);
      return { productId: p.id, name: p.name, quantity: bal?.quantity ?? 0 };
    });
    const empty = balances.find((b) => b.kind === StockKind.EMPTY_BOTTLE)?.quantity ?? 0;
    const damaged = balances.find((b) => b.kind === StockKind.DAMAGED_BOTTLE)?.quantity ?? 0;

    let obligations = 0;
    let credits = 0;
    for (const g of customerGrouped) {
      const d = g._sum.delta ?? 0;
      if (d > 0) obligations += d;
      else if (d < 0) credits += -d;
    }

    const physicalAccounted =
      fullByProduct.reduce((s, x) => s + x.quantity, 0) + empty + damaged + obligations - credits;

    return {
      bottleType,
      fullByProduct,
      emptyWarehouse: empty,
      damagedWarehouse: damaged,
      customerObligationsInternal: obligations,
      customerCreditsInternal: credits,
      physicalAccountedEstimate: physicalAccounted,
      ledgerDisclaimer:
        'Customer obligations/credits come from the bottle ledger, not a physical count at customers.',
      recentMovements: movements,
      recentCompensations: compensations,
    };
  }

  @Get('balances')
  balances() {
    return this.db.stockBalance.findMany({
      include: { product: true, bottleType: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  @Get('movements')
  movements(@Query('kind') kind?: StockKind, @Query('bottleTypeId') bottleTypeId?: string) {
    return this.db.stockMovement.findMany({
      where: {
        ...(kind ? { kind } : {}),
        ...(bottleTypeId
          ? { OR: [{ bottleTypeId }, { product: { bottleTypeId } }] }
          : {}),
      },
      include: { product: true, bottleType: true, inventoryOperation: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Roles(Role.OWNER)
  @Post('adjustments')
  async adjust(@Body() dto: AdjustmentDto, @CurrentUser() user: { id: string }) {
    if (!dto.note.trim()) throw new BadRequestException('Reason is required');
    if (dto.kind === StockKind.DAMAGED_BOTTLE && !dto.bottleTypeId) {
      throw new BadRequestException('bottleTypeId required');
    }
    return this.db.$transaction(async (tx) => {
      await this.inventory.change(tx, {
        ...dto,
        userId: user.id,
        reason: dto.delta > 0 ? StockReason.ADJUSTMENT_IN : StockReason.ADJUSTMENT_OUT,
      });
      return { success: true };
    });
  }

  @Roles(Role.OWNER)
  @Post('receive-full')
  async receiveFull(@Body() dto: ReceiveFullDto, @CurrentUser() user: { id: string }) {
    const { fromExistingEmpties, withSupplierBottles } = resolveReceiveQuantities(dto);
    const payloadHash = dto.idempotencyKey
      ? this.inventory.payloadHash({ ...dto, fromExistingEmpties, withSupplierBottles })
      : undefined;

    return this.db.$transaction(
      async (tx) => {
        const result = await this.stockReceiving.receiveFull(tx, {
          productId: dto.productId,
          mode: dto.mode,
          fromExistingEmpties,
          withSupplierBottles,
          supplierId: dto.supplierId,
          unitCost: dto.unitCost,
          reference: dto.reference,
          note: dto.note,
          receivedAt: dto.receivedAt,
          idempotencyKey: dto.idempotencyKey,
          payloadHash,
          userId: user.id,
        });
        return {
          mode: dto.mode,
          operationId: result.operation.id,
          purchaseId: result.purchaseId,
          fromExistingEmpties: result.fromExisting,
          withSupplierBottles: result.withSupplier,
          totalFull: result.totalFull,
        };
      },
      { timeout: 45000, maxWait: 15000 },
    );
  }

  @Roles(Role.OWNER)
  @Post('receive-empty')
  async receiveEmpty(@Body() dto: ReceiveEmptyDto, @CurrentUser() user: { id: string }) {
    const quantity = resolveQuantityEach(dto);
    if (!dto.note.trim()) throw new BadRequestException('Reason is required');
    const payloadHash = dto.idempotencyKey ? this.inventory.payloadHash({ ...dto, quantity }) : undefined;
    return this.db.$transaction(async (tx) => {
      const op = await this.inventory.receiveEmpty(tx, {
        bottleTypeId: dto.bottleTypeId,
        quantity,
        note: dto.note.trim(),
        idempotencyKey: dto.idempotencyKey,
        payloadHash,
        userId: user.id,
      });
      return { operationId: op.id, quantity };
    });
  }

  @Roles(Role.OWNER)
  @Post('convert-empties-to-full')
  async convert(@Body() dto: ConvertDto, @CurrentUser() user: { id: string }) {
    const quantity = resolveQuantityEach(dto);
    const payloadHash = dto.idempotencyKey ? this.inventory.payloadHash({ ...dto, quantity }) : undefined;
    return this.db.$transaction(
      async (tx) => {
        const result = await this.stockReceiving.receiveFull(tx, {
          productId: dto.productId,
          mode: 'FROM_EXISTING_EMPTIES',
          fromExistingEmpties: quantity,
          withSupplierBottles: 0,
          note: dto.note,
          idempotencyKey: dto.idempotencyKey,
          payloadHash,
          userId: user.id,
        });
        return { operationId: result.operation.id, quantity };
      },
      { timeout: 30000, maxWait: 15000 },
    );
  }

  @Roles(Role.OWNER, Role.CASHIER)
  @Post('breakage')
  async breakage(@Body() dto: BreakageDto, @CurrentUser() user: { id: string; role: Role }) {
    const quantity = resolveQuantityEach(dto);
    if (!dto.reason.trim()) throw new BadRequestException('Reason is required');
    if (dto.waiveBottleLiability && user.role !== Role.OWNER) {
      throw new BadRequestException('Owner approval required to waive bottle liability');
    }
    if (dto.waiveBottleLiability && dto.kind !== BreakageKind.CUSTOMER_BROKEN) {
      throw new BadRequestException('Waive applies only to customer broken returns');
    }
    const payloadHash = dto.idempotencyKey ? this.inventory.payloadHash({ ...dto, quantity }) : undefined;
    return this.db.$transaction(async (tx) => {
      const op = await this.inventory.recordBreakage(tx, {
        kind: dto.kind,
        bottleTypeId: dto.bottleTypeId,
        productId: dto.productId,
        customerId: dto.customerId,
        quantity,
        note: dto.reason.trim(),
        waiveBottleLiability: dto.waiveBottleLiability,
        idempotencyKey: dto.idempotencyKey,
        payloadHash,
        userId: user.id,
      });
      return { operationId: op.id, quantity };
    });
  }

  @Roles(Role.OWNER)
  @Post('reconcile')
  async reconcile(@Body() dto: ReconcileDto, @CurrentUser() user: { id: string }) {
    if (!dto.note.trim()) throw new BadRequestException('Reason is required');
    const payloadHash = dto.idempotencyKey ? this.inventory.payloadHash(dto) : undefined;
    return this.db.$transaction(async (tx) => {
      const op = await this.inventory.reconcilePhysical(tx, {
        bottleTypeId: dto.bottleTypeId,
        countedEmpty: dto.countedEmpty,
        countedDamaged: dto.countedDamaged,
        fullCounts: dto.fullCounts,
        note: dto.note.trim(),
        idempotencyKey: dto.idempotencyKey,
        payloadHash,
        userId: user.id,
      });
      return {
        operationId: op.id,
        disclaimer: 'Reconciliation adjusts warehouse records only; customer bottle ledger is unchanged.',
      };
    });
  }
}
