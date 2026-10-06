-- Passwords set by the company (client, 6 Oct 2026; migration
-- 20261006020727_hr_sets_passwords made it every company's setting). A link
-- handed out before then is spent, for good: switching Settings → Passwords
-- back to "the person" later must never bring an old link back to life.
-- A Super Admin's password is always their own, so the links of a login
-- holding the Super Admin panel are kept.
UPDATE "PasswordResetToken" t
SET "usedAt" = now()
WHERE t."usedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "Membership" m
    JOIN "Role" r ON r."organizationId" = m."organizationId" AND r."key" = m."role"
    WHERE m."userId" = t."userId" AND r."locked" = true
  );
