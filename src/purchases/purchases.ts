import { createHash } from 'crypto';
import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { InventoryOperationKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../common/auth';
import { Role } from '@prisma/client';
import { InventoryService } from '../inventory/inventory.service';
import { PurchaseReceivingService } from '../inventory/purchase-receiving';
import { IsHalfDozenBottles, perDozenTotal } from '../common/pack-quantity';

class PurchaseLineDto {
  @IsString() productId!: string;
  @IsInt() @Min(6) @IsHalfDozenBottles() quantity!: number;
  @IsNumberString() unitCost!: string;
}

class PurchaseDto {
  @IsString() supplierId!: string;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() idempotencyKey?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PurchaseLineDto) items!: PurchaseLineDto[];
}

function purchasePayloadHash(dto: PurchaseDto): string {
  const canonical = {
    supplierId: dto.supplierId,
    reference: dto.reference ?? null,
    items: [...dto.items].sort((a, b) => a.productId.localeCompare(b.productId)),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

@ApiTags('Purchases')
@ApiBearerAuth()
@Roles(Role.OWNER)
@Controller('purchases')
export class PurchasesController {
  constructor(
    private db: PrismaService,
    private inventory: InventoryService,
    private purchaseReceiving: PurchaseReceivingService,
  ) {}

  @Get() list() {
    return this.db.purchase.findMany({
      include: { supplier: true, items: { include: { product: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Get(':id') get(@Param('id') id: string) {
    return this.db.purchase.findUniqueOrThrow({
      where: { id },
      include: { supplier: true, items: true },
    });
  }

  @Post() async receive(@Body() dto: PurchaseDto, @CurrentUser() user: { id: string }) {
    if (dto.items.some((x) => !Number.isFinite(Number(x.unitCost)) || Number(x.unitCost) < 0)) {
      throw new BadRequestException('Invalid unit cost');
    }
    const ids = dto.items.map((x) => x.productId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Combine duplicate product lines');
    }

    const payloadHash = dto.idempotencyKey ? purchasePayloadHash(dto) : null;

    if (dto.idempotencyKey) {
      const existing = await this.db.purchase.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
        include: { items: true, supplier: true },
      });
      if (existing) {
        if (existing.idempotencyPayloadHash && existing.idempotencyPayloadHash !== payloadHash) {
          throw new BadRequestException('Idempotency key reused with different purchase payload');
        }
        return existing;
      }
    }

    return this.db.$transaction(
      async (tx) => {
        if (dto.idempotencyKey) {
          const again = await tx.purchase.findUnique({
            where: { idempotencyKey: dto.idempotencyKey },
            include: { items: true, supplier: true },
          });
          if (again) return again;
        }

        const supplier = await tx.supplier.findUnique({ where: { id: dto.supplierId } });
        if (!supplier?.active) throw new BadRequestException('Invalid supplier');
        const products = await tx.product.findMany({ where: { id: { in: ids }, active: true } });
        if (products.length !== ids.length) throw new BadRequestException('Invalid product');

        const items = dto.items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          unitCost: new Prisma.Decimal(item.unitCost),
          lineTotal: perDozenTotal(item.unitCost, item.quantity),
        }));
        const total = items.reduce((sum, x) => sum.add(x.lineTotal), new Prisma.Decimal(0));

        const op = await this.inventory.createOperation(tx, {
          kind: InventoryOperationKind.RECEIVE_FULL,
          idempotencyKey: dto.idempotencyKey,
          idempotencyPayloadHash: payloadHash ?? undefined,
          note: 'Supplier purchase',
          userId: user.id,
        });

        const purchase = await tx.purchase.create({
          data: {
            supplierId: dto.supplierId,
            reference: dto.reference,
            idempotencyKey: dto.idempotencyKey,
            idempotencyPayloadHash: payloadHash ?? undefined,
            createdById: user.id,
            total,
            inventoryOperationId: op.id,
            items: { create: items },
          },
        });

        await this.purchaseReceiving.postPurchaseStock(tx, {
          purchaseId: purchase.id,
          inventoryOperationId: op.id,
          items,
          userId: user.id,
        });

        return tx.purchase.findUniqueOrThrow({
          where: { id: purchase.id },
          include: { items: true, supplier: true },
        });
      },
      { timeout: 15000 },
    );
  }
}
