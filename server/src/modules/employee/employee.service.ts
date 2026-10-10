import type { AppContext } from '../../platform/context'
import { NotFound, Conflict, BadRequest, Forbidden } from '../../platform/errors/AppError'
import { addCalendarDays, fromDateColumn, toDateColumn } from '../../domain/shared/dates'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { isUniqueViolation } from '../../platform/db/errors'
import { logger } from '../../platform/logger'
import {
  assertLoginEmail,
  createLoginInTransaction,
  freeEmployeeCode,
  loginStartFor,
  preparedPassword,
  rolesForGrant,
  rolesLock,
  type LoginStart,
} from '../user/user.service'
import { findMembershipByEmail, passwordRules } from '../user/user.repository'
import { mayGive, REFUSAL_MESSAGES } from '../user/user.policy'
import { loginKind } from '../../domain/org/passwords'
import { EMPLOYEE_ROLE } from '../../platform/authz/defaultRoles'
import { isInScope, type PersonPlace } from '../../platform/authz/scopeWhere'
import { SCOPED_RESOURCES } from '../../platform/authz/scope'
import { RESOURCE_LABELS } from '../../platform/authz/catalogue'
import * as repo from './employee.repository'
import { audit } from '../audit/audit.service'
import type { TxDb } from '../../platform/db/transaction'
import { buildTree } from '../../domain/org/companyTree'
import { namesOf, treePeople } from '../organization/tree.repository'
import { findApprovalRules } from '../organization/organization.repository'
import { tellNewApprovers } from '../leave/leaveNotices'
import { settleLeaveAfter } from '../leave/leaveApproval.service'
import { afterJoiningChanged, grantOnJoining, holdGrantLocks, leaveYearNow, saveJoinerEntitlements } from '../leave/leaveEntitlement.service'
import * as lifecycleRepo from '../lifecycle/lifecycle.repository'
import { lifecycleSettings } from '../lifecycle/lifecycle.repository'
import { aboveCaller, assertMayChangeEmployment, assertMayChangeRecord, checkWork, loadWork } from '../organization/workRules.service'
import { assertOpenFrom, holdPayrollFrom } from '../payroll/payrollLock.service'
import { companyToday } from '../organization/organization.service'
import { defaultProbationEnd } from '../../domain/org/lifecycle'
import { tellJoined } from '../notifications/peopleNotices'

/**
 * Employee reads and writes.
 *
 * The service owns two decisions and delegates everything else: which fields
 * this caller may see, and what "not found" means for them.
 */

/**
 * Three permissions, not one.
 *
 * Salary, banking and tax identity are different classes of data held by
 * different roles. Accounts needs a bank account to pay someone and has no
 * business holding their PAN; HR needs the PAN for statutory filing and has no
 * business seeing the salary. A single `employee:read` would hand all three to
 * anyone who could see a name.
 */
async function accessFor(ctx: AppContext): Promise<repo.FieldAccess> {
  return {
    includeCompensation: ctx.can('employee:compensation:read'),
    compensationScope: ctx.scopeFor('compensation'),
    includeBank: ctx.can('employee:bank:read'),
    includeIdentity: ctx.can('employee:identity:read'),
    includeLogins: (['role:manage', 'user:invite', 'user:status:update', 'user:delete', 'membership:role:assign', 'user:password:set'] as const).some((p) => ctx.can(p)),
    today: await companyToday(ctx),
    lifecycleOf: await lifecycleVisibility(ctx),
  }
}

/**
 * Whose unaccepted resignation and exit reason the caller sees in the
 * directory. Whoever runs the lifecycle sees those of the people whose
 * employment record is theirs to run — not a senior's (the Super Admin's),
 * nor a fellow runner's, whose record goes up the tree; the Super Admin,
 * everybody's.
 */
async function lifecycleVisibility(ctx: AppContext): Promise<repo.FieldAccess['lifecycleOf']> {
  if (ctx.can('role:manage')) return { everybody: true, employeeId: ctx.employeeId, notTheirs: [] }
  if (!ctx.can('employee:lifecycle:manage')) return { everybody: false, employeeId: ctx.employeeId, notTheirs: [] }
  const loaded = await loadWork(ctx.db, ctx.organizationId, 'lifecycle')
  const notTheirs = [...loaded.names.keys()].filter((id) => aboveCaller(ctx, loaded, id) || !checkWork(ctx, loaded, id).allowed)
  return { everybody: true, employeeId: ctx.employeeId, notTheirs }
}

export interface EmployeeListResult {
  rows: repo.EmployeeRow[]
  total: number
  access: repo.FieldAccess
}

