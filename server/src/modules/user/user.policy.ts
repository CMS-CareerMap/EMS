import { grantsMoreThan, type RoleGrant } from '../../platform/authz/grant'
import { isBelow, type RoleNode } from '../../platform/authz/roleOrder'

/**
 * The rules that stop role assignment from becoming a way to seize the system.
 *
 * Pure functions, no database, no context object — so every one of them can be
 * tested exhaustively across every combination of roles in milliseconds, which
 * is what makes it reasonable to check every combination rather than the two
 * somebody thought of.
 *
 * Since Day 21 roles are rows the Super Admin edits, so each rule is handed the
 * roles as they stand (their grants and their order) rather than looking a
 * name up in code.
 */

/** A role as these rules need it: what it allows, where it sits, whether it is the Super Admin's. */
export interface PolicyRole extends RoleNode {
  grant: RoleGrant
  /** The Super Admin role: the top of the order, edited by nobody. */
  locked: boolean
}

/**
 * May `actor` hand out `candidate`?
 *
 * Two tests, and both must pass:
 *
 *   ORDER  the candidate comes below the actor's role, as the Super Admin
 *          arranged them. The Super Admin may also make another Super Admin —
 *          handing over before leaving is exactly what that is for.
 *   POWERS the candidate holds nothing the actor does not, over nobody the
 *          actor does not reach. The order is what somebody chose; this is
 *          what the roles really do. Without it a role placed below yours by
 *          mistake, but holding payroll, would hand payroll out through you.
 */
export function mayGive(actor: PolicyRole, candidate: PolicyRole, order: ReadonlyMap<string, RoleNode>): boolean {
  if (actor.locked) return true
  return isBelow(candidate.key, actor.key, order) && !grantsMoreThan(candidate.grant, actor.grant)
}

/** May `actor` manage — change the role of, switch off, reset — a login holding `target`? Only one below their own. */
export function mayManage(actor: PolicyRole, target: PolicyRole, order: ReadonlyMap<string, RoleNode>): boolean {
  if (actor.locked) return true
  return isBelow(target.key, actor.key, order) && !grantsMoreThan(target.grant, actor.grant)
}

/**
 * Is the target one of the actor's own logins? The one they are signed in
 * with, or — since a person can have two (Day 23) — their other one. The
 * rules about yourself are about the person: an HR head may not hand their
 * own employee login a role, or switch it off, from their HR login.
 */
export function isOwnLogin(input: {
  actorMembershipId: string
  actorEmployeeId: string | null
  targetMembershipId: string
  targetEmployeeId: string | null
}): boolean {
  if (input.actorMembershipId === input.targetMembershipId) return true
  return input.actorEmployeeId !== null && input.actorEmployeeId === input.targetEmployeeId
}

export type RoleChangeRefusal = 'own_role' | 'target_not_below' | 'not_below' | 'last_super_admin'

export interface RoleChangeInput {
  actorMembershipId: string
  /** The actor's person; null for a login with no employee record. */
  actorEmployeeId: string | null
  actor: PolicyRole
  targetMembershipId: string
  targetEmployeeId: string | null
  targetCurrent: PolicyRole
  next: PolicyRole
  order: ReadonlyMap<string, RoleNode>
  /** Active logins holding the Super Admin role in this organization, counted including the target. */
  activeSuperAdminCount: number
}

/**
 * Returns why a role change must be refused, or null if it may proceed.
 *
 * Returning a reason rather than throwing keeps this callable from a test and
 * from a "can I?" check in the UI, and keeps the HTTP status decision in the
 * service where it belongs.
 */
export function refuseRoleChange(input: RoleChangeInput): RoleChangeRefusal | null {
  // 1. You cannot change your own role.
  //
  // Not even downwards, and not even as super_admin. Allowing it means the only
  // super_admin can demote themselves and lock the company out of its own
  // settings with no way back short of a database edit. It also removes the
  // "I was already an admin, I just adjusted myself" story entirely. Their
  // other login is theirs too.
  if (isOwnLogin(input)) {
    return 'own_role'
  }

  // 2. You manage only people whose role is below yours. Without this, anybody
  // who could assign roles could demote the person above them.
  if (!mayManage(input.actor, input.targetCurrent, input.order)) {
    return 'target_not_below'
  }

  // 3. You cannot grant a role above your own, or powers you do not hold.
  //
  // Without this, any role that could assign roles could assign super_admin and
  // then log in as that person — or simply create one. Privilege escalation by
  // proxy rather than by self-promotion, and it looks like ordinary admin work
  // in the audit log.
  if (!mayGive(input.actor, input.next, input.order)) {
    return 'not_below'
  }

  // 4. The last active super_admin cannot be demoted.
  //
  // The company would be left with nobody who can manage users or settings, and
  // no route back — bootstrap refuses to run a second time by design. This is
  // the one rule that protects against a mistake rather than an attack.
  if (input.targetCurrent.locked && !input.next.locked && input.activeSuperAdminCount <= 1) {
    return 'last_super_admin'
  }

  return null
}

export const REFUSAL_MESSAGES: Record<RoleChangeRefusal, string> = {
  own_role: 'You cannot change your own role, on this login or your other one. Ask another administrator.',
  target_not_below: 'You can change the role only of people whose role is below yours.',
  not_below: 'You can give only a role below your own, with nothing you cannot do yourself.',
  last_super_admin:
    'This is the last active super admin. Promote someone else first, or the company will have no administrator.',
}

/**
 * The same protection for deactivation and termination: the last active super
 * admin must not be removed, nobody may lock themselves out, and nobody may
 * switch off somebody whose role is not below their own.
 */
export type AccountChangeRefusal = 'own_account' | 'target_not_below' | 'last_super_admin'

export function refuseAccountChange(input: {
  actorMembershipId: string
  actorEmployeeId: string | null
  actor: PolicyRole
  targetMembershipId: string
  targetEmployeeId: string | null
  target: PolicyRole
  order: ReadonlyMap<string, RoleNode>
  activeSuperAdminCount: number
}): AccountChangeRefusal | null {
  if (isOwnLogin(input)) {
    return 'own_account'
  }

  if (!mayManage(input.actor, input.target, input.order)) {
    return 'target_not_below'
  }

  if (input.target.locked && input.activeSuperAdminCount <= 1) {
    return 'last_super_admin'
  }

  return null
}

export const ACCOUNT_REFUSAL_MESSAGES: Record<AccountChangeRefusal, string> = {
  own_account: 'You cannot deactivate or remove your own account, on this login or your other one.',
  target_not_below: 'You can switch off only the logins of people whose role is below yours.',
  last_super_admin:
    'This is the last active super admin. Promote someone else first, or the company will have no administrator.',
}
