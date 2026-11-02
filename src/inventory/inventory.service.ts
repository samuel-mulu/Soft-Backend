import { BadRequestException, Injectable } from '@nestjs/common';
import {
  BottleReason,
  InventoryOperationKind,
  Prisma,
  StockKind,
  StockReason,
} from '@prisma/client';
import { createHash } from 'crypto';

export type StockChangeInput = {
  kind: StockKind;
  productId?: string;
  bottleTypeId?: string;
  delta: number;
  reason: StockReason;
  note?: string;
  purchaseId?: string;
  saleId?: string;
  inventoryOperationId?: string;
  userId: string;
};

@Injectable()
export class InventoryService {
  async change(tx: Prisma.TransactionClient, input: StockChangeInput): Promise<void> {
    const {
      kind,
      productId,
      bottleTypeId,
      delta,
      reason,
      note,
      purchaseId,
      saleId,
      inventoryOperationId,
      userId,
    } = input;
    if (!Number.isSafeInteger(delta) || delta === 0) {
      throw new BadRequestException('Nonzero integer stock change required');
    }
    const isFull = kind === StockKind.FULL_DRINK;
    const isBottleKind = kind === StockKind.EMPTY_BOTTLE || kind === StockKind.DAMAGED_BOTTLE;
    if (isFull !== !!productId || isBottleKind !== !!bottleTypeId) {
      throw new BadRequestException('Stock target does not match kind');
    }
    const where = productId
      ? { kind_productId: { kind, productId } }
      : { kind_bottleTypeId: { kind, bottleTypeId: bottleTypeId! } };
    const row = await tx.stockBalance.upsert({
      where: where as any,
      create: { kind, productId, bottleTypeId, quantity: 0 },
      update: {},
    });
    const updated = await tx.stockBalance.updateMany({
      where: { id: row.id, quantity: { gte: -delta } },
      data: { quantity: { increment: delta } },
    });
    if (updated.count !== 1) {
      let detail = 'Not enough stock for this product.';
      if (productId) {
        const p = await tx.product.findUnique({ where: { id: productId }, select: { name: true } });
        if (p?.name) detail = `Not enough stock for “${p.name}”.`;
      } else if (bottleTypeId) {
        const b = await tx.bottleType.findUnique({ where: { id: bottleTypeId }, select: { name: true } });
        if (b?.name) {
          detail =
            kind === StockKind.EMPTY_BOTTLE
              ? `Not enough empty bottles in warehouse for “${b.name}”.`
              : `Not enough stock for “${b.name}”.`;
        }
      }
      throw new BadRequestException(detail);
    }
    await tx.stockMovement.create({
      data: {
        kind,
        productId,
        bottleTypeId,
        delta,
        reason,
        note,
        purchaseId,
        saleId,
        inventoryOperationId,
        createdById: userId,
      },
    });
  }

