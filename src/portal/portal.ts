import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
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
    const [sales, payments, bottles, moneyOutstanding, bottleBalances, bottleTypes] =
      await Promise.all([
        this.db.sale.findMany({
          where: { customerId: id },
          include: { items: true, payments: true },
          orderBy: { createdAt: 'desc' },
        }),
        this.db.payment.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' } }),
        this.db.bottleMovement.findMany({
          where: { customerId: id },
          include: { bottleType: true },
          orderBy: { createdAt: 'desc' },
        }),
        this.ledger.moneyOutstanding(id),
        this.ledger.bottleBalances(id),
        this.db.bottleType.findMany({ where: { active: true }, select: { id: true, name: true } }),
      ]);
    return { customer, sales, payments, bottles, moneyOutstanding, bottleBalances, bottleTypes };
  }
}
