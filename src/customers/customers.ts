import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  IsNumberString,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BottleReason, CustomerStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerLedgerService } from './customer-ledger';
import { PaymentAllocationService } from './payment-allocation.service';
import { CurrentUser, Roles } from '../common/auth';
import { normalizeEtPhone } from '../common/phone';
import {
  CUSTOMER_OPENING_NOTE,
  createOpeningBottleMovements,
  parseOpeningMoney,
  type OpeningBottleInput,
  type OpeningDirection,
} from './customer-opening';

class OpeningBottleDto {
  @IsString() bottleTypeId!: string;
  @IsNumber() quantityDozen!: number;
  @IsIn(['OWES', 'CREDIT']) direction!: OpeningDirection;
}

class CustomerDto {
  @IsString() name!: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() notes?: string;
  /** Owner-only: migrate balances from manual books on first digital registration. */
  @IsOptional() @IsBoolean() initialRegistration?: boolean;
  @IsOptional() @IsNumberString() openingMoneyAmount?: string;
  @IsOptional() @IsIn(['OWES', 'CREDIT']) openingMoneyDirection?: OpeningDirection;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OpeningBottleDto)
  openingBottles?: OpeningBottleDto[];
}

class UpdateCustomerDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsEnum(CustomerStatus) status?: CustomerStatus;
}

function wantsInitialRegistration(dto: CustomerDto): boolean {
  if (dto.initialRegistration === true) return true;
  if (dto.openingMoneyAmount != null && String(dto.openingMoneyAmount).trim() !== '') return true;
  if (dto.openingBottles?.length) return true;
  return false;
}

@ApiTags('Customers')
@ApiBearerAuth()
@Roles(Role.OWNER, Role.CASHIER)
@Controller('customers')
export class CustomersController {
  constructor(
    private db: PrismaService,
    private ledger: CustomerLedgerService,
    private paymentAllocation: PaymentAllocationService,
  ) {}

  @Get() async list(@Query('search') search?: string) {
    const customers = await this.db.customer.findMany({
      where: search
        ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { phone: { contains: search } }] }
        : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const [grouped, salesByCustomer, paymentsByCustomer, compByCustomer] = await Promise.all([
      this.db.bottleMovement.groupBy({ by: ['customerId', 'bottleTypeId'], _sum: { delta: true } }),
      this.db.sale.groupBy({ by: ['customerId'], where: { customerId: { not: null } }, _sum: { total: true } }),
      this.db.payment.groupBy({
        by: ['customerId'],
        where: { customerId: { not: null } },
        _sum: { amount: true },
      }),
      this.db.bottleCompensation.groupBy({ by: ['customerId'], _sum: { totalAmount: true } }),
    ]);
    const byCustomer = new Map<string, { bottleTypeId: string; outstanding: number }[]>();
    for (const g of grouped) {
      for (const row of this.ledger.bottleBalanceRowsFromGrouped([
        { bottleTypeId: g.bottleTypeId, _sum: { delta: g._sum.delta } },
      ])) {
        const list = byCustomer.get(g.customerId) || [];
        list.push(row);
        byCustomer.set(g.customerId, list);
      }
    }
    const salesMap = new Map(
      salesByCustomer.map((s) => [s.customerId!, s._sum.total ?? new Prisma.Decimal(0)]),
    );
    const payMap = new Map(
      paymentsByCustomer.map((p) => [p.customerId!, p._sum.amount ?? new Prisma.Decimal(0)]),
    );
    const compMap = new Map(
      compByCustomer.map((c) => [c.customerId, c._sum.totalAmount ?? new Prisma.Decimal(0)]),
    );
    return customers.map((c) => {
      const moneyOutstanding = this.ledger.moneyOutstandingFromTotals(
        salesMap.get(c.id) ?? new Prisma.Decimal(0),
        payMap.get(c.id) ?? new Prisma.Decimal(0),
        compMap.get(c.id) ?? new Prisma.Decimal(0),
        c.openingMoney ?? new Prisma.Decimal(0),
      );
      return { ...c, bottleBalances: byCustomer.get(c.id) || [], moneyOutstanding };
    });
  }

