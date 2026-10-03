-- CreateEnum
CREATE TYPE "ExitReason" AS ENUM ('resigned', 'terminated', 'retired', 'contract_ended', 'absconded', 'other');

-- CreateEnum
CREATE TYPE "EmploymentEventKind" AS ENUM ('onboarding_completed', 'probation_extended', 'confirmed', 'transferred', 'promoted', 'resignation_submitted', 'resignation_accepted', 'resignation_withdrawn', 'resignation_cancelled', 'exited');

-- CreateEnum
CREATE TYPE "ResignationStatus" AS ENUM ('submitted', 'accepted', 'withdrawn', 'cancelled', 'completed');

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "confirmedOn" DATE,
ADD COLUMN     "exitReason" "ExitReason",
ADD COLUMN     "onboardedOn" DATE,
ADD COLUMN     "probationEndDate" DATE;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "noticePeriodDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "probationMonths" INTEGER NOT NULL DEFAULT 6;

-- CreateTable
CREATE TABLE "EmploymentEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" "EmploymentEventKind" NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmploymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resignation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "ResignationStatus" NOT NULL DEFAULT 'submitted',
    "reason" TEXT NOT NULL,
    "submittedOn" DATE NOT NULL,
    "requestedLastDay" DATE NOT NULL,
    "lastWorkingDay" DATE,
    "submittedByUserId" TEXT NOT NULL,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "closedByUserId" TEXT,
    "closedAt" TIMESTAMPTZ(3),
    "closeNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Resignation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmploymentEvent_organizationId_employeeId_effectiveDate_idx" ON "EmploymentEvent"("organizationId", "employeeId", "effectiveDate");

-- CreateIndex
CREATE INDEX "Resignation_organizationId_employeeId_idx" ON "Resignation"("organizationId", "employeeId");

-- CreateIndex
CREATE INDEX "Resignation_organizationId_status_idx" ON "Resignation"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "EmploymentEvent" ADD CONSTRAINT "EmploymentEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentEvent" ADD CONSTRAINT "EmploymentEvent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resignation" ADD CONSTRAINT "Resignation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resignation" ADD CONSTRAINT "Resignation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Hand-written below (Day 23 wrap-up: the employee lifecycle) ───────────

-- 1. People already here. Their lifecycle starts where it plainly stands:
--    onboarded once they have joined; on probation for the company's six
--    months from joining, and confirmed if that is already past. Somebody
--    whose joining date is ahead has not been onboarded yet.
UPDATE "Employee"
SET "onboardedOn" = COALESCE("dateOfJoining", "createdAt"::date)
WHERE "dateOfJoining" IS NULL OR "dateOfJoining" <= CURRENT_DATE;

UPDATE "Employee"
SET "probationEndDate" = ("dateOfJoining" + INTERVAL '6 months')::date
WHERE "dateOfJoining" IS NOT NULL;

UPDATE "Employee"
SET "confirmedOn" = "probationEndDate"
WHERE "probationEndDate" IS NOT NULL AND "probationEndDate" <= CURRENT_DATE;

UPDATE "Employee"
SET "confirmedOn" = "createdAt"::date
WHERE "dateOfJoining" IS NULL;

-- 2. Roles. The new permission is the Super Admin's (who holds everything)
--    and HR's (client §3: "Manage onboarding", "Manage employee lifecycle").
UPDATE "Role"
SET "permissions" = array_append("permissions", 'employee:lifecycle:manage'), "updatedAt" = now()
WHERE ("locked" = true OR ("key" = 'hr' AND "builtIn" = true))
  AND NOT ('employee:lifecycle:manage' = ANY ("permissions"));

--    `attendance:delete` is checked by nothing (a day is corrected, never
--    removed); off every role but the Super Admin's, which holds everything.
UPDATE "Role"
SET "permissions" = array_remove("permissions", 'attendance:delete'), "updatedAt" = now()
WHERE "locked" = false AND 'attendance:delete' = ANY ("permissions");

UPDATE "Role"
SET "description" = 'Runs people operations day to day: employees from onboarding to exit, attendance, documents, holidays and monthly incentives. Sees all leave, gives the yearly leave and corrects balances. Sees salaries, except those of the people above them.'
WHERE "key" = 'hr' AND "builtIn" = true
  AND "description" = 'Runs people operations day to day: employees, attendance, documents, holidays and monthly incentives. Sees all leave, gives the yearly leave and corrects balances. Sees salaries, except those of the people above them.';

