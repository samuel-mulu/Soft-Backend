import { BadRequestException, Injectable } from '@nestjs/common';
import { InventoryOperationKind, PackagingKind, Prisma, StockKind, StockReason } from '@prisma/client';
import { InventoryService } from './inventory.service';
import { PurchaseReceivingService } from './purchase-receiving';
import { perDozenTotal } from '../common/pack-quantity';

export type ReceiveFullMode =
  | 'FROM_EXISTING_EMPTIES'
  | 'WITH_BOTTLES'
  | 'MIXED_SOURCE';

export type ReceiveFullInput = {
  productId: string;
  mode: ReceiveFullMode;
  fromExistingEmpties: number;
  withSupplierBottles: number;
  supplierId?: string;
  unitCost?: string;
  reference?: string;
  note?: string;
  receivedAt?: string;
  idempotencyKey?: string;
  payloadHash?: string;
  userId: string;
};

@Injectable()
export class StockReceivingService {
  constructor(
    private inventory: InventoryService,
    private purchaseReceiving: PurchaseReceivingService,
  ) {}

  resolveQuantities(input: ReceiveFullInput): { fromExisting: number; withSupplier: number; totalFull: number } {
    let fromExisting = input.fromExistingEmpties;
    let withSupplier = input.withSupplierBottles;

    if (input.mode === 'FROM_EXISTING_EMPTIES') {
      withSupplier = 0;
      if (fromExisting <= 0) throw new BadRequestException('Quantity from existing empties required');
    } else if (input.mode === 'WITH_BOTTLES') {
      fromExisting = 0;
      if (withSupplier <= 0) throw new BadRequestException('Quantity with supplier bottles required');
    } else if (fromExisting <= 0 && withSupplier <= 0) {
      throw new BadRequestException('Mixed receive requires at least one source quantity');
    }

    const totalFull = fromExisting + withSupplier;
    if (!Number.isSafeInteger(totalFull) || totalFull <= 0) {
      throw new BadRequestException('Invalid receive quantity');
    }
    return { fromExisting, withSupplier, totalFull };
  }

  async receiveFull(tx: Prisma.TransactionClient, input: ReceiveFullInput) {
    const { fromExisting, withSupplier, totalFull } = this.resolveQuantities(input);

    const existing = await this.inventory.findIdempotentOperation(
      tx,
      input.idempotencyKey,
      input.payloadHash ?? null,
    );
    if (existing) {
      const purchase = await tx.purchase.findFirst({ where: { inventoryOperationId: existing.id } });
      return { operation: existing, purchaseId: purchase?.id, totalFull, fromExisting, withSupplier };
    }

    const product = await tx.product.findUnique({ where: { id: input.productId } });
    if (!product?.active) throw new BadRequestException('Invalid product');
    if (product.packagingKind !== PackagingKind.RETURNABLE || !product.bottleTypeId) {
      throw new BadRequestException('Product must be returnable with a bottle type');
    }

    if (input.mode === 'FROM_EXISTING_EMPTIES' && input.supplierId) {
      throw new BadRequestException('Supplier not used when filling from warehouse empties only');
    }

    if (withSupplier > 0 && input.supplierId) {
      const unitCostStr = input.unitCost;
      if (!unitCostStr || !Number.isFinite(Number(unitCostStr)) || Number(unitCostStr) < 0) {
        throw new BadRequestException('unitCost required for supplier-bottled quantity');
      }
    }

    const kind =
      input.mode === 'FROM_EXISTING_EMPTIES'
        ? InventoryOperationKind.CONVERT_EMPTIES
        : InventoryOperationKind.RECEIVE_FULL;

    const note =
      input.note?.trim() ||
      `Receive full: ${fromExisting} from empties, ${withSupplier} with supplier bottles`;

    const op = await tx.inventoryOperation.create({
      data: {
        kind,
        idempotencyKey: input.idempotencyKey,
        idempotencyPayloadHash: input.payloadHash,
        note,
        bottleTypeId: product.bottleTypeId,
        productId: product.id,
        fromExistingEmpties: fromExisting,
        withSupplierBottles: withSupplier,
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : undefined,
        createdById: input.userId,
      },
    });

    if (fromExisting > 0) {
      await this.inventory.change(tx, {
        kind: StockKind.EMPTY_BOTTLE,
        bottleTypeId: product.bottleTypeId,
        delta: -fromExisting,
        reason: StockReason.EMPTY_TO_FULL,
        inventoryOperationId: op.id,
        note,
        userId: input.userId,
      });
      await this.inventory.change(tx, {
        kind: StockKind.FULL_DRINK,
        productId: product.id,
        delta: fromExisting,
        reason: StockReason.EMPTY_TO_FULL,
        inventoryOperationId: op.id,
        note,
        userId: input.userId,
      });
    }

    let purchaseId: string | undefined;
    if (withSupplier > 0) {
      if (input.supplierId) {
        const unitCost = new Prisma.Decimal(input.unitCost!);
        const lineTotal = perDozenTotal(unitCost, withSupplier);
        const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId } });
        if (!supplier?.active) throw new BadRequestException('Invalid supplier');

        const purchase = await tx.purchase.create({
          data: {
            supplierId: input.supplierId,
            reference: input.reference,
            createdById: input.userId,
            total: lineTotal,
            inventoryOperationId: op.id,
            items: {
              create: [{ productId: product.id, quantity: withSupplier, unitCost, lineTotal }],
            },
          },
        });
        purchaseId = purchase.id;
        await this.purchaseReceiving.postPurchaseStock(tx, {
          purchaseId: purchase.id,
          inventoryOperationId: op.id,
          items: [{ productId: product.id, quantity: withSupplier, unitCost, lineTotal }],
          userId: input.userId,
        });
      } else {
        await this.inventory.change(tx, {
          kind: StockKind.FULL_DRINK,
          productId: product.id,
          delta: withSupplier,
          reason: StockReason.ADJUSTMENT_IN,
          inventoryOperationId: op.id,
          note: `${note} · supplier bottles (no purchase record)`,
          userId: input.userId,
        });
      }
    }

    return { operation: op, purchaseId, totalFull, fromExisting, withSupplier };
  }
}
