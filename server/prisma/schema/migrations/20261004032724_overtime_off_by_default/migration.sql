-- AlterTable
ALTER TABLE "OrganizationPolicy" ALTER COLUMN "overtimeEnabled" SET DEFAULT false;


-- Off for every company until it is turned on in Settings → Payroll Config:
-- the column arrived on in the migration before this one, and both run
-- together, so no company has chosen it yet.
UPDATE "OrganizationPolicy" SET "overtimeEnabled" = false;
