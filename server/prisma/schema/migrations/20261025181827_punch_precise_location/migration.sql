-- Precise location only (client, 25 Oct 2026): where a punch reads the
-- location and does not judge it against the office (Location + Selfie, a day
-- away that asks for it), a reading vaguer than this is refused — no camera,
-- no punch. A phone on "Approximate" gives 1–3 km; precise indoors 10–65 m.
-- Every company starts at 100 m; the Super Admin can change it.
ALTER TABLE "Organization" ADD COLUMN     "punchPreciseMeters" INTEGER NOT NULL DEFAULT 100;
