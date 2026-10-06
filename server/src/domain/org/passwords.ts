/**
 * Who sets a login's password (client, 6 Oct 2026; Settings → Users & Roles →
 * Passwords).
 *
 * Three kinds of login, by their role:
 *   an employee login   holds the company's Employee role — the person's own things
 *   a role login        any other role: HR, Accounts, a manager's, an operator's
 *   a Super Admin's     the locked role
 *
 * For an employee login the company chooses between HR (and the Super Admin)
 * setting it, the employee unable to change it — the client's choice — and the
 * employee setting their own from a link. For a role login the same choice is
 * between the Super Admin alone and the person. A Super Admin's own password
 * is always theirs: somebody must be able to change theirs, and no role sits
 * above them to do it.
 *
 * Setting a password FOR somebody is a separate question from whose it is: the
 * Super Admin may set anybody's, a holder of the permission an employee
 * login's, and nobody else a role login's — whichever way the company chose.
 */

export type PasswordSetter = 'company' | 'self'

export interface PasswordRules {
  employeePasswords: PasswordSetter
  rolePasswords: PasswordSetter
  passwordMinLength: number
}

export const DEFAULT_PASSWORD_MIN_LENGTH = 10
/** Settings → Passwords: the fewest characters may be set between these. */
export const PASSWORD_MIN_LENGTH_LIMITS = { min: 8, max: 64 } as const

export type LoginKind = 'employee' | 'role' | 'super_admin'

export function loginKind(role: string, employeeRole: string, locked: boolean): LoginKind {
  if (locked) return 'super_admin'
  return role === employeeRole ? 'employee' : 'role'
}

/**
 * Whose password it is: set for them by the company, or their own. A person
 * who holds the Super Admin panel owns every password of theirs — their
 * employee login's too: nobody above them could set it.
 */
export function passwordSetBy(
  kind: LoginKind,
  rules: Pick<PasswordRules, 'employeePasswords' | 'rolePasswords'>,
  person: { holdsSuperAdmin: boolean } = { holdsSuperAdmin: false },
): PasswordSetter {
  if (kind === 'super_admin' || person.holdsSuperAdmin) return 'self'
  return kind === 'employee' ? rules.employeePasswords : rules.rolePasswords
}

/** Whether the person may change their own password while signed in. */
export function mayChangeOwnPassword(kind: LoginKind, rules: Pick<PasswordRules, 'employeePasswords' | 'rolePasswords'>): boolean {
  return passwordSetBy(kind, rules) === 'self'
}

/**
 * Whether somebody may set this kind of login's password for its owner — the
 * other rules (never their own, only somebody below them, never a senior's
 * other login) apply on top. `holds` is the permission to set passwords.
 */
export function maySetPasswordFor(kind: LoginKind, actor: { locked: boolean; holds: boolean }): boolean {
  if (actor.locked) return true
  return actor.holds && kind === 'employee'
}

/** Who sets it, in words, for a refusal or a notice. */
export function passwordSetterName(kind: LoginKind): string {
  return kind === 'employee' ? 'HR' : 'the Super Admin'
}
