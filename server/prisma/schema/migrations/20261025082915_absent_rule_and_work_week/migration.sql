-- AlterEnum
ALTER TYPE "AttendanceSource" ADD VALUE 'system';

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "checkOutNudgedAt" TIMESTAMPTZ(3),
ADD COLUMN     "statusBeforeSystem" "AttendanceStatus";

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "absentWaitDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "absentWithoutCheckIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "absentWithoutCheckInFrom" DATE,
ADD COLUMN     "fixedHolidaysThrough" INTEGER,
ADD COLUMN     "holidayReminderYear" INTEGER;

-- CreateTable
CREATE TABLE "WorkWeek" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "weeklyOffDays" INTEGER[],
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkWeek_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkWeek_organizationId_effectiveFrom_key" ON "WorkWeek"("organizationId", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "WorkWeek" ADD CONSTRAINT "WorkWeek_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The working week as it has been (client, 25 Oct 2026): every policy period
-- whose weekly offs differ from the period before it becomes a WorkWeek row
-- from the same day. A company's history reads the same as it did; from now
-- on each day goes by the row in force on it, and the policy column is no
-- longer read.
INSERT INTO "WorkWeek" ("id", "organizationId", "effectiveFrom", "weeklyOffDays", "createdByUserId", "createdAt")
SELECT gen_random_uuid()::text, p."organizationId", p."effectiveFrom", p."weeklyOffDays", p."createdByUserId", p."createdAt"
FROM (
  SELECT *, LAG("weeklyOffDays") OVER (PARTITION BY "organizationId" ORDER BY "effectiveFrom") AS "previous"
  FROM "OrganizationPolicy"
) p
WHERE p."previous" IS NULL OR p."previous" IS DISTINCT FROM p."weeklyOffDays";

-- The fixed national holidays a company already has, by their days (a
-- company may have renamed one): the nightly job adds the year after the
-- latest of them, once, and never one the company removed.
UPDATE "Organization" o
SET "fixedHolidaysThrough" = (
  SELECT MAX(EXTRACT(YEAR FROM h."date"))::int
  FROM "Holiday" h
  WHERE h."organizationId" = o."id"
    AND to_char(h."date", 'MM-DD') IN ('01-26', '08-15', '10-02')
);

