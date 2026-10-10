-- CreateEnum
CREATE TYPE "LeaveJoinerGrant" AS ENUM ('months_left', 'months_after_joining', 'full_year');

-- AlterTable
ALTER TABLE "LeaveRequest" ADD COLUMN     "groupId" TEXT;

-- AlterTable
ALTER TABLE "LeaveType" ADD COLUMN     "joinerGrant" "LeaveJoinerGrant" NOT NULL DEFAULT 'months_left',
ADD COLUMN     "usableAfterConfirmation" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EmployeeLeaveEntitlement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "annualQuota" DECIMAL(5,2) NOT NULL,
    "note" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmployeeLeaveEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeLeaveEntitlement_organizationId_leaveTypeId_idx" ON "EmployeeLeaveEntitlement"("organizationId", "leaveTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeLeaveEntitlement_organizationId_employeeId_leaveTyp_key" ON "EmployeeLeaveEntitlement"("organizationId", "employeeId", "leaveTypeId");

-- CreateIndex
CREATE INDEX "LeaveRequest_groupId_idx" ON "LeaveRequest"("groupId");

-- AddForeignKey
ALTER TABLE "EmployeeLeaveEntitlement" ADD CONSTRAINT "EmployeeLeaveEntitlement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeLeaveEntitlement" ADD CONSTRAINT "EmployeeLeaveEntitlement_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeLeaveEntitlement" ADD CONSTRAINT "EmployeeLeaveEntitlement_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Loss of Pay (client, 9 Oct 2026): unpaid leave that needs no balance — an
-- unpaid type with no days a year has no limit, and every day of it is cut
-- from pay. Added to each company that has leave types but no unpaid one yet,
-- and only where neither its code nor its name is taken (an archived type
-- keeps both for ever) — in any letters, as the app compares them. A company
-- that has never had leave types gets it with the others when they are first
-- set up (prisma/seed/referenceData.ts).
INSERT INTO "LeaveType" ("id", "organizationId", "name", "code", "annualQuota", "isPaid", "carryForward", "carryForwardCap", "updatedAt")
SELECT gen_random_uuid()::text, o."id", 'Loss of Pay', 'LOP', 0, false, false, 0, CURRENT_TIMESTAMP
FROM "Organization" o
WHERE EXISTS (SELECT 1 FROM "LeaveType" t WHERE t."organizationId" = o."id")
  AND NOT EXISTS (SELECT 1 FROM "LeaveType" t WHERE t."organizationId" = o."id" AND t."isPaid" = false AND t."archivedAt" IS NULL)
  AND NOT EXISTS (SELECT 1 FROM "LeaveType" t WHERE t."organizationId" = o."id" AND (lower(t."code") = 'lop' OR lower(t."name") = 'loss of pay'));

-- Work From Home is a request (Requests → Work from home), not leave: the
-- leave type of that code was seeded with no days and nothing reads it. It is
-- archived — kept, with any history, and shown as archived in reports — where
-- it is the seeded one still unused: no days a year, none ever given, and no
-- request of it waiting. One a company gave days to is left as it is.
UPDATE "LeaveType" t
SET "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
WHERE t."code" = 'WFH'
  AND t."archivedAt" IS NULL
  AND t."annualQuota" = 0
  AND NOT EXISTS (SELECT 1 FROM "LeaveRequest" r WHERE r."leaveTypeId" = t."id" AND r."status" = 'pending')
  AND NOT EXISTS (SELECT 1 FROM "LeaveLedgerEntry" l WHERE l."leaveTypeId" = t."id" AND l."days" > 0);

