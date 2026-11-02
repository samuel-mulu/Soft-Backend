/**
 * Extended lifecycle integration tests — use TEST_DATABASE_URL (separate from dev).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, StockKind } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AppModule } from './app.module';
import { JwtService } from '@nestjs/jwt';

const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const runIntegration = !!dbUrl;

const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

async function truncateAll() {
  await prisma.paymentCompensationAllocation.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.bottleCompensation.deleteMany();
  await prisma.bottleMovement.deleteMany();
  await prisma.stockMovement.deleteMany();
  await prisma.stockBalance.deleteMany();
  await prisma.inventoryOperation.deleteMany();
  await prisma.purchaseItem.deleteMany();
  await prisma.purchasePayment.deleteMany();
  await prisma.purchase.deleteMany();
  await prisma.saleItem.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.product.deleteMany();
  await prisma.bottleType.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.supplier.deleteMany();
}

describe('Bottle lifecycle phase 2 (integration)', () => {
  let app: INestApplication;
  let token: string;
  let baseUrl: string;

  beforeAll(async () => {
    if (!runIntegration) return;
    await truncateAll();
    const passwordHash = await bcrypt.hash('IntegrationTest1!', 10);
    await prisma.user.upsert({
      where: { username: 'integration-owner' },
      create: { username: 'integration-owner', passwordHash, role: 'OWNER', active: true },
      update: { passwordHash, role: 'OWNER', active: true },
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address();
    const port = typeof addr === 'object' && addr ? addr.port : 4000;
    baseUrl = `http://127.0.0.1:${port}/api`;
    const jwt = app.get(JwtService);
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'integration-owner' } });
    token = await jwt.signAsync({ sub: user.id, role: user.role });
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    await prisma.$disconnect();
  });

  async function api(path: string, init?: RequestInit) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string>),
      },
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* plain */
    }
    if (!res.ok) throw new Error(`${init?.method || 'GET'} ${path} → ${res.status}: ${text}`);
    return body as Record<string, unknown>;
  }

  async function seedReturnable(suffix: string) {
    const bt = await api('/bottle-types', {
      method: 'POST',
      body: JSON.stringify({ name: `BT-${suffix}`, replacementPrice: '25.00', capacityLabel: '300ml' }),
    });
    const bottleTypeId = String(bt.id);
    await api('/inventory/receive-empty', {
      method: 'POST',
      body: JSON.stringify({ bottleTypeId, quantity: 500, note: 'empties' }),
    });
    const product = await api('/products', {
      method: 'POST',
      body: JSON.stringify({
        name: `Prod-${suffix}`,
        bottleTypeId,
        sellingPrice: '15',
        defaultCost: '9',
        unitsPerCase: 12,
      }),
    });
    const productId = String(product.id);
    await api('/inventory/convert-empties-to-full', {
      method: 'POST',
      body: JSON.stringify({ productId, quantity: 120, note: 'stock for tests' }),
    });
    return { bottleTypeId, productId };
  }

  (runIntegration ? it : it.skip)('mixed receive: empties + supplier bottles → single full increment', async () => {
    await truncateAll();
    const suffix = `${Date.now()}`;
    const { bottleTypeId, productId } = await seedReturnable(suffix);
    const sup = await api('/suppliers', { method: 'POST', body: JSON.stringify({ name: `Sup-${suffix}` }) });
    const res = await api('/inventory/receive-full', {
      method: 'POST',
      body: JSON.stringify({
        productId,
        mode: 'MIXED_SOURCE',
        fromExisting: { each: 30 },
        withSupplier: { each: 20 },
        supplierId: String(sup.id),
        unitCost: '8.50',
        note: 'mixed',
      }),
    });
    expect(res.totalFull).toBe(50);
    const fullBal = await prisma.stockBalance.findUnique({
      where: { kind_productId: { kind: StockKind.FULL_DRINK, productId } },
    });
    const emptyBal = await prisma.stockBalance.findUnique({
      where: { kind_bottleTypeId: { kind: StockKind.EMPTY_BOTTLE, bottleTypeId } },
    });
    expect(fullBal?.quantity).toBe(170);
    expect(emptyBal?.quantity).toBe(350);
    const op = await prisma.inventoryOperation.findUnique({ where: { id: String(res.operationId) } });
    expect(op?.fromExistingEmpties).toBe(30);
    expect(op?.withSupplierBottles).toBe(20);
  }, 90000);

  (runIntegration ? it : it.skip)('general payment allocates compensation before drink debt', async () => {
    await truncateAll();
    const suffix = `${Date.now()}`;
    const { bottleTypeId, productId } = await seedReturnable(suffix);
    const customer = await api('/customers', { method: 'POST', body: JSON.stringify({ name: 'Pay Cust' }) });
    const customerId = String(customer.id);
    await api('/sales', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        items: [{ productId, quantity: 10 }],
        payment: '0',
      }),
    });
    await api('/customer-bottles/compensations', {
      method: 'POST',
      body: JSON.stringify({ customerId, bottleTypeId, quantity: 2, note: 'lost bottles' }),
    });
    const pay = await api('/payments', {
      method: 'POST',
      body: JSON.stringify({ customerId, amount: '100', method: 'CASH' }),
    });
    expect(Number(pay.allocatedToCompensation)).toBeGreaterThan(0);
    const history = await api(`/customers/${customerId}/history`);
    const mb = history.moneyBreakdown as Record<string, unknown>;
    expect(mb).toBeDefined();
    const allocRows = await prisma.paymentCompensationAllocation.count();
    expect(allocRows).toBeGreaterThanOrEqual(1);
    const paymentCount = await prisma.payment.count({ where: { customerId } });
    expect(paymentCount).toBe(1);
  }, 120000);

  (runIntegration ? it : it.skip)('customer broken return does not waive ledger without owner flag', async () => {
    await truncateAll();
    const suffix = `${Date.now()}`;
    const { bottleTypeId, productId } = await seedReturnable(suffix);
    const customer = await api('/customers', { method: 'POST', body: JSON.stringify({ name: 'Broken' }) });
    const customerId = String(customer.id);
    await api('/sales', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        items: [{ productId, quantity: 5 }],
        payment: '0',
      }),
    });
    const before = await prisma.bottleMovement.groupBy({
      by: ['customerId'],
      where: { customerId },
      _sum: { delta: true },
    });
    await api('/inventory/breakage', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'CUSTOMER_BROKEN',
        bottleTypeId,
        customerId,
        quantity: 2,
        reason: 'Customer returned broken',
      }),
    });
    const after = await prisma.bottleMovement.groupBy({
      by: ['customerId'],
      where: { customerId },
      _sum: { delta: true },
    });
    expect(after[0]?._sum.delta).toBe(before[0]?._sum.delta);
  }, 90000);

  (runIntegration ? it : it.skip)('owner waiver posts BROKEN_WAIVED movement', async () => {
    await truncateAll();
    const suffix = `${Date.now()}`;
    const { bottleTypeId, productId } = await seedReturnable(suffix);
    const customer = await api('/customers', { method: 'POST', body: JSON.stringify({ name: 'Waive' }) });
    const customerId = String(customer.id);
    await api('/sales', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        items: [{ productId, quantity: 5 }],
        payment: '0',
      }),
    });
    await api('/inventory/breakage', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'CUSTOMER_BROKEN',
        bottleTypeId,
        customerId,
        quantity: 2,
        reason: 'Approved write-off audit',
        waiveBottleLiability: true,
      }),
    });
    const waived = await prisma.bottleMovement.findFirst({
      where: { customerId, reason: 'BROKEN_WAIVED' },
    });
    expect(waived?.delta).toBe(-2);
  }, 90000);

  async function receiveFromEmptiesPack(pack: { each?: number; dozen?: number }) {
    await truncateAll();
    const suffix = `${Date.now()}-${Math.random()}`;
    const { productId, bottleTypeId } = await seedReturnable(suffix);
    await api('/inventory/receive-full', {
      method: 'POST',
      body: JSON.stringify({ productId, mode: 'FROM_EXISTING_EMPTIES', note: 'pack test', ...pack }),
    });
    const fullBal = await prisma.stockBalance.findUnique({
      where: { kind_productId: { kind: StockKind.FULL_DRINK, productId } },
    });
    expect((fullBal?.quantity ?? 0)).toBeGreaterThan(120);
    const emptyBal = await prisma.stockBalance.findUnique({
      where: { kind_bottleTypeId: { kind: StockKind.EMPTY_BOTTLE, bottleTypeId } },
    });
    expect(emptyBal?.quantity).toBeLessThan(380);
  }

  (runIntegration ? it : it.skip)('receive-full from empties accepts each count', () =>
    receiveFromEmptiesPack({ each: 7 }), 90000);
  (runIntegration ? it : it.skip)('receive-full from empties accepts dozen count', () =>
    receiveFromEmptiesPack({ dozen: 2 }), 90000);
  (runIntegration ? it : it.skip)('receive-full from empties accepts mixed dozen+each', () =>
    receiveFromEmptiesPack({ dozen: 1, each: 5 }), 90000);

  (runIntegration ? it : it.skip)('manual compensation payment creates one payment row', async () => {
    await truncateAll();
    const suffix = `${Date.now()}`;
    const { bottleTypeId, productId } = await seedReturnable(suffix);
    const customer = await api('/customers', { method: 'POST', body: JSON.stringify({ name: 'Manual' }) });
    const customerId = String(customer.id);
    await api('/sales', {
      method: 'POST',
      body: JSON.stringify({ customerId, items: [{ productId, quantity: 5 }], payment: '0' }),
    });
    const comp = await api('/customer-bottles/compensations', {
      method: 'POST',
      body: JSON.stringify({ customerId, bottleTypeId, quantity: 1, note: 'one lost' }),
    });
    await api('/payments', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        amount: '25',
        bottleCompensationId: String(comp.id),
      }),
    });
    expect(await prisma.payment.count({ where: { customerId } })).toBe(1);
  }, 120000);

  (runIntegration ? it : it.skip)('overpayment preserved as customer credit on breakdown', async () => {
    await truncateAll();
    const suffix = `${Date.now()}`;
    const { productId } = await seedReturnable(suffix);
    const customer = await api('/customers', { method: 'POST', body: JSON.stringify({ name: 'Credit' }) });
    const customerId = String(customer.id);
    await api('/sales', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        items: [{ productId, quantity: 1 }],
        payment: '0',
      }),
    });
    await api('/payments', {
      method: 'POST',
      body: JSON.stringify({ customerId, amount: '500', method: 'CASH' }),
    });
    const history = await api(`/customers/${customerId}/history`);
    const mb = history.moneyBreakdown as Record<string, unknown>;
    expect(Number(mb.customerCredit)).toBeGreaterThan(0);
    expect(Number(history.moneyOutstanding)).toBeLessThan(0);
  }, 90000);
});
