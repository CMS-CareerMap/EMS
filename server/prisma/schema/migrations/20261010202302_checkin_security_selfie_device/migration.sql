-- CreateEnum
CREATE TYPE "PunchDeviceStatus" AS ENUM ('approved', 'waiting', 'retired');

-- AlterEnum
ALTER TYPE "PunchFlag" ADD VALUE 'new_device';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PunchRefusal" ADD VALUE 'device_waiting';
ALTER TYPE "PunchRefusal" ADD VALUE 'no_photo';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "punchOneDevice" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "punchSelfie" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "punchSelfieKeepDays" INTEGER NOT NULL DEFAULT 60;

-- AlterTable
ALTER TABLE "PunchEvidence" ADD COLUMN     "deviceKeyHash" TEXT,
ADD COLUMN     "photoBytes" INTEGER,
ADD COLUMN     "photoKey" TEXT,
ADD COLUMN     "photoSha" TEXT;

-- CreateTable
CREATE TABLE "PunchDevice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "label" TEXT,
    "status" "PunchDeviceStatus" NOT NULL DEFAULT 'waiting',
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PunchDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PunchDevice_organizationId_status_idx" ON "PunchDevice"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PunchDevice_organizationId_employeeId_keyHash_key" ON "PunchDevice"("organizationId", "employeeId", "keyHash");

-- AddForeignKey
ALTER TABLE "PunchDevice" ADD CONSTRAINT "PunchDevice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PunchDevice" ADD CONSTRAINT "PunchDevice_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

