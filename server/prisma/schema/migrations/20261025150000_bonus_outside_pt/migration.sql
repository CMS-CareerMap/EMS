-- Bonus is outside the salary professional tax is charged on: the Maharashtra
-- PT Act's "salary or wage" "does not include bonus in any form". Bonus was
-- made counting for PT (20261003191940); from now on it does not, as decided on
-- 27 Sep 2026. Payroll → Components can still switch it. Payslips already
-- made keep what they say; a draft is recalculated before it can be approved.
UPDATE "SalaryComponent"
SET "countsForPt" = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'BONUS' AND "countsForPt" = true;
