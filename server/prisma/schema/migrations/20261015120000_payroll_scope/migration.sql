-- Whose payroll (client, 15 Oct 2026): the Payroll module gets a reach of its
-- own on the Roles screen, like Employees, Salaries, Attendance and Leave —
-- whose salaries, incentives, tax, loans, bank accounts and payslips a role
-- works with. Preparing, approving and paying the month's payroll, and the
-- bank file, stay the whole company's.
--
-- Every role keeps what it reaches on its Payroll pages:
--   · a role that opens Payroll (salary structures), runs it, or reads or
--     keeps bank accounts reached everybody there — the salaries, the runs,
--     the bank accounts: "Whole company". (Its loans and payroll reports
--     followed its salaries reach; with a salaries reach narrower than the
--     whole company — no built-in role has one — they now show the whole
--     company too, as its other Payroll pages already did.)
--   · a role that only enters monthly incentives (HR) entered them for the
--     people whose salaries it sees: its salaries reach;
--   · every other role reached nobody's payroll: "Only their own".
-- A role that already has a payroll reach is left as it is.
UPDATE "Role"
SET "scopes" = COALESCE("scopes", '{}'::jsonb) || jsonb_build_object(
      'payroll',
      CASE
        WHEN "permissions" && ARRAY['payroll:structure:read', 'payroll:structure:manage', 'payroll:run:create', 'payroll:run:approve', 'employee:bank:read', 'employee:bank:manage']::text[]
          THEN 'ORGANIZATION'
        WHEN 'payroll:entry:manage' = ANY ("permissions")
          AND 'employee:compensation:read' = ANY ("permissions")
          AND "scopes"->>'compensation' IN ('SELF', 'DIRECT_REPORTS', 'ALL_REPORTS', 'DEPARTMENT', 'ORGANIZATION_EXCEPT_ABOVE', 'ORGANIZATION')
          THEN "scopes"->>'compensation'
        ELSE 'SELF'
      END
    ),
    "updatedAt" = now()
WHERE NOT (COALESCE("scopes", '{}'::jsonb) ? 'payroll');

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
    (id_super_admin, org_id, 'super_admin', 'Super Admin', 'The owner of the system. Everything, including approving the payroll, reports, the audit log, settings, users and roles.', NULL, true, true, ARRAY['dashboard:read', 'employee:read', 'employee:create', 'employee:update', 'employee:delete', 'employee:lifecycle:manage', 'employee:compensation:read', 'employee:bank:read', 'employee:bank:manage', 'employee:identity:read', 'attendance:read', 'attendance:punch', 'attendance:mark', 'attendance:update', 'attendance:delete', 'leave:read', 'leave:apply', 'leave:balance:manage', 'leave:type:manage', 'holiday:manage', 'payroll:structure:read', 'payroll:structure:manage', 'payroll:run:create', 'payroll:run:approve', 'payroll:entry:manage', 'payslip:read', 'document:read', 'document:upload', 'document:verify', 'document:company:read', 'document:company:manage', 'document:type:manage', 'notification:read', 'report:read', 'settings:read', 'settings:update', 'user:invite', 'user:status:update', 'user:delete', 'membership:role:assign', 'user:password:set', 'user:device:manage', 'audit:read', 'role:manage']::text[], '{"employee":"ORGANIZATION","compensation":"ORGANIZATION","attendance":"ORGANIZATION","leave":"ORGANIZATION","payroll":"ORGANIZATION","payslip":"ORGANIZATION","document":"ORGANIZATION"}'::jsonb, now()),
    (id_admin, org_id, 'admin', 'Admin', 'Looks after employee records and documents.', id_super_admin, true, false, ARRAY['dashboard:read', 'employee:read', 'employee:create', 'employee:update', 'leave:type:manage', 'document:read', 'document:upload', 'document:verify', 'document:company:read', 'document:company:manage', 'document:type:manage', 'payslip:read', 'notification:read', 'user:device:manage']::text[], '{"employee":"ORGANIZATION","compensation":"SELF","attendance":"SELF","leave":"SELF","payroll":"SELF","payslip":"SELF","document":"ORGANIZATION"}'::jsonb, now()),
    (id_hr, org_id, 'hr', 'HR', 'Runs people operations day to day: employees from onboarding to exit, attendance, documents, holidays and monthly incentives. Sees all leave, gives the yearly leave and corrects balances. Sees salaries, except those of the people above them.', id_super_admin, true, false, ARRAY['dashboard:read', 'employee:read', 'employee:create', 'employee:update', 'employee:identity:read', 'employee:compensation:read', 'employee:lifecycle:manage', 'attendance:read', 'attendance:punch', 'attendance:mark', 'attendance:update', 'leave:read', 'leave:apply', 'leave:balance:manage', 'leave:type:manage', 'holiday:manage', 'payroll:entry:manage', 'document:read', 'document:upload', 'document:verify', 'document:company:read', 'document:company:manage', 'document:type:manage', 'payslip:read', 'notification:read', 'user:password:set', 'user:device:manage']::text[], '{"employee":"ORGANIZATION","compensation":"ORGANIZATION_EXCEPT_ABOVE","attendance":"ORGANIZATION","leave":"ORGANIZATION","payroll":"ORGANIZATION_EXCEPT_ABOVE","payslip":"SELF","document":"ORGANIZATION"}'::jsonb, now()),
    (id_accounts, org_id, 'accounts', 'Accounts', 'Salaries and payroll: salary structures, the monthly payroll, bank accounts and the bank transfer file.', id_super_admin, true, false, ARRAY['dashboard:read', 'employee:compensation:read', 'employee:bank:read', 'employee:bank:manage', 'payroll:structure:read', 'payroll:structure:manage', 'payroll:run:create', 'payroll:entry:manage', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"ORGANIZATION","attendance":"SELF","leave":"SELF","payroll":"ORGANIZATION","payslip":"ORGANIZATION","document":"SELF"}'::jsonb, now()),
    (id_manager, org_id, 'manager', 'Manager', 'Leads a team: sees the team''s attendance and leave.', id_hr, true, false, ARRAY['dashboard:read', 'employee:read', 'attendance:read', 'attendance:punch', 'leave:read', 'leave:apply', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"SELF","attendance":"DIRECT_REPORTS","leave":"DIRECT_REPORTS","payroll":"SELF","payslip":"SELF","document":"SELF"}'::jsonb, now()),
    (id_rm, org_id, 'rm', 'Reporting Manager', 'The same as Manager, under a different title.', id_manager, true, false, ARRAY['dashboard:read', 'employee:read', 'attendance:read', 'attendance:punch', 'leave:read', 'leave:apply', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"ORGANIZATION","compensation":"SELF","attendance":"DIRECT_REPORTS","leave":"DIRECT_REPORTS","payroll":"SELF","payslip":"SELF","document":"SELF"}'::jsonb, now()),
    (id_employee, org_id, 'employee', 'Employee', 'Their own attendance, leave, payslips, documents and bank account.', id_rm, true, false, ARRAY['dashboard:read', 'attendance:read', 'attendance:punch', 'leave:read', 'leave:apply', 'document:read', 'document:upload', 'payslip:read', 'document:company:read', 'notification:read']::text[], '{"employee":"SELF","compensation":"SELF","attendance":"SELF","leave":"SELF","payroll":"SELF","payslip":"SELF","document":"SELF"}'::jsonb, now());
END
$$;