export async function listEmployees(
  ctx: AppContext,
  filters: repo.EmployeeFilters = {},
): Promise<EmployeeListResult> {
  const access = await accessFor(ctx)
  const scope = ctx.scopeFor('employee')

  const [rows, total] = await Promise.all([
    repo.list(ctx.db, scope, access, filters),
    repo.count(ctx.db, scope, filters),
  ])

  return { rows, total, access }
}

export interface EmployeeResult {
  row: repo.EmployeeRow
  access: repo.FieldAccess
}

/**
 * One employee, or 404.
 *
 * 404 and NOT 403, even when the row exists and the caller simply may not see
 * it. A 403 answers a question nobody should be able to ask: it confirms that
 * this particular id is a real employee. Given a few thousand guesses that maps
 * out the organization, and for an HR system the existence of a record is
 * itself information — a resignation can be detected before it is announced.
 *
 * "Not found" is also true from the caller's point of view. There is no
 * employee at that id, as far as they are concerned.
 */
export async function getEmployee(ctx: AppContext, id: string): Promise<EmployeeResult> {
  const access = await accessFor(ctx)
  const row = await repo.findById(ctx.db, ctx.scopeFor('employee'), id, access)

  if (!row) throw NotFound('Employee not found')

  return { row, access }
}

/**
 * Creating and editing.
 *
 * Both run in ONE transaction covering every table they touch, which is what
 * makes the guide's requirement meaningful: an employee created with a bad
 * statutory field leaves zero rows, not an employee with no PAN.
 */

export interface CreateEmployeeInput {
  employeeCode: string
  fullName: string
  personalEmail?: string | null | undefined
  phone?: string | null | undefined
  dateOfJoining?: string | null | undefined
  lastWorkingDate?: string | null | undefined
  gender?: 'male' | 'female' | 'other' | null | undefined
  employmentType?: 'full_time' | 'part_time' | 'contract' | 'intern' | undefined
  departmentId?: string | null | undefined
  designationId?: string | null | undefined
  shiftId?: string | null | undefined
  reportingManagerId?: string | null | undefined
  attendanceMode?: 'app' | 'biometric' | 'manual' | undefined
  workArrangement?: 'office' | 'hybrid' | 'remote' | undefined
  /** Personal details (client §42), written only by somebody who can read them. */
  personal?:
    | {
        dateOfBirth?: string | null | undefined
        nationality?: string | null | undefined
        address?: string | null | undefined
        emergencyContactName?: string | null | undefined
        emergencyContactRelation?: string | null | undefined
        emergencyContactPhone?: string | null | undefined
      }
    | undefined
  country?: string | undefined
  currency?: string | undefined
  statutory?:
    | {
        pan?: string | null | undefined
        uan?: string | null | undefined
        pfAccountNumber?: string | null | undefined
        esiNumber?: string | null | undefined
        ptState?: string | null | undefined
        pfApplicable?: boolean | undefined
        hasPriorPfMembership?: boolean | null | undefined
        epsMember?: boolean | null | undefined
      }
    | undefined
  /** `role` is a role key of this company. */
  /**
   * A login with the record. Its email is optional for an employee login,
   * which signs in with the Employee ID; the password is typed for them when
   * the company sets it (Settings → Passwords).
   */
  login?: { email?: string | null | undefined; role: string; password?: string | undefined } | undefined
  /** Somebody already working here: onboarded and confirmed on this day (the employee lifecycle). */
  confirmedOn?: string | null | undefined
  /** Their own days a year of some leave types (client, 9 Oct 2026); `leave:balance:manage` only. */
  leaveEntitlements?: { leaveTypeId: string; days: number }[] | undefined
}

export interface CreateEmployeeResult {
  row: repo.EmployeeRow
  access: repo.FieldAccess
  /** Present only when a login was made that starts with a link. Shown once, never stored. */
  invite?: { token: string; expiresAt: Date } | undefined
  /** How the login started: a password typed for them, a link, or none yet. */
  loginStart?: LoginStart | undefined
}

/**
 * Nobody leaves before they join.
 *
 * Checked here rather than in the validator because on an edit only one of the
 * two dates may be in the body, and the other is whatever is already stored.
 * Letting it through would give payroll an employment window that ends before
 * it starts — which the salary engine reads as zero days and pays nothing,
 * without anybody having decided that.
 */
function assertLeavesAfterJoining(dateOfJoining: string | null, lastWorkingDate: string | null): void {
  if (dateOfJoining && lastWorkingDate && lastWorkingDate < dateOfJoining) {
    throw BadRequest(
      `The last working day (${lastWorkingDate}) cannot be before the joining date (${dateOfJoining})`,
    )
  }
}

/**
 * PAN, UAN, PF and ESIC — and whether PF applies, which changes a payslip —
 * are written only by somebody who may read them. Writing them blind, as a
 * role that edits records but holds no identity read could, would change
 * deductions nobody on that side can see.
 */
