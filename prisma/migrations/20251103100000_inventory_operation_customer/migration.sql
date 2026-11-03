ALTER TABLE "InventoryOperation" ADD COLUMN IF NOT EXISTS "customerId" TEXT;
CREATE INDEX IF NOT EXISTS "InventoryOperation_customerId_createdAt_idx" ON "InventoryOperation"("customerId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "InventoryOperation" ADD CONSTRAINT "InventoryOperation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