  @Post()
  create(@Body() dto: CustomerDto, @CurrentUser() user: { id: string; role: Role }) {
    const phone = dto.phone ? normalizeEtPhone(dto.phone) : null;
    if (dto.phone?.trim() && !phone) {
      throw new BadRequestException('Phone must start with 09 or 10 and be 10 digits');
    }
    if (!dto.name?.trim()) throw new BadRequestException('Name is required');

    const initial = wantsInitialRegistration(dto);
    if (initial && user.role !== Role.OWNER) {
      throw new ForbiddenException('Only the owner can set initial registration balances');
    }

    if (!initial) {
      return this.db.customer.create({
        data: {
          name: dto.name.trim(),
          phone: phone ?? undefined,
          address: dto.address,
          notes: dto.notes,
        },
      });
    }

    const openingMoney = parseOpeningMoney(dto.openingMoneyAmount, dto.openingMoneyDirection);
    const bottles = (dto.openingBottles || []) as OpeningBottleInput[];

    return this.db.$transaction(
      async (tx) => {
        const customer = await tx.customer.create({
          data: {
            name: dto.name.trim(),
            phone: phone ?? undefined,
            address: dto.address,
            notes: dto.notes,
            openingMoney,
          },
        });
        await createOpeningBottleMovements(tx, {
          customerId: customer.id,
          bottles,
          userId: user.id,
        });
        return customer;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  @Get(':id') get(@Param('id') id: string) {
    return this.db.customer.findUniqueOrThrow({ where: { id } });
  }

  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    const data = { ...dto } as UpdateCustomerDto;
    if (dto.phone !== undefined) {
      if (!dto.phone?.trim()) data.phone = undefined;
      else {
        const phone = normalizeEtPhone(dto.phone);
        if (!phone) throw new BadRequestException('Phone must start with 09 or 10 and be 10 digits');
        data.phone = phone;
      }
    }
    return this.db.customer.update({ where: { id }, data });
  }

  @Get(':id/history') async history(@Param('id') id: string) {
    const customer = await this.db.customer.findUniqueOrThrow({ where: { id } });
    const [sales, payments, bottles, moneyBreakdown, bottleBalances, compensations, openCompensations] =
      await Promise.all([
        this.db.sale.findMany({
          where: { customerId: id },
          include: { items: true, payments: true },
          orderBy: { createdAt: 'desc' },
        }),
        this.db.payment.findMany({
          where: { customerId: id },
          orderBy: { createdAt: 'desc' },
          include: {
            compensationAllocations: true,
            bottleCompensation: { include: { bottleType: true } },
          },
        }),
        this.db.bottleMovement.findMany({
          where: { customerId: id },
          include: { bottleType: true },
          orderBy: { createdAt: 'desc' },
        }),
        this.ledger.moneyBreakdown(id),
        this.ledger.bottleBalances(id),
        this.db.bottleCompensation.findMany({
          where: { customerId: id },
          include: { bottleType: true },
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
        this.paymentAllocation.openCompensations(this.db, id),
      ]);
    const openWithType = openCompensations.map((c) => ({
      ...c,
      remaining: c.remaining.toString(),
      totalAmount: c.totalAmount.toString(),
      unitPrice: c.unitPrice.toString(),
    }));
    return {
      customer,
      sales,
      payments,
      bottles,
      moneyBreakdown,
      moneyOutstanding: moneyBreakdown.moneyOutstanding,
      bottleBalances,
      compensations,
      openCompensations: openWithType,
      openingNote: CUSTOMER_OPENING_NOTE,
      hasOpeningBottles: bottles.some(
        (b) => b.reason === BottleReason.ADJUSTMENT && b.note === CUSTOMER_OPENING_NOTE,
      ),
    };
  }
}