function assertMayWriteStatutory(ctx: AppContext, input: { statutory?: unknown; personal?: unknown }): void {
  if (input.statutory !== undefined && !ctx.can('employee:identity:read')) {
    throw Forbidden('PAN, UAN, PF and ESIC details are entered by somebody who can see them. Ask HR.')
  }
  if (input.personal !== undefined && !ctx.can('employee:identity:read')) {
    throw Forbidden('Personal details are entered by somebody who can see them. Ask HR.')
  }
}

/** Personal details as columns: only those sent, a date as a date column. */
function personalData(personal: CreateEmployeeInput['personal']): Record<string, unknown> {
  if (!personal) return {}
  const data: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(personal)) {
    if (value === undefined) continue
    data[key] = key === 'dateOfBirth' ? (value ? toDateColumn(value) : null) : value
  }
  return data
}

function asConflict(err: unknown): never {
  // A duplicate employee code is an ordinary thing for a person to do, not a
  // server fault. 409 with a readable message rather than a 500.
  if (isUniqueViolation(err)) {
    throw Conflict('An employee with that code already exists')
  }
  throw err
}

/**
 * Refuses a record that would land outside the people the caller can see.
 *
 * Checked BEFORE anything is written. A role that adds or edits people over
 * its team or department (Day 21) used to have the change saved and then be
 * told "not found" when it was read back — and a new login's one-time link,
 * returned only in that answer, was lost with it.
 */
export function assertWithinReach(ctx: AppContext, place: PersonPlace, adding: boolean): void {
  const scope = ctx.scopeFor('employee')
  if (isInScope(scope, place)) return
  const where =
    scope.scope === 'DIRECT_REPORTS'
      ? 'Set yourself as their reporting manager'
      : scope.scope === 'ALL_REPORTS'
        ? 'Set yourself, or somebody under you, as their reporting manager'
        : scope.scope === 'DEPARTMENT'
          ? 'Keep them in your own department'
          : scope.scope === 'ORGANIZATION_EXCEPT_ABOVE'
            ? 'Somebody above you in the company tree is not in your reach'
            : 'You can only see your own record'
  throw BadRequest(`${adding ? 'You can add only people you will be able to see.' : 'That change would take this person out of the people you can see.'} ${where}.`)
}

/**
 * Refuses moving somebody INTO the caller's reach (Day 21).
 *
 * Every team and department scope is measured from a person's manager and
 * department — the two fields this edit can change. Without this, somebody
 * who edits records company-wide but sees salaries only for their team could
 * make the managing director report to them and read the MD's pay. Moving
 * people between teams and departments is still done; by somebody above, or
 * by somebody whose reach the move does not change.
 */
export function assertNoNewReach(ctx: AppContext, before: PersonPlace, after: PersonPlace): void {
  for (const resource of SCOPED_RESOURCES) {
    const scope = ctx.scopeFor(resource)
    // Moving one of your seniors can take them, and everybody above them, out
    // of "the people above you" — and their information into your reach. A
    // senior's place is for somebody above you to change.
    if (scope.scope === 'ORGANIZATION_EXCEPT_ABOVE' && scope.tree?.above.includes(before.id)) {
      throw Forbidden(
        `This person is above you in the company tree, and moving them could show you their information (${RESOURCE_LABELS[resource].toLowerCase()}). Ask somebody above you to make the change.`,
      )
    }
    if (scope.scope !== 'DIRECT_REPORTS' && scope.scope !== 'DEPARTMENT' && scope.scope !== 'ALL_REPORTS') continue
    if (!isInScope(scope, before) && isInScope(scope, after)) {
      const where = scope.scope === 'DIRECT_REPORTS' ? 'your team' : scope.scope === 'ALL_REPORTS' ? 'the part of the company tree under you' : 'your department'
      throw Forbidden(
        `That change would put this person in ${where}, which would show you more of their information (${RESOURCE_LABELS[resource].toLowerCase()}). Ask somebody above you to make it.`,
      )
    }
  }
}

/** Every change to who reports to whom waits for the one before it: two moves at once could otherwise make a loop neither saw. */
export const treeLock = (organizationId: string) => `tree:${organizationId}`

/**
 * Refuses a reporting line the company tree cannot hold (Day 22): nobody
 * reports to themselves, to somebody who has left, or to somebody under
 * them — the tree cannot loop — and nobody is placed above the owner.
 * Under the tree lock, so the tree it reads is the tree that is changed.
 */
