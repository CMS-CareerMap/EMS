-- CreateEnum
CREATE TYPE "RequestType" AS ENUM ('attendance_correction', 'work_from_home', 'on_duty', 'overtime', 'profile_change');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'withdrawn');

-- CreateEnum
CREATE TYPE "RequestApprover" AS ENUM ('manager', 'hr');

-- CreateEnum
CREATE TYPE "WorkMode" AS ENUM ('office', 'wfh', 'on_duty', 'remote');

-- CreateEnum
CREATE TYPE "WorkArrangement" AS ENUM ('office', 'hybrid', 'remote');

-- AlterEnum
ALTER TYPE "AttendanceSource" ADD VALUE 'correction';

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "checkInDevice" TEXT,
ADD COLUMN     "workMode" "WorkMode";

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "address" TEXT,
ADD COLUMN     "dateOfBirth" DATE,
ADD COLUMN     "emergencyContactName" TEXT,
ADD COLUMN     "emergencyContactPhone" TEXT,
ADD COLUMN     "emergencyContactRelation" TEXT,
ADD COLUMN     "nationality" TEXT,
ADD COLUMN     "workArrangement" "WorkArrangement" NOT NULL DEFAULT 'office';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "correctionApprover" "RequestApprover" NOT NULL DEFAULT 'manager',
ADD COLUMN     "overtimeApprover" "RequestApprover" NOT NULL DEFAULT 'manager',
ADD COLUMN     "profileApprover" "RequestApprover" NOT NULL DEFAULT 'hr',
ADD COLUMN     "wfhApprover" "RequestApprover" NOT NULL DEFAULT 'manager',
ADD COLUMN     "wfhGpsRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EmployeeRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "type" "RequestType" NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'pending',
    "fromDate" DATE,
    "toDate" DATE,
    "details" JSONB NOT NULL DEFAULT '{}',
    "reason" TEXT NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "attachmentKey" TEXT,
    "attachmentName" TEXT,
    "attachmentType" TEXT,
    "attachmentBytes" INTEGER,
    "attachmentSha256" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmployeeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeRequest_organizationId_status_idx" ON "EmployeeRequest"("organizationId", "status");

-- CreateIndex
CREATE INDEX "EmployeeRequest_organizationId_employeeId_type_idx" ON "EmployeeRequest"("organizationId", "employeeId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeRequest_organizationId_number_key" ON "EmployeeRequest"("organizationId", "number");

-- AddForeignKey
ALTER TABLE "EmployeeRequest" ADD CONSTRAINT "EmployeeRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeRequest" ADD CONSTRAINT "EmployeeRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

