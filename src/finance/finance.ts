import { createHash } from 'crypto';
import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsIn, IsInt, IsNumberString, IsOptional, IsString } from 'class-validator';
import { BottleReason, PaymentMethod, PaymentPurpose, Prisma, Role, StockKind, StockReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { CurrentUser, Roles } from '../common/auth';
import { assertCompatibleBottleReturns } from '../sales/bottle-returns';
import { BottleCompensationService } from './bottle-compensation.service';
import { PaymentAllocationService } from '../customers/payment-allocation.service';
import { PackQuantityDto, resolveQuantityEach } from '../inventory/quantity.dto';
import { bottleTypePackSize } from '../common/pack-size';

const amount = (v: string) => {
  const n = new Prisma.Decimal(v);
  if (!n.isFinite() || n.lte(0)) throw new BadRequestException('Amount must be positive');
  return n;
};

class PaymentDto {
  @IsString() customerId!: string;
  @IsOptional() @IsString() saleId?: string;
  @IsNumberString() amount!: string;
  @IsOptional() @IsEnum(PaymentMethod) method?: PaymentMethod;
  @IsOptional() @IsString() note?: string;
  /** Pay this compensation only (amount must match payment). */
  @IsOptional() @IsString() bottleCompensationId?: string;
  /** AUTO = compensation FIFO then sales; COMPENSATION = requires bottleCompensationId; SALES = drink debt only. */
  @IsOptional() @IsIn(['AUTO', 'COMPENSATION', 'SALES']) allocationMode?: 'AUTO' | 'COMPENSATION' | 'SALES';
}

class ReturnDto extends PackQuantityDto {
  @IsString() customerId!: string;
  @IsString() bottleTypeId!: string;
  @IsOptional() @IsString() note?: string;
}

class CorrectionDto extends ReturnDto {
  @IsString() reason!: string;
}

class CompensationDto extends PackQuantityDto {
  @IsString() customerId!: string;
  @IsString() bottleTypeId!: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() idempotencyKey?: string;
  @IsOptional() @IsNumberString() payNowAmount?: string;
  @IsOptional() @IsEnum(PaymentMethod) payNowMethod?: PaymentMethod;
}

class CompensationPayDto {
  @IsNumberString() amount!: string;
  @IsOptional() @IsEnum(PaymentMethod) method?: PaymentMethod;
  @IsOptional() @IsString() note?: string;
}

class ExpenseDto {
  @IsString() category!: string;
  @IsString() description!: string;
  @IsNumberString() amount!: string;
  @IsOptional() @IsEnum(PaymentMethod) method?: PaymentMethod;
}

class SupplierPayDto {
  @IsString() purchaseId!: string;
  @IsNumberString() amount!: string;
  @IsOptional() @IsEnum(PaymentMethod) method?: PaymentMethod;
  @IsOptional() @IsString() note?: string;
}

@ApiTags('Customer payments')
@ApiBearerAuth()
@Roles(Role.OWNER, Role.CASHIER)
@Controller('payments')
export class PaymentsController {
  constructor(
    private db: PrismaService,
    private paymentAllocation: PaymentAllocationService,
  ) {}

  @Get() list(@Query('customerId') customerId?: string) {
    return this.db.payment.findMany({
      where: customerId ? { customerId } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Post() async pay(@Body() dto: PaymentDto, @CurrentUser() user: { id: string }) {
    const value = amount(dto.amount);
    const mode = dto.allocationMode ?? (dto.bottleCompensationId ? 'COMPENSATION' : 'AUTO');
    if (mode === 'COMPENSATION' && !dto.bottleCompensationId) {
      throw new BadRequestException('Select a compensation record for this payment');
    }
    if (mode === 'COMPENSATION' && dto.saleId) {
      throw new BadRequestException('Invoice payment cannot target a compensation');
    }
    let manual: { bottleCompensationId?: string; compensationAmount?: string; salesOnly?: boolean } | undefined;
    if (mode === 'COMPENSATION') {
      manual = { bottleCompensationId: dto.bottleCompensationId, compensationAmount: dto.amount };
    } else if (mode === 'SALES') {
      manual = { salesOnly: true };
    }
    return this.db.$transaction(
      async (tx) =>
        this.paymentAllocation.applyCustomerPayment(tx, {
          customerId: dto.customerId,
          amount: value,
          method: dto.method || PaymentMethod.CASH,
          note: dto.note,
          saleId: dto.saleId,
          manual,
          userId: user.id,
        }),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 45_000,
        maxWait: 15_000,
      },
    );
  }
}

@ApiTags('Bottle ledger')
@ApiBearerAuth()
@Roles(Role.OWNER, Role.CASHIER)
@Controller('customer-bottles')
export class CustomerBottlesController {
  constructor(
    private db: PrismaService,
    private inventory: InventoryService,
    private compensation: BottleCompensationService,
  ) {}

  @Get(':customerId') async ledger(@Param('customerId') customerId: string) {
    const movements = await this.db.bottleMovement.findMany({
      where: { customerId },
      include: { bottleType: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const totals = await this.db.bottleMovement.groupBy({
      by: ['bottleTypeId'],
      where: { customerId },
      _sum: { delta: true },
    });
    return {
      totals: totals.map((x) => ({ bottleTypeId: x.bottleTypeId, outstanding: x._sum.delta || 0 })),
      movements,
    };
  }

  @Post('returns') async returnBottles(@Body() dto: ReturnDto, @CurrentUser() user: { id: string }) {
    const quantity = resolveQuantityEach(dto, await bottleTypePackSize(this.db, dto.bottleTypeId));
    return this.db.$transaction(
      async (tx) => {
        const customer = await tx.customer.findUnique({ where: { id: dto.customerId } });
        const bt = await tx.bottleType.findUnique({ where: { id: dto.bottleTypeId } });
        if (!customer || !bt || !bt.active) throw new BadRequestException('Invalid customer or bottle type');
        const returned = new Map([[dto.bottleTypeId, quantity]]);
        await assertCompatibleBottleReturns(tx, returned);
        const entry = await tx.bottleMovement.create({
          data: {
            customerId: dto.customerId,
            bottleTypeId: dto.bottleTypeId,
            delta: -quantity,
            reason: BottleReason.RETURN,
            note: dto.note,
            createdById: user.id,
          },
        });
        await this.inventory.change(tx, {
          kind: StockKind.EMPTY_BOTTLE,
          bottleTypeId: dto.bottleTypeId,
          delta: quantity,
          reason: StockReason.BOTTLE_RETURN,
          userId: user.id,
        });
        return entry;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  @Roles(Role.OWNER)
  @Post('corrections')
  async correct(@Body() dto: CorrectionDto, @CurrentUser() user: { id: string }) {
    const quantity = resolveQuantityEach(dto, await bottleTypePackSize(this.db, dto.bottleTypeId));
    if (!dto.reason?.trim()) throw new BadRequestException('Reason required');
    return this.db.$transaction(
      async (tx) => {
        const bt = await tx.bottleType.findUnique({ where: { id: dto.bottleTypeId } });
        if (!bt) throw new BadRequestException('Invalid bottle type');
        return tx.bottleMovement.create({
          data: {
            customerId: dto.customerId,
            bottleTypeId: dto.bottleTypeId,
            delta: quantity,
            reason: BottleReason.ADJUSTMENT,
            note: dto.reason,
            createdById: user.id,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  @Post('compensations') async compensate(@Body() dto: CompensationDto, @CurrentUser() user: { id: string }) {
    const quantity = resolveQuantityEach(dto, await bottleTypePackSize(this.db, dto.bottleTypeId));
    const payloadHash = dto.idempotencyKey
      ? createHashPayload({ ...dto, quantity })
      : undefined;
    return this.compensation.create({
      customerId: dto.customerId,
      bottleTypeId: dto.bottleTypeId,
      quantity,
      note: dto.note,
      idempotencyKey: dto.idempotencyKey,
      payloadHash,
      payNow: dto.payNowAmount
        ? { amount: dto.payNowAmount, method: dto.payNowMethod }
        : undefined,
      userId: user.id,
    });
  }

  @Post('compensations/:id/payments') async payCompensation(
    @Param('id') id: string,
    @Body() dto: CompensationPayDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.compensation.pay(id, {
      amount: dto.amount,
      method: dto.method,
      note: dto.note,
      userId: user.id,
    });
  }
}

function createHashPayload(payload: unknown) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

@ApiTags('Expenses')
@ApiBearerAuth()
@Roles(Role.OWNER, Role.CASHIER)
@Controller('expenses')
export class ExpensesController {
  constructor(private db: PrismaService) {}

  @Get() list() {
    return this.db.expense.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  }

  @Post() create(@Body() dto: ExpenseDto, @CurrentUser() user: { id: string }) {
    return this.db.expense.create({
      data: {
        ...dto,
        amount: amount(dto.amount),
        method: dto.method || PaymentMethod.CASH,
        createdById: user.id,
      },
    });
  }
}

@ApiTags('Supplier payments')
@ApiBearerAuth()
@Controller('purchase-payments')
export class PurchasePaymentsController {
  constructor(private db: PrismaService) {}

  @Get() list() {
    return this.db.purchasePayment.findMany({
      include: { supplier: true, purchase: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Post() pay(@Body() dto: SupplierPayDto, @CurrentUser() user: { id: string }) {
    return this.db.$transaction(
      async (tx) => {
        const purchase = await tx.purchase.findUnique({ where: { id: dto.purchaseId } });
        if (!purchase) throw new BadRequestException('Purchase not found');
        const previous = await tx.purchasePayment.aggregate({
          where: { purchaseId: purchase.id },
          _sum: { amount: true },
        });
        const value = amount(dto.amount);
        if (value.gt(purchase.total.sub(previous._sum.amount || new Prisma.Decimal(0)))) {
          throw new BadRequestException('Payment exceeds purchase balance');
        }
        return tx.purchasePayment.create({
          data: {
            purchaseId: purchase.id,
            supplierId: purchase.supplierId,
            amount: value,
            method: dto.method || PaymentMethod.CASH,
            note: dto.note,
            createdById: user.id,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
