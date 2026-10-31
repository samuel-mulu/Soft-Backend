import { createHash, randomUUID } from 'crypto';
import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsEnum, IsInt, IsNumberString, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { BottleReason, PackagingKind, PaymentMethod, Prisma, Role, StockKind, StockReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory';
import { CustomerLedgerService } from '../customers/customer-ledger';
import { CurrentUser, Roles } from '../common/auth';
import { withDatabaseRetries } from '../common/db-errors';
import { assertCompatibleBottleReturns } from './bottle-returns';

const D = (n: string) => {
  const v = new Prisma.Decimal(n);
  if (!v.isFinite() || v.isNegative()) throw new BadRequestException('Invalid amount');
  return v;
};

class SaleLine {
  @IsString() productId!: string;
  @IsInt() @Min(1) quantity!: number;
  @IsOptional() @IsNumberString() unitPrice?: string;
}
class BottleLine {
  @IsString() bottleTypeId!: string;
  @IsInt() @Min(1) quantity!: number;
}
class PaymentPartDto {
  @IsNumberString() amount!: string;
  @IsEnum(PaymentMethod) method!: PaymentMethod;
}
class SaleDto {
  @IsOptional() @IsString() idempotencyKey?: string;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() guestName?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => SaleLine) items!: SaleLine[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BottleLine) bottlesReturned?: BottleLine[];
  @IsOptional() @IsNumberString() discount?: string;
  @IsOptional() @IsNumberString() payment?: string;
  @IsOptional() @IsEnum(PaymentMethod) paymentMethod?: PaymentMethod;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PaymentPartDto) paymentParts?: PaymentPartDto[];
  @IsOptional() @IsString() note?: string;
}

