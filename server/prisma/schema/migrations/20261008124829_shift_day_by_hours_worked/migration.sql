-- AlterTable
ALTER TABLE "Shift" ALTER COLUMN "breakMinutes" SET DEFAULT 0;


-- The client's day (8 Oct 2026): eight hours worked is a full day, four and a
-- half a half day, under that absent, and no break taken off — lunch is taken
-- whenever a person likes. Given to every shift still on the old defaults: a
-- 60-minute break on nine hours with no minimums of its own. That is the
-- reference shifts, and any shift added through the old Shifts table without
-- changing its break (archived ones too). A shift with any other break, hours
-- or minimums is left as it is. Days already recorded keep their hours and
-- their status. No audit row: this is the company's own decision, applied once.
UPDATE "Shift"
SET "breakMinutes" = 0, "minFullDayHours" = 8, "minHalfDayHours" = 4.5
WHERE "breakMinutes" = 60
  AND "expectedHours" = 9
  AND "minFullDayHours" IS NULL
  AND "minHalfDayHours" IS NULL;
