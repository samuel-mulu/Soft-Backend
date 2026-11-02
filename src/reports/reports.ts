import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PaymentMethod, PaymentPurpose, Prisma, Role, StockKind, StockReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../common/auth';
import { ledgerTotalsByBottleType } from '../customers/bottle-ledger-metrics';

const zero = () => new Prisma.Decimal(0);

function dates(from?: string, to?: string) {
  const start = from
    ? new Date(`${from}T00:00:00.000Z`)
    : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const end = to ? new Date(`${to}T23:59:59.999Z`) : new Date();
  if (isNaN(+start) || isNaN(+end) || start > end) {
    throw new BadRequestException('Invalid date range; use YYYY-MM-DD');
  }
  return { gte: start, lte: end };
}

function parsePaymentMethod(method?: string): PaymentMethod | undefined {
  if (!method || method.toUpperCase() === 'ALL') return undefined;
  const m = method.toUpperCase();
  if (m === 'CASH' || m === 'BANK' || m === 'MOBILE' || m === 'OTHER') return m as PaymentMethod;
  throw new BadRequestException('Invalid method; use CASH, BANK, MOBILE, or OTHER');
}

@ApiTags('Reports')
@ApiBearerAuth()
@Roles(Role.OWNER)
@Controller('reports')
export class ReportsController {
  constructor(private db: PrismaService) {}

  @Get('summary')
  async summary(@Query('from') from?: string, @Query('to') to?: string, @Query('method') method?: string) {
    const range = dates(from, to);
    const payMethod = parsePaymentMethod(method);
    const paymentWhere: Prisma.PaymentWhereInput = {
      createdAt: range,
      ...(payMethod ? { method: payMethod } : {}),
    };
    const [sales, receipts, expenses, items, compInPeriod] = await Promise.all([
      this.db.sale.aggregate({
        where: { createdAt: range, status: 'POSTED' },
        _sum: { total: true, discount: true },
        _count: true,
      }),
      this.db.payment.aggregate({ where: paymentWhere, _sum: { amount: true } }),
      this.db.expense.aggregate({ where: { createdAt: range }, _sum: { amount: true } }),
      this.db.saleItem.findMany({
        where: { sale: { createdAt: range, status: 'POSTED' } },
        select: { quantity: true, unitCost: true },
      }),
      this.db.bottleCompensation.aggregate({
        where: { createdAt: range },
        _sum: { totalAmount: true },
        _count: true,
      }),
    ]);
    const [bottles, allSales, allPayments, allComp] = await Promise.all([
      this.db.bottleMovement.groupBy({ by: ['bottleTypeId'], _sum: { delta: true } }),
      this.db.sale.aggregate({ where: { status: 'POSTED' }, _sum: { total: true } }),
      this.db.payment.aggregate({ _sum: { amount: true } }),
      this.db.bottleCompensation.aggregate({ _sum: { totalAmount: true } }),
    ]);
    const revenue = sales._sum.total || zero();
    const cost = items.reduce((v, x) => v.add(x.unitCost.mul(x.quantity)), zero());
    const expenseTotal = expenses._sum.amount || zero();
    const cashIn = receipts._sum.amount || zero();
    const cashOut = expenseTotal;
    const customerReceivables = (allSales._sum.total || zero())
      .add(allComp._sum.totalAmount || zero())
      .sub(allPayments._sum.amount || zero());

    return {
      period: { from: range.gte, to: range.lte },
      paymentMethod: payMethod ?? null,
      salesCount: sales._count,
      salesRevenue: revenue,
      bottleCompensationCharges: compInPeriod._sum.totalAmount || zero(),
      bottleCompensationCount: compInPeriod._count,
      discounts: sales._sum.discount || zero(),
      cashReceived: cashIn,
      expenses: expenseTotal,
      cashFlow: cashIn.sub(cashOut),
      costOfGoodsSold: cost,
      grossProfit: revenue.sub(cost),
      estimatedNetProfit: revenue.sub(cost).sub(expenseTotal),
      customerReceivables,
      customerBottleLedgerNet: bottles.map((x) => ({
        bottleTypeId: x.bottleTypeId,
        netInternal: x._sum.delta || 0,
      })),
      ledgerDisclaimer: 'customerBottleLedgerNet is signed ledger accounting, not verified physical counts',
    };
  }

