-- CreateTable
CREATE TABLE "LeaveYearEndNotice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveYear" INTEGER NOT NULL,
    "days" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveYearEndNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeaveYearEndNotice_organizationId_employeeId_leaveYear_key" ON "LeaveYearEndNotice"("organizationId", "employeeId", "leaveYear");

-- AddForeignKey
ALTER TABLE "LeaveYearEndNotice" ADD CONSTRAINT "LeaveYearEndNotice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveYearEndNotice" ADD CONSTRAINT "LeaveYearEndNotice_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