  payloadHash(payload: unknown): string {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  async findIdempotentOperation(
    tx: Prisma.TransactionClient,
    idempotencyKey: string | undefined,
    payloadHash: string | null,
  ) {
    if (!idempotencyKey) return null;
    const op = await tx.inventoryOperation.findUnique({ where: { idempotencyKey } });
    if (!op) return null;
    if (op.idempotencyPayloadHash && payloadHash && op.idempotencyPayloadHash !== payloadHash) {
      throw new BadRequestException('Idempotency key reused with different payload');
    }
    return op;
  }

  async createOperation(
    tx: Prisma.TransactionClient,
    data: {
      kind: InventoryOperationKind;
      idempotencyKey?: string;
      idempotencyPayloadHash?: string;
      note?: string;
      bottleTypeId?: string;
      productId?: string;
      userId: string;
    },
  ) {
    return tx.inventoryOperation.create({
      data: {
        kind: data.kind,
        idempotencyKey: data.idempotencyKey,
        idempotencyPayloadHash: data.idempotencyPayloadHash,
        note: data.note,
        bottleTypeId: data.bottleTypeId,
        productId: data.productId,
        createdById: data.userId,
      },
    });
  }

  async convertEmptiesToFull(
    tx: Prisma.TransactionClient,
    input: {
      productId: string;
      quantity: number;
      note?: string;
      idempotencyKey?: string;
      payloadHash?: string;
      userId: string;
    },
  ) {
    const existing = await this.findIdempotentOperation(tx, input.idempotencyKey, input.payloadHash ?? null);
    if (existing) return existing;

    const product = await tx.product.findUnique({ where: { id: input.productId } });
    if (!product?.bottleTypeId) throw new BadRequestException('Product has no bottle type');

    const op = await this.createOperation(tx, {
      kind: InventoryOperationKind.CONVERT_EMPTIES,
      idempotencyKey: input.idempotencyKey,
      idempotencyPayloadHash: input.payloadHash,
      note: input.note,
      bottleTypeId: product.bottleTypeId,
      productId: product.id,
      userId: input.userId,
    });

    const note = input.note?.trim() || 'Empty bottles converted to full stock';
    await this.change(tx, {
      kind: StockKind.EMPTY_BOTTLE,
      bottleTypeId: product.bottleTypeId,
      delta: -input.quantity,
      reason: StockReason.EMPTY_TO_FULL,
      inventoryOperationId: op.id,
      note,
      userId: input.userId,
    });
    await this.change(tx, {
      kind: StockKind.FULL_DRINK,
      productId: product.id,
      delta: input.quantity,
      reason: StockReason.EMPTY_TO_FULL,
      inventoryOperationId: op.id,
      note,
      userId: input.userId,
    });
    return op;
  }

  async receiveEmpty(
    tx: Prisma.TransactionClient,
    input: {
      bottleTypeId: string;
      quantity: number;
      note: string;
      idempotencyKey?: string;
      payloadHash?: string;
      userId: string;
    },
  ) {
    const existing = await this.findIdempotentOperation(tx, input.idempotencyKey, input.payloadHash ?? null);
    if (existing) return existing;

    const bt = await tx.bottleType.findUnique({ where: { id: input.bottleTypeId } });
    if (!bt?.active) throw new BadRequestException('Invalid bottle type');

    const op = await this.createOperation(tx, {
      kind: InventoryOperationKind.RECEIVE_EMPTY,
      idempotencyKey: input.idempotencyKey,
      idempotencyPayloadHash: input.payloadHash,
      note: input.note,
      bottleTypeId: input.bottleTypeId,
      userId: input.userId,
    });

    await this.change(tx, {
      kind: StockKind.EMPTY_BOTTLE,
      bottleTypeId: input.bottleTypeId,
      delta: input.quantity,
      reason: StockReason.ADJUSTMENT_IN,
      inventoryOperationId: op.id,
      note: input.note,
      userId: input.userId,
    });
    return op;
  }

  async recordBreakage(
    tx: Prisma.TransactionClient,
    input: {
      kind: 'EMPTY' | 'FULL' | 'CUSTOMER_BROKEN';
      bottleTypeId: string;
      productId?: string;
      customerId?: string;
      quantity: number;
      note: string;
      waiveBottleLiability?: boolean;
      idempotencyKey?: string;
      payloadHash?: string;
      userId: string;
    },
  ) {
    const existing = await this.findIdempotentOperation(tx, input.idempotencyKey, input.payloadHash ?? null);
    if (existing) return existing;

    const op = await this.createOperation(tx, {
      kind: InventoryOperationKind.BREAKAGE,
      idempotencyKey: input.idempotencyKey,
      idempotencyPayloadHash: input.payloadHash,
      note: input.note,
      bottleTypeId: input.bottleTypeId,
      productId: input.productId,
      userId: input.userId,
    });

    if (input.kind === 'EMPTY') {
      await this.change(tx, {
        kind: StockKind.EMPTY_BOTTLE,
        bottleTypeId: input.bottleTypeId,
        delta: -input.quantity,
        reason: StockReason.WAREHOUSE_BREAKAGE,
        inventoryOperationId: op.id,
        note: input.note,
        userId: input.userId,
      });
      await this.change(tx, {
        kind: StockKind.DAMAGED_BOTTLE,
        bottleTypeId: input.bottleTypeId,
        delta: input.quantity,
        reason: StockReason.WAREHOUSE_BREAKAGE,
        inventoryOperationId: op.id,
        note: input.note,
        userId: input.userId,
      });
    } else if (input.kind === 'FULL') {
      if (!input.productId) throw new BadRequestException('productId required for full breakage');
      await this.change(tx, {
        kind: StockKind.FULL_DRINK,
        productId: input.productId,
        delta: -input.quantity,
        reason: StockReason.WAREHOUSE_BREAKAGE,
        inventoryOperationId: op.id,
        note: input.note,
        userId: input.userId,
      });
      await this.change(tx, {
        kind: StockKind.DAMAGED_BOTTLE,
        bottleTypeId: input.bottleTypeId,
        delta: input.quantity,
        reason: StockReason.WAREHOUSE_BREAKAGE,
        inventoryOperationId: op.id,
        note: input.note,
        userId: input.userId,
      });
    } else {
      if (!input.customerId) throw new BadRequestException('customerId required for customer broken intake');
      const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
      if (!customer) throw new BadRequestException('Invalid customer');
      // Physical damaged intake only — does not reduce customer bottle obligation.
      await this.change(tx, {
        kind: StockKind.DAMAGED_BOTTLE,
        bottleTypeId: input.bottleTypeId,
        delta: input.quantity,
        reason: StockReason.CUSTOMER_BROKEN_INTAKE,
        inventoryOperationId: op.id,
        note: input.note,
        userId: input.userId,
      });
      if (input.waiveBottleLiability) {
        await tx.bottleMovement.create({
          data: {
            customerId: input.customerId!,
            bottleTypeId: input.bottleTypeId,
            delta: -input.quantity,
            reason: BottleReason.BROKEN_WAIVED,
            note: input.note,
            createdById: input.userId,
          },
        });
      }
    }
    return op;
  }

  async reconcilePhysical(
    tx: Prisma.TransactionClient,
    input: {
      bottleTypeId: string;
      countedEmpty: number;
      countedDamaged: number;
      fullCounts: { productId: string; quantity: number }[];
      note: string;
      idempotencyKey?: string;
      payloadHash?: string;
      userId: string;
    },
  ) {
    const existing = await this.findIdempotentOperation(tx, input.idempotencyKey, input.payloadHash ?? null);
    if (existing) return existing;

    const op = await this.createOperation(tx, {
      kind: InventoryOperationKind.RECONCILIATION,
      idempotencyKey: input.idempotencyKey,
      idempotencyPayloadHash: input.payloadHash,
      note: input.note,
      bottleTypeId: input.bottleTypeId,
      userId: input.userId,
    });

    const applyDelta = async (
      kind: StockKind,
      target: { productId?: string; bottleTypeId?: string },
      recorded: number,
      counted: number,
    ) => {
      const delta = counted - recorded;
      if (delta === 0) return;
      await this.change(tx, {
        kind,
        ...target,
        delta,
        reason: StockReason.PHYSICAL_RECONCILIATION,
        inventoryOperationId: op.id,
        note: `${input.note} · counted ${counted}, was ${recorded}`,
        userId: input.userId,
      });
    };

    const emptyBal = await tx.stockBalance.findUnique({
      where: { kind_bottleTypeId: { kind: StockKind.EMPTY_BOTTLE, bottleTypeId: input.bottleTypeId } },
    });
    await applyDelta(
      StockKind.EMPTY_BOTTLE,
      { bottleTypeId: input.bottleTypeId },
      emptyBal?.quantity ?? 0,
      input.countedEmpty,
    );

    const damagedBal = await tx.stockBalance.findUnique({
      where: { kind_bottleTypeId: { kind: StockKind.DAMAGED_BOTTLE, bottleTypeId: input.bottleTypeId } },
    });
    await applyDelta(
      StockKind.DAMAGED_BOTTLE,
      { bottleTypeId: input.bottleTypeId },
      damagedBal?.quantity ?? 0,
      input.countedDamaged,
    );

    for (const row of input.fullCounts) {
      const product = await tx.product.findFirst({
        where: { id: row.productId, bottleTypeId: input.bottleTypeId },
      });
      if (!product) throw new BadRequestException('Product not linked to this bottle type');
      const bal = await tx.stockBalance.findUnique({
        where: { kind_productId: { kind: StockKind.FULL_DRINK, productId: row.productId } },
      });
      await applyDelta(
        StockKind.FULL_DRINK,
        { productId: row.productId },
        bal?.quantity ?? 0,
        row.quantity,
      );
    }

    return op;
  }
}
