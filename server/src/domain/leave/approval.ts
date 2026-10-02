import type { CompanyTree } from '../org/companyTree'

/**
 * Who decides somebody's leave (Day 22) — from the company tree, never from a
 * role. Pure: the tree, the company's approval settings and who is asking come
 * in; nothing is read.
 *
 * The client's model (30 Sep and 1 Oct 2026):
 *   - a request goes to the requester's reporting manager, whatever that
 *     person's role — an Accounts head approves the accountant's leave;
 *   - somebody with nobody above them goes to the Super Admin, or to the
 *     person Settings → Approvals names;
 *   - when the manager is away, the Super Admin may decide instead (or the
 *     manager's own manager, or nobody: a setting);
 *   - approved leave is cancelled by the reporting manager or the Super Admin
 *     (or only the Super Admin: a setting);
 *   - the owner's own leave needs nobody — it is recorded directly;
 *   - nobody else decides their own.
 *
 * The route is worked out from the tree AS IT IS when somebody decides, so a
 * request waiting when its requester moves goes to the new manager, and one
 * waiting when a manager leaves goes to whoever decides for "nobody above".
 */

export type BackupApprover = 'super_admin' | 'next_up' | 'none'
export type ReversalBy = 'manager_or_super_admin' | 'super_admin_only'

export interface ApprovalRules {
  ownerEmployeeId: string | null
  /** Who decides for somebody with nobody above; null is the Super Admin. */
  noManagerApproverId: string | null
  backup: BackupApprover
  reversal: ReversalBy
}

export type ApprovalRoute =
  /** The owner: nobody approves; their leave is recorded directly. */
  | { kind: 'owner' }
  /** Their reporting manager in effect. */
  | { kind: 'manager'; managerId: string }
  /** Nobody above them: the person the settings name, or — null — the Super Admin. */
  | { kind: 'nobody_above'; approverId: string | null }

export function routeOf(tree: CompanyTree, rules: ApprovalRules, employeeId: string): ApprovalRoute {
  if (rules.ownerEmployeeId && employeeId === rules.ownerEmployeeId) return { kind: 'owner' }
  // A manager with no login that can sign in — never given one, or switched
  // off — cannot decide: the request goes on as if nobody were above, rather
  // than waiting for somebody who will never see it.
  const managerId = tree.managerOf(employeeId)
  if (managerId && tree.canAct(managerId)) return { kind: 'manager', managerId }
  // The named person never decides their own leave, and somebody who has left
  // or cannot sign in decides nothing: either way it falls to the Super Admin.
  const named = rules.noManagerApproverId
  const usable = named && named !== employeeId && tree.canAct(named) ? named : null
  return { kind: 'nobody_above', approverId: usable }
}

export interface Decider {
  employeeId: string | null
  /** Holds the Super Admin panel (role:manage). */
  isSuperAdmin: boolean
}

export interface DecisionRight {
  allowed: boolean
  /** Deciding instead of the person whose decision it is — said in the log and on screen. */
  asBackup: boolean
}

const NO: DecisionRight = { allowed: false, asBackup: false }
const YES: DecisionRight = { allowed: true, asBackup: false }
const AS_BACKUP: DecisionRight = { allowed: true, asBackup: true }

/** Whether `decider` may approve or reject a pending request of `requesterId`. */
export function mayDecide(tree: CompanyTree, rules: ApprovalRules, requesterId: string, decider: Decider): DecisionRight {
  const route = routeOf(tree, rules, requesterId)
  const me = decider.employeeId
  if (me === requesterId) {
    // Only the owner, whose leave needs nobody — a request of theirs from
    // before they were marked can be settled by themselves.
    return route.kind === 'owner' ? YES : NO
  }
  if (route.kind === 'manager' && me === route.managerId) return YES
  if (route.kind === 'nobody_above') {
    if (route.approverId ? me === route.approverId : decider.isSuperAdmin) return YES
  }
  // Standing in for whoever's decision it is.
  if (rules.backup === 'super_admin' && decider.isSuperAdmin) return AS_BACKUP
  if (rules.backup === 'next_up' && route.kind === 'manager' && me && tree.managerOf(route.managerId) === me) return AS_BACKUP
  // Nobody above in effect because their manager cannot sign in: the person
  // above that manager stands in under "next up" too.
  if (rules.backup === 'next_up' && route.kind === 'nobody_above' && me) {
    const managerId = tree.managerOf(requesterId)
    if (managerId && tree.managerOf(managerId) === me) return AS_BACKUP
  }
  return NO
}

/** Whether `decider` may cancel an approved request of `requesterId`. */
export function mayReverse(tree: CompanyTree, rules: ApprovalRules, requesterId: string, decider: Decider): DecisionRight {
  const route = routeOf(tree, rules, requesterId)
  const me = decider.employeeId
  // Giving yourself your days back is deciding your own leave — the owner apart.
  if (me === requesterId) return route.kind === 'owner' ? YES : NO
  if (decider.isSuperAdmin) return YES
  if (rules.reversal === 'super_admin_only') return NO
  if (route.kind === 'manager' && me === route.managerId) return YES
  if (route.kind === 'nobody_above' && route.approverId && me === route.approverId) return YES
  return NO
}

/** The one person whose decision it is, when there is one — for "ask ___" and for the notice. */
export function primaryApprover(route: ApprovalRoute): string | null {
  if (route.kind === 'manager') return route.managerId
  if (route.kind === 'nobody_above') return route.approverId
  return null
}
