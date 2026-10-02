/**
 * A person's logins, taken together (Day 23). Pure.
 *
 * Somebody who holds a role has two logins — an employee login for their own
 * things and a role login for the role's work, each with its own email — and
 * both are the SAME person in the company tree. So every rule about a person
 * (who can sign in, who holds the Super Admin panel, what work they do) asks
 * all of their logins, never one: an HR head is "somebody who checks bank
 * accounts" whichever of the two they signed in with, and their own bank
 * account goes up the tree from both.
 *
 * A login that is switched off, or still only invited, counts for nothing.
 */

export interface LoginFacts {
  status: 'active' | 'inactive' | 'invited'
  roleDef: { locked: boolean; permissions?: readonly string[] }
}

/** The logins that can sign in now. */
export function liveLogins<T extends LoginFacts>(logins: readonly T[]): T[] {
  return logins.filter((l) => l.status === 'active')
}

/** Has a login that can sign in — somebody who could decide or act at all. */
export function canSignIn(logins: readonly LoginFacts[]): boolean {
  return logins.some((l) => l.status === 'active')
}

/** Holds the Super Admin panel on a login that can sign in. */
export function holdsSuperAdmin(logins: readonly LoginFacts[]): boolean {
  return logins.some((l) => l.status === 'active' && l.roleDef.locked)
}

/** Everything the person's live logins may do, together. */
export function permissionsOf(logins: readonly LoginFacts[]): Set<string> {
  return new Set(liveLogins(logins).flatMap((l) => l.roleDef.permissions ?? []))
}

export interface LoginKind {
  id: string
  /** The role's key. */
  role: string
  status: 'active' | 'inactive' | 'invited'
}

/**
 * Is this the person's EMPLOYEE login, while they also have a live role
 * login? Then it is for their own things only — punching in, their own leave,
 * documents, payslips and bank account — and the company tree's decisions
 * (their team's leave) are made from the role login, as the client asked.
 *
 * This names a kind of login, in the client's words, not an access decision:
 * what either login may do is still its role's permissions. `employeeRole` is
 * the key of the role every login gets unless somebody chooses another.
 * Somebody whose role login is only invited, or switched off, still decides
 * from the employee login, so nothing they decide is left waiting.
 */
export function isSelfServiceLogin(login: LoginKind, personLogins: readonly LoginKind[], employeeRole: string): boolean {
  if (login.role !== employeeRole) return false
  return personLogins.some((other) => other.id !== login.id && other.status === 'active' && other.role !== employeeRole)
}

/**
 * The logins a person decides from: all not switched off, less their employee
 * login when they have a live role login (`isSelfServiceLogin`).
 */
export function decidingLogins<T extends LoginKind>(personLogins: readonly T[], employeeRole: string): T[] {
  return personLogins.filter((l) => l.status !== 'inactive' && !isSelfServiceLogin(l, personLogins, employeeRole))
}
