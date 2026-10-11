-- CreateEnum
CREATE TYPE "MachineMatch" AS ENUM ('confirmed', 'time_differs', 'not_on_machine', 'from_machine');

-- CreateEnum
CREATE TYPE "MachineMissing" AS ENUM ('flag', 'absent');

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "machineCheckedAt" TIMESTAMPTZ(3),
ADD COLUMN     "machineFirstScan" TIMESTAMPTZ(3),
ADD COLUMN     "machineLastScan" TIMESTAMPTZ(3),
ADD COLUMN     "machineMatch" "MachineMatch",
ADD COLUMN     "statusBeforeMachine" "AttendanceStatus";

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "machineId" TEXT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "punchMachineFills" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "punchMachineMatch" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "punchMachineMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "punchMachineMissing" "MachineMissing" NOT NULL DEFAULT 'flag';

-- CreateIndex
CREATE UNIQUE INDEX "Employee_organizationId_machineId_key" ON "Employee"("organizationId", "machineId");

