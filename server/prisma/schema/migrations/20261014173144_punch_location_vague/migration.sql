-- Location + Selfie (client, 14 Oct 2026): wherever the person is, their
-- current location is kept with the photo, never fenced. One too vague to say
-- where (over 100 m: "precise location" off) is taken, and flagged for HR.

-- AlterEnum
ALTER TYPE "PunchFlag" ADD VALUE 'location_vague';
