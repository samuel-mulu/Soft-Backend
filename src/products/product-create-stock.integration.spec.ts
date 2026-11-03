/**
 * Product create + initial stock — TEST_DATABASE_URL or DATABASE_URL.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InventoryOperationKind, PrismaClient, StockKind } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../app.module';
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

describe('Product create initial stock (integration)', () => {
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
    if (!res.ok) throw new Error(`${init?.method || 'GET'} ${path} → ${res.status}: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  }

  (runIntegration ? it : it.skip)('acceptance: 3000 empty → create product mixed 1000+2000', async () => {
    await truncateAll();
    const suffix = Date.now();
    const bt = await api('/bottle-types', {
      method: 'POST',
      body: JSON.stringify({ name: `Coke300-${suffix}`, replacementPrice: '25.00' }),
    });
    const bottleTypeId = String(bt.id);
    await api('/inventory/receive-empty', {
      method: 'POST',
      body: JSON.stringify({ bottleTypeId, quantity: 3000, note: 'opening empties' }),
    });

    const product = await api('/products', {
      method: 'POST',
      body: JSON.stringify({
        name: `Coca-Cola 300ml ${suffix}`,
        bottleTypeId,
        sellingPrice: '12',
        defaultCost: '8',
        unitsPerCase: 12,
        initialFromExistingEmpties: 1000,
        initialQuantity: 2000,
        stockNote: 'Initial mixed receive',
      }),
    });
    const productId = String(product.id);

    const emptyBal = await prisma.stockBalance.findUnique({
      where: { kind_bottleTypeId: { kind: StockKind.EMPTY_BOTTLE, bottleTypeId } },
    });
    const fullBal = await prisma.stockBalance.findUnique({
      where: { kind_productId: { kind: StockKind.FULL_DRINK, productId } },
    });
    expect(emptyBal?.quantity).toBe(2000);
    expect(fullBal?.quantity).toBe(3000);

    const ops = await prisma.inventoryOperation.findMany({ where: { productId } });
    expect(ops.length).toBe(1);
    expect(ops[0]?.fromExistingEmpties).toBe(1000);
    expect(ops[0]?.withSupplierBottles).toBe(2000);
    expect(ops[0]?.kind).toBe(InventoryOperationKind.RECEIVE_FULL);

    const fullMovements = await prisma.stockMovement.count({
      where: { productId, kind: StockKind.FULL_DRINK, delta: { gt: 0 } },
    });
    expect(fullMovements).toBe(2);
    const totalFullDelta = await prisma.stockMovement.aggregate({
      where: { productId, kind: StockKind.FULL_DRINK },
      _sum: { delta: true },
    });
    expect(totalFullDelta._sum.delta).toBe(3000);
  }, 120000);

  (runIntegration ? it : it.skip)('create with no initial stock fields → zero movement', async () => {
    await truncateAll();
    const suffix = Date.now();
    const bt = await api('/bottle-types', {
      method: 'POST',
      body: JSON.stringify({ name: `EmptyOnly-${suffix}` }),
    });
    const product = await api('/products', {
      method: 'POST',
      body: JSON.stringify({
        name: `Water ${suffix}`,
        bottleTypeId: String(bt.id),
        sellingPrice: '10',
        defaultCost: '7',
        unitsPerCase: 12,
      }),
    });
    const productId = String(product.id);
    expect(n(product.stock)).toBe(0);
    const ops = await prisma.inventoryOperation.count({ where: { productId } });
    expect(ops).toBe(0);
  }, 90000);

  (runIntegration ? it : it.skip)('FROM_EXISTING_EMPTIES only on create', async () => {
    await truncateAll();
    const suffix = Date.now();
    const bt = await api('/bottle-types', {
      method: 'POST',
      body: JSON.stringify({ name: `E-${suffix}` }),
    });
    const bottleTypeId = String(bt.id);
    await api('/inventory/receive-empty', {
      method: 'POST',
      body: JSON.stringify({ bottleTypeId, quantity: 500, note: 'e' }),
    });
    const product = await api('/products', {
      method: 'POST',
      body: JSON.stringify({
        name: `Fill ${suffix}`,
        bottleTypeId,
        sellingPrice: '10',
        defaultCost: '7',
        unitsPerCase: 12,
        initialFromExistingEmpties: 120,
      }),
    });
    const productId = String(product.id);
    const fullBal = await prisma.stockBalance.findUnique({
      where: { kind_productId: { kind: StockKind.FULL_DRINK, productId } },
    });
    expect(fullBal?.quantity).toBe(120);
    const op = await prisma.inventoryOperation.findFirst({ where: { productId } });
    expect(op?.kind).toBe(InventoryOperationKind.CONVERT_EMPTIES);
  }, 120000);

  (runIntegration ? it : it.skip)('WITH_BOTTLES only on create', async () => {
    await truncateAll();
    const suffix = Date.now();
    const bt = await api('/bottle-types', {
      method: 'POST',
      body: JSON.stringify({ name: `S-${suffix}` }),
    });
    const bottleTypeId = String(bt.id);
    const product = await api('/products', {
      method: 'POST',
      body: JSON.stringify({
        name: `Sup ${suffix}`,
        bottleTypeId,
        sellingPrice: '10',
        defaultCost: '7',
        unitsPerCase: 12,
        initialQuantity: 50,
      }),
    });
    const productId = String(product.id);
    const emptyBal = await prisma.stockBalance.findUnique({
      where: { kind_bottleTypeId: { kind: StockKind.EMPTY_BOTTLE, bottleTypeId } },
    });
    expect(emptyBal?.quantity ?? 0).toBe(0);
    const fullBal = await prisma.stockBalance.findUnique({
      where: { kind_productId: { kind: StockKind.FULL_DRINK, productId } },
    });
    expect(fullBal?.quantity).toBe(50);
  }, 90000);

  (runIntegration ? it : it.skip)('edit receive uses the same three modes', async () => {
    await truncateAll();
    const suffix = Date.now();
    const bt = await api('/bottle-types', {
      method: 'POST',
      body: JSON.stringify({ name: `Edit-${suffix}` }),
    });
    const bottleTypeId = String(bt.id);
    await api('/inventory/receive-empty', {
      method: 'POST',
      body: JSON.stringify({ bottleTypeId, quantity: 3000, note: 'opening empties' }),
    });
    const created = await api('/products', {
      method: 'POST',
      body: JSON.stringify({
        name: `Edit drink ${suffix}`,
        bottleTypeId,
        sellingPrice: '12',
        defaultCost: '8',
        unitsPerCase: 12,
      }),
    });
    const productId = String(created.id);

    const mixed = await api(`/products/${productId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: `Edit drink ${suffix}`,
        sellingPrice: '12',
        defaultCost: '8',
        unitsPerCase: 12,
        packagingKind: 'RETURNABLE',
        bottleTypeId,
        active: true,
        initialFromExistingEmpties: 1000,
        initialQuantity: 2000,
        stockNote: 'Edit mixed receive',
      }),
    });
    expect(n(mixed.stock)).toBe(3000);

    const emptyBal = await prisma.stockBalance.findUnique({
      where: { kind_bottleTypeId: { kind: StockKind.EMPTY_BOTTLE, bottleTypeId } },
    });
    expect(emptyBal?.quantity).toBe(2000);
    const op = await prisma.inventoryOperation.findFirst({ where: { productId } });
    expect(op?.kind).toBe(InventoryOperationKind.RECEIVE_FULL);
    expect(op?.fromExistingEmpties).toBe(1000);
    expect(op?.withSupplierBottles).toBe(2000);

    const removed = await api(`/products/${productId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: `Edit drink ${suffix}`,
        sellingPrice: '12',
        defaultCost: '8',
        unitsPerCase: 12,
        addStock: -40,
      }),
    });
    expect(n(removed.stock)).toBe(2960);
    const emptyAfterRemove = await prisma.stockBalance.findUnique({
      where: { kind_bottleTypeId: { kind: StockKind.EMPTY_BOTTLE, bottleTypeId } },
    });
    expect(emptyAfterRemove?.quantity).toBe(2000);
  }, 120000);
});

function n(v: unknown) {
  return Number(v || 0);
}