export async function assertManagerFits(tx: TxDb, ctx: AppContext, personId: string | null, managerId: string | null): Promise<void> {
  if (personId) {
    const owner = (await findApprovalRules(tx, ctx.organizationId))?.ownerEmployeeId ?? null
    if (managerId && owner === personId) {
      throw BadRequest('This person is the owner, at the top of the company tree: nobody is above them.')
    }
  }
  if (!managerId) return
  if (managerId === personId) throw BadRequest('Somebody cannot report to themselves.')

  const manager = await repo.managerCandidate(tx, managerId)
  if (!manager) throw BadRequest('That reporting manager was not found.')
  if (manager.archivedAt) throw BadRequest(`${manager.fullName} has left the company, so nobody can report to them.`)

  if (personId) {
    const tree = buildTree(await treePeople(tx))
    // Whoever somebody reports to decides their leave and does the work they
    // cannot do on their own record. Moving a person under yourself — or under
    // anybody below you — would hand you those decisions over somebody already
    // here: the Super Admin, who sets the company tree, may; nobody else. (A
    // new joiner added straight into your own team is a hire, not a takeover.)
    if (!ctx.can('role:manage') && ctx.employeeId && (managerId === ctx.employeeId || tree.below(ctx.employeeId).includes(managerId))) {
      throw Forbidden(
        'Moving somebody under you, or under somebody below you, would make their leave and their work yours to decide. Ask the Super Admin, who sets the company tree.',
      )
    }
    if (tree.wouldLoop(personId, managerId)) {
      const names = await namesOf(tx, [personId])
      throw BadRequest(
        `${manager.fullName} already reports to ${names.get(personId) ?? 'this person'}, directly or through others, so this would make the company tree go in a loop.`,
      )
    }
  }
}

/**
 * Where a new record starts in the employee lifecycle (client §43). A new
 * joiner starts in onboarding, with a probation ending the company's months
 * after joining. Somebody already working here, added with the day they were
 * confirmed, starts confirmed. Shared with the roster import.
 */
export async function lifecycleStart(
  ctx: AppContext,
  input: { dateOfJoining?: string | null | undefined; confirmedOn?: string | null | undefined },
): Promise<{ onboardedOn: Date | null; probationEndDate: Date | null; confirmedOn: Date | null }> {
  const joined = input.dateOfJoining ?? null
  if (input.confirmedOn) {
    if (joined && input.confirmedOn < joined) {
      throw BadRequest(`The confirmation date (${input.confirmedOn}) cannot be before the joining date (${joined}).`)
    }
    if (input.confirmedOn > (await companyToday(ctx))) {
      throw BadRequest(`The confirmation date (${input.confirmedOn}) is in the future. Leave it empty for somebody still on probation.`)
    }
    return { onboardedOn: toDateColumn(joined ?? input.confirmedOn), probationEndDate: null, confirmedOn: toDateColumn(input.confirmedOn) }
  }
  const months = (await lifecycleSettings(ctx.db, ctx.organizationId))?.probationMonths ?? 6
  return { onboardedOn: null, probationEndDate: joined ? toDateColumn(defaultProbationEnd(joined, months)) : null, confirmedOn: null }
}

