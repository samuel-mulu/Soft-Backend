import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InventoryOperationKind, Role, StockReason } from '@prisma/client';
import { CurrentUser, Roles } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerLedgerService } from '../customers/customer-ledger';

@ApiTags('Customer portal')
@ApiBearerAuth()
@Roles(Role.CUSTOMER)
@Controller('portal')
export class PortalController {
  constructor(
    private db: PrismaService,
    private ledger: CustomerLedgerService,
  ) {}

  @Get('history')
  async history(@CurrentUser() user: { id: string }) {
    const id = user.id;
    const customer = await this.db.customer.findUniqueOrThrow({ where: { id } });
    const [
      sales,
      payments,
      bottles,
      moneyBreakdown,
      bottleBalances,
      bottleTypes,
      compensations,
      breakageOps,
    ] = await Promise.all([
      this.db.sale.findMany({
        where: { customerId: id },
        include: { items: true, payments: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.db.payment.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        include: { compensationAllocations: true },
      }),
      this.db.bottleMovement.findMany({
        where: { customerId: id },
        include: { bottleType: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.ledger.moneyBreakdown(id),
      this.ledger.bottleBalances(id),
      this.db.bottleType.findMany({
        where: { active: true },
        select: { id: true, name: true, capacityLabel: true },
      }),
      this.db.bottleCompensation.findMany({
        where: { customerId: id },
        include: { bottleType: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.db.inventoryOperation.findMany({
        where: { customerId: id, kind: InventoryOperationKind.BREAKAGE },
        include: {
          stockMovements: { where: { reason: StockReason.CUSTOMER_BROKEN_INTAKE } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const typeById = new Map(bottleTypes.map((t) => [t.id, t]));

    const waived = bottles.filter((m) => m.reason === 'BROKEN_WAIVED');
    const damagedRecords = breakageOps
      .map((op) => {
        const qty = op.stockMovements.reduce((s: number, m) => s + m.delta, 0);
        if (qty <= 0 || !op.bottleTypeId) return null;
        const matchedWaive = waived.find(
          (w) =>
            w.bottleTypeId === op.bottleTypeId &&
            Math.abs(w.delta) === qty &&
            Math.abs(w.createdAt.getTime() - op.createdAt.getTime()) < 120_000,
        );
        const matchedComp = compensations.find(
          (c) =>
            c.bottleTypeId === op.bottleTypeId &&
            c.quantity === qty &&
            c.createdAt >= op.createdAt &&
            c.createdAt.getTime() - op.createdAt.getTime() < 7 * 86_400_000,
        );
        let liabilityStatus: 'WAIVED' | 'COMPENSATED' | 'OWED' = 'OWED';
        if (matchedWaive) liabilityStatus = 'WAIVED';
        else if (matchedComp) liabilityStatus = 'COMPENSATED';
        return {
          id: op.id,
          createdAt: op.createdAt,
          bottleTypeId: op.bottleTypeId,
          bottleType: typeById.get(op.bottleTypeId) ?? null,
          quantity: qty,
          liabilityStatus,
          note: op.note,
          compensationId: matchedComp?.id,
        };
      })
      .filter(Boolean);

    const balanceByType = new Map<string, number>();
    for (const m of bottles) {
      balanceByType.set(m.bottleTypeId, (balanceByType.get(m.bottleTypeId) ?? 0) + m.delta);
    }
    const bottleSummaryLines = [...balanceByType.entries()].map(([bottleTypeId, outstanding]) => ({
      bottleTypeId,
      outstanding,
    }));

    return {
      customer,
      sales,
      payments,
      bottles,
      moneyBreakdown,
      moneyOutstanding: moneyBreakdown.moneyOutstanding,
      bottleBalances,
      bottleSummaryLines,
      bottleTypes,
      compensations,
      damagedRecords,
    };
  }
}
