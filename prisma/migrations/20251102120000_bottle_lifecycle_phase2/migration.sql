-- CreateEnum extension for BottleReason (if not exists handled by prisma)
-- AlterTable InventoryOperation
ALTER TABLE "InventoryOperation" ADD COLUMN IF NOT EXISTS "fromExistingEmpties" INTEGER;
ALTER TABLE "InventoryOperation" ADD COLUMN IF NOT EXISTS "withSupplierBottles" INTEGER;
ALTER TABLE "InventoryOperation" ADD COLUMN IF NOT EXISTS "receivedAt" TIMESTAMP(3);

-- AlterTable Payment
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "allocatedToCompensation" DECIMAL(16,2);
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "allocatedToSales" DECIMAL(16,2);

-- CreateTable PaymentCompensationAllocation
CREATE TABLE IF NOT EXISTS "PaymentCompensationAllocation" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "bottleCompensationId" TEXT NOT NULL,
    "amount" DECIMAL(16,2) NOT NULL,

    CONSTRAINT "PaymentCompensationAllocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentCompensationAllocation_paymentId_bottleCompensationId_key" ON "PaymentCompensationAllocation"("paymentId", "bottleCompensationId");

DO $$ BEGIN
 ALTER TABLE "PaymentCompensationAllocation" ADD CONSTRAINT "PaymentCompensationAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "PaymentCompensationAllocation" ADD CONSTRAINT "PaymentCompensationAllocation_bottleCompensationId_fkey" FOREIGN KEY ("bottleCompensationId") REFERENCES "BottleCompensation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- BottleReason BROKEN_WAIVED (PostgreSQL enum alter)
ALTER TYPE "BottleReason" ADD VALUE IF NOT EXISTS 'BROKEN_WAIVED';