export async function createEmployee(
  ctx: AppContext,
  input: CreateEmployeeInput,
): Promise<CreateEmployeeResult> {
  let invite: { token: string; expiresAt: Date } | undefined
  let loginStart: LoginStart | undefined

  assertMayWriteStatutory(ctx, input)
  assertLeavesAfterJoining(input.dateOfJoining ?? null, input.lastWorkingDate ?? null)
  // A new record has no id yet, so it is in reach only by its manager or department.
  assertWithinReach(ctx, { id: '', reportingManagerId: input.reportingManagerId ?? null, departmentId: input.departmentId ?? null }, true)
  const lifecycle = await lifecycleStart(ctx, input)
  const loginEmail = input.login?.email ? input.login.email.toLowerCase().trim() : null
  // Told as what it is, not as a duplicate employee code (the unique index would say that).
  if (loginEmail && (await findMembershipByEmail(ctx.db, loginEmail))) {
    throw Conflict('Someone with that email address already has access to this company. Each login needs an email of its own.')
  }
  // Checked and hashed before any lock: hashing is deliberately slow.
  const password = input.login ? await preparedPassword(ctx.db, ctx.organizationId, input.login.password) : null

  const employeeId = await withTransaction(ctx.db, async (tx) => {
    let roleName: string | null = null

    if (input.reportingManagerId) {
      await lockFor(tx, treeLock(ctx.organizationId))
      await assertManagerFits(tx, ctx, null, input.reportingManagerId)
    }

    if (input.login && password) {
      // An inviter cannot hand out a role above their own — the same rule the
      // invite endpoint applies, reused rather than restated.
      await lockFor(tx, rolesLock(ctx.organizationId))
      const { actor, next: given, order } = await rolesForGrant(tx, ctx, input.login.role, ['employee:create'])
      if (!mayGive(actor, given, order)) throw Forbidden(REFUSAL_MESSAGES.not_below)
      roleName = given.grant.name
      const kind = loginKind(input.login.role, EMPLOYEE_ROLE, given.locked)
      assertLoginEmail(kind, loginEmail, true)
      // The rules as they stand under the lock a change of them takes too.
      loginStart = loginStartFor(kind, await passwordRules(tx, ctx.organizationId), actor, password.hash !== null)
    }

    const employee = await repo.createEmployee(tx, {
      organizationId: ctx.organizationId,
      employeeCode: await freeEmployeeCode(tx, ctx.organizationId, input.employeeCode),
      fullName: input.fullName.trim(),
      personalEmail: input.personalEmail ?? null,
      phone: input.phone ?? null,
      dateOfJoining: input.dateOfJoining ? toDateColumn(input.dateOfJoining) : null,
      lastWorkingDate: input.lastWorkingDate ? toDateColumn(input.lastWorkingDate) : null,
      gender: input.gender ?? null,
      ...(input.employmentType ? { employmentType: input.employmentType } : {}),
      departmentId: input.departmentId ?? null,
      designationId: input.designationId ?? null,
      shiftId: input.shiftId ?? null,
      reportingManagerId: input.reportingManagerId ?? null,
      ...(input.attendanceMode ? { attendanceMode: input.attendanceMode } : {}),
      ...(input.workArrangement ? { workArrangement: input.workArrangement } : {}),
      ...personalData(input.personal),
      ...(input.country ? { country: input.country.toUpperCase() } : {}),
      ...(input.currency ? { currency: input.currency.toUpperCase() } : {}),
      ...lifecycle,
    })

    if (input.login && password && loginStart) {
      const created = await createLoginInTransaction(tx, {
        email: loginEmail,
        role: input.login.role,
        organizationId: ctx.organizationId,
        invitedByUserId: ctx.userId,
        employeeId: employee.id,
        start: loginStart,
        passwordHash: password.hash,
      })
      if (created.inviteToken && created.expiresAt) invite = { token: created.inviteToken, expiresAt: created.expiresAt }
    }

    if (input.statutory) {
      await repo.createStatutoryIdentity(tx, {
        organizationId: ctx.organizationId,
        employeeId: employee.id,
        pan: input.statutory.pan ?? null,
        uan: input.statutory.uan ?? null,
        pfAccountNumber: input.statutory.pfAccountNumber ?? null,
        esiNumber: input.statutory.esiNumber ?? null,
        ptState: input.statutory.ptState ?? null,
        ...(input.statutory.pfApplicable !== undefined
          ? { pfApplicable: input.statutory.pfApplicable }
          : {}),
        hasPriorPfMembership: input.statutory.hasPriorPfMembership ?? null,
        epsMember: input.statutory.epsMember ?? null,
      })
    }

    await audit(ctx, {
      action: 'employee.created',
      entityType: 'employee',
      entityId: employee.id,
      details: { employeeCode: employee.employeeCode, withLogin: Boolean(input.login), role: input.login?.role ?? null, roleName },
    }, tx)
    // Their manager and HR hear of a new joiner (client §45).
    await tellJoined(ctx, tx, employee.id, input.dateOfJoining ?? null)

    // Their share of this leave year, at once (client, 9 Oct 2026) — from any
    // days a year of their own given here, by each type's rule for joiners.
    await saveJoinerEntitlements(ctx, tx, employee.id, input.leaveEntitlements ?? [])
    await grantOnJoining(ctx, tx, [employee.id])

    return employee.id
  }).catch(asConflict)

  const access = await accessFor(ctx)
  // Read back by the company, not the caller's scope: the reach was checked
  // before anything was written, and a tree scope ("everybody under them")
  // was loaded before this person existed — reading through it would answer
  // "not found" and lose the one-time invitation link. Field access still applies.
  const row = await repo.findById(ctx.db, { ...ctx.scopeFor('employee'), scope: 'ORGANIZATION' }, employeeId, access)
  if (!row) throw NotFound('Employee was created but could not be read back')

  logger.info('Employee created', { by: ctx.userId, employeeId, withLogin: Boolean(input.login), loginStart })

  return { row, access, invite, loginStart }
}

export type UpdateEmployeeInput = Partial<Omit<CreateEmployeeInput, 'login' | 'confirmedOn' | 'leaveEntitlements'>>

