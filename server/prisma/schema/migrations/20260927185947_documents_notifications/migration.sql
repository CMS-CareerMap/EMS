-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('pending', 'verified', 'rejected');

-- CreateEnum
CREATE TYPE "CompanyDocumentCategory" AS ENUM ('policy', 'handbook', 'template', 'announcement', 'other');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('leave', 'payroll', 'document', 'bank', 'account', 'announcement', 'system');

-- AlterTable
ALTER TABLE "EmployeeBankAccount" ADD COLUMN     "proofBytes" INTEGER,
ADD COLUMN     "proofContentType" TEXT,
ADD COLUMN     "proofSha256" TEXT,
ADD COLUMN     "proofUploadedAt" TIMESTAMPTZ(3),
ADD COLUMN     "submittedByUserId" TEXT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "maxUploadMb" INTEGER NOT NULL DEFAULT 2;

-- CreateTable
CREATE TABLE "DocumentType" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "DocumentType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeDocument" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "documentTypeId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'pending',
    "remarks" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "uploadedByUserId" TEXT,
    "uploadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMPTZ(3),
    "removedAt" TIMESTAMPTZ(3),
    "removedByUserId" TEXT,

    CONSTRAINT "EmployeeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyDocument" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "CompanyDocumentCategory" NOT NULL DEFAULT 'policy',
    "description" TEXT,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedByUserId" TEXT,
    "uploadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMPTZ(3),
    "removedByUserId" TEXT,

    CONSTRAINT "CompanyDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationSetting" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NotificationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentType_organizationId_archivedAt_idx" ON "DocumentType"("organizationId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentType_organizationId_code_key" ON "DocumentType"("organizationId", "code");

-- CreateIndex
CREATE INDEX "EmployeeDocument_organizationId_employeeId_documentTypeId_idx" ON "EmployeeDocument"("organizationId", "employeeId", "documentTypeId");

-- CreateIndex
CREATE INDEX "EmployeeDocument_organizationId_status_idx" ON "EmployeeDocument"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CompanyDocument_organizationId_removedAt_idx" ON "CompanyDocument"("organizationId", "removedAt");

-- CreateIndex
CREATE INDEX "Notification_organizationId_userId_createdAt_idx" ON "Notification"("organizationId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_organizationId_userId_readAt_idx" ON "Notification"("organizationId", "userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationSetting_organizationId_event_key" ON "NotificationSetting"("organizationId", "event");

-- AddForeignKey
ALTER TABLE "DocumentType" ADD CONSTRAINT "DocumentType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_documentTypeId_fkey" FOREIGN KEY ("documentTypeId") REFERENCES "DocumentType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyDocument" ADD CONSTRAINT "CompanyDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationSetting" ADD CONSTRAINT "NotificationSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Starting checklist for every company that already exists; a new company
-- gets the same list from bootstrap (prisma/seed/referenceData.ts). Editable
-- in Settings → Documents. Skipped where a company already has the code.
INSERT INTO "DocumentType" ("id", "organizationId", "code", "label", "required", "displayOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o."id", t.code, t.label, t.required, t.ord, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Organization" o
CROSS JOIN (VALUES
  ('offer_letter', 'Offer Letter', true, 1),
  ('aadhaar', 'Aadhaar Card', true, 2),
  ('pan', 'PAN Card', true, 3),
  ('resume', 'Resume / CV', true, 4),
  ('passport', 'Passport', false, 5),
  ('edu_certificate', 'Education Certificate', false, 6),
  ('exp_letter', 'Experience Letter', false, 7),
  ('other', 'Other Document', false, 8)
) AS t(code, label, required, ord)
ON CONFLICT ("organizationId", "code") DO NOTHING;
