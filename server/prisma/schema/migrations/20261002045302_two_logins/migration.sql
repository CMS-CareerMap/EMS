-- Day 23: a person can have more than one login.
--
-- The link between a login and a person moves from Employee.membershipId (one
-- login per person, unique) to Membership.employeeId (any number of logins per
-- person). Every existing link is copied across BEFORE the old column goes, so
-- nobody loses the login they have today.

-- 1. The new column, empty.
ALTER TABLE "Membership" ADD COLUMN "employeeId" TEXT;

-- 2. Every login that is linked to a person today keeps that person.
UPDATE "Membership" m
SET "employeeId" = e."id"
FROM "Employee" e
WHERE e."membershipId" = m."id";

-- 3. Its indexes and foreign key.
CREATE INDEX "Membership_employeeId_idx" ON "Membership"("employeeId");

CREATE UNIQUE INDEX "Membership_organizationId_employeeId_role_key" ON "Membership"("organizationId", "employeeId", "role");

ALTER TABLE "Membership" ADD CONSTRAINT "Membership_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. The old link, now copied.
ALTER TABLE "Employee" DROP CONSTRAINT "Employee_membershipId_fkey";

DROP INDEX "Employee_membershipId_key";

ALTER TABLE "Employee" DROP COLUMN "membershipId";