export async function updateEmployee(
  ctx: AppContext,
  id: string,
  input: UpdateEmployeeInput,
): Promise<EmployeeResult> {
  assertMayWriteStatutory(ctx, input)
  const access = await accessFor(ctx)
  const scope = ctx.scopeFor('employee')

  // Scoped read FIRST. Updating by id alone would let anyone with
  // employee:update edit an employee they cannot even see — including one in
  // another company, since an update by primary key carries no company filter.
  const existing = await repo.findById(ctx.db, scope, id, access)
  if (!existing) throw NotFound('Employee not found')

  // Whichever date the body leaves out is the one already stored.
  assertLeavesAfterJoining(
    input.dateOfJoining !== undefined
      ? input.dateOfJoining
      : existing.dateOfJoining
        ? fromDateColumn(existing.dateOfJoining)
        : null,
    input.lastWorkingDate !== undefined
      ? input.lastWorkingDate
      : existing.lastWorkingDate
        ? fromDateColumn(existing.lastWorkingDate)
        : null,
  )

  // Whichever of manager and department the body leaves out stays as stored.
  const before: PersonPlace = { id: existing.id, reportingManagerId: existing.reportingManagerId, departmentId: existing.departmentId }
  const after: PersonPlace = {
    id: existing.id,
    reportingManagerId: input.reportingManagerId !== undefined ? input.reportingManagerId : existing.reportingManagerId,
    departmentId: input.departmentId !== undefined ? input.departmentId : existing.departmentId,
  }
  const moved = after.reportingManagerId !== before.reportingManagerId || after.departmentId !== before.departmentId
  // Nobody decides where they themselves sit: their team and department are
  // what other people's scopes — and their own — are measured from. The Super
  // Admin passes this check (role:manage is theirs alone); their own
  // department, like the rest of their employment record, is then theirs only
  // as the owner — anybody else's goes up the tree (assertMayChangeEmployment).
  if (moved && existing.id === ctx.employeeId && !ctx.can('role:manage')) {
    throw Forbidden('You cannot change your own reporting manager or department. Ask somebody above you.')
  }
  const managerChanged = after.reportingManagerId !== before.reportingManagerId
  // Who somebody already here reports to is the Super Admin's to set — the
  // company tree is theirs (the client's words). Anybody else could otherwise
  // hand a person's leave and work decisions to whoever they liked: to a new
  // hire whose invitation link they hold, to the approver for "nobody above"
  // by clearing the line, or to a peer by moving that peer's manager. A new
  // joiner is still placed by whoever adds them (createEmployee).
  if (managerChanged && !ctx.can('role:manage')) {
    throw Forbidden('Who somebody reports to is set by the Super Admin, on Settings → Company Tree. Ask the Super Admin to move them.')
  }
  assertWithinReach(ctx, after, false)
  if (moved) assertNoNewReach(ctx, before, after)

  // Designation, department and last working day are the employment record
  // (client §43): the lifecycle's rules hold here too — never one's own or a
  // fellow HR person's, never a senior's — and the change is in their history.
  const designationChanged = input.designationId !== undefined && input.designationId !== existing.designationId
  const departmentChanged = after.departmentId !== before.departmentId
  const lastDayBefore = fromDateColumn(existing.lastWorkingDate)
  const lastDayAfter = input.lastWorkingDate !== undefined ? input.lastWorkingDate : lastDayBefore
  const lastDayChanged = lastDayAfter !== lastDayBefore
  const joinedBefore = fromDateColumn(existing.dateOfJoining)
  const joiningChanged = input.dateOfJoining !== undefined && input.dateOfJoining !== joinedBefore
  // The joining date too: it moves pay and the end of probation.
  if (designationChanged || departmentChanged || lastDayChanged || joiningChanged) await assertMayChangeEmployment(ctx, ctx.db, existing.id)
  // And the rest of the record — whether PF applies, a PAN, a shift change
  // somebody's pay: never one's own, a fellow HR person's or a senior's
  // (client §27, Day 22). Those go up the tree, as a profile change request does.
  await assertMayChangeRecord(ctx, ctx.db, existing.id)
  // Pay is worked out from both dates: a month whose payroll is approved keeps them.
  const lastDayPayFrom = lastDayChanged
    ? addCalendarDays([lastDayBefore, lastDayAfter].filter((d): d is string => Boolean(d)).sort()[0]!, 1)
    : null
  const joiningPayFrom = joiningChanged
    ? ([joinedBefore, input.dateOfJoining].filter((d): d is string => Boolean(d)).sort()[0] ?? null)
    : null
  if (lastDayPayFrom) await assertOpenFrom(ctx, lastDayPayFrom, 'a change to the last working day')
  if (joiningPayFrom) await assertOpenFrom(ctx, joiningPayFrom, 'a change to the joining date')

  await withTransaction(ctx.db, async (tx) => {
    const data: Record<string, unknown> = {}
    // The old value beside the new, for the audit log (client §47).
    const changes: Record<string, { from: unknown; to: unknown }> = {}

    if (managerChanged) {
      await lockFor(tx, treeLock(ctx.organizationId))
      await assertManagerFits(tx, ctx, existing.id, after.reportingManagerId)
    }
    if (lastDayChanged) {
      // The same lock a resignation's acceptance takes: the two never cross.
      await lockFor(tx, `lifecycle:${existing.id}`)
      const now = await lifecycleRepo.findPerson(tx, null, existing.id)
      if (now?.resignations[0]) {
        throw Conflict(`${existing.fullName}'s last working day comes from their resignation. Change it there: call the resignation off, or complete the exit.`)
      }
    }
    // A corrected joining date changes their share of the leave years granted
    // (client, 9 Oct 2026): the grant locks first, before the person's leave
    // lock below — the order every grant takes them in.
    if (joiningChanged) await holdGrantLocks(tx, ctx.organizationId, await leaveYearNow(ctx.db, ctx.organizationId))
    // The payroll locks of the months the dates reach — after the person's
    // leave lock, which settling their leave takes too; at once, earliest
    // first; and before any row is written — then checked again: a month
    // approved since the check above is refused rather than missed.
    const payFrom = [lastDayPayFrom, joiningPayFrom].filter((d): d is string => Boolean(d)).sort()[0]
    if (payFrom) {
      // Before the payroll locks, as an approval takes it: a corrected joining
      // date changes their leave balance too (afterJoiningChanged).
      if (lastDayChanged || joiningChanged) await lockFor(tx, `leave-apply:${id}`)
      await holdPayrollFrom(ctx, tx, payFrom)
      if (lastDayPayFrom) await assertOpenFrom(ctx, lastDayPayFrom, 'a change to the last working day', tx)
      if (joiningPayFrom) await assertOpenFrom(ctx, joiningPayFrom, 'a change to the joining date', tx)
    }
    if (designationChanged || departmentChanged) {
      const today = await companyToday(ctx)
      const [fromDesignation, toDesignation, fromDepartment, toDepartment] = await Promise.all([
        lifecycleRepo.designationName(tx, existing.designationId),
        designationChanged ? lifecycleRepo.designationName(tx, input.designationId ?? null) : Promise.resolve(null),
        lifecycleRepo.departmentName(tx, before.departmentId),
        departmentChanged ? lifecycleRepo.departmentName(tx, after.departmentId) : Promise.resolve(null),
      ])
      const event = { organizationId: ctx.organizationId, employeeId: existing.id, effectiveDate: toDateColumn(today), createdByUserId: ctx.userId }
      if (designationChanged) await lifecycleRepo.addEvent(tx, { ...event, kind: 'promoted', details: { fromDesignation, toDesignation, via: 'edit' } })
      if (departmentChanged) await lifecycleRepo.addEvent(tx, { ...event, kind: 'transferred', details: { fromDepartment, toDepartment, via: 'edit' } })
      if (designationChanged) changes.designation = { from: fromDesignation, to: toDesignation }
      if (departmentChanged) changes.department = { from: fromDepartment, to: toDepartment }
    }

    // Checked only when it changes: the edit form sends it every time, and an
    // ID kept as it was is no new clash.
    if (input.employeeCode !== undefined && input.employeeCode.trim() !== existing.employeeCode) {
      data.employeeCode = await freeEmployeeCode(tx, ctx.organizationId, input.employeeCode, existing.id)
    }
    if (input.fullName !== undefined) data.fullName = input.fullName.trim()
    if (input.personalEmail !== undefined) data.personalEmail = input.personalEmail
    if (input.phone !== undefined) data.phone = input.phone
    if (joiningChanged) {
      data.dateOfJoining = input.dateOfJoining ? toDateColumn(input.dateOfJoining) : null
      // A joining date corrected while on probation moves the end of probation
      // with it — unless HR set that end by hand (it no longer matches the
      // company's months from the old date).
      const oldJoined = fromDateColumn(existing.dateOfJoining)
      const end = fromDateColumn(existing.probationEndDate)
      if (!existing.confirmedOn && input.dateOfJoining !== oldJoined) {
        const months = (await lifecycleSettings(tx, ctx.organizationId))?.probationMonths ?? 6
        if (!end || (oldJoined && end === defaultProbationEnd(oldJoined, months))) {
          data.probationEndDate = input.dateOfJoining ? toDateColumn(defaultProbationEnd(input.dateOfJoining, months)) : null
        }
      }
    }
    // Written only when changed: an acceptance, promotion or transfer committed
    // since this edit read the record is not put back by a form that resent it.
    if (lastDayChanged) {
      data.lastWorkingDate = lastDayAfter ? toDateColumn(lastDayAfter) : null
    }
    if (input.gender !== undefined) data.gender = input.gender
    if (input.employmentType !== undefined) data.employmentType = input.employmentType
    if (departmentChanged) data.departmentId = after.departmentId
    if (designationChanged) data.designationId = input.designationId
    if (input.shiftId !== undefined) data.shiftId = input.shiftId
    if (managerChanged) data.reportingManagerId = after.reportingManagerId
    if (input.attendanceMode !== undefined) data.attendanceMode = input.attendanceMode
    if (input.workArrangement !== undefined) data.workArrangement = input.workArrangement
    Object.assign(data, personalData(input.personal))
    if (input.country !== undefined) data.country = input.country?.toUpperCase()
    if (input.currency !== undefined) data.currency = input.currency?.toUpperCase()

    if (Object.keys(data).length > 0) {
      await repo.updateEmployee(tx, id, data)
    }
    // A last working day set here, as by an accepted resignation: no leave is
    // taken from a job they will have left.
    if (lastDayChanged && lastDayAfter) await settleLeaveAfter(ctx, tx, id, lastDayAfter)
    // Their leave worked out again from the new joining date — or granted, if
    // they had none for want of one.
    if (joiningChanged) await afterJoiningChanged(ctx, tx, id, joinedBefore)

    // The work record's old and new values are written out. Contact, personal
    // and statutory details are named only (below): a PAN or a phone number
    // has no business in a log more people will one day read than hold the
    // permission to see it.
    const was = existing as unknown as Record<string, unknown>
    for (const key of ['employeeCode', 'fullName', 'employmentType', 'attendanceMode', 'workArrangement', 'country', 'currency'] as const) {
      if (key in data && data[key] !== was[key]) changes[key] = { from: was[key] ?? null, to: data[key] ?? null }
    }
    if (joiningChanged) changes.dateOfJoining = { from: joinedBefore, to: input.dateOfJoining ?? null }
    if (lastDayChanged) changes.lastWorkingDate = { from: lastDayBefore, to: lastDayAfter }
    if ('shiftId' in data && data.shiftId !== existing.shiftId) {
      changes.shift = { from: await repo.shiftName(tx, existing.shiftId), to: await repo.shiftName(tx, (data.shiftId as string | null) ?? null) }
    }

    if (input.statutory) {
      const s = input.statutory
      await repo.upsertStatutoryIdentity(
        tx,
        id,
        {
          ...(s.pan !== undefined ? { pan: s.pan } : {}),
          ...(s.uan !== undefined ? { uan: s.uan } : {}),
          ...(s.pfAccountNumber !== undefined ? { pfAccountNumber: s.pfAccountNumber } : {}),
          ...(s.esiNumber !== undefined ? { esiNumber: s.esiNumber } : {}),
          ...(s.ptState !== undefined ? { ptState: s.ptState } : {}),
          ...(s.pfApplicable !== undefined ? { pfApplicable: s.pfApplicable } : {}),
          ...(s.hasPriorPfMembership !== undefined
            ? { hasPriorPfMembership: s.hasPriorPfMembership }
            : {}),
          ...(s.epsMember !== undefined ? { epsMember: s.epsMember } : {}),
        },
        {
          organizationId: ctx.organizationId,
          employeeId: id,
          pan: s.pan ?? null,
          uan: s.uan ?? null,
          pfAccountNumber: s.pfAccountNumber ?? null,
          esiNumber: s.esiNumber ?? null,
          ptState: s.ptState ?? null,
          ...(s.pfApplicable !== undefined ? { pfApplicable: s.pfApplicable } : {}),
          hasPriorPfMembership: s.hasPriorPfMembership ?? null,
          epsMember: s.epsMember ?? null,
        },
      )
    }

    // Which fields, not their values: a PAN or a phone number has no business
    // in a log that more people will one day read than hold the permission.
    const statutoryFields = input.statutory ? Object.keys(input.statutory) : []
    if (Object.keys(data).length > 0 || statutoryFields.length > 0) {
      await audit(ctx, {
        action: 'employee.updated',
        entityType: 'employee',
        entityId: id,
        details: {
          fields: Object.keys(data),
          statutoryFields,
          changes,
          // Who they reported to before and after: the company tree's history (Day 22).
          ...(managerChanged ? { managerFrom: before.reportingManagerId, managerTo: after.reportingManagerId } : {}),
        },
      }, tx)
    }
    // Their waiting requests now go to somebody else, who is told.
    if (managerChanged) await tellNewApprovers(ctx, tx, id)
  }).catch(asConflict)

  const row = await repo.findById(ctx.db, scope, id, access)
  if (!row) throw NotFound('Employee not found')

  logger.info('Employee updated', { by: ctx.userId, employeeId: id })

  return { row, access }
}