function salePayloadHash(dto: SaleDto): string {
  const canonical = {
    customerId: dto.customerId ?? null,
    guestName: dto.guestName ?? null,
    items: [...dto.items].sort((a, b) => a.productId.localeCompare(b.productId)),
    bottlesReturned: [...(dto.bottlesReturned ?? [])].sort((a, b) =>
      a.bottleTypeId.localeCompare(b.bottleTypeId),
    ),
    discount: dto.discount ?? '0',
    payment: dto.payment ?? '0',
    paymentMethod: dto.paymentMethod ?? null,
    note: dto.note ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

@ApiTags('Sales') @ApiBearerAuth() @Roles(Role.OWNER, Role.CASHIER) @Controller('sales')
export class SalesController {
  constructor(
    private db: PrismaService,
    private inventory: InventoryService,
    private ledger: CustomerLedgerService,
  ) {}

  @Get() list(@Query('customerId') customerId?: string) {
    return this.db.sale.findMany({
      where: customerId ? { customerId } : {},
      include: { items: { include: { product: true } }, payments: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Get(':id') get(@Param('id') id: string) {
    return this.db.sale.findUniqueOrThrow({
      where: { id },
      include: {
        items: { include: { product: true } },
        payments: true,
        bottleMovements: true,
        customer: true,
      },
    });
  }

  @Post() async create(@Body() dto: SaleDto, @CurrentUser() user: { id: string }) {
    if (new Set(dto.items.map((x) => x.productId)).size !== dto.items.length) {
      throw new BadRequestException('Combine duplicate product lines');
    }
    if (
      new Set((dto.bottlesReturned || []).map((x) => x.bottleTypeId)).size !==
      (dto.bottlesReturned || []).length
    ) {
      throw new BadRequestException('Combine duplicate bottle types');
    }

    const payloadHash = dto.idempotencyKey ? salePayloadHash(dto) : null;

    if (dto.idempotencyKey) {
      const existing = await this.db.sale.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
        include: { items: true, payments: true, bottleMovements: true },
      });
      if (existing) {
        if (existing.idempotencyPayloadHash && existing.idempotencyPayloadHash !== payloadHash) {
          throw new BadRequestException('Idempotency key reused with different sale payload');
        }
        return existing;
      }
    }

    return withDatabaseRetries(
      () =>
        this.db.$transaction(
          async (tx) => {
            if (dto.idempotencyKey) {
              const again = await tx.sale.findUnique({
                where: { idempotencyKey: dto.idempotencyKey },
                include: { items: true, payments: true, bottleMovements: true },
              });
              if (again) return again;
            }

            const customer = dto.customerId
              ? await tx.customer.findUnique({ where: { id: dto.customerId } })
              : null;
            if (dto.customerId && customer?.status !== 'ACTIVE') {
              throw new BadRequestException('Active customer required');
            }
            const products = await tx.product.findMany({
              where: { id: { in: dto.items.map((x) => x.productId) }, active: true },
            });
            if (products.length !== dto.items.length) {
              throw new BadRequestException('Invalid product');
            }
            const byId = new Map(products.map((x) => [x.id, x]));
            const lines = dto.items.map((x) => {
              const p = byId.get(x.productId)!;
              const unitPrice = x.unitPrice !== undefined ? D(x.unitPrice) : p.sellingPrice;
              return {
                productId: p.id,
                quantity: x.quantity,
                unitPrice,
                unitCost: p.defaultCost,
                lineTotal: unitPrice.mul(x.quantity),
                packagingKind: p.packagingKind,
                bottleTypeId: p.bottleTypeId,
              };
            });
            const subtotal = lines.reduce((v, x) => v.add(x.lineTotal), new Prisma.Decimal(0));
            const discount = D(dto.discount || '0');
            if (discount.gt(subtotal)) throw new BadRequestException('Discount exceeds subtotal');
            const total = subtotal.sub(discount);
            const payment = D(dto.payment || '0');
            if (!dto.customerId && payment.gt(total)) {
              throw new BadRequestException('Payment exceeds sale total');
            }
            if (
              !dto.customerId &&
              (payment.lt(total) || (dto.bottlesReturned || []).length > 0)
            ) {
              throw new BadRequestException(
                'Registered customer required for credit or bottle ledger',
              );
            }

            const issued = new Map<string, number>();
            for (const x of lines) {
              if (x.packagingKind !== PackagingKind.RETURNABLE || !x.bottleTypeId) continue;
              issued.set(x.bottleTypeId, (issued.get(x.bottleTypeId) || 0) + x.quantity);
            }
            const returned = new Map<string, number>();
            for (const x of dto.bottlesReturned || []) {
              returned.set(x.bottleTypeId, x.quantity);
            }
            if (returned.size && dto.customerId) {
              await assertCompatibleBottleReturns(tx, returned);
            }

            const sale = await tx.sale.create({
              data: {
                invoiceNo: `INV-${randomUUID()}`,
                idempotencyKey: dto.idempotencyKey ?? undefined,
                idempotencyPayloadHash: payloadHash ?? undefined,
                customerId: dto.customerId,
                guestName: dto.guestName,
                createdById: user.id,
                subtotal,
                discount,
                total,
                note: dto.note,
                items: {
                  create: lines.map(({ bottleTypeId, packagingKind, ...x }) => x),
                },
              },
            });

            for (const line of lines) {
              await this.inventory.change(tx, {
                kind: StockKind.FULL_DRINK,
                productId: line.productId,
                delta: -line.quantity,
                reason: StockReason.SALE,
                saleId: sale.id,
                userId: user.id,
              });
            }
            if (dto.customerId) {
              for (const [bottleTypeId, quantity] of issued) {
                await tx.bottleMovement.create({
                  data: {
                    customerId: dto.customerId,
                    bottleTypeId,
                    delta: quantity,
                    reason: BottleReason.SALE,
                    saleId: sale.id,
                    createdById: user.id,
                  },
                });
              }
              for (const [bottleTypeId, quantity] of returned) {
                await tx.bottleMovement.create({
                  data: {
                    customerId: dto.customerId,
                    bottleTypeId,
                    delta: -quantity,
                    reason: BottleReason.RETURN,
                    saleId: sale.id,
                    createdById: user.id,
                  },
                });
                await this.inventory.change(tx, {
                  kind: StockKind.EMPTY_BOTTLE,
                  bottleTypeId,
                  delta: quantity,
                  reason: StockReason.BOTTLE_RETURN,
                  saleId: sale.id,
                  userId: user.id,
                });
              }
            }
            if (dto.paymentParts?.length) {
              let partsTotal = new Prisma.Decimal(0);
              for (const part of dto.paymentParts) {
                const amt = D(part.amount);
                if (amt.lte(0)) continue;
                partsTotal = partsTotal.add(amt);
                await tx.payment.create({
                  data: {
                    saleId: sale.id,
                    customerId: dto.customerId,
                    amount: amt,
                    method: part.method,
                    createdById: user.id,
                  },
                });
              }
              if (!partsTotal.eq(payment)) {
                throw new BadRequestException('Payment total must match split payments');
              }
            } else if (payment.gt(0)) {
              await tx.payment.create({
                data: {
                  saleId: sale.id,
                  customerId: dto.customerId,
                  amount: payment,
                  method: dto.paymentMethod || PaymentMethod.CASH,
                  createdById: user.id,
                },
              });
            }
            return tx.sale.findUniqueOrThrow({
              where: { id: sale.id },
              include: { items: true, payments: true, bottleMovements: true },
            });
          },
          { maxWait: 15000, timeout: 45000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
        ),
    );
  }
}
