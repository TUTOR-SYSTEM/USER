-- AlterTable
-- Mirrors gateway drizzle/0010_must_change_password.sql (users part). IF NOT EXISTS keeps it safe on
-- databases where gateway's migration already ran.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" BOOLEAN NOT NULL DEFAULT false;
