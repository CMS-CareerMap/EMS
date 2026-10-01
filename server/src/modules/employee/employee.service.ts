import type { AppContext } from '../../platform/context'
import { NotFound, Conflict, BadRequest, Forbidden } from '../../platform/errors/AppError'
import { fromDateColumn, toDateColumn } from '../../domain/shared/dates'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { isUniqueViolation } from '../../platform/db/errors'
import { logger } from '../../platform/logger'
import { assertMayGive, createLoginInTransaction, rolesLock } from '../user/user.service'
import { isInScope, type PersonPlace } from '../../platform/authz/scopeWhere'
import { SCOPED_RESOURCES } from '../../platform/authz/scope'
import { RESOURCE_LABELS } from '../../platform/authz/catalogue'
import * as repo from './employee.repository'
import { audit } from '../audit/audit.service'

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
function accessFor(ctx: AppContext): repo.FieldAccess {
  return {
    includeCompensation: ctx.can('employee:compensation:read'),
    compensationScope: ctx.scopeFor('compensation'),
    includeBank: ctx.can('employee:bank:read'),
    includeIdentity: ctx.can('employee:identity:read'),
  }
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
  const access = accessFor(ctx)
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
  const access = accessFor(ctx)
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
      }
    | undefined
  /** `role` is a role key of this company. */
  login?: { email: string; role: string } | undefined
}

export interface CreateEmployeeResult {
  row: repo.EmployeeRow
  access: repo.FieldAccess
  /** Present only when a login was requested. Shown once, never stored. */
  invite?: { token: string; expiresAt: Date } | undefined
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
function assertWithinReach(ctx: AppContext, place: PersonPlace, adding: boolean): void {
  const scope = ctx.scopeFor('employee')
  if (isInScope(scope, place)) return
  const where =
    scope.scope === 'DIRECT_REPORTS'
      ? 'Set yourself as their reporting manager'
      : scope.scope === 'DEPARTMENT'
        ? 'Keep them in your own department'
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
function assertNoNewReach(ctx: AppContext, before: PersonPlace, after: PersonPlace): void {
  for (const resource of SCOPED_RESOURCES) {
    const scope = ctx.scopeFor(resource)
    if (scope.scope !== 'DIRECT_REPORTS' && scope.scope !== 'DEPARTMENT') continue
    if (!isInScope(scope, before) && isInScope(scope, after)) {
      throw Forbidden(
        `That change would put this person in ${scope.scope === 'DIRECT_REPORTS' ? 'your team' : 'your department'}, which would show you more of their information (${RESOURCE_LABELS[resource].toLowerCase()}). Ask somebody above you to make it.`,
      )
    }
  }
}

export async function createEmployee(
  ctx: AppContext,
  input: CreateEmployeeInput,
): Promise<CreateEmployeeResult> {
  let invite: { token: string; expiresAt: Date } | undefined

  assertLeavesAfterJoining(input.dateOfJoining ?? null, input.lastWorkingDate ?? null)
  // A new record has no id yet, so it is in reach only by its manager or department.
  assertWithinReach(ctx, { id: '', reportingManagerId: input.reportingManagerId ?? null, departmentId: input.departmentId ?? null }, true)

  const employeeId = await withTransaction(ctx.db, async (tx) => {
    let membershipId: string | null = null
    let roleName: string | null = null

    if (input.login) {
      // An inviter cannot hand out a role above their own — the same rule the
      // invite endpoint applies, reused rather than restated.
      await lockFor(tx, rolesLock(ctx.organizationId))
      roleName = (await assertMayGive(tx, ctx, input.login.role, ['employee:create'])).grant.name

      const created = await createLoginInTransaction(tx, {
        email: input.login.email,
        role: input.login.role,
        organizationId: ctx.organizationId,
        invitedByUserId: ctx.userId,
      })

      membershipId = created.membershipId
      invite = { token: created.inviteToken, expiresAt: created.expiresAt }
    }

    const employee = await repo.createEmployee(tx, {
      organizationId: ctx.organizationId,
      membershipId,
      employeeCode: input.employeeCode.trim(),
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
      ...(input.country ? { country: input.country.toUpperCase() } : {}),
      ...(input.currency ? { currency: input.currency.toUpperCase() } : {}),
    })

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
      })
    }

    await audit(ctx, {
      action: 'employee.created',
      entityType: 'employee',
      entityId: employee.id,
      details: { employeeCode: employee.employeeCode, withLogin: Boolean(input.login), role: input.login?.role ?? null, roleName },
    }, tx)

    return employee.id
  }).catch(asConflict)

  const access = accessFor(ctx)
  const row = await repo.findById(ctx.db, ctx.scopeFor('employee'), employeeId, access)
  if (!row) throw NotFound('Employee was created but could not be read back')

  logger.info('Employee created', { by: ctx.userId, employeeId, withLogin: Boolean(input.login) })

  return { row, access, invite }
}

export type UpdateEmployeeInput = Partial<Omit<CreateEmployeeInput, 'login'>>

export async function updateEmployee(
  ctx: AppContext,
  id: string,
  input: UpdateEmployeeInput,
): Promise<EmployeeResult> {
  const access = accessFor(ctx)
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
  // Admin, with nobody above, is the exception (role:manage is theirs alone).
  if (moved && existing.id === ctx.employeeId && !ctx.can('role:manage')) {
    throw Forbidden('You cannot change your own reporting manager or department. Ask somebody above you.')
  }
  assertWithinReach(ctx, after, false)
  if (moved) assertNoNewReach(ctx, before, after)

  await withTransaction(ctx.db, async (tx) => {
    const data: Record<string, unknown> = {}

    if (input.employeeCode !== undefined) data.employeeCode = input.employeeCode.trim()
    if (input.fullName !== undefined) data.fullName = input.fullName.trim()
    if (input.personalEmail !== undefined) data.personalEmail = input.personalEmail
    if (input.phone !== undefined) data.phone = input.phone
    if (input.dateOfJoining !== undefined) {
      data.dateOfJoining = input.dateOfJoining ? toDateColumn(input.dateOfJoining) : null
    }
    if (input.lastWorkingDate !== undefined) {
      data.lastWorkingDate = input.lastWorkingDate ? toDateColumn(input.lastWorkingDate) : null
    }
    if (input.gender !== undefined) data.gender = input.gender
    if (input.employmentType !== undefined) data.employmentType = input.employmentType
    if (input.departmentId !== undefined) data.departmentId = input.departmentId
    if (input.designationId !== undefined) data.designationId = input.designationId
    if (input.shiftId !== undefined) data.shiftId = input.shiftId
    if (input.reportingManagerId !== undefined) data.reportingManagerId = input.reportingManagerId
    if (input.attendanceMode !== undefined) data.attendanceMode = input.attendanceMode
    if (input.country !== undefined) data.country = input.country?.toUpperCase()
    if (input.currency !== undefined) data.currency = input.currency?.toUpperCase()

    if (Object.keys(data).length > 0) {
      await repo.updateEmployee(tx, id, data)
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
        details: { fields: Object.keys(data), statutoryFields },
      }, tx)
    }
  }).catch(asConflict)

  const row = await repo.findById(ctx.db, scope, id, access)
  if (!row) throw NotFound('Employee not found')

  logger.info('Employee updated', { by: ctx.userId, employeeId: id })

  return { row, access }
}
