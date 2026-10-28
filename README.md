# Soft Drink Distribution API (B0-B4)

NestJS + Prisma 6 + PostgreSQL backend. Requires Node.js 20+ and a running PostgreSQL server. No Docker needed.

## Windows / VS Code setup

```powershell
cd softdrink-backend
npm install
Copy-Item .env.example .env
```

Create a PostgreSQL database named `softdrink` using pgAdmin or `createdb -U postgres softdrink`. Update `DATABASE_URL`, `JWT_SECRET`, and `SEED_OWNER_PASSWORD` in `.env`.

```powershell
npx prisma generate
npx prisma migrate dev --name init
npm run seed
npm run start:dev
```

Open http://localhost:4000/docs . All API endpoints are prefixed with `/api`.

## Test flow

1. `POST /api/auth/login` with `{"username":"owner","password":"<your password>"}`.
2. Click Swagger **Authorize**, paste the JWT.
3. `POST /api/bottle-types`: `{"name":"Glass 300ml"}`.
4. `POST /api/products`: `{"name":"Pepsi 300ml","bottleTypeId":"<id>","sellingPrice":"10.00","defaultCost":"7.00","unitsPerCase":12}`.
5. `POST /api/suppliers`: `{"name":"Main supplier"}`.
6. `POST /api/purchases`: `{"supplierId":"<id>","items":[{"productId":"<id>","quantity":200,"unitCost":"7.00"}]}`.
7. `GET /api/inventory/balances` should show 200 full drinks.
8. `POST /api/inventory/adjustments`: `{"kind":"EMPTY_BOTTLE","bottleTypeId":"<id>","delta":100,"note":"Opening empty bottle count"}`.

## Design notes and scope

- Registered customers are stored in `/customers`. Guest purchases will be modeled in the sales module (B5), not as anonymous fake customer accounts.
- `GET /customers/:id/history` is a **placeholder** until B5-B7; it does not fabricate activity.
- The product's bottle type identifies compatible returnable packaging; no bottle liability is posted until sales/returns are built in B5-B7.
- Full drinks and empty bottles are different inventory balances. Purchasing full drinks does not automatically increase empty bottle stock.
- The purchases endpoint records **received stock and cost**, not supplier payments. Accounts payable and cash flow are future phases.
- Prices/costs are decimal strings in the API, e.g. `"10.00"`.
- Inventory changes are atomic with movement logs; negative stock is rejected. All purchase lines and stock movements commit together.
- No public registration. Owner creates cashier users. Both authenticated roles can view stock, customers, and purchases; owner alone manages prices, products, users, suppliers, and manual stock adjustments.
- Use a unique reference when receiving an external purchase to avoid accidental duplicate submissions.
- For production, replace development JWT fallback, use HTTPS, strong passwords, backup PostgreSQL, and apply migrations with `npx prisma migrate deploy`.


## B5-B9 added modules

- `POST /api/sales` creates an invoice, decreases full-drink stock, issues customer bottles, accepts optional bottle returns and initial payment in one serializable transaction. Guest sales must be fully paid and cannot maintain bottle balances.
- `GET /api/sales`, `GET /api/sales/:id` list invoices.
- `POST /api/payments` records later customer payments (optionally linked to an invoice); `GET /api/payments` lists receipts.
- `POST /api/customer-bottles/returns`, `GET /api/customer-bottles/:customerId`, owner-only `POST /api/customer-bottles/corrections` manage the bottle ledger.
- `POST /api/expenses`, `GET /api/expenses` track operating costs.
- `POST /api/purchase-payments`, `GET /api/purchase-payments` track supplier payments separately from purchases.
- Owner-only `GET /api/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD`, `/reports/daily`, `/reports/customers`, `/reports/stock` provide reporting.
- `GET /api/customers/:id/history` includes sales, payments, bottle movements and money outstanding.

**Limitations / important accounting notes:** This starter does not implement invoice voids, refunds, sale corrections, FIFO inventory valuation, formal double-entry accounting, or a customer login portal. Profit uses the recorded default product cost snapshot at sale time, not FIFO actual batch cost. Bottle corrections affect the customer ledger only; if physical warehouse bottles also change, make a separate inventory adjustment. The system assumes 1 returnable bottle per drink. For credit or bottle tracking, use a registered customer. Customer payments without `saleId` settle the overall customer balance, not a specific invoice. Date ranges are UTC. Production deployment requires testing, backups, and additional operational hardening.

## Deploy on Render

Connect the **Soft-Backend** GitHub repo as a **Web Service**.

| Setting | Value |
|--------|--------|
| **Root Directory** | **Leave empty** — do **not** set `src`. If Root Directory is `src`, start fails with `Cannot find module .../src/dist/main.js`. |
| **Build Command** | `npm ci && npm run build` |
| **Start Command** | `npm run start` |
| **Pre-deploy / Release** | `npx prisma db push` |
| **Health check path** | `/api/health` |

**Environment:** `DATABASE_URL` (Neon pooler URL), `JWT_SECRET`, `CORS_ALLOW_VERCEL=true`, optional `CORS_ORIGIN=https://your-app.vercel.app`, `SEED_OWNER_PASSWORD`.

After the first successful deploy, open **Shell** once: `npm run seed`.

### Fresh install

```powershell
npm install
Copy-Item .env.example .env
# Edit .env with DATABASE_URL, JWT_SECRET, and SEED_OWNER_PASSWORD
npx prisma generate
npx prisma migrate dev --name initial_b0_b9
npm run seed
npm run start:dev
```

### Upgrade an existing B0-B4 database

Back up the database first, then run `npx prisma migrate dev --name add_sales_finance_reports` in development. Use `npx prisma migrate deploy` for migrations already committed in a production environment.
