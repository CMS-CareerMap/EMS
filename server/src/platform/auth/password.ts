import bcrypt from 'bcryptjs'

/**
 * Password hashing.
 *
 * bcryptjs rather than bcrypt: it is pure JavaScript, so there is no native
 * build step to fail on Windows or on a slim deploy image. Slower, but hashing
 * happens twice per login at most.
 */

/**
 * Cost factor. Each increment doubles the work. 12 costs roughly a quarter of a
 * second on modern hardware — slow enough to make offline cracking expensive,
 * fast enough that nobody notices logging in.
 */
const COST = 12

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST)
}

/**
 * Always compare through bcrypt, even when the stored hash is null — an
 * invited user who has not set a password must take the same time to reject as
 * a wrong password, or the timing difference reveals which accounts exist.
 */
export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  if (!hash) {
    await bcrypt.compare(plain, DUMMY_HASH)
    return false
  }
  return bcrypt.compare(plain, hash)
}

/** A real bcrypt hash of a value nobody knows, used only to burn time. */
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.0OaAkKn7VeCa5.d0/BnZzLBr2q8Z8Ry'

/**
 * Minimum policy. Deliberately about length rather than character classes —
 * length is what actually resists cracking, and complexity rules mostly produce
 * P@ssw0rd1. The fewest characters is the company's setting (Settings →
 * Passwords, 10 unless changed); bootstrap, before there is a company, uses 10.
 */
export function passwordProblem(plain: string, minLength = 10): string | null {
  if (plain.length < minLength) return `Password must be at least ${minLength} characters`
  if (plain.length > 200) return 'Password must be at most 200 characters'
  if (/^\s|\s$/.test(plain)) return 'Password must not start or end with a space'
  return null
}
