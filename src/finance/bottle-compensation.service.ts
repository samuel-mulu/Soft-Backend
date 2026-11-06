import { BadRequestException, Injectable } from '@nestjs/common';
import {
  BottleCompensationStatus,
  BottleReason,
  PaymentMethod,
  PaymentPurpose,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { perDozenTotal } from '../common/pack-quantity';

const zero = () => new Prisma.Decimal(0);

@Injectable()
export class BottleCompensationService {
  constructor(
    private db: PrismaService,
    private inventory: InventoryService,
  ) {}

  async refreshCompensationStatus(tx: Prisma.TransactionClient, compensationId: string) {
    const comp = await tx.bottleCompensation.findUniqueOrThrow({
      where: { id: compensationId },
      include: { payments: true, paymentAllocations: true },
    });
    const direct = comp.payments.reduce((v, p) => v.add(p.amount), zero());
    const viaAlloc = comp.paymentAllocations.reduce((v, p) => v.add(p.amount), zero());
    const paid = direct.add(viaAlloc);
    let status: BottleCompensationStatus = BottleCompensationStatus.OPEN;
    if (paid.gte(comp.totalAmount)) status = BottleCompensationStatus.PAID;
    else if (paid.gt(0)) status = BottleCompensationStatus.PARTIALLY_PAID;
    await tx.bottleCompensation.update({ where: { id: compensationId }, data: { status } });
    return { paid, status };
  }

  async create(
    input: {
      customerId: string;
      bottleTypeId: string;
      quantity: number;
      note?: string;
      idempotencyKey?: string;
      payloadHash?: string;
      payNow?: { amount: string; method?: PaymentMethod };
      userId: string;
    },
  ) {
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }

    return this.db.$transaction(
      async (tx) => {
        if (input.idempotencyKey) {
          const existing = await tx.bottleCompensation.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
            include: { payments: true, bottleMovement: true },
          });
          if (existing) {
            if (
              existing.idempotencyPayloadHash &&
              input.payloadHash &&
              existing.idempotencyPayloadHash !== input.payloadHash
            ) {
              throw new BadRequestException('Idempotency key reused with different payload');
            }
            return existing;
          }
        }

        const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
        if (!customer || customer.status !== 'ACTIVE') {
          throw new BadRequestException('Active customer required');
        }

        const bottleType = await tx.bottleType.findUnique({ where: { id: input.bottleTypeId } });
        if (!bottleType?.active) throw new BadRequestException('Invalid bottle type');
        if (!bottleType.replacementPrice || bottleType.replacementPrice.lte(0)) {
          throw new BadRequestException('Configure replacement price on bottle type first');
        }

        const grouped = await tx.bottleMovement.groupBy({
          by: ['bottleTypeId'],
          where: { customerId: input.customerId, bottleTypeId: input.bottleTypeId },
          _sum: { delta: true },
        });
        const internalOwed = grouped[0]?._sum.delta ?? 0;
        if (internalOwed < input.quantity) {
          throw new BadRequestException(
            'Compensation quantity exceeds customer bottle obligation for this type',
          );
        }

        const unitPrice = bottleType.replacementPrice;
        const totalAmount = perDozenTotal(unitPrice, input.quantity, bottleType.bottlesPerDozen);

        const movement = await tx.bottleMovement.create({
          data: {
            customerId: input.customerId,
            bottleTypeId: input.bottleTypeId,
            delta: -input.quantity,
            reason: BottleReason.COMPENSATION,
            note: input.note?.trim() || 'Bottle replacement compensation',
            createdById: input.userId,
          },
        });

        const compensation = await tx.bottleCompensation.create({
          data: {
            customerId: input.customerId,
            bottleTypeId: input.bottleTypeId,
            quantity: input.quantity,
            unitPrice,
            totalAmount,
            status: BottleCompensationStatus.OPEN,
            idempotencyKey: input.idempotencyKey,
            idempotencyPayloadHash: input.payloadHash,
            note: input.note,
            bottleMovementId: movement.id,
            createdById: input.userId,
          },
          include: { payments: true, bottleMovement: true },
        });

        if (input.payNow) {
          const amt = new Prisma.Decimal(input.payNow.amount);
          if (amt.lte(0)) throw new BadRequestException('Payment amount must be positive');
          if (amt.gt(totalAmount)) throw new BadRequestException('Payment exceeds compensation total');
          await tx.payment.create({
            data: {
              customerId: input.customerId,
              bottleCompensationId: compensation.id,
              purpose: PaymentPurpose.COMPENSATION,
              amount: amt,
              allocatedToCompensation: amt,
              allocatedToSales: zero(),
              method: input.payNow.method ?? PaymentMethod.CASH,
              createdById: input.userId,
            },
          });
          await this.refreshCompensationStatus(tx, compensation.id);
        }

        return tx.bottleCompensation.findUniqueOrThrow({
          where: { id: compensation.id },
          include: { payments: true, bottleMovement: true, bottleType: true },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 45_000,
        maxWait: 15_000,
      },
    );
  }

  async pay(
    compensationId: string,
    input: { amount: string; method?: PaymentMethod; note?: string; userId: string },
  ) {
    const value = new Prisma.Decimal(input.amount);
    if (!value.isFinite() || value.lte(0)) throw new BadRequestException('Amount must be positive');

    return this.db.$transaction(
      async (tx) => {
        const comp = await tx.bottleCompensation.findUniqueOrThrow({
          where: { id: compensationId },
          include: { payments: true, paymentAllocations: true },
        });
        const direct = comp.payments.reduce((v, p) => v.add(p.amount), zero());
        const viaAlloc = comp.paymentAllocations.reduce((v, p) => v.add(p.amount), zero());
        const paid = direct.add(viaAlloc);
        const remaining = comp.totalAmount.sub(paid);
        if (value.gt(remaining)) throw new BadRequestException('Payment exceeds remaining balance');

        await tx.payment.create({
          data: {
            customerId: comp.customerId,
            bottleCompensationId: comp.id,
            purpose: PaymentPurpose.COMPENSATION,
            amount: value,
            allocatedToCompensation: value,
            allocatedToSales: zero(),
            method: input.method ?? PaymentMethod.CASH,
            note: input.note,
            createdById: input.userId,
          },
        });
        await this.refreshCompensationStatus(tx, comp.id);
        return tx.bottleCompensation.findUniqueOrThrow({
          where: { id: comp.id },
          include: { payments: true },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 45_000,
        maxWait: 15_000,
      },
    );
  }
}
