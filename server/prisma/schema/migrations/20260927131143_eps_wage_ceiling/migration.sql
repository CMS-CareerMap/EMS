-- AlterTable
ALTER TABLE "OrganizationPolicy" ADD COLUMN     "epsWageCeiling" DECIMAL(12,2) NOT NULL DEFAULT 15000,
ALTER COLUMN "pfWageCeiling" SET DEFAULT 25000;

