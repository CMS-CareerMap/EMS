-- AlterTable
ALTER TABLE "OrganizationPolicy" ADD COLUMN     "wagesShareEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "wagesSharePercent" DECIMAL(5,2) NOT NULL DEFAULT 50;

