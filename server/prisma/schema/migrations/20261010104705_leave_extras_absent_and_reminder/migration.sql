-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "sourceBeforeLeave" "AttendanceSource",
ADD COLUMN     "statusBeforeLeave" "AttendanceStatus";

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "leaveYearEndReminderDays" INTEGER NOT NULL DEFAULT 30;

