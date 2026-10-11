-- CreateEnum
CREATE TYPE "PunchFlag" AS ENUM ('frozen_readings', 'repeated_spot', 'too_precise', 'stale_reading', 'not_a_phone');

-- AlterEnum
ALTER TYPE "PunchRefusal" ADD VALUE 'not_phone';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "punchPhoneOnly" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "PunchEvidence" ADD COLUMN     "flags" "PunchFlag"[] DEFAULT ARRAY[]::"PunchFlag"[];

