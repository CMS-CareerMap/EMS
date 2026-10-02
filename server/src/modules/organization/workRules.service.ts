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

export type WorkKind = 'bank' | 'leave_balance' | 'documents' | 'attendance' | 'incentive' | 'salary'

const WORK: Readonly<Record<WorkKind, { permissions: readonly Permission[]; ownVerb: string; noun: string }>> = {
  bank: { permissions: ['employee:bank:manage'], ownVerb: 'check your own bank account', noun: 'bank account' },
  leave_balance: { permissions: ['leave:balance:manage'], ownVerb: 'correct your own leave balance', noun: 'leave balance' },
  documents: { permissions: ['document:verify'], ownVerb: 'check your own documents', noun: 'documents' },
  attendance: { permissions: ['attendance:mark', 'attendance:update', 'attendance:delete'], ownVerb: 'mark or correct your own attendance', noun: 'attendance' },
  incentive: { permissions: ['payroll:entry:manage'], ownVerb: 'enter your own incentive', noun: 'incentive' },
  salary: { permissions: ['payroll:structure:manage'], ownVerb: 'enter or change your own salary', noun: 'salary' },
}

export interface WorkCheck {
  allowed: boolean
  /** Who to ask instead, by name — "the Super Admin" when nobody above does it. */
  ask: string | null
  own: boolean
}

export interface LoadedWork {
  world: WorkWorld
  names: Map<string, string>
}

export async function loadWork(db: TxDb, organizationId: string, kind: WorkKind): Promise<LoadedWork> {
  const [people, rules] = await Promise.all([workPeople(db), findApprovalRules(db, organizationId)])
  const byId = new Map(people.map((p) => [p.id, p]))
  const permissions = WORK[kind].permissions
  return {
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

/** Whether the caller may do this kind of work on each of these people — for the buttons a list draws. */
export function checkWork(ctx: AppContext, loaded: LoadedWork, targetId: string): WorkCheck {
  const verdict = mayDoWorkOn(loaded.world, { employeeId: ctx.employeeId, isSuperAdmin: ctx.can('role:manage') }, targetId)
  if (verdict.allowed) return { allowed: true, ask: null, own: false }
  return { allowed: false, own: verdict.own, ask: verdict.askId ? (loaded.names.get(verdict.askId) ?? 'the person above them') : 'the Super Admin' }
}

/** Refuses the work, naming the person to ask instead. */
export async function assertWorkGoesUp(ctx: AppContext, db: TxDb, kind: WorkKind, targetId: string): Promise<void> {
  const loaded = await loadWork(db, ctx.organizationId, kind)
  const check = checkWork(ctx, loaded, targetId)
  if (check.allowed) return
  const work = WORK[kind]
  // Nobody above a Super Admin and no owner marked: nobody could ever do it
  // until the owner — who does their own — is marked.
  const stuck = !loaded.world.ownerId && loaded.world.isSuperAdmin(targetId) && loaded.world.tree.chain(targetId).length === 0
  if (stuck) {
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
