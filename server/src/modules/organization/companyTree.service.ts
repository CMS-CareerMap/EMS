import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict, NotFound } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { logger } from '../../platform/logger'
import { buildTree } from '../../domain/org/companyTree'
import type { BackupApprover, ReversalBy } from '../../domain/leave/approval'
import { audit } from '../audit/audit.service'
import { treeLock } from '../employee/employee.service'
import * as treeRepo from './tree.repository'
import * as repo from './organization.repository'

/**
 * Settings → Company tree and Settings → Approvals (Day 22), for the Super
 * Admin: who reports to whom, the one owner, the people with nobody above
 * them, and who decides when the tree has no answer.
 *
 * Moving somebody is the employee edit (PATCH /employees/:id with their
 * reporting manager) — one path, with its loop check, whether it is made from
 * the chart or from the person's own page.
 */

export interface TreeNode {
  id: string
  name: string
  code: string
  department: string | null
  designation: string | null
  /** The role their login holds, by name; null with no login. */
  role: string | null
  /** Who they report to in effect. */
  managerId: string | null
  /** The manager who left, while they have not been placed again. */
  managerWhoLeft: string | null
  isOwner: boolean
  /** Holds the Super Admin panel on a live login — who may be marked the owner. */
  canBeOwner: boolean
  /** Has a login that can sign in — who may be named to decide in Settings → Approvals. */
  canSignIn: boolean
}

export interface CompanyTreeView {
  people: TreeNode[]
  ownerId: string | null
  /** With nobody above them — the owner apart — for the Super Admin to place. */
  unplaced: string[]
  /** Last saved, for the owner mark: two tabs cannot overwrite each other. */
  version: string
}

export async function companyTree(ctx: AppContext): Promise<CompanyTreeView> {
  const [people, everybody, rules] = await Promise.all([
    treeRepo.chartPeople(ctx.db),
    treeRepo.treePeople(ctx.db),
    repo.findApprovalRules(ctx.db, ctx.organizationId),
  ])
  const tree = buildTree(everybody)
  const ownerId = rules?.ownerEmployeeId && tree.has(rules.ownerEmployeeId) && !tree.left(rules.ownerEmployeeId) ? rules.ownerEmployeeId : null
  const leftManagers = new Map(tree.unplaced().map((u) => [u.id, u.managerWhoLeft]))
  const names = await treeRepo.namesOf(ctx.db, [...leftManagers.values()].filter((v): v is string => Boolean(v)))

  return {
    people: people.map((p) => ({
      id: p.id,
      name: p.fullName,
      code: p.employeeCode,
      department: p.department?.name ?? null,
      designation: p.designation?.name ?? null,
      role: p.membership && p.membership.status !== 'inactive' ? p.membership.roleDef.name : null,
      managerId: tree.managerOf(p.id),
      managerWhoLeft: (() => {
        const left = leftManagers.get(p.id)
        return left ? (names.get(left) ?? null) : null
      })(),
      isOwner: p.id === ownerId,
      canBeOwner: Boolean(p.membership && p.membership.status === 'active' && p.membership.roleDef.locked),
      canSignIn: p.membership?.status === 'active',
    })),
    ownerId,
    unplaced: tree.unplaced().map((u) => u.id).filter((id) => id !== ownerId),
    version: String(rules?.updatedAt.getTime() ?? 0),
  }
}

/**
 * Marks the owner: the one person whose own leave and items need nobody's
 * approval. They must hold the Super Admin panel and still be here. They sit
 * at the top, so a reporting manager they had is taken away — and the log
 * says so.
 */
