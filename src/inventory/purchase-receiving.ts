import { BadRequestException, Injectable } from '@nestjs/common';
import {
  InventoryOperationKind,
  PackagingKind,
  Prisma,
  StockKind,
  StockReason,
} from '@prisma/client';
import { InventoryService } from './inventory.service';

export type PurchaseLineInput = {
  productId: string;
  quantity: number;
  unitCost: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
};

/** Single authoritative path for posting full stock from a supplier purchase. */
@Injectable()
export class PurchaseReceivingService {
  constructor(private inventory: InventoryService) {}

  async postPurchaseStock(
    tx: Prisma.TransactionClient,
    input: {
      purchaseId: string;
      inventoryOperationId: string;
      items: PurchaseLineInput[];
      userId: string;
    },
  ): Promise<void> {
    const { purchaseId, inventoryOperationId, items, userId } = input;
    const existing = await tx.stockMovement.count({ where: { purchaseId } });
    if (existing > 0) {
      throw new BadRequestException('Purchase stock already posted');
    }
    for (const item of items) {
      const product = await tx.product.findUnique({ where: { id: item.productId } });
      if (!product?.active) throw new BadRequestException('Invalid product');
      await this.inventory.change(tx, {
        kind: StockKind.FULL_DRINK,
        productId: item.productId,
        delta: item.quantity,
        reason: StockReason.PURCHASE,
        purchaseId,
        inventoryOperationId,
        userId,
        note: 'Supplier purchase (full with bottles)',
      });
    }
  }

  async assertReturnableProductForConversion(
    tx: Prisma.TransactionClient,
    productId: string,
    expectedBottleTypeId?: string,
  ) {
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product?.active) throw new BadRequestException('Invalid product');
    if (product.packagingKind !== PackagingKind.RETURNABLE || !product.bottleTypeId) {
      throw new BadRequestException('Product must be returnable with a bottle type');
    }
    if (expectedBottleTypeId && product.bottleTypeId !== expectedBottleTypeId) {
      throw new BadRequestException('Product bottle type does not match');
    }
    return product;
  }

  operationKindForReceive(): InventoryOperationKind {
    return InventoryOperationKind.RECEIVE_FULL;
  }
}
