-- CreateTable
CREATE TABLE "BankFileTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "includeHeader" BOOLEAN NOT NULL DEFAULT true,
    "dateFormat" TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
    "narration" TEXT NOT NULL DEFAULT 'Salary {month} {year}',
    "onlyVerified" BOOLEAN NOT NULL DEFAULT true,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BankFileTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankFileTemplate_organizationId_key" ON "BankFileTemplate"("organizationId");

-- AddForeignKey
ALTER TABLE "BankFileTemplate" ADD CONSTRAINT "BankFileTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

