import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const zero = () => new Prisma.Decimal(0);

export type BottleBalanceRow = { bottleTypeId: string; outstanding: number };

@Injectable()
export class CustomerLedgerService {
 constructor(private db: PrismaService) {}

 moneyOutstandingFromTotals(salesTotal: Prisma.Decimal, paymentsTotal: Prisma.Decimal): Prisma.Decimal {
  return salesTotal.sub(paymentsTotal);
 }

 async moneyOutstanding(customerId: string): Promise<Prisma.Decimal> {
  const [sales, payments] = await Promise.all([
   this.db.sale.aggregate({ where: { customerId, status: 'POSTED' }, _sum: { total: true } }),
   this.db.payment.aggregate({ where: { customerId }, _sum: { amount: true } }),
  ]);
  return this.moneyOutstandingFromTotals(sales._sum.total ?? zero(), payments._sum.amount ?? zero());
 }

 bottleBalanceRowsFromGrouped(grouped: { bottleTypeId: string; _sum: { delta: number | null } }[]): BottleBalanceRow[] {
  return grouped
   .map(g => ({ bottleTypeId: g.bottleTypeId, outstanding: g._sum.delta ?? 0 }))
   .filter(x => x.outstanding !== 0);
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
  return new Map(sums.map(s => [s.bottleTypeId, s._sum.delta ?? 0]));
 }

}
