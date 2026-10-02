-- Day 23: a login goes with its person. EMS never hard-deletes an employee
-- row, but if one were deleted, SET NULL would leave their HR or Accounts
-- login with no person — outside every rule about "your own" while keeping
-- its role. Nothing in the data changes.
ALTER TABLE "Membership" DROP CONSTRAINT "Membership_employeeId_fkey";

ALTER TABLE "Membership" ADD CONSTRAINT "Membership_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
