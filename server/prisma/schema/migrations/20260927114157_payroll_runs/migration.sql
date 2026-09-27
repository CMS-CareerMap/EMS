-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('draft', 'approved', 'paid');

-- CreateEnum
CREATE TYPE "LopBasis" AS ENUM ('calendar_days', 'fixed_30', 'working_days');

-- AlterTable
ALTER TABLE "OrganizationPolicy" ADD COLUMN     "lopBasis" "LopBasis" NOT NULL DEFAULT 'calendar_days',
ADD COLUMN     "sandwichRule" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'draft',
    "lopBasis" "LopBasis" NOT NULL,
    "sandwichRule" BOOLEAN NOT NULL,
    "employeeCount" INTEGER NOT NULL,
    "grossEarnings" DECIMAL(14,2) NOT NULL,
    "totalDeductions" DECIMAL(14,2) NOT NULL,
    "netPayable" DECIMAL(14,2) NOT NULL,
    "employerPf" DECIMAL(14,2) NOT NULL,
    "employerEsi" DECIMAL(14,2) NOT NULL,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByUserId" TEXT,
    "calculatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payslip" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "designation" TEXT,
    "department" TEXT,
    "daysInMonth" INTEGER NOT NULL,
    "employmentDays" INTEGER NOT NULL,
    "lopDays" DECIMAL(4,1) NOT NULL,
    "paidDays" DECIMAL(4,1) NOT NULL,
    "ncpDays" DECIMAL(4,1) NOT NULL,
    "lopBasis" "LopBasis" NOT NULL,
    "payBasisDays" INTEGER NOT NULL,
    "payableDays" DECIMAL(4,1) NOT NULL,
    "grossEarnings" DECIMAL(12,2) NOT NULL,
    "pfWages" DECIMAL(12,2) NOT NULL,
    "employeePf" DECIMAL(12,2) NOT NULL,
    "employeeEsi" DECIMAL(12,2) NOT NULL,
    "professionalTax" DECIMAL(12,2) NOT NULL,
    "tds" DECIMAL(12,2) NOT NULL,
    "otherDeductions" DECIMAL(12,2) NOT NULL,
    "totalDeductions" DECIMAL(12,2) NOT NULL,
    "netPayable" DECIMAL(12,2) NOT NULL,
    "employerPf" DECIMAL(12,2) NOT NULL,
    "employerEps" DECIMAL(12,2) NOT NULL,
    "employerEpf" DECIMAL(12,2) NOT NULL,
    "employerEsi" DECIMAL(12,2) NOT NULL,
    "basis" JSONB NOT NULL,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayslipLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "payslipId" TEXT NOT NULL,
    "kind" "ComponentType" NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "rate" DECIMAL(12,2),
    "amount" DECIMAL(12,2) NOT NULL,
    "displayOrder" INTEGER NOT NULL,

    CONSTRAINT "PayslipLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeTdsDirective" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "financialYear" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "monthlyAmount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT,
    "enteredByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmployeeTdsDirective_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeMonthlyEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "salaryComponentId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "enteredByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmployeeMonthlyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_organizationId_year_month_key" ON "PayrollRun"("organizationId", "year", "month");

-- CreateIndex
CREATE INDEX "Payslip_organizationId_employeeId_year_month_idx" ON "Payslip"("organizationId", "employeeId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "Payslip_organizationId_payrollRunId_employeeId_key" ON "Payslip"("organizationId", "payrollRunId", "employeeId");

-- CreateIndex
CREATE INDEX "PayslipLine_organizationId_payslipId_idx" ON "PayslipLine"("organizationId", "payslipId");

-- CreateIndex
CREATE INDEX "EmployeeTdsDirective_organizationId_financialYear_idx" ON "EmployeeTdsDirective"("organizationId", "financialYear");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeTdsDirective_organizationId_employeeId_effectiveFro_key" ON "EmployeeTdsDirective"("organizationId", "employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "EmployeeMonthlyEntry_organizationId_year_month_idx" ON "EmployeeMonthlyEntry"("organizationId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeMonthlyEntry_organizationId_employeeId_salaryCompon_key" ON "EmployeeMonthlyEntry"("organizationId", "employeeId", "salaryComponentId", "year", "month");

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayslipLine" ADD CONSTRAINT "PayslipLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayslipLine" ADD CONSTRAINT "PayslipLine_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "Payslip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTdsDirective" ADD CONSTRAINT "EmployeeTdsDirective_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTdsDirective" ADD CONSTRAINT "EmployeeTdsDirective_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeMonthlyEntry" ADD CONSTRAINT "EmployeeMonthlyEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeMonthlyEntry" ADD CONSTRAINT "EmployeeMonthlyEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeMonthlyEntry" ADD CONSTRAINT "EmployeeMonthlyEntry_salaryComponentId_fkey" FOREIGN KEY ("salaryComponentId") REFERENCES "SalaryComponent"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

