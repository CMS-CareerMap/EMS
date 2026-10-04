import type { AppContext } from '../../platform/context'
import type { TxDb } from '../../platform/db/transaction'
import type { Permission } from '../../platform/authz/permissions'
import { Forbidden } from '../../platform/errors/AppError'
import { buildTree } from '../../domain/org/companyTree'
import { mayDoWorkOn, type WorkWorld } from '../../domain/org/workGoesUp'
import { workPeople } from './tree.repository'
import { findApprovalRules } from './organization.repository'

/**
 * "Your own work goes up the tree" (Day 22), as the server applies it — the
 * rule itself is domain/org/workGoesUp.ts. Every place a kind of work is done
 * on somebody's record asks here first, and a refusal names the person to ask.
 */

export type WorkKind = 'bank' | 'leave_balance' | 'documents' | 'attendance' | 'incentive' | 'salary' | 'lifecycle' | 'profile'

const WORK: Readonly<Record<WorkKind, { permissions: readonly Permission[]; ownVerb: string; noun: string }>> = {
  bank: { permissions: ['employee:bank:manage'], ownVerb: 'check your own bank account', noun: 'bank account' },
  leave_balance: { permissions: ['leave:balance:manage'], ownVerb: 'correct your own leave balance', noun: 'leave balance' },
  documents: { permissions: ['document:verify'], ownVerb: 'check your own documents', noun: 'documents' },
  // Not attendance:delete: nothing deletes attendance, so holding that tick
  // must not make somebody "do attendance work".
  attendance: { permissions: ['attendance:mark', 'attendance:update'], ownVerb: 'mark or correct your own attendance', noun: 'attendance' },
  incentive: { permissions: ['payroll:entry:manage'], ownVerb: 'enter your own incentive', noun: 'incentive' },
  salary: { permissions: ['payroll:structure:manage'], ownVerb: 'enter or change your own salary', noun: 'salary' },
  // The employee lifecycle (client §43): nobody confirms, promotes, transfers
  // or completes the exit of themselves, or of somebody who does it too.
  lifecycle: { permissions: ['employee:lifecycle:manage'], ownVerb: 'change your own employment record', noun: 'employment record' },
  // Approving a profile change (client §27): never one's own, nor a fellow reviewer's.
  profile: { permissions: ['employee:update'], ownVerb: 'approve a change to your own profile', noun: 'profile' },
}

export interface WorkCheck {
  allowed: boolean
  /** Who to ask instead, by name — "the Super Admin" when nobody above does it. */
  ask: string | null
  own: boolean
}

export interface LoadedWork {
  kind: WorkKind
  world: WorkWorld
  names: Map<string, string>
}

export async function loadWork(db: TxDb, organizationId: string, kind: WorkKind): Promise<LoadedWork> {
  const [people, rules] = await Promise.all([workPeople(db), findApprovalRules(db, organizationId)])
  const byId = new Map(people.map((p) => [p.id, p]))
  const permissions = WORK[kind].permissions
  return {
    kind,
    world: {
      tree: buildTree(people),
      ownerId: rules?.ownerEmployeeId ?? null,
      doesWork: (id) => {
        const person = byId.get(id)
        return Boolean(person && permissions.some((p) => person.permissions.has(p)))
      },
      isSuperAdmin: (id) => byId.get(id)?.isSuperAdmin ?? false,
    },
    names: new Map(people.map((p) => [p.id, p.name])),
  }
}

/**
 * Nobody above a Super Admin and no owner marked: nobody could ever do their
 * work until the owner — who does their own — is marked.
 */
function stuck(loaded: LoadedWork, targetId: string): boolean {
  return !loaded.world.ownerId && loaded.world.isSuperAdmin(targetId) && loaded.world.tree.chain(targetId).length === 0
}

/** Whether the caller may do this kind of work on each of these people — for the buttons a list draws. */
export function checkWork(ctx: AppContext, loaded: LoadedWork, targetId: string): WorkCheck {
  const verdict = mayDoWorkOn(loaded.world, { employeeId: ctx.employeeId, isSuperAdmin: ctx.can('role:manage') }, targetId)
  if (verdict.allowed) return { allowed: true, ask: null, own: false }
  // The hint says what the refusal says: not "the Super Admin", who cannot either.
  if (stuck(loaded, targetId)) return { allowed: false, own: verdict.own, ask: 'the owner, once marked (Settings → Company tree)' }
  return { allowed: false, own: verdict.own, ask: verdict.askId ? (loaded.names.get(verdict.askId) ?? 'the person above them') : 'the Super Admin' }
}

/**
 * Whether somebody else — not the caller — may do this kind of work on a
 * person: for whom a "to check" notice is meant. A notice sent to somebody
 * who would then be refused is a notice about nothing.
 */
export function mayDoWork(loaded: LoadedWork, worker: { employeeId: string | null; isSuperAdmin: boolean }, targetId: string): boolean {
  // A senior's employment record is the Super Admin's (assertMayChangeEmployment):
  // the people below them are not told about it either.
  if (loaded.kind === 'lifecycle' && !worker.isSuperAdmin && worker.employeeId && loaded.world.tree.above(worker.employeeId).includes(targetId)) return false
  return mayDoWorkOn(loaded.world, worker, targetId).allowed
}

/** Refuses the work, naming the person to ask instead. */
export async function assertWorkGoesUp(ctx: AppContext, db: TxDb, kind: WorkKind, targetId: string): Promise<void> {
  refuseUnlessAllowed(ctx, await loadWork(db, ctx.organizationId, kind), kind, targetId)
}

/**
 * Somebody above the caller in the company tree, as recorded. Their employment
 * record — designation, department, probation, last day — is the Super
 * Admin's to change: a person never sets the terms of their own senior.
 */
export function aboveCaller(ctx: AppContext, loaded: LoadedWork, targetId: string): boolean {
  if (ctx.can('role:manage') || !ctx.employeeId) return false
  return loaded.world.tree.above(ctx.employeeId).includes(targetId)
}

/**
 * A change to somebody's employment record — a lifecycle step, or their
 * designation, department or last working day edited on their record. Never
 * one's own or a fellow lifecycle runner's (their own work goes up), and never
 * somebody above the caller in the tree.
 */
export async function assertMayChangeEmployment(ctx: AppContext, db: TxDb, targetId: string): Promise<void> {
  const loaded = await loadWork(db, ctx.organizationId, 'lifecycle')
  if (aboveCaller(ctx, loaded, targetId)) {
    throw Forbidden(`${loaded.names.get(targetId) ?? 'This person'} is above you in the company tree, so their employment record is changed by the Super Admin.`)
  }
  refuseUnlessAllowed(ctx, loaded, 'lifecycle', targetId)
}

function refuseUnlessAllowed(ctx: AppContext, loaded: LoadedWork, kind: WorkKind, targetId: string): void {
  const check = checkWork(ctx, loaded, targetId)
  if (check.allowed) return
  const work = WORK[kind]
  if (stuck(loaded, targetId)) {
    throw Forbidden(
      `Nobody is above ${check.own ? 'you' : (loaded.names.get(targetId) ?? 'this person')} in the company tree, and no owner is marked. Mark the owner in Settings → Company tree: the owner does their own, and everybody else's goes up to them.`,
    )
  }
  if (check.own) {
    throw Forbidden(`You cannot ${work.ownVerb}. It goes to the person above you: ${check.ask}.`)
  }
  const target = loaded.names.get(targetId) ?? 'This person'
  throw Forbidden(`${target} does this kind of work too, so their ${work.noun} is done by the people above them. Ask ${check.ask}.`)
}
