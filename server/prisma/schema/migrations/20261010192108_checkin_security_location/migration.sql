-- CreateEnum
CREATE TYPE "PunchAction" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "PunchRefusal" AS ENUM ('outside', 'unreliable');

-- AlterTable
ALTER TABLE "GeofenceLocation" ALTER COLUMN "radiusMeters" SET DEFAULT 20,
ALTER COLUMN "maxAccuracyMeters" SET DEFAULT 20;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "punchCheckOutLocation" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "PunchEvidence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "attendanceId" TEXT,
    "action" "PunchAction" NOT NULL,
    "refusedFor" "PunchRefusal",
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workMode" "WorkMode",
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "accuracyMeters" INTEGER,
    "distanceMeters" INTEGER,
    "fenceApplied" BOOLEAN NOT NULL DEFAULT false,
    "readings" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "PunchEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PunchEvidence_organizationId_employeeId_date_idx" ON "PunchEvidence"("organizationId", "employeeId", "date");

-- CreateIndex
CREATE INDEX "PunchEvidence_organizationId_date_idx" ON "PunchEvidence"("organizationId", "date");

-- CreateIndex
CREATE INDEX "PunchEvidence_organizationId_attendanceId_idx" ON "PunchEvidence"("organizationId", "attendanceId");

-- AddForeignKey
ALTER TABLE "PunchEvidence" ADD CONSTRAINT "PunchEvidence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PunchEvidence" ADD CONSTRAINT "PunchEvidence_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PunchEvidence" ADD CONSTRAINT "PunchEvidence_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Data: every office into the client's fence (11 Oct 2026) — radius 15–20 m,
-- accuracy needed 10–20 m. The check never applies more than 20 either way;
-- this keeps what Settings shows true to what is applied.
UPDATE "GeofenceLocation" SET "radiusMeters" = LEAST(GREATEST("radiusMeters", 15), 20)
  WHERE "radiusMeters" < 15 OR "radiusMeters" > 20;
UPDATE "GeofenceLocation" SET "maxAccuracyMeters" = LEAST(GREATEST("maxAccuracyMeters", 10), 20)
  WHERE "maxAccuracyMeters" < 10 OR "maxAccuracyMeters" > 20;