  @Get('warehouse')
  async warehouse() {
    const [balances, customerGrouped, comps] = await Promise.all([
      this.db.stockBalance.findMany({ include: { product: true, bottleType: true } }),
      this.db.bottleMovement.groupBy({
        by: ['bottleTypeId', 'customerId'],
        _sum: { delta: true },
      }),
      this.db.bottleCompensation.findMany({
        select: { id: true, totalAmount: true, status: true, bottleTypeId: true },
      }),
    ]);
    const ledger = ledgerTotalsByBottleType(customerGrouped);
    const compByType = new Map<string, { charges: Prisma.Decimal; open: number }>();
    for (const c of comps) {
      const cur = compByType.get(c.bottleTypeId) ?? {
        charges: zero(),
        open: 0,
      };
      cur.charges = cur.charges.add(c.totalAmount);
      if (c.status !== 'PAID') cur.open++;
      compByType.set(c.bottleTypeId, cur);
    }
    return {
      balances,
      byBottleType: [...ledger.entries()].map(([bottleTypeId, l]) => ({
        bottleTypeId,
        customerObligationsInternal: l.obligations,
        customerCreditsInternal: l.credits,
        customerLedgerNetInternal: l.netInternal,
        compensation: compByType.get(bottleTypeId) ?? { charges: '0', open: 0 },
      })),
      movementsByReason: await this.db.stockMovement.groupBy({
        by: ['reason'],
        _count: true,
      }),
      disclaimer:
        'Warehouse balances are physical stock records. Customer ledger fields are obligations/credits, not physical custody.',
    };
  }

  @Get('customers')
  async customers() {
    const rows = await this.db.customer.findMany({
      select: {
        id: true,
        name: true,
        phone: true,
        status: true,
        sales: { where: { status: 'POSTED' }, select: { total: true } },
        payments: { select: { amount: true } },
        bottleCompensations: { select: { totalAmount: true } },
        bottleMovements: { select: { bottleTypeId: true, delta: true } },
      },
    });
    return rows.map((x) => {
      const debt = x.sales
        .reduce((v, s) => v.add(s.total), zero())
        .add(x.bottleCompensations.reduce((v, c) => v.add(c.totalAmount), zero()))
        .sub(x.payments.reduce((v, p) => v.add(p.amount), zero()));
      const bottles: Record<string, number> = {};
      for (const b of x.bottleMovements) {
        bottles[b.bottleTypeId] = (bottles[b.bottleTypeId] || 0) + b.delta;
      }
      return { id: x.id, name: x.name, phone: x.phone, status: x.status, debt, bottles };
    });
  }

  @Get('stock')
  stock() {
    return this.db.stockBalance.findMany({ include: { product: true, bottleType: true } });
  }

  @Get('daily')
  async daily(@Query('from') from?: string, @Query('to') to?: string) {
    const range = dates(from, to);
    const sales = await this.db.sale.findMany({
      where: { createdAt: range, status: 'POSTED' },
      select: { createdAt: true, total: true },
    });
    const payments = await this.db.payment.findMany({
      where: { createdAt: range },
      select: { createdAt: true, amount: true },
    });
    const byDay: Record<string, { date: string; sales: string; received: string; count: number }> = {};
    for (const s of sales) {
      const d = s.createdAt.toISOString().slice(0, 10);
      byDay[d] ??= { date: d, sales: '0', received: '0', count: 0 };
      byDay[d].sales = new Prisma.Decimal(byDay[d].sales).add(s.total).toString();
      byDay[d].count++;
    }
    for (const p of payments) {
      const d = p.createdAt.toISOString().slice(0, 10);
      byDay[d] ??= { date: d, sales: '0', received: '0', count: 0 };
      byDay[d].received = new Prisma.Decimal(byDay[d].received).add(p.amount).toString();
    }
    return Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
  }

