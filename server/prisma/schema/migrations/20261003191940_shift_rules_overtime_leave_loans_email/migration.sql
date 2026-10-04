-- CreateEnum
CREATE TYPE "LeaveAccrual" AS ENUM ('yearly', 'monthly');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('pending', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "LoanKind" AS ENUM ('loan', 'advance');

-- CreateEnum
CREATE TYPE "PayBasis" AS ENUM ('gross', 'basic');

-- AlterEnum
ALTER TYPE "LeaveLedgerReason" ADD VALUE 'encashed';

-- AlterEnum
ALTER TYPE "RequestType" ADD VALUE 'leave_encashment';

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "earlyLeavingMinutes" INTEGER,
ADD COLUMN     "lateMinutes" INTEGER,
ADD COLUMN     "overtimeMinutes" INTEGER;

-- AlterTable
ALTER TABLE "LeaveRequest" ADD COLUMN     "halfDaySessions" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "LeaveType" ADD COLUMN     "accrual" "LeaveAccrual" NOT NULL DEFAULT 'yearly',
ADD COLUMN     "countsNonWorkingDays" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "eligibleAfterDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "eligibleGender" "Gender",
ADD COLUMN     "encashMaxDaysPerYear" DECIMAL(5,2),
ADD COLUMN     "encashable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "halfDayAllowed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "maxDaysPerRequest" DECIMAL(5,2),
ADD COLUMN     "minNoticeDays" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "NotificationSetting" ADD COLUMN     "email" BOOLEAN;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "encashmentApprover" "RequestApprover" NOT NULL DEFAULT 'hr';

-- AlterTable
ALTER TABLE "OrganizationPolicy" ADD COLUMN     "encashmentBasis" "PayBasis" NOT NULL DEFAULT 'basic',
ADD COLUMN     "overtimeBasis" "PayBasis" NOT NULL DEFAULT 'gross',
ADD COLUMN     "overtimeEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "overtimeRate" DECIMAL(4,2) NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "SalaryComponent" ADD COLUMN     "countsForEsi" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "countsForPt" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "earlyLeavingMinutes" INTEGER,
ADD COLUMN     "graceMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lateThresholdMinutes" INTEGER,
ADD COLUMN     "minFullDayHours" DECIMAL(4,2),
ADD COLUMN     "minHalfDayHours" DECIMAL(4,2),
ADD COLUMN     "overtimeAfterMinutes" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "EmailOutbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeLoan" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" "LoanKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "installment" DECIMAL(12,2) NOT NULL,
    "startYear" INTEGER NOT NULL,
    "startMonth" INTEGER NOT NULL,
    "note" TEXT,
    "closedAt" TIMESTAMPTZ(3),
    "closedNote" TEXT,
    "closedByUserId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmployeeLoan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanRecovery" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "payslipId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "LoanRecovery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailOutbox_status_createdAt_idx" ON "EmailOutbox"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_organizationId_createdAt_idx" ON "EmailOutbox"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "EmployeeLoan_organizationId_employeeId_idx" ON "EmployeeLoan"("organizationId", "employeeId");

-- CreateIndex
CREATE INDEX "LoanRecovery_organizationId_payslipId_idx" ON "LoanRecovery"("organizationId", "payslipId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanRecovery_organizationId_loanId_payslipId_key" ON "LoanRecovery"("organizationId", "loanId", "payslipId");

-- AddForeignKey
ALTER TABLE "EmailOutbox" ADD CONSTRAINT "EmailOutbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeLoan" ADD CONSTRAINT "EmployeeLoan_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeLoan" ADD CONSTRAINT "EmployeeLoan_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanRecovery" ADD CONSTRAINT "LoanRecovery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanRecovery" ADD CONSTRAINT "LoanRecovery_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "EmployeeLoan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanRecovery" ADD CONSTRAINT "LoanRecovery_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "Payslip"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Bonus and Commission (client §40), entered per employee per month like an
-- incentive. A bonus is outside ESI wages; both count for professional tax
-- until the accountant says otherwise. A company that already has the code
-- keeps its own.
INSERT INTO "SalaryComponent" ("id", "organizationId", "code", "label", "type", "entry", "countsForPf", "taxable", "countsForEsi", "countsForPt", "displayOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o."id", c.code, c.label, 'earning', 'monthly', false, true, c.esi, true, c.ord, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Organization" o
CROSS JOIN (VALUES ('BONUS', 'Bonus', false, 7), ('COMMISSION', 'Commission', true, 8)) AS c(code, label, esi, ord)
ON CONFLICT ("organizationId", "code") DO NOTHING;
