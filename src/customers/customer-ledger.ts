import { Injectable } from '@nestjs/common';
import { BottleCompensationStatus, PaymentPurpose, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentAllocationService } from './payment-allocation.service';

const zero = () => new Prisma.Decimal(0);

export type BottleBalanceRow = { bottleTypeId: string; outstanding: number };

export type MoneyBreakdown = {
  salesTotal: Prisma.Decimal;
  compensationChargesTotal: Prisma.Decimal;
  paymentsTotal: Prisma.Decimal;
  moneyOutstanding: Prisma.Decimal;
  drinkOutstanding: Prisma.Decimal;
  compensationOutstanding: Prisma.Decimal;
  customerCredit: Prisma.Decimal;
};

@Injectable()
export class CustomerLedgerService {
  constructor(
    private db: PrismaService,
    private paymentAllocation: PaymentAllocationService,
  ) {}

  moneyOutstandingFromTotals(
    salesTotal: Prisma.Decimal,
    paymentsTotal: Prisma.Decimal,
    compensationChargesTotal: Prisma.Decimal,
  ): Prisma.Decimal {
    return salesTotal.add(compensationChargesTotal).sub(paymentsTotal);
  }

  async compensationChargesTotal(customerId: string): Promise<Prisma.Decimal> {
    const rows = await this.db.bottleCompensation.findMany({
      where: { customerId },
      select: { totalAmount: true },
    });
    return rows.reduce((v, r) => v.add(r.totalAmount), zero());
  }

  async moneyOutstanding(customerId: string): Promise<Prisma.Decimal> {
    const b = await this.moneyBreakdown(customerId);
    return b.moneyOutstanding;
  }

  async moneyBreakdown(customerId: string): Promise<MoneyBreakdown> {
    const [sales, payments, compensationCharges] = await Promise.all([
      this.db.sale.aggregate({ where: { customerId, status: 'POSTED' }, _sum: { total: true } }),
      this.db.payment.aggregate({ where: { customerId }, _sum: { amount: true } }),
      this.compensationChargesTotal(customerId),
    ]);
    const salesTotal = sales._sum.total ?? zero();
    const paymentsTotal = payments._sum.amount ?? zero();
    const compensationChargesTotal = compensationCharges;
    const moneyOutstanding = this.moneyOutstandingFromTotals(
      salesTotal,
      paymentsTotal,
      compensationChargesTotal,
    );

    const open = await this.db.bottleCompensation.findMany({
      where: {
        customerId,
        status: { in: [BottleCompensationStatus.OPEN, BottleCompensationStatus.PARTIALLY_PAID] },
      },
    });
    let compensationOutstanding = zero();
    for (const c of open) {
      const paid = await this.paymentAllocation.compensationPaidTotal(this.db, c.id);
      const rem = c.totalAmount.sub(paid);
      if (rem.gt(0)) compensationOutstanding = compensationOutstanding.add(rem);
    }

    const payRows = await this.db.payment.findMany({
      where: { customerId },
      select: {
        amount: true,
        purpose: true,
        saleId: true,
        allocatedToSales: true,
        allocatedToCompensation: true,
      },
    });
    let appliedToSales = zero();
    for (const p of payRows) {
      if (p.allocatedToSales != null || p.allocatedToCompensation != null) {
        appliedToSales = appliedToSales.add(p.allocatedToSales ?? zero());
      } else if (p.purpose === PaymentPurpose.SALE || p.saleId) {
        appliedToSales = appliedToSales.add(p.amount);
      } else if (p.purpose !== PaymentPurpose.COMPENSATION) {
        appliedToSales = appliedToSales.add(p.amount);
      }
    }
    const drinkOutstanding = Prisma.Decimal.max(zero(), salesTotal.sub(appliedToSales));
    const customerCredit = moneyOutstanding.lt(0) ? moneyOutstanding.abs() : zero();

    return {
      salesTotal,
      compensationChargesTotal,
      paymentsTotal,
      moneyOutstanding,
      drinkOutstanding,
      compensationOutstanding,
      customerCredit,
    };
  }

  bottleBalanceRowsFromGrouped(
    grouped: { bottleTypeId: string; _sum: { delta: number | null } }[],
  ): BottleBalanceRow[] {
    return grouped
      .map((g) => ({ bottleTypeId: g.bottleTypeId, outstanding: g._sum.delta ?? 0 }))
      .filter((x) => x.outstanding !== 0);
  }

  async bottleBalances(customerId: string): Promise<BottleBalanceRow[]> {
    const grouped = await this.db.bottleMovement.groupBy({
      by: ['bottleTypeId'],
      where: { customerId },
      _sum: { delta: true },
    });
    return this.bottleBalanceRowsFromGrouped(grouped);
  }

  async heldByBottleType(customerId: string, bottleTypeIds: string[]): Promise<Map<string, number>> {
    if (!bottleTypeIds.length) return new Map();
    const sums = await this.db.bottleMovement.groupBy({
      by: ['bottleTypeId'],
      where: { customerId, bottleTypeId: { in: bottleTypeIds } },
      _sum: { delta: true },
    });
    return new Map(sums.map((s) => [s.bottleTypeId, s._sum.delta ?? 0]));
  }
}