-- 3. The built-in roles a NEW company gets. GENERATED by
--    `npx tsx scripts/roleSeedSql.ts` from defaultRoles.ts; roles.test.ts
--    fails if a new company's roles ever differ from that file.
CREATE OR REPLACE FUNCTION ems_seed_default_roles(org_id TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  id_super_admin TEXT := gen_random_uuid()::text;
  id_admin TEXT := gen_random_uuid()::text;
  id_hr TEXT := gen_random_uuid()::text;
  id_accounts TEXT := gen_random_uuid()::text;
  id_manager TEXT := gen_random_uuid()::text;
  id_rm TEXT := gen_random_uuid()::text;
  id_employee TEXT := gen_random_uuid()::text;
BEGIN
  INSERT INTO "Role" ("id", "organizationId", "key", "name", "description", "parentId", "builtIn", "locked", "permissions", "scopes", "updatedAt") VALUES
    (id_super_admin, org_id, 'super_admin', 'Super Admin', 'The owner of the system. Everything, including approving the payroll, reports, the audit log, settings, users and roles.', NULL, true, true, ARRAY['dashboard:read', 'employee:read', 'employee:create', 'employee:update', 'employee:delete', 'employee:lifecycle:manage', 'employee:compensation:read', 'employee:bank:read', 'employee:bank:manage', 'employee:identity:read', 'attendance:read', 'attendance:punch', 'attendance:mark', 'attendance:update', 'attendance:delete', 'leave:read', 'leave:apply', 'leave:balance:manage', 'leave:type:manage', 'holiday:manage', 'payroll:structure:read', 'payroll:structure:manage', 'payroll:run:create', 'payroll:run:approve', 'payroll:entry:manage', 'payslip:read', 'document:read', 'document:upload', 'document:verify', 'document:company:read', 'document:company:manage', 'document:type:manage', 'notification:read', 'report:read', 'settings:read', 'settings:update', 'user:invite', 'user:status:update', 'user:delete', 'membership:role:assign', 'audit:read', 'role:manage']::text[], '{"employee":"ORGANIZATION","compensation":"ORGANIZATION","attendance":"ORGANIZATION","leave":"ORGANIZATION","payslip":"ORGANIZATION","document":"ORGANIZATION"}'::jsonb, now()),
    (id_admin, org_id, 'admin', 'Admin', 'Looks after employee records and documents.', id_super_admin, true, false, ARRAY['dashboard:read', 'employee:read', 'employee:create', 'employee:update', 'leave:type:manage', 'document:read', 'document:upload', 'document:verify', 'document:company:read', 'document:company:manage', 'document:type:manage', 'payslip:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"SELF","attendance":"SELF","leave":"SELF","payslip":"SELF","document":"ORGANIZATION"}'::jsonb, now()),
    (id_hr, org_id, 'hr', 'HR', 'Runs people operations day to day: employees from onboarding to exit, attendance, documents, holidays and monthly incentives. Sees all leave, gives the yearly leave and corrects balances. Sees salaries, except those of the people above them.', id_super_admin, true, false, ARRAY['dashboard:read', 'employee:read', 'employee:create', 'employee:update', 'employee:identity:read', 'employee:compensation:read', 'employee:lifecycle:manage', 'attendance:read', 'attendance:punch', 'attendance:mark', 'attendance:update', 'leave:read', 'leave:apply', 'leave:balance:manage', 'leave:type:manage', 'holiday:manage', 'payroll:entry:manage', 'document:read', 'document:upload', 'document:verify', 'document:company:read', 'document:company:manage', 'document:type:manage', 'payslip:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"ORGANIZATION_EXCEPT_ABOVE","attendance":"ORGANIZATION","leave":"ORGANIZATION","payslip":"SELF","document":"ORGANIZATION"}'::jsonb, now()),
    (id_accounts, org_id, 'accounts', 'Accounts', 'Salaries and payroll: salary structures, the monthly payroll, bank accounts and the bank transfer file.', id_super_admin, true, false, ARRAY['dashboard:read', 'employee:compensation:read', 'employee:bank:read', 'employee:bank:manage', 'payroll:structure:read', 'payroll:structure:manage', 'payroll:run:create', 'payroll:entry:manage', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"ORGANIZATION","attendance":"SELF","leave":"SELF","payslip":"ORGANIZATION","document":"SELF"}'::jsonb, now()),
    (id_manager, org_id, 'manager', 'Manager', 'Leads a team: sees the team''s attendance and leave.', id_hr, true, false, ARRAY['dashboard:read', 'employee:read', 'attendance:read', 'attendance:punch', 'leave:read', 'leave:apply', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"SELF","attendance":"DIRECT_REPORTS","leave":"DIRECT_REPORTS","payslip":"SELF","document":"SELF"}'::jsonb, now()),
    (id_rm, org_id, 'rm', 'Reporting Manager', 'The same as Manager, under a different title.', id_manager, true, false, ARRAY['dashboard:read', 'employee:read', 'attendance:read', 'attendance:punch', 'leave:read', 'leave:apply', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"SELF","attendance":"DIRECT_REPORTS","leave":"DIRECT_REPORTS","payslip":"SELF","document":"SELF"}'::jsonb, now()),
    (id_employee, org_id, 'employee', 'Employee', 'Their own attendance, leave, payslips, documents and bank account.', id_rm, true, false, ARRAY['dashboard:read', 'attendance:read', 'attendance:punch', 'leave:read', 'leave:apply', 'document:read', 'document:upload', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"SELF","compensation":"SELF","attendance":"SELF","leave":"SELF","payslip":"SELF","document":"SELF"}'::jsonb, now());
END
$$;