  @Get('activity')
  async activity(@Query('from') from?: string, @Query('to') to?: string, @Query('method') method?: string) {
    const range = dates(from, to);
    const payMethod = parsePaymentMethod(method);
    const paymentWhere: Prisma.PaymentWhereInput = {
      createdAt: range,
      ...(payMethod ? { method: payMethod } : {}),
    };
    const [payments, movements, sales] = await Promise.all([
      this.db.payment.findMany({
        where: paymentWhere,
        include: { customer: true, sale: true, bottleCompensation: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.db.bottleMovement.findMany({
        where: { createdAt: range },
        include: { customer: true, bottleType: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.db.sale.findMany({
        where: { createdAt: range, status: 'POSTED' },
        include: { customer: true, payments: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    type Line = {
      id: string;
      at: string;
      date: string;
      customerName: string;
      kind: 'payment' | 'credit' | 'bottle';
      label: string;
      paymentMethod: string | null;
      received: string | null;
      credited: string | null;
      bottleDelta: number | null;
      bottleTypeName: string | null;
    };
    const lines: Line[] = [];
    let totalReceived = zero(),
      totalCredited = zero(),
      bottlesOut = 0,
      bottlesIn = 0;
    for (const p of payments) {
      totalReceived = totalReceived.add(p.amount);
      const d = p.createdAt.toISOString();
      const label =
        p.purpose === PaymentPurpose.COMPENSATION
          ? `Bottle compensation · ${p.method}`
          : p.saleId
            ? `Payment · ${p.method}`
            : `Balance payment · ${p.method}`;
      lines.push({
        id: `pay-${p.id}`,
        at: d,
        date: d.slice(0, 10),
        customerName: p.customer?.name || '—',
        kind: 'payment',
        label,
        paymentMethod: p.method,
        received: p.amount.toString(),
        credited: null,
        bottleDelta: null,
        bottleTypeName: null,
      });
    }
    for (const s of sales) {
      const paid = s.payments.reduce((v, x) => v.add(x.amount), zero());
      const credit = s.total.sub(paid);
      if (credit.gt(0)) {
        totalCredited = totalCredited.add(credit);
        const d = s.createdAt.toISOString();
        lines.push({
          id: `cred-${s.id}`,
          at: d,
          date: d.slice(0, 10),
          customerName: s.customer?.name || s.guestName || 'Walk-in',
          kind: 'credit',
          label: `Sale credit · ${String(s.invoiceNo).slice(0, 18)}`,
          paymentMethod: null,
          received: null,
          credited: credit.toString(),
          bottleDelta: null,
          bottleTypeName: null,
        });
      }
    }
    for (const b of movements) {
      const d = b.createdAt.toISOString();
      const delta = b.delta;
      if (delta > 0) bottlesOut += delta;
      else if (delta < 0) bottlesIn += -delta;
      const label =
        b.reason === 'RETURN'
          ? 'Bottle return'
          : b.reason === 'SALE'
            ? 'Bottles with customer'
            : b.reason === 'COMPENSATION'
              ? 'Bottle compensation (ledger)'
              : 'Bottle adjustment';
      lines.push({
        id: `bot-${b.id}`,
        at: d,
        date: d.slice(0, 10),
        customerName: b.customer.name,
        kind: 'bottle',
        label,
        paymentMethod: null,
        bottleDelta: delta,
        bottleTypeName: b.bottleType.name,
        received: null,
        credited: null,
      });
    }
    lines.sort((a, b) => b.at.localeCompare(a.at));
    return {
      totals: {
        received: totalReceived.toString(),
        credited: totalCredited.toString(),
        bottlesOut,
        bottlesIn,
      },
      paymentMethod: payMethod ?? null,
      lines,
    };
  }
}
