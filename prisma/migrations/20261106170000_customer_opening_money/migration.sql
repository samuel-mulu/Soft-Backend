-- Opening AR carried from manual books when a customer is first registered digitally.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "openingMoney" DECIMAL(16, 2) NOT NULL DEFAULT 0;
