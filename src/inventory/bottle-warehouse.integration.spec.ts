/**
 * Integration tests — set TEST_DATABASE_URL to a disposable database.
 * Run: npm run test:integration
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, StockKind } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../app.module';
import { JwtService } from '@nestjs/jwt';

const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const runIntegration = !!dbUrl;

const prisma = new PrismaClient({
  datasources: { db: { url: dbUrl } },
});

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

describe('Bottle warehouse lifecycle (integration)', () => {
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

  (runIntegration ? it : it.skip)(
    'mandatory: 3000 empty → convert 1800 → sell 300 / return 120',
    async () => {
      await truncateAll();
      const suffix = Date.now();
      const bt = await api('/bottle-types', {
        method: 'POST',
        body: JSON.stringify({ name: `Coke300-${suffix}` }),
      });
      await prisma.bottleType.update({
        where: { id: String(bt.id) },
        data: { replacementPrice: '30.00' },
      });
      const bottleTypeId = String(bt.id);

      await api('/inventory/receive-empty', {
        method: 'POST',
        body: JSON.stringify({ bottleTypeId, quantity: 3000, note: 'Receive empties' }),
      });

      const product = await api('/products', {
        method: 'POST',
        body: JSON.stringify({
          name: `Coca-Cola 300ml ${suffix}`,
          bottleTypeId,
          sellingPrice: '12.00',
          defaultCost: '8.00',
          unitsPerCase: 12,
        }),
      });
      const productId = String(product.id);

      await api('/inventory/convert-empties-to-full', {
        method: 'POST',
        body: JSON.stringify({
          productId,
          quantity: 1800,
          idempotencyKey: `conv-${suffix}`,
        }),
      });

      const customer = await api('/customers', {
        method: 'POST',
        body: JSON.stringify({ name: 'Scenario Customer' }),
      });

      await api('/sales', {
        method: 'POST',
        body: JSON.stringify({
          customerId: String(customer.id),
          items: [{ productId, quantity: 300 }],
          bottlesReturned: [{ bottleTypeId, quantity: 120 }],
          payment: '0',
        }),
      });

      const emptyBal = await prisma.stockBalance.findUnique({
        where: { kind_bottleTypeId: { kind: StockKind.EMPTY_BOTTLE, bottleTypeId } },
      });
      const fullBal = await prisma.stockBalance.findUnique({
        where: { kind_productId: { kind: StockKind.FULL_DRINK, productId } },
      });
      const bottleSum = await prisma.bottleMovement.groupBy({
        by: ['bottleTypeId'],
        where: { customerId: String(customer.id) },
        _sum: { delta: true },
      });
      expect(fullBal?.quantity).toBe(1500);
      expect(emptyBal?.quantity).toBe(1320);
      expect(bottleSum[0]?._sum.delta).toBe(180);
    },
    120000,
  );

  (runIntegration ? it : it.skip)('rejects conversion when insufficient empties', async () => {
    await truncateAll();
    const suffix = Date.now();
    const bt = await api('/bottle-types', {
      method: 'POST',
      body: JSON.stringify({ name: `Small-${suffix}` }),
    });
    const bottleTypeId = String(bt.id);
    await api('/inventory/receive-empty', {
      method: 'POST',
      body: JSON.stringify({ bottleTypeId, quantity: 6, note: 'few' }),
    });
    const product = await api('/products', {
      method: 'POST',
      body: JSON.stringify({
        name: `P-${suffix}`,
        bottleTypeId,
        sellingPrice: '10',
        defaultCost: '7',
        unitsPerCase: 12,
      }),
    });
    await expect(
      api('/inventory/convert-empties-to-full', {
        method: 'POST',
        body: JSON.stringify({ productId: String(product.id), quantity: 12 }),
      }),
    ).rejects.toThrow(/Not enough empty/);
  }, 60000);

  (runIntegration ? it : it.skip)('idempotent conversion does not double-post', async () => {
    await truncateAll();
    const suffix = Date.now();
    const bt = await api('/bottle-types', {
      method: 'POST',
      body: JSON.stringify({ name: `Idem-${suffix}` }),
    });
    const bottleTypeId = String(bt.id);
    await api('/inventory/receive-empty', {
      method: 'POST',
      body: JSON.stringify({ bottleTypeId, quantity: 96, note: 'e' }),
    });
    const product = await api('/products', {
      method: 'POST',
      body: JSON.stringify({
        name: `P2-${suffix}`,
        bottleTypeId,
        sellingPrice: '10',
        defaultCost: '7',
        unitsPerCase: 12,
      }),
    });
    const productId = String(product.id);
    const key = `idem-${suffix}`;
    await api('/inventory/convert-empties-to-full', {
      method: 'POST',
      body: JSON.stringify({ productId, quantity: 36, idempotencyKey: key }),
    });
    await api('/inventory/convert-empties-to-full', {
      method: 'POST',
      body: JSON.stringify({ productId, quantity: 36, idempotencyKey: key }),
    });
    const fullBal = await prisma.stockBalance.findUnique({
      where: { kind_productId: { kind: StockKind.FULL_DRINK, productId } },
    });
    expect(fullBal?.quantity).toBe(36);
  }, 60000);
});
