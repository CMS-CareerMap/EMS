-- AlterTable
ALTER TABLE "PayrollRun" ADD COLUMN     "approvedAt" TIMESTAMPTZ(3),
ADD COLUMN     "approvedByUserId" TEXT,
ADD COLUMN     "assumedDays" INTEGER,
ADD COLUMN     "employerAddress" TEXT,
ADD COLUMN     "employerName" TEXT,
ADD COLUMN     "paidAt" TIMESTAMPTZ(3),
ADD COLUMN     "paidByUserId" TEXT,
ADD COLUMN     "paidOn" DATE;

-- AlterTable
ALTER TABLE "Payslip" ADD COLUMN     "country" TEXT NOT NULL DEFAULT 'IN',
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "dateOfJoining" DATE,
ADD COLUMN     "esicNumber" TEXT,
ADD COLUMN     "pan" TEXT,
ADD COLUMN     "pdfBytes" INTEGER,
ADD COLUMN     "pdfGeneratedAt" TIMESTAMPTZ(3),
ADD COLUMN     "pdfKey" TEXT,
ADD COLUMN     "pdfSha256" TEXT,
ADD COLUMN     "pfMemberId" TEXT,
ADD COLUMN     "uan" TEXT;

-- CreateIndex
CREATE INDEX "PayrollRun_organizationId_status_idx" ON "PayrollRun"("organizationId", "status");

