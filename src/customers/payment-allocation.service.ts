import { BadRequestException, Injectable } from '@nestjs/common';
import {
  BottleCompensationStatus,
  PaymentMethod,
  PaymentPurpose,
  Prisma,
} from '@prisma/client';
import { BottleCompensationService } from '../finance/bottle-compensation.service';

const zero = () => new Prisma.Decimal(0);

export type ManualAllocation = {
  bottleCompensationId?: string;
  compensationAmount?: string;
  /** Entire payment applies to drink sales; compensation debt unchanged. */
  salesOnly?: boolean;
};

@Injectable()
export class PaymentAllocationService {
  constructor(private compensationService: BottleCompensationService) {}

  async compensationPaidTotal(
    tx: Prisma.TransactionClient,
    compensationId: string,
  ): Promise<Prisma.Decimal> {
    const [direct, allocated] = await Promise.all([
      tx.payment.aggregate({
        where: { bottleCompensationId: compensationId },
        _sum: { amount: true },
      }),
      tx.paymentCompensationAllocation.aggregate({
        where: { bottleCompensationId: compensationId },
        _sum: { amount: true },
      }),
    ]);
    return (direct._sum.amount ?? zero()).add(allocated._sum.amount ?? zero());
  }

  async openCompensations(tx: Prisma.TransactionClient, customerId: string) {
    const comps = await tx.bottleCompensation.findMany({
      where: {
        customerId,
        status: { in: [BottleCompensationStatus.OPEN, BottleCompensationStatus.PARTIALLY_PAID] },
      },
      orderBy: { createdAt: 'asc' },
      include: { bottleType: { select: { id: true, name: true, capacityLabel: true, replacementPrice: true } } },
    });
    const result = [];
    for (const c of comps) {
      const paid = await this.compensationPaidTotal(tx, c.id);
      result.push({ ...c, remaining: c.totalAmount.sub(paid) });
    }
    return result;
  }

  /** Single payment row; compensation-first FIFO via allocation rows. */
  async applyCustomerPayment(
    tx: Prisma.TransactionClient,
    input: {
      customerId: string;
      amount: Prisma.Decimal;
      method: PaymentMethod;
      note?: string;
      saleId?: string;
      manual?: ManualAllocation;
      userId: string;
    },
  ) {
    const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw new BadRequestException('Customer not found');

    if (input.saleId) {
      const sale = await tx.sale.findUnique({ where: { id: input.saleId } });
      if (!sale || sale.customerId !== input.customerId) {
        throw new BadRequestException('Invoice does not belong to customer');
      }
      const payment = await tx.payment.create({
        data: {
          customerId: input.customerId,
          saleId: input.saleId,
          purpose: PaymentPurpose.SALE,
          amount: input.amount,
          allocatedToSales: input.amount,
          allocatedToCompensation: zero(),
          method: input.method,
          note: input.note,
          createdById: input.userId,
        },
      });
      return payment;
    }

    if (input.manual?.salesOnly) {
      const payment = await tx.payment.create({
        data: {
          customerId: input.customerId,
          purpose: PaymentPurpose.GENERAL,
          amount: input.amount,
          allocatedToCompensation: zero(),
          allocatedToSales: input.amount,
          method: input.method,
          note: input.note,
          createdById: input.userId,
        },
      });
      return payment;
    }

    if (input.manual?.bottleCompensationId) {
      const compId = input.manual.bottleCompensationId;
      const payAmt = input.manual.compensationAmount
        ? new Prisma.Decimal(input.manual.compensationAmount)
        : input.amount;
      if (!payAmt.eq(input.amount)) {
        throw new BadRequestException('Manual compensation amount must equal payment amount');
      }
      const comp = await tx.bottleCompensation.findUniqueOrThrow({ where: { id: compId } });
      const paid = await this.compensationPaidTotal(tx, compId);
      if (payAmt.gt(comp.totalAmount.sub(paid))) {
        throw new BadRequestException('Payment exceeds compensation balance');
      }
      const payment = await tx.payment.create({
        data: {
          customerId: input.customerId,
          bottleCompensationId: compId,
          purpose: PaymentPurpose.COMPENSATION,
          amount: payAmt,
          allocatedToCompensation: payAmt,
          allocatedToSales: zero(),
          method: input.method,
          note: input.note,
          createdById: input.userId,
        },
      });
      await this.compensationService.refreshCompensationStatus(tx, compId);
      return payment;
    }

    let remaining = input.amount;
    const allocations: { bottleCompensationId: string; amount: Prisma.Decimal }[] = [];

    const open = await this.openCompensations(tx, input.customerId);
    for (const comp of open) {
      if (remaining.lte(0)) break;
      if (comp.remaining.lte(0)) continue;
      const apply = Prisma.Decimal.min(remaining, comp.remaining);
      allocations.push({ bottleCompensationId: comp.id, amount: apply });
      remaining = remaining.sub(apply);
    }

    const toComp = input.amount.sub(remaining);
    const toSales = remaining;

    const payment = await tx.payment.create({
      data: {
        customerId: input.customerId,
        purpose: PaymentPurpose.GENERAL,
        amount: input.amount,
        allocatedToCompensation: toComp,
        allocatedToSales: toSales,
        method: input.method,
        note: input.note,
        createdById: input.userId,
        compensationAllocations: {
          create: allocations.map((a) => ({
            bottleCompensationId: a.bottleCompensationId,
            amount: a.amount,
          })),
        },
      },
      include: { compensationAllocations: true },
    });

    for (const a of allocations) {
      await this.compensationService.refreshCompensationStatus(tx, a.bottleCompensationId);
    }

    return payment;
  }
}
