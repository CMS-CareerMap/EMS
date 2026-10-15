-- The punch method (client, 14 Oct 2026): the Super Admin chooses exactly one
-- way an app punch is proved — the office fence, a live selfie, or both — and
-- the punch asks for that and nothing else. A check-out is proved the way its
-- day was checked in, kept on the day, so changing the method mid-day never
-- strands anybody.

-- CreateEnum
CREATE TYPE "PunchMethod" AS ENUM ('location', 'selfie', 'location_selfie');

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "punchMethod" "PunchMethod";

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "punchMethod" "PunchMethod" NOT NULL DEFAULT 'location';

-- Every company keeps the office fence it has: the method starts as Location
-- for all (the column default). Location + Selfie reads the location wherever
-- the person is and never checks the office, so a company that had the selfie
-- on is NOT moved to it — that would quietly drop its office check. Its Super
-- Admin chooses a selfie method when wanted. "Phones only" and "check location
-- at check-out" stop being switches: a punch that reads the location is from a
-- phone, and a check-out is proved as its day was. Those columns stay one
-- release, read by nothing, so the version before still runs on a rollback.

-- The new permission, user:device:manage — replacing or resetting the phone a
-- person punches from — for the built-in Super Admin, HR and Admin roles of
-- every company there is. It reaches whoever the role's employee records
-- reach, which for a role the Super Admin made may be wider than its
-- attendance did: so it is not handed to such roles here — the Super Admin
-- gives it where wanted. Only added: whatever else the Super Admin has chosen
-- for those roles stays as it is.
UPDATE "Role"
SET "permissions" = array_append("permissions", 'user:device:manage'), "updatedAt" = now()
WHERE "builtIn" = true
  AND "key" IN ('super_admin', 'hr', 'admin')
  AND NOT ('user:device:manage' = ANY ("permissions"));

-- And for every company made from now on (scripts/roleSeedSql.ts, from
-- src/platform/authz/defaultRoles.ts).
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
    (id_super_admin, org_id, 'super_admin', 'Super Admin', 'The owner of the system. Everything, including approving the payroll, reports, the audit log, settings, users and roles.', NULL, true, true, ARRAY['dashboard:read', 'employee:read', 'employee:create', 'employee:update', 'employee:delete', 'employee:lifecycle:manage', 'employee:compensation:read', 'employee:bank:read', 'employee:bank:manage', 'employee:identity:read', 'attendance:read', 'attendance:punch', 'attendance:mark', 'attendance:update', 'attendance:delete', 'leave:read', 'leave:apply', 'leave:balance:manage', 'leave:type:manage', 'holiday:manage', 'payroll:structure:read', 'payroll:structure:manage', 'payroll:run:create', 'payroll:run:approve', 'payroll:entry:manage', 'payslip:read', 'document:read', 'document:upload', 'document:verify', 'document:company:read', 'document:company:manage', 'document:type:manage', 'notification:read', 'report:read', 'settings:read', 'settings:update', 'user:invite', 'user:status:update', 'user:delete', 'membership:role:assign', 'user:password:set', 'user:device:manage', 'audit:read', 'role:manage']::text[], '{"employee":"ORGANIZATION","compensation":"ORGANIZATION","attendance":"ORGANIZATION","leave":"ORGANIZATION","payslip":"ORGANIZATION","document":"ORGANIZATION"}'::jsonb, now()),
    (id_admin, org_id, 'admin', 'Admin', 'Looks after employee records and documents.', id_super_admin, true, false, ARRAY['dashboard:read', 'employee:read', 'employee:create', 'employee:update', 'leave:type:manage', 'document:read', 'document:upload', 'document:verify', 'document:company:read', 'document:company:manage', 'document:type:manage', 'payslip:read', 'notification:read', 'user:device:manage']::text[], '{"employee":"ORGANIZATION","compensation":"SELF","attendance":"SELF","leave":"SELF","payslip":"SELF","document":"ORGANIZATION"}'::jsonb, now()),
    (id_hr, org_id, 'hr', 'HR', 'Runs people operations day to day: employees from onboarding to exit, attendance, documents, holidays and monthly incentives. Sees all leave, gives the yearly leave and corrects balances. Sees salaries, except those of the people above them.', id_super_admin, true, false, ARRAY['dashboard:read', 'employee:read', 'employee:create', 'employee:update', 'employee:identity:read', 'employee:compensation:read', 'employee:lifecycle:manage', 'attendance:read', 'attendance:punch', 'attendance:mark', 'attendance:update', 'leave:read', 'leave:apply', 'leave:balance:manage', 'leave:type:manage', 'holiday:manage', 'payroll:entry:manage', 'document:read', 'document:upload', 'document:verify', 'document:company:read', 'document:company:manage', 'document:type:manage', 'payslip:read', 'notification:read', 'user:password:set', 'user:device:manage']::text[], '{"employee":"ORGANIZATION","compensation":"ORGANIZATION_EXCEPT_ABOVE","attendance":"ORGANIZATION","leave":"ORGANIZATION","payslip":"SELF","document":"ORGANIZATION"}'::jsonb, now()),
    (id_accounts, org_id, 'accounts', 'Accounts', 'Salaries and payroll: salary structures, the monthly payroll, bank accounts and the bank transfer file.', id_super_admin, true, false, ARRAY['dashboard:read', 'employee:compensation:read', 'employee:bank:read', 'employee:bank:manage', 'payroll:structure:read', 'payroll:structure:manage', 'payroll:run:create', 'payroll:entry:manage', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"ORGANIZATION","attendance":"SELF","leave":"SELF","payslip":"ORGANIZATION","document":"SELF"}'::jsonb, now()),
    (id_manager, org_id, 'manager', 'Manager', 'Leads a team: sees the team''s attendance and leave.', id_hr, true, false, ARRAY['dashboard:read', 'employee:read', 'attendance:read', 'attendance:punch', 'leave:read', 'leave:apply', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"SELF","attendance":"DIRECT_REPORTS","leave":"DIRECT_REPORTS","payslip":"SELF","document":"SELF"}'::jsonb, now()),
    (id_rm, org_id, 'rm', 'Reporting Manager', 'The same as Manager, under a different title.', id_manager, true, false, ARRAY['dashboard:read', 'employee:read', 'attendance:read', 'attendance:punch', 'leave:read', 'leave:apply', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"SELF","attendance":"DIRECT_REPORTS","leave":"DIRECT_REPORTS","payslip":"SELF","document":"SELF"}'::jsonb, now()),
    (id_employee, org_id, 'employee', 'Employee', 'Their own attendance, leave, payslips, documents and bank account.', id_rm, true, false, ARRAY['dashboard:read', 'attendance:read', 'attendance:punch', 'leave:read', 'leave:apply', 'document:read', 'document:upload', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"SELF","compensation":"SELF","attendance":"SELF","leave":"SELF","payslip":"SELF","document":"SELF"}'::jsonb, now());
END
$$;
