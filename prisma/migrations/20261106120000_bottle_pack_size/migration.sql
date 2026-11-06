-- Configurable "dozen" size per bottle type (e.g. 12 or 24 bottles per crate).
ALTER TABLE "BottleType" ADD COLUMN IF NOT EXISTS "bottlesPerDozen" INTEGER NOT NULL DEFAULT 12;
