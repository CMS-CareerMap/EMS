-- Day 21: roles move from a fixed list in code (the "Role" enum) to a table
-- the Super Admin edits on Settings → Roles & Permissions.
--
-- Written by hand around what Prisma generated, which would have done damage:
-- it DROPPED Membership.role and added it again, turning every login into an
-- employee; and it created the "Role" table while the enum type of that name
-- still existed, which Postgres refuses (a table is also a type).

-- 1. Membership.role: the enum becomes text, every value kept as it was.
ALTER TABLE "Membership" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "Membership" ALTER COLUMN "role" SET DATA TYPE TEXT USING "role"::text;
ALTER TABLE "Membership" ALTER COLUMN "role" SET DEFAULT 'employee';

-- 2. The enum goes, which frees its name for the table.
DROP TYPE "Role";

-- 3. The table.
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "parentId" TEXT,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "permissions" TEXT[],
    "scopes" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Role_parentId_idx" ON "Role"("parentId");

CREATE UNIQUE INDEX "Role_organizationId_key_key" ON "Role"("organizationId", "key");

ALTER TABLE "Role" ADD CONSTRAINT "Role_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Role" ADD CONSTRAINT "Role_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Role"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 4. The seven built-in roles. GENERATED from server/src/platform/authz/
--    defaultRoles.ts, not typed — and roles.test.ts fails if a company's
--    seeded roles ever differ from that file. To change a default later,
--    change defaultRoles.ts and replace this function in a new migration.
CREATE FUNCTION ems_seed_default_roles(org_id TEXT) RETURNS void LANGUAGE plpgsql AS $$
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
    (id_super_admin, org_id, 'super_admin', 'Super Admin', 'The owner of the system. Everything, including approving the payroll, reports, the audit log, settings, users and roles.', NULL, true, true, ARRAY['dashboard:read', 'employee:read', 'employee:create', 'employee:update', 'employee:delete', 'employee:compensation:read', 'employee:bank:read', 'employee:bank:manage', 'employee:identity:read', 'attendance:read', 'attendance:punch', 'attendance:mark', 'attendance:update', 'attendance:delete', 'leave:read', 'leave:apply', 'leave:approve', 'leave:balance:manage', 'leave:type:manage', 'holiday:manage', 'payroll:structure:read', 'payroll:structure:manage', 'payroll:run:create', 'payroll:run:approve', 'payroll:entry:manage', 'payslip:read', 'document:read', 'document:upload', 'document:verify', 'document:company:read', 'document:company:manage', 'document:type:manage', 'notification:read', 'report:read', 'settings:read', 'settings:update', 'user:invite', 'user:status:update', 'user:delete', 'membership:role:assign', 'audit:read', 'role:manage']::text[], '{"employee":"ORGANIZATION","compensation":"ORGANIZATION","attendance":"ORGANIZATION","leave":"ORGANIZATION","payslip":"ORGANIZATION","document":"ORGANIZATION"}'::jsonb, now()),
    (id_admin, org_id, 'admin', 'Admin', 'Looks after employee records and documents.', id_super_admin, true, false, ARRAY['dashboard:read', 'employee:read', 'employee:create', 'employee:update', 'leave:type:manage', 'document:read', 'document:upload', 'document:verify', 'document:company:read', 'document:company:manage', 'document:type:manage', 'payslip:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"SELF","attendance":"SELF","leave":"SELF","payslip":"SELF","document":"ORGANIZATION"}'::jsonb, now()),
    (id_hr, org_id, 'hr', 'HR', 'Runs people operations day to day: employees, attendance, leave, documents, holidays and monthly incentives.', id_super_admin, true, false, ARRAY['dashboard:read', 'employee:read', 'employee:create', 'employee:update', 'employee:identity:read', 'attendance:read', 'attendance:punch', 'attendance:mark', 'attendance:update', 'attendance:delete', 'leave:read', 'leave:apply', 'leave:approve', 'leave:balance:manage', 'leave:type:manage', 'holiday:manage', 'payroll:entry:manage', 'document:read', 'document:upload', 'document:verify', 'document:company:read', 'document:company:manage', 'document:type:manage', 'payslip:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"SELF","attendance":"ORGANIZATION","leave":"ORGANIZATION","payslip":"SELF","document":"ORGANIZATION"}'::jsonb, now()),
    (id_accounts, org_id, 'accounts', 'Accounts', 'Salaries and payroll: salary structures, the monthly payroll, bank accounts and the bank transfer file.', id_super_admin, true, false, ARRAY['dashboard:read', 'employee:compensation:read', 'employee:bank:read', 'employee:bank:manage', 'payroll:structure:read', 'payroll:structure:manage', 'payroll:run:create', 'payroll:entry:manage', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"ORGANIZATION","attendance":"SELF","leave":"SELF","payslip":"ORGANIZATION","document":"SELF"}'::jsonb, now()),
    (id_manager, org_id, 'manager', 'Manager', 'Leads a team: sees the team''s attendance and leave, and approves the team''s leave.', id_hr, true, false, ARRAY['dashboard:read', 'employee:read', 'attendance:read', 'attendance:punch', 'leave:read', 'leave:apply', 'leave:approve', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"SELF","attendance":"DIRECT_REPORTS","leave":"DIRECT_REPORTS","payslip":"SELF","document":"SELF"}'::jsonb, now()),
    (id_rm, org_id, 'rm', 'Reporting Manager', 'The same as Manager, under a different title.', id_manager, true, false, ARRAY['dashboard:read', 'employee:read', 'attendance:read', 'attendance:punch', 'leave:read', 'leave:apply', 'leave:approve', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"SELF","attendance":"DIRECT_REPORTS","leave":"DIRECT_REPORTS","payslip":"SELF","document":"SELF"}'::jsonb, now()),
    (id_employee, org_id, 'employee', 'Employee', 'Their own attendance, leave, payslips, documents and bank account.', id_rm, true, false, ARRAY['dashboard:read', 'attendance:read', 'attendance:punch', 'leave:read', 'leave:apply', 'document:read', 'document:upload', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"SELF","compensation":"SELF","attendance":"SELF","leave":"SELF","payslip":"SELF","document":"SELF"}'::jsonb, now());
END
$$;

-- 5. For every company that already exists…
SELECT ems_seed_default_roles("id") FROM "Organization";

-- 6. …and for every company created from now on, by whatever path: bootstrap,
--    a test, a hand-written INSERT. (A full restore is unaffected: pg_restore
--    loads the rows before it creates triggers.)
CREATE FUNCTION ems_organization_default_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ems_seed_default_roles(NEW."id");
  RETURN NEW;
END
$$;

CREATE TRIGGER "Organization_default_roles" AFTER INSERT ON "Organization" FOR EACH ROW EXECUTE FUNCTION ems_organization_default_roles();

-- 7. Every login points at a real role of its own company, by key. NO ACTION:
--    a role somebody holds cannot be deleted, and deleting a whole company
--    still works, because its logins and roles go in the same statement.
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_role_fkey" FOREIGN KEY ("organizationId", "role") REFERENCES "Role"("organizationId", "key") ON DELETE NO ACTION ON UPDATE NO ACTION;
