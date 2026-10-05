import type { Prisma, RequestApprover, RequestType } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import type { Permission } from '../../platform/authz/permissions'
import type { ScopedResource } from '../../platform/authz/scope'
import { AppError, BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors/AppError'
import { withTransaction, type TxDb } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { logger } from '../../platform/logger'
import { employeesInScope, isInScope } from '../../platform/authz/scopeWhere'
import { discardUpload, storeUpload, type IncomingFile } from '../../platform/storage/files'
import { dayLabel, fromDateColumn, monthKey, monthName, monthOfDay, parseWallClock, toDateColumn, type CalendarDate } from '../../domain/shared/dates'
import { clockMinutes, minutesLabel } from '../../domain/attendance/shiftRules'
import { mayDecide } from '../../domain/leave/approval'
import {
  AWAY_DAYS_MAX,
  AWAY_TYPES,
  PROFILE_FIELDS,
  REQUEST_LABELS,
  daysCovered,
  profileFieldLabel,
  requestNumber,
  type ProfileField,
} from '../../domain/requests/requests'
import { audit } from '../audit/audit.service'
import { notify, type Recipients } from '../notifications/notify.service'
import { companyTimezone, companyToday } from '../organization/organization.service'
import { checkWork, loadWork, mayDoWork, type LoadedWork, type WorkKind } from '../organization/workRules.service'
import { approvalWorld, approverName, approverUsers, assertSomebodyDecides, deciderOf, type ApprovalWorld } from '../leave/leaveApprover.service'
import { assertDaysOpen, closedMonthKeys } from '../payroll/payrollLock.service'
import { leaveYearOf, unearnedDays } from '../leave/leave.service'
import * as leaveRepo from '../leave/leave.repository'
import { writeCorrectedDay } from '../attendance/attendanceAdmin.service'
import { readStored } from '../files/readStored'
import * as roleRepo from '../roles/roles.repository'
import { namesOfUsers } from '../lifecycle/lifecycle.repository'
import * as repo from './requests.repository'

/**
 * Requests (client §28–29) — everything an employee asks for besides leave,
 * through one approval engine with one level:
 *
 *   Employee → the one whose decision it is → Approve / Reject
 *
 * Whose decision it is depends on the kind (Settings → Approvals): the person
 * they report to in the company tree, as with leave — or HR, whoever does that
 * kind of work and reaches them (attendance for a correction, employee records
 * for a profile change). Never their own; a fellow HR person's goes up the
 * tree. The company owner's requests need nobody: they are recorded approved.
 * An approval takes effect in the same transaction it is recorded in.
 */

const lockOf = (employeeId: string) => `requests:${employeeId}`

export type RequestRules = repo.RequestRules

/** Whose decision each kind is, by the company's settings. */
export function approverOf(rules: RequestRules, type: RequestType): RequestApprover {
  if (type === 'attendance_correction') return rules.correctionApprover
  if (type === 'work_from_home' || type === 'on_duty') return rules.wfhApprover
  if (type === 'overtime') return rules.overtimeApprover
  if (type === 'leave_encashment') return rules.encashmentApprover
  return rules.profileApprover
}

/**
 * What "HR" means for each kind: the right that decides it, the reach it is
 * measured in, the kind of work — and the right that only sees it (HR's
 * "All requests" view).
 */
const HR_WORK: Record<RequestType, { permission: Permission; resource: ScopedResource; work: WorkKind; who: string; sees: Permission; holds?: Permission }> = {
  attendance_correction: { permission: 'attendance:update', resource: 'attendance', work: 'attendance', who: 'HR, who corrects attendance', sees: 'attendance:read' },
  work_from_home: { permission: 'attendance:update', resource: 'attendance', work: 'attendance', who: 'HR, who keeps attendance', sees: 'attendance:read' },
  on_duty: { permission: 'attendance:update', resource: 'attendance', work: 'attendance', who: 'HR, who keeps attendance', sees: 'attendance:read' },
  overtime: { permission: 'attendance:update', resource: 'attendance', work: 'attendance', who: 'HR, who keeps attendance', sees: 'attendance:read' },
  // Personal details are shown and written, so their reader's right too (client §42).
  profile_change: { permission: 'employee:update', resource: 'employee', work: 'profile', who: 'HR, who keeps employee records', sees: 'employee:update', holds: 'employee:identity:read' },
  leave_encashment: { permission: 'leave:balance:manage', resource: 'leave', work: 'leave_balance', who: 'HR, who keeps leave balances', sees: 'leave:balance:manage' },
}

async function rulesOf(ctx: AppContext): Promise<RequestRules> {
  const rules = await repo.requestRules(ctx.db, ctx.organizationId)
  if (!rules) throw NotFound('Company not found')
  return rules
}

interface Right {
  allowed: boolean
  asBackup: boolean
}
const NO: Right = { allowed: false, asBackup: false }

/** Everything a decision is checked against, read once. */
interface Context {
  world: ApprovalWorld
  rules: RequestRules
  work: Map<WorkKind, LoadedWork>
}

async function contextOf(ctx: AppContext): Promise<Context> {
  const [world, rules] = await Promise.all([approvalWorld(ctx.db, ctx.organizationId), rulesOf(ctx)])
  return { world, rules, work: new Map() }
}

async function workOf(ctx: AppContext, c: Context, kind: WorkKind): Promise<LoadedWork> {
  let loaded = c.work.get(kind)
  if (!loaded) {
    loaded = await loadWork(ctx.db, ctx.organizationId, kind)
    c.work.set(kind, loaded)
  }
  return loaded
}

/** Whether the caller decides this request — ignoring its status, which the caller checks. */
async function decides(ctx: AppContext, c: Context, r: repo.RequestRow): Promise<Right> {
  if (r.employeeId === ctx.employeeId) return NO
  if (approverOf(c.rules, r.type) === 'manager') {
    const right = mayDecide(c.world.tree, c.world.rules, r.employeeId, deciderOf(ctx))
    return { allowed: right.allowed, asBackup: right.asBackup }
  }
  // The employee login of somebody with a role login decides nothing (Day 23).
  if (ctx.selfServiceOnly) return NO
  const hr = HR_WORK[r.type]
  if (!ctx.can(hr.permission) || (hr.holds && !ctx.can(hr.holds))) return NO
  const place = { id: r.employeeId, reportingManagerId: r.employee.reportingManagerId, departmentId: r.employee.departmentId }
  if (!isInScope(ctx.scopeFor(hr.resource), place)) return NO
  return { allowed: checkWork(ctx, await workOf(ctx, c, hr.work), r.employeeId).allowed, asBackup: false }
}

/** Who decides it, in words — for the screen and for a refusal. */
async function decidedByWhom(ctx: AppContext, c: Context, type: RequestType, employeeId: string): Promise<string> {
  return approverOf(c.rules, type) === 'manager' ? approverName(ctx.db, c.world, employeeId) : HR_WORK[type].who
}

/** HR's view of requests: who may see which, without deciding them. */
function hrSees(ctx: AppContext, r: repo.RequestRow): boolean {
  const hr = HR_WORK[r.type]
  if (!ctx.can(hr.sees) || (hr.holds && !ctx.can(hr.holds))) return false
  return isInScope(ctx.scopeFor(hr.resource), { id: r.employeeId, reportingManagerId: r.employee.reportingManagerId, departmentId: r.employee.departmentId })
}

// ─── Views ──────────────────────────────────────────────────────────────────

export interface RequestView {
  row: repo.RequestRow
  number: string
  label: string
  decidedByWhom: string | null
  decidedBy: string | null
  may: { decide: boolean; asBackup: boolean; withdraw: boolean; attach: boolean }
  /**
   * The details themselves (a profile change's phone, address…), or only which
   * ones: shown to the person and to whoever may read personal details (client
   * §42) — not to a manager deciding it without that right.
   */
  showsDetails: boolean
}

async function viewOf(ctx: AppContext, c: Context, r: repo.RequestRow, today: CalendarDate, names: Map<string, string>): Promise<RequestView> {
  const own = r.employeeId === ctx.employeeId
  const right = r.status === 'pending' ? await decides(ctx, c, r) : NO
  return {
    row: r,
    number: requestNumber(r.number),
    label: REQUEST_LABELS[r.type],
    decidedByWhom: r.status === 'pending' ? await decidedByWhom(ctx, c, r.type, r.employeeId) : null,
    decidedBy: r.decidedByUserId ? (names.get(r.decidedByUserId) ?? null) : null,
    may: {
      decide: right.allowed,
      asBackup: right.asBackup,
      withdraw: own && withdrawable(r, today),
      attach: own && r.status === 'pending' && !r.attachmentKey,
    },
    showsDetails: r.type !== 'profile_change' || own || ctx.can('employee:identity:read'),
  }
}

/** Waiting — or an approved away request whose first day is still ahead. */
function withdrawable(r: repo.RequestRow, today: CalendarDate): boolean {
  if (r.status === 'pending') return true
  const from = fromDateColumn(r.fromDate)
  return r.status === 'approved' && AWAY_TYPES.includes(r.type) && Boolean(from && from > today)
}

async function viewsOf(ctx: AppContext, rows: repo.RequestRow[], c?: Context): Promise<RequestView[]> {
  const context = c ?? (await contextOf(ctx))
  const today = await companyToday(ctx)
  const names = await namesOf(ctx, rows.map((r) => r.decidedByUserId ?? '').filter(Boolean))
  const views: RequestView[] = []
  for (const r of rows) views.push(await viewOf(ctx, context, r, today, names))
  return views
}

async function namesOf(ctx: AppContext, userIds: string[]): Promise<Map<string, string>> {
  return namesOfUsers(ctx.db, userIds)
}

// ─── Settings ───────────────────────────────────────────────────────────────

export async function getRules(ctx: AppContext): Promise<RequestRules> {
  return rulesOf(ctx)
}

export async function updateRules(ctx: AppContext, input: RequestRules): Promise<RequestRules> {
  const before = await rulesOf(ctx)
  await withTransaction(ctx.db, async (tx) => {
    await repo.updateRequestRules(tx, ctx.organizationId, input)
    await audit(ctx, { action: 'request.settings_updated', entityType: 'organization', entityId: ctx.organizationId, details: { ...input, before: { ...before } } }, tx)
  })
  return rulesOf(ctx)
}

// ─── Asking ─────────────────────────────────────────────────────────────────

export type NewRequest =
  | { type: 'attendance_correction'; date: CalendarDate; checkIn: string | null; checkOut: string | null; reason: string }
  | { type: 'work_from_home' | 'on_duty'; fromDate: CalendarDate; toDate: CalendarDate; reason: string }
  | { type: 'profile_change'; changes: Partial<Record<ProfileField, string | null>>; reason: string }
  | { type: 'overtime'; date: CalendarDate; minutes: number | null; reason: string }
  | { type: 'leave_encashment'; leaveTypeId: string; days: number; reason: string }

interface Prepared {
  fromDate: CalendarDate | null
  toDate: CalendarDate | null
  details: Prisma.InputJsonObject
}

function assertWorked(person: repo.PersonRow, day: CalendarDate, what: string): void {
  const joined = fromDateColumn(person.dateOfJoining)
  const last = fromDateColumn(person.lastWorkingDate)
  if (joined && day < joined) throw BadRequest(`${what} is before you joined, on ${dayLabel(joined)}.`)
  if (last && day > last) throw BadRequest(`${what} is after your last working day, ${dayLabel(last)}.`)
}

/** Checks a new request against the record as it is now, inside the person's lock. */
async function prepare(ctx: AppContext, tx: TxDb, person: repo.PersonRow, input: NewRequest, today: CalendarDate): Promise<Prepared> {
  switch (input.type) {
    case 'attendance_correction': {
      if (input.date > today) throw BadRequest('A day that has not happened cannot be corrected.')
      assertWorked(person, input.date, 'That day')
      const start = input.checkIn ? parseWallClock(input.checkIn) : null
      const end = input.checkOut ? parseWallClock(input.checkOut) : null
      if (start === null && end === null) throw BadRequest('Give the check-in time, the check-out time, or both.')
      // Out at or before in is the next morning — a night shift — as a day typed by HR reads.
      if (start !== null && end !== null && end === start) throw BadRequest('The check-in and the check-out cannot be the same time.')
      await assertDaysOpen(ctx, [input.date], 'a correction to that day', tx)
      const day = await repo.attendanceOn(tx, person.id, toDateColumn(input.date))
      if (day?.status === 'on_leave') {
        throw BadRequest(`${dayLabel(input.date)} is a day of approved leave. Withdraw or cancel the leave first if you worked that day.`)
      }
      if (await repo.pendingRequestOn(tx, person.id, 'attendance_correction', toDateColumn(input.date))) {
        throw Conflict(`A correction for ${dayLabel(input.date)} is already waiting. Withdraw it to send another.`)
      }
      // Nothing recorded that day: one time alone would leave a day "present" with no hours.
      if (!day?.checkIn && (start === null || end === null)) {
        throw BadRequest(`Nothing is recorded on ${dayLabel(input.date)}, so give both the check-in and the check-out.`)
      }
      // A check-in alone, at or after the check-out on record, could never be approved.
      if (start !== null && end === null && day?.checkOut) {
        const out = clockMinutes(day.checkOut, input.date, await companyTimezone(ctx))
        if (start >= out) throw BadRequest(`The check-out on record is ${wallTime(out)}; a check-in at ${input.checkIn} would be after it. Give both times.`)
      }
      return { fromDate: input.date, toDate: input.date, details: { checkIn: input.checkIn, checkOut: input.checkOut } }
    }
    case 'work_from_home':
    case 'on_duty': {
      if (person.workArrangement === 'remote') throw BadRequest('You work remotely, so no request is needed to check in from where you are.')
      if (input.toDate < input.fromDate) throw BadRequest('The last day cannot be before the first.')
      if (input.fromDate < today) throw BadRequest('These cover days ahead. A day already past is put right with an attendance correction.')
      if (daysCovered(input.fromDate, input.toDate) > AWAY_DAYS_MAX) throw BadRequest(`One request covers at most ${AWAY_DAYS_MAX} days.`)
      assertWorked(person, input.fromDate, 'The first day')
      assertWorked(person, input.toDate, 'The last day')
      const clash = await repo.overlappingAway(tx, person.id, toDateColumn(input.fromDate), toDateColumn(input.toDate))
      if (clash) throw Conflict(`${requestNumber(clash.number)} (${REQUEST_LABELS[clash.type]}) already covers some of these days.`)
      return { fromDate: input.fromDate, toDate: input.toDate, details: {} }
    }
    case 'profile_change': {
      const changes: Record<string, string | null> = {}
      const before: Record<string, string | null> = {}
      for (const { key } of PROFILE_FIELDS) {
        if (!(key in input.changes)) continue
        const next = input.changes[key] ?? null
        const current = currentValue(person, key)
        if (next !== current) {
          changes[key] = next
          before[key] = current
        }
      }
      if (Object.keys(changes).length === 0) throw BadRequest('Nothing would change: these are your details already.')
      if ('fullName' in changes && !changes.fullName) throw BadRequest('Your name cannot be blank.')
      return { fromDate: null, toDate: null, details: { changes, before } }
    }
    case 'overtime': {
      // Worked, then claimed (client §35): the time past the shift is measured
      // when they check out, and what is asked is at most that.
      if (input.date > today) throw BadRequest('Overtime is claimed for a day already worked.')
      assertWorked(person, input.date, 'That day')
      // Whether the company pays overtime NOW decides whether it can be claimed —
      // turned on today, yesterday's long day can be claimed today.
      const policy = await repo.payPolicyOn(tx, toDateColumn(today))
      if (!policy?.overtimeEnabled) throw BadRequest('The company does not pay overtime. Ask HR if you think it should.')
      const day = await repo.attendanceOn(tx, person.id, toDateColumn(input.date))
      const worked = day?.overtimeMinutes ?? 0
      if (!day?.checkOut || worked <= 0) {
        throw BadRequest(`No overtime is recorded on ${dayLabel(input.date)}. Overtime is the time worked past your shift’s hours, counted when you check out. If the times are wrong, ask for an attendance correction first.`)
      }
      const minutes = input.minutes ?? worked
      if (minutes > worked) throw BadRequest(`${minutesLabel(worked)} of overtime is recorded on ${dayLabel(input.date)}. Claim at most that.`)
      const claimed = await repo.overtimeClaimOn(tx, person.id, toDateColumn(input.date))
      if (claimed) throw Conflict(`Overtime on ${dayLabel(input.date)} is already claimed: ${requestNumber(claimed.number)}.`)
      return { fromDate: input.date, toDate: input.date, details: { minutes, recordedMinutes: worked } }
    }
    case 'leave_encashment': {
      const type = await repo.leaveTypeOf(tx, input.leaveTypeId)
      if (!type) throw NotFound('That leave type does not exist')
      if (!type.encashable) throw BadRequest(`${type.name} cannot be turned into pay. Ask HR which leave can.`)
      const policy = await repo.payPolicyOn(tx, toDateColumn(today))
      const startMonth = policy?.leaveYearStartMonth ?? 4
      const leaveYear = leaveYearOf(today, startMonth)
      await assertEncashable(tx, person, type, leaveYear, startMonth, today, input.days)
      return { fromDate: null, toDate: null, details: { leaveTypeId: type.id, leaveTypeName: type.name, days: input.days, leaveYear } }
    }
  }
}

/**
 * Whether these days can be encashed now: within what is left of the balance
 * (less leave applied for, other encashments waiting, and what a monthly type
 * has not earned yet), and within the type's yearly cap.
 */
async function assertEncashable(
  tx: TxDb,
  person: { id: string; dateOfJoining: Date | null },
  type: NonNullable<Awaited<ReturnType<typeof repo.leaveTypeOf>>>,
  leaveYear: number,
  startMonth: number,
  today: CalendarDate,
  days: number,
  exceptId?: string,
): Promise<void> {
  const [balance, pendingLeave, pendingEncash, unearned, encashed] = await Promise.all([
    leaveRepo.balanceOn(tx, person.id, type.id, leaveYear),
    leaveRepo.pendingDays(tx, person.id, type.id, leaveYear),
    repo.pendingEncashDays(tx, person.id, type.id, leaveYear, exceptId),
    unearnedDays(tx, person.id, type, leaveYear, startMonth, fromDateColumn(person.dateOfJoining), today),
    leaveRepo.encashedDays(tx, person.id, type.id, leaveYear),
  ])
  const available = Math.round((balance - pendingLeave - pendingEncash - unearned) * 2) / 2
  if (days > available) {
    const some = available > 0 ? `Only ${available} day${available === 1 ? '' : 's'}` : 'No days'
    const held = pendingLeave + pendingEncash > 0 ? ', after what is waiting for approval' : ''
    throw BadRequest(`${some} of ${type.name} can be encashed now${held}.`)
  }
  const cap = type.encashMaxDaysPerYear === null ? null : Number(type.encashMaxDaysPerYear)
  if (cap !== null && encashed + pendingEncash + days > cap) {
    throw BadRequest(`At most ${cap} days of ${type.name} can be encashed in a leave year; ${encashed + pendingEncash} already are or are waiting.`)
  }
}

function currentValue(person: repo.PersonRow, key: ProfileField): string | null {
  if (key === 'dateOfBirth') return fromDateColumn(person.dateOfBirth)
  const value = person[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/** Who to tell that a request waits — the same people who could decide it. */
async function deciders(ctx: AppContext, tx: TxDb, c: Context, type: RequestType, employeeId: string): Promise<Recipients> {
  if (approverOf(c.rules, type) === 'manager') return { users: await approverUsers(tx, ctx.organizationId, employeeId) }
  const hr = HR_WORK[type]
  // Told only if they hold every right deciding it needs.
  return { reaching: { permission: hr.permission, resource: hr.resource, employeeId, work: hr.work, ...(hr.holds ? { alsoHolding: hr.holds } : {}) } }
}

/** Refuses a request nobody could ever decide, rather than letting it wait for ever. */
async function assertDecidable(ctx: AppContext, tx: TxDb, c: Context, type: RequestType, employeeId: string): Promise<void> {
  if (approverOf(c.rules, type) === 'manager') return assertSomebodyDecides(tx, c.world, employeeId)
  const hr = HR_WORK[type]
  const loaded = await workOf(ctx, c, hr.work)
  const holders = (await roleRepo.membershipsHolding(tx, hr.permission))
    .filter((m) => m.status === 'active' && m.employee?.id !== employeeId)
    .filter((m) => !hr.holds || m.roleDef.locked || m.roleDef.permissions.includes(hr.holds))
  if (!holders.some((m) => mayDoWork(loaded, { employeeId: m.employee?.id ?? null, isSuperAdmin: m.roleDef.locked }, employeeId))) {
    throw BadRequest('Nobody could decide this request: nobody else does that kind of work for you. Ask the Super Admin to set who approves it in Settings → Approvals.')
  }
}

/** What an approval does, inside its transaction. */
async function takeEffect(ctx: AppContext, tx: TxDb, r: repo.RequestRow): Promise<void> {
  const details = r.details as Record<string, unknown>
  if (r.type === 'attendance_correction') {
    const date = fromDateColumn(r.fromDate)!
    // Under the month's payroll lock: approved since it was asked, it is refused rather than missed.
    await assertDaysOpen(ctx, [date], 'a correction to that day', tx)
    await writeCorrectedDay(tx, ctx, {
      employeeId: r.employeeId,
      date,
      checkIn: (details.checkIn as string | null) ?? null,
      checkOut: (details.checkOut as string | null) ?? null,
      note: `${requestNumber(r.number)}: ${r.reason}`,
    })
    return
  }
  if (r.type === 'profile_change') {
    const changes = (details.changes ?? {}) as Record<string, string | null>
    const data: Prisma.EmployeeUpdateInput = {}
    for (const [key, value] of Object.entries(changes)) {
      if (!PROFILE_FIELDS.some((f) => f.key === key)) continue
      if (key === 'dateOfBirth') data.dateOfBirth = value ? toDateColumn(value) : null
      else if (key === 'fullName') data.fullName = value ?? undefined
      else (data as Record<string, unknown>)[key] = value
    }
    await repo.updatePersonal(tx, r.employeeId, data)
    return
  }
  if (r.type === 'overtime') {
    // Paid with the salary of the month it was worked in — or, once that
    // month is signed off, the next month still open.
    const person = await repo.personOf(tx, r.employeeId)
    if (!person) throw NotFound('Employee not found')
    const pay = await payMonthFor(ctx, tx, monthOfDay(fromDateColumn(r.fromDate)!), fromDateColumn(person.lastWorkingDate), 'this overtime')
    await repo.setDetails(tx, r.id, { ...(details as Prisma.InputJsonObject), payYear: pay.year, payMonth: pay.month })
    return
  }
  if (r.type === 'leave_encashment') {
    // The person's leave lock, as leave applications and approvals take it:
    // the balance read here must not move before the days come off it.
    await lockFor(tx, `leave-apply:${r.employeeId}`)
    const type = await repo.leaveTypeOf(tx, String(details.leaveTypeId))
    if (!type) throw NotFound('That leave type no longer exists')
    if (!type.encashable) throw Conflict(`${type.name} can no longer be encashed. Reject this request.`)
    const person = await repo.personOf(tx, r.employeeId)
    if (!person) throw NotFound('Employee not found')
    const today = await companyToday(ctx)
    // The month it is paid in, chosen — and held — before the days come off.
    const pay = await payMonthFor(ctx, tx, monthOfDay(today), fromDateColumn(person.lastWorkingDate), 'this encashment')
    const leaveYear = Number(details.leaveYear)
    const policy = await repo.payPolicyOn(tx, toDateColumn(today))
    const days = Number(details.days)
    await assertEncashable(tx, person, type, leaveYear, policy?.leaveYearStartMonth ?? 4, today, days, r.id)
    await repo.encashFromBalance(tx, {
      organizationId: ctx.organizationId,
      employeeId: r.employeeId,
      leaveTypeId: type.id,
      leaveYear,
      days: -days,
      reason: 'encashed',
      note: `${requestNumber(r.number)}: encashed`,
      createdByUserId: ctx.userId,
    })
    await repo.setDetails(tx, r.id, { ...(details as Prisma.InputJsonObject), payYear: pay.year, payMonth: pay.month })
  }
  // Working from home or on duty takes effect at check-in, which looks for it.
}

/** "18:30" from minutes past midnight (past 1440 is the next morning's time). */
const wallTime = (minutes: number) => `${String(Math.floor((minutes % 1440) / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

type Month = { year: number; month: number }
const nextMonth = (m: Month): Month => (m.month === 12 ? { year: m.year + 1, month: 1 } : { year: m.year, month: m.month + 1 })
const order = (m: Month) => m.year * 12 + m.month

/**
 * The payroll month an approved overtime claim or encashment is paid in: the
 * month asked for, or the first after it still open — never after the month
 * somebody leaves in, whose payroll is their last. Held under that month's
 * payroll lock to the end of the transaction, so the month cannot be approved
 * between this choice and the approval being saved; a payroll approved after
 * it sees this and asks to be recalculated first.
 */
async function payMonthFor(ctx: AppContext, tx: TxDb, from: Month, lastDay: CalendarDate | null, what: string): Promise<Month> {
  const last = lastDay ? monthOfDay(lastDay) : null
  let pay = last && order(last) < order(from) ? last : from
  const closed = await closedMonthKeys(ctx, tx)
  while (closed.has(monthKey(pay.year, pay.month))) pay = nextMonth(pay)
  if (last && order(pay) > order(last)) {
    throw Conflict(`Their last payroll, ${monthName(last.year, last.month)}, is already approved, so ${what} cannot be paid through payroll. Pay it with their final settlement and reject this request.`)
  }
  if ((await closedMonthKeys(ctx, tx, [pay])).has(monthKey(pay.year, pay.month))) {
    throw Conflict(`The ${monthName(pay.year, pay.month)} payroll was approved a moment ago. Try again.`)
  }
  return pay
}

export async function submit(ctx: AppContext, input: NewRequest): Promise<RequestView> {
  if (!ctx.employeeId) throw Forbidden('Only somebody on the staff can send a request, and your login has no employee record.')
  const employeeId = ctx.employeeId
  const today = await companyToday(ctx)
  const c = await contextOf(ctx)
  const created = await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, lockOf(employeeId))
    const person = await repo.personOf(tx, employeeId)
    if (!person || person.archivedAt || person.status === 'inactive') throw Forbidden('You have left the company, so you cannot send requests.')
    const prepared = await prepare(ctx, tx, person, input, today)
    // The owner's requests need nobody's approval, as their leave needs none.
    const owner = c.world.rules.ownerEmployeeId === employeeId
    if (!owner) await assertDecidable(ctx, tx, c, input.type, employeeId)
    const row = await repo.createRequest(tx, {
      organizationId: ctx.organizationId,
      employeeId,
      type: input.type,
      status: owner ? 'approved' : 'pending',
      fromDate: prepared.fromDate ? toDateColumn(prepared.fromDate) : null,
      toDate: prepared.toDate ? toDateColumn(prepared.toDate) : null,
      details: prepared.details,
      reason: input.reason,
      submittedByUserId: ctx.userId,
      ...(owner ? { decidedByUserId: ctx.userId, decidedAt: new Date(), decisionNote: 'Recorded directly: the owner’s requests need no approval.' } : {}),
    })
    await audit(ctx, {
      action: 'request.submitted',
      entityType: 'employee_request',
      entityId: row.id,
      details: { employeeId, number: row.number, type: input.type, fromDate: prepared.fromDate, toDate: prepared.toDate, ...auditable(input.type, prepared.details), recordedDirectly: owner },
    }, tx)
    if (owner) {
      await takeEffect(ctx, tx, row)
    } else {
      await notify(ctx, tx, {
        event: 'request.submitted',
        to: await deciders(ctx, tx, c, input.type, employeeId),
        title: `${REQUEST_LABELS[input.type]} to decide`,
        message: `${person.fullName} asks: ${summaryOf(row)}. ${input.reason}`,
        link: '/requests?tab=decide',
        entity: { type: 'employee_request', id: row.id },
      })
    }
    return row
  })
  logger.info('Request sent', { employeeId, type: input.type, number: created.number })
  const [view] = await viewsOf(ctx, [created], c)
  return view!
}

/** A request in a line: "a correction to 2 Oct (in 09:30, out 18:30)". */
function summaryOf(r: repo.RequestRow): string {
  const details = r.details as Record<string, unknown>
  const from = fromDateColumn(r.fromDate)
  const to = fromDateColumn(r.toDate)
  const days = from && to ? (from === to ? dayLabel(from) : `${dayLabel(from)} to ${dayLabel(to)}`) : ''
  switch (r.type) {
    case 'attendance_correction': {
      const times = [details.checkIn ? `in ${details.checkIn}` : null, details.checkOut ? `out ${details.checkOut}` : null].filter(Boolean).join(', ')
      return `a correction to ${days} (${times})`
    }
    case 'work_from_home':
      return `to work from home, ${days}`
    case 'on_duty':
      return `to be on duty away from the office, ${days}`
    case 'overtime': {
      const paid = details.payMonth ? `, paid with ${monthName(Number(details.payYear), Number(details.payMonth))}’s salary` : ''
      return `overtime on ${days} (${minutesLabel(Number(details.minutes ?? 0))})${paid}`
    }
    case 'profile_change':
      return `a change to their ${Object.keys((details.changes ?? {}) as object).map(profileFieldLabel).join(', ').toLowerCase()}`
    case 'leave_encashment': {
      const n = Number(details.days ?? 0)
      const paid = details.payMonth ? `, paid with ${monthName(Number(details.payYear), Number(details.payMonth))}’s salary` : ''
      return `to encash ${n} day${n === 1 ? '' : 's'} of ${String(details.leaveTypeName ?? 'leave')}${paid}`
    }
  }
}

/** The supporting file, while the request waits — one per request. */
export async function attach(ctx: AppContext, id: string, file: IncomingFile): Promise<RequestView> {
  const r = await repo.findRequest(ctx.db, id)
  if (!r || r.employeeId !== ctx.employeeId) throw NotFound('Request not found')
  if (r.status !== 'pending') throw Conflict('This request has been decided, so nothing more can be added to it.')
  if (r.attachmentKey) throw Conflict('This request has a file already. Withdraw it and send it again to change the file.')
  const stored = await storeUpload(file, { organizationId: ctx.organizationId, kind: 'request-attachment', ownerId: r.employeeId }, await repo.uploadLimit(ctx.db, ctx.organizationId))
  try {
    await withTransaction(ctx.db, async (tx) => {
      await lockFor(tx, lockOf(r.employeeId))
      const now = await repo.findRequest(tx, id)
      if (!now || now.status !== 'pending' || now.attachmentKey) throw Conflict('This request changed a moment ago. Reload to see it.')
      await repo.setAttachment(tx, id, {
        attachmentKey: stored.key,
        attachmentName: stored.fileName,
        attachmentType: stored.contentType,
        attachmentBytes: stored.bytes,
        attachmentSha256: stored.sha256,
      })
      await audit(ctx, { action: 'request.attachment_added', entityType: 'employee_request', entityId: id, details: { number: r.number, fileName: stored.fileName, bytes: stored.bytes } }, tx)
    })
  } catch (err) {
    if (err instanceof AppError) await discardUpload(stored.key)
    throw err
  }
  return view(ctx, id)
}

// ─── Deciding ───────────────────────────────────────────────────────────────

export async function decide(ctx: AppContext, id: string, verdict: 'approved' | 'rejected', note: string | null): Promise<RequestView> {
  const r = await repo.findRequest(ctx.db, id)
  if (!r) throw NotFound('Request not found')
  const c = await contextOf(ctx)
  const right = await decides(ctx, c, r)
  if (!right.allowed) {
    if (r.employeeId !== ctx.employeeId && !hrSees(ctx, r)) throw NotFound('Request not found')
    const who = await decidedByWhom(ctx, c, r.type, r.employeeId)
    throw Forbidden(r.employeeId === ctx.employeeId ? `You cannot decide your own request. It goes to ${who}.` : `This request is decided by ${who}.`)
  }
  if (verdict === 'rejected' && !note) throw BadRequest('Say why it is rejected — the employee is told.')
  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, lockOf(r.employeeId))
    const moved = await repo.moveRequest(tx, id, ['pending'], { status: verdict, decidedByUserId: ctx.userId, decidedAt: new Date(), decisionNote: note })
    if (moved === 0) throw Conflict('This request was withdrawn or decided a moment ago. Reload to see it.')
    if (verdict === 'approved') await takeEffect(ctx, tx, r)
    const details = r.details as Record<string, unknown>
    await audit(ctx, {
      action: verdict === 'approved' ? 'request.approved' : 'request.rejected',
      entityType: 'employee_request',
      entityId: id,
      details: {
        employeeId: r.employeeId,
        number: r.number,
        type: r.type,
        note,
        ...(right.asBackup ? { asBackup: true } : {}),
        ...(r.type === 'profile_change' && verdict === 'approved' ? { changes: changesOf(details) } : {}),
      },
    }, tx)
    await notify(ctx, tx, {
      event: 'request.decided',
      to: { employee: r.employeeId },
      title: `${REQUEST_LABELS[r.type]} ${verdict === 'approved' ? 'approved' : 'rejected'}`,
      message: `Your request ${requestNumber(r.number)}, ${summaryOf(r).replace('their', 'your')}, is ${verdict}.${note ? ` ${note}` : ''}`,
      link: '/requests',
      entity: { type: 'employee_request', id },
    })
  })
  logger.info('Request decided', { by: ctx.userId, number: r.number, verdict })
  return view(ctx, id)
}

/**
 * Each changed detail for the audit log (client §47): the name's old and new
 * value; every other detail — phone, email, birth date, address, emergency
 * contact — by name only, as an employee edit records them. A log more
 * people will one day read than hold the permission is no place for them;
 * the request itself keeps the values, for whoever may see it.
 */
function changesOf(details: Record<string, unknown>): Record<string, { from: unknown; to: unknown } | null> {
  const changes = (details.changes ?? {}) as Record<string, unknown>
  const before = (details.before ?? {}) as Record<string, unknown>
  return Object.fromEntries(Object.keys(changes).map((k) => [k, k === 'fullName' ? { from: before[k] ?? null, to: changes[k] } : null]))
}

/** What a new request's audit row keeps: a profile change's fields by name (as changesOf), the rest as asked. */
function auditable(type: RequestType, details: Prisma.InputJsonObject): Record<string, unknown> {
  if (type !== 'profile_change') return details
  return { fields: Object.keys((details.changes ?? {}) as object) }
}

export async function withdraw(ctx: AppContext, id: string): Promise<RequestView> {
  const r = await repo.findRequest(ctx.db, id)
  if (!r || r.employeeId !== ctx.employeeId) throw NotFound('Request not found')
  const today = await companyToday(ctx)
  const c = await contextOf(ctx)
  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, lockOf(r.employeeId))
    const now = await repo.findRequest(tx, id)
    if (!now || !withdrawable(now, today)) {
      throw Conflict('This request has been decided, so it can no longer be withdrawn. Talk to whoever decided it.')
    }
    const moved = await repo.moveRequest(tx, id, [now.status], { status: 'withdrawn' })
    if (moved === 0) throw Conflict('This request changed a moment ago. Reload to see it.')
    await audit(ctx, { action: 'request.withdrawn', entityType: 'employee_request', entityId: id, details: { employeeId: r.employeeId, number: r.number, type: r.type, wasApproved: now.status === 'approved' } }, tx)
    await notify(ctx, tx, {
      event: 'request.submitted',
      to: await deciders(ctx, tx, c, r.type, r.employeeId),
      title: `${REQUEST_LABELS[r.type]} withdrawn`,
      message: `${r.employee.fullName} has withdrawn ${requestNumber(r.number)}: ${summaryOf(r)}.`,
      link: null,
      entity: { type: 'employee_request', id },
    })
  })
  return view(ctx, id)
}

// ─── Reading ────────────────────────────────────────────────────────────────

/** One request, for whoever may see it: the person, whoever decides it, and HR within reach. */
export async function view(ctx: AppContext, id: string): Promise<RequestView> {
  const r = await repo.findRequest(ctx.db, id)
  if (!r) throw NotFound('Request not found')
  const c = await contextOf(ctx)
  if (!(await canSee(ctx, c, r))) throw NotFound('Request not found')
  const [result] = await viewsOf(ctx, [r], c)
  return result!
}

/**
 * The person's own; HR's, within its reach; and whoever decides that person's
 * requests of this kind now — whether it waits or was decided. Not whoever
 * decided it once: a manager whose report moved, or whose role changed, no
 * longer reads what they decided then.
 */
async function canSee(ctx: AppContext, c: Context, r: repo.RequestRow): Promise<boolean> {
  if (r.employeeId === ctx.employeeId || hrSees(ctx, r)) return true
  return (await decides(ctx, c, r)).allowed
}

export async function mine(ctx: AppContext): Promise<RequestView[]> {
  if (!ctx.employeeId) return []
  return viewsOf(ctx, await repo.requestsOf(ctx.db, ctx.employeeId))
}

/** Requests waiting for the caller to decide — as the one asked, or standing in. */
export async function waiting(ctx: AppContext): Promise<RequestView[]> {
  const c = await contextOf(ctx)
  const pending = await repo.pendingRequests(ctx.db)
  const mineToDecide: repo.RequestRow[] = []
  for (const r of pending) if ((await decides(ctx, c, r)).allowed) mineToDecide.push(r)
  return viewsOf(ctx, mineToDecide, c)
}

export interface ListFilters {
  type?: RequestType | undefined
  status?: 'pending' | 'approved' | 'rejected' | 'withdrawn' | undefined
}

/**
 * The requests the caller's rights and reach show, kind by kind — the "All
 * requests" view, and the Requests report, alike. Empty: none.
 */
export function requestReach(ctx: AppContext): Prisma.EmployeeRequestWhereInput[] {
  const reaches: Prisma.EmployeeRequestWhereInput[] = []
  const within = (resource: ScopedResource): Prisma.EmployeeRequestWhereInput => {
    const scope = ctx.scopeFor(resource)
    // The whole company is no condition at all — never `employee: {}` inside an OR.
    return scope.scope === 'ORGANIZATION' ? {} : { employee: employeesInScope(scope) }
  }
  const byKind = new Map<string, RequestType[]>()
  for (const [type, hr] of Object.entries(HR_WORK) as [RequestType, (typeof HR_WORK)[RequestType]][]) {
    if (!ctx.can(hr.sees) || (hr.holds && !ctx.can(hr.holds))) continue
    byKind.set(hr.resource, [...(byKind.get(hr.resource) ?? []), type])
  }
  for (const [resource, types] of byKind) reaches.push({ type: { in: types }, ...within(resource as ScopedResource) })
  return reaches
}

/**
 * Every request the caller's reach shows — HR's view (client §29): attendance
 * kinds within the attendance reach, profile changes within the employee
 * reach, encashments within the leave reach. Nobody else sees other people's
 * requests here.
 */
export async function all(ctx: AppContext, filters: ListFilters): Promise<RequestView[]> {
  const reaches = requestReach(ctx)
  if (reaches.length === 0) throw Forbidden('Your role does not see other people’s requests.')
  const rows = await repo.listRequests(ctx.db, {
    AND: [
      { OR: reaches },
      ...(filters.type ? [{ type: filters.type }] : []),
      ...(filters.status ? [{ status: filters.status }] : []),
    ],
  })
  return viewsOf(ctx, rows)
}

/** The supporting file, to whoever may see the request. */
export async function attachment(ctx: AppContext, id: string): Promise<{ bytes: Buffer; name: string; type: string }> {
  const r = await repo.findRequest(ctx.db, id)
  if (!r || !r.attachmentKey || !r.attachmentSha256) throw NotFound('No file is attached to this request')
  const c = await contextOf(ctx)
  if (!(await canSee(ctx, c, r))) throw NotFound('No file is attached to this request')
  const bytes = await readStored(ctx, { key: r.attachmentKey, sha256: r.attachmentSha256 }, { type: 'employee_request', id })
  await audit(ctx, { action: 'request.attachment_downloaded', entityType: 'employee_request', entityId: id, details: { number: r.number, fileName: r.attachmentName } })
  return { bytes, name: r.attachmentName ?? 'attachment', type: r.attachmentType ?? 'application/octet-stream' }
}

/** The largest file the company accepts — for the request form to shrink a photo to. */
export async function uploadLimit(ctx: AppContext): Promise<number> {
  return repo.uploadLimit(ctx.db, ctx.organizationId)
}

/** The caller's own details, as a profile change starts from them. */
export async function myDetails(ctx: AppContext): Promise<Record<ProfileField, string | null>> {
  if (!ctx.employeeId) throw NotFound('Your login has no employee record.')
  const person = await repo.personOf(ctx.db, ctx.employeeId)
  if (!person) throw NotFound('Your login has no employee record.')
  return Object.fromEntries(PROFILE_FIELDS.map(({ key }) => [key, currentValue(person, key)])) as Record<ProfileField, string | null>
}