export async function markOwner(ctx: AppContext, employeeId: string, version: string): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, treeLock(ctx.organizationId))
    const rules = await repo.findApprovalRules(tx, ctx.organizationId)
    if (!rules) throw NotFound('Company not found')
    if (String(rules.updatedAt.getTime()) !== version) {
      throw Conflict('Somebody changed the company tree settings a moment ago. Reload and try again.')
    }
    const person = await treeRepo.personForTree(tx, employeeId)
    if (!person) throw NotFound('Employee not found')
    if (person.archivedAt) throw BadRequest(`${person.fullName} has left the company.`)
    if (!person.membership || person.membership.status !== 'active' || !person.membership.roleDef.locked) {
      throw BadRequest(`The owner must hold the Super Admin panel. Give ${person.fullName} the Super Admin role first.`)
    }
    if (rules.ownerEmployeeId === employeeId) return

    const managerCleared = person.reportingManagerId
    if (managerCleared) await treeRepo.clearManager(tx, employeeId)
    await repo.updateApprovalRules(tx, ctx.organizationId, { ownerEmployeeId: employeeId })
    await audit(ctx, {
      action: 'company.owner_marked',
      entityType: 'employee',
      entityId: employeeId,
      details: { employeeId, previousOwnerId: rules.ownerEmployeeId, ...(managerCleared ? { managerFrom: managerCleared } : {}) },
    }, tx)
  })
  logger.info('Owner marked', { by: ctx.userId, employeeId })
}

export interface ApprovalSettings {
  noManagerApproverId: string | null
  noManagerApproverName: string | null
  backup: BackupApprover
  reversal: ReversalBy
  version: string
}

export async function approvalSettings(ctx: AppContext): Promise<ApprovalSettings> {
  const rules = await repo.findApprovalRules(ctx.db, ctx.organizationId)
  if (!rules) throw NotFound('Company not found')
  const named = rules.leaveNoManagerApproverId ? await treeRepo.personForTree(ctx.db, rules.leaveNoManagerApproverId) : null
  return {
    // Somebody who has left decides nothing: shown as the Super Admin, which is what applies.
    noManagerApproverId: named && !named.archivedAt ? named.id : null,
    noManagerApproverName: named && !named.archivedAt ? named.fullName : null,
    backup: rules.leaveBackup,
    reversal: rules.leaveReversal,
    version: String(rules.updatedAt.getTime()),
  }
}

export interface ApprovalSettingsInput {
  noManagerApproverId: string | null
  backup: BackupApprover
  reversal: ReversalBy
  version: string
}

export async function updateApprovalSettings(ctx: AppContext, input: ApprovalSettingsInput): Promise<ApprovalSettings> {
  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, treeLock(ctx.organizationId))
    const rules = await repo.findApprovalRules(tx, ctx.organizationId)
    if (!rules) throw NotFound('Company not found')
    if (String(rules.updatedAt.getTime()) !== input.version) {
      throw Conflict('Somebody changed these settings a moment ago. Reload and try again.')
    }
    if (input.noManagerApproverId) {
      const person = await treeRepo.personForTree(tx, input.noManagerApproverId)
      if (!person) throw BadRequest('That person was not found.')
      if (person.archivedAt) throw BadRequest(`${person.fullName} has left the company.`)
      // A login to decide with — or the requests would wait for somebody who cannot sign in.
      if (!person.membership || person.membership.status !== 'active') {
        throw BadRequest(`${person.fullName} has no active login, so they could not decide anything.`)
      }
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    if ((rules.leaveNoManagerApproverId ?? null) !== input.noManagerApproverId) changes.noManagerApprover = { from: rules.leaveNoManagerApproverId, to: input.noManagerApproverId }
    if (rules.leaveBackup !== input.backup) changes.backup = { from: rules.leaveBackup, to: input.backup }
    if (rules.leaveReversal !== input.reversal) changes.reversal = { from: rules.leaveReversal, to: input.reversal }
    if (Object.keys(changes).length === 0) return

    await repo.updateApprovalRules(tx, ctx.organizationId, {
      leaveNoManagerApproverId: input.noManagerApproverId,
      leaveBackup: input.backup,
      leaveReversal: input.reversal,
    })
    await audit(ctx, {
      action: 'approvals.updated',
      entityType: 'organization',
      entityId: ctx.organizationId,
      details: {
        changes,
        noManagerApproverId: input.noManagerApproverId,
        backup: input.backup,
        reversal: input.reversal,
      },
    }, tx)
  })
  logger.info('Approval settings saved', { by: ctx.userId })
  return approvalSettings(ctx)
}
