import type { ExitReason } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors/AppError'
import { withTransaction, type TxDb } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { logger } from '../../platform/logger'
import { addCalendarDays, dayLabel, fromDateColumn, toDateColumn, type CalendarDate } from '../../domain/shared/dates'
import {
  addMonths,
  defaultLastDay,
  defaultProbationEnd,
  NOTICE_DAYS_MAX,
  PROBATION_MONTHS_MAX,
  stageOf,
  type LifecycleFacts,
  type LifecycleStage,
} from '../../domain/org/lifecycle'
import { mayDecide } from '../../domain/leave/approval'
import { audit } from '../audit/audit.service'
import { notify } from '../notifications/notify.service'
import { companyToday } from '../organization/organization.service'
import { aboveCaller, assertMayChangeEmployment, checkWork, loadWork } from '../organization/workRules.service'
import { approvalWorld, approverName, approverUsers, assertSomebodyDecides, deciderOf } from '../leave/leaveApprover.service'
import { tellNewApprovers } from '../leave/leaveNotices'
import { assertManagerFits, assertNoNewReach, assertWithinReach, treeLock } from '../employee/employee.service'
import { closeLoginsForExit, endSessionsOf, mayCloseLoginsForExit, rolesLock } from '../user/user.service'
import { assertOpenFrom } from '../payroll/payrollLock.service'
import * as repo from './lifecycle.repository'

/**
 * The employee lifecycle (client §43):
 *
 *   Joining soon → Onboarding → On probation → Confirmed → (transfers,
 *   promotions) → Resigned → Serving notice → Exit → Left
 *
 * HR runs it — `employee:lifecycle:manage`, within its employee reach, and
 * never on its own record or a fellow HR person's (their own goes up the tree).
 * A resignation is the employee's to hand in and the person above them to
 * accept, as with leave. Every step is one transaction, under a lock on the
 * person, and lands in their employment history and the audit log.
 */

const lockOf = (employeeId: string) => `lifecycle:${employeeId}`

const EARLIEST_DATE = '2000-01-01'

function factsOf(p: repo.PersonRow): LifecycleFacts {
  const open = p.resignations[0]
  return {
    dateOfJoining: fromDateColumn(p.dateOfJoining),
    onboardedOn: fromDateColumn(p.onboardedOn),
    confirmedOn: fromDateColumn(p.confirmedOn),
    lastWorkingDate: fromDateColumn(p.lastWorkingDate),
    left: p.archivedAt !== null || p.status === 'inactive',
    resignation: open && (open.status === 'submitted' || open.status === 'accepted') ? { status: open.status } : null,
  }
}

const stageFor = (p: repo.PersonRow, today: CalendarDate): LifecycleStage => stageOf(factsOf(p), today)

/** On the roll, in a stage where transfers, promotions and the like still make sense. */
const WORKING: readonly LifecycleStage[] = ['onboarding', 'probation', 'confirmed', 'resigned', 'notice_period']
/** Where a resignation can be handed in. */
const MAY_RESIGN: readonly LifecycleStage[] = ['onboarding', 'probation', 'confirmed']

const STAGE_WORDS: Record<LifecycleStage, string> = {
  joining_soon: 'has not joined yet',
  onboarding: 'is still being onboarded',
  probation: 'is on probation',
  confirmed: 'is confirmed',
  resigned: 'has resigned',
  notice_period: 'is serving notice',
  exit_due: 'is past their last working day',
  left: 'has left the company',
}

/**
 * The first day whose pay a change of last working day alters: the day after
 * the earlier of the old and new dates. A change that adds or removes paid
 * days in a month whose payroll is approved is refused (payrollLock).
 */
function firstPayDayChanged(previous: CalendarDate | null, next: CalendarDate | null): CalendarDate | null {
  const dates = [previous, next].filter((d): d is CalendarDate => Boolean(d)).sort()
  if (dates.length === 0 || previous === next) return null
  return addCalendarDays(dates[0]!, 1)
}

async function assertPayOpen(ctx: AppContext, previous: CalendarDate | null, next: CalendarDate | null): Promise<void> {
  const from = firstPayDayChanged(previous, next)
  if (from) await assertOpenFrom(ctx, from, 'a change to the last working day')
}

function assertDateInRange(value: CalendarDate, label: string, p: repo.PersonRow, latest: CalendarDate | null): void {
  const joined = fromDateColumn(p.dateOfJoining)
  if (joined && value < joined) throw BadRequest(`${label} (${dayLabel(value)}) cannot be before ${p.fullName} joined, on ${dayLabel(joined)}.`)
  if (value < EARLIEST_DATE) throw BadRequest(`${label} is not a date EMS can take.`)
  if (latest && value > latest) throw BadRequest(`${label} cannot be later than today (${dayLabel(latest)}).`)
}

/**
 * The person, for a step HR takes on their record: inside the caller's
 * employee reach (else "not found"), not their own or a fellow lifecycle
 * runner's — that goes up the company tree — and not somebody above them.
 */
async function manageable(ctx: AppContext, employeeId: string): Promise<repo.PersonRow> {
  const person = await repo.findPerson(ctx.db, ctx.scopeFor('employee'), employeeId)
  if (!person) throw NotFound('Employee not found')
  await assertMayChangeEmployment(ctx, ctx.db, employeeId)
  return person
}

/** The person, read again under their lock — the stage they are in now, not when the request arrived. */
async function lockedPerson(tx: TxDb, employeeId: string): Promise<repo.PersonRow> {
  await lockFor(tx, lockOf(employeeId))
  const person = await repo.findPerson(tx, null, employeeId)
  if (!person) throw NotFound('Employee not found')
  return person
}

function refuseStage(p: repo.PersonRow, stage: LifecycleStage, wanted: string): never {
  throw Conflict(`${p.fullName} ${STAGE_WORDS[stage]}, so ${wanted}. Reload to see where they stand.`)
}

async function tellEmployee(ctx: AppContext, tx: TxDb, employeeId: string, title: string, message: string): Promise<void> {
  await notify(ctx, tx, {
    event: 'employment.changed',
    to: { employee: employeeId },
    title,
    message,
    link: null,
    entity: { type: 'employee', id: employeeId },
  })
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export interface LifecycleSettings {
  probationMonths: number
  noticePeriodDays: number
}

export async function getSettings(ctx: AppContext): Promise<LifecycleSettings> {
  const row = await repo.lifecycleSettings(ctx.db, ctx.organizationId)
  if (!row) throw NotFound('Company not found')
  return row
}

export interface ResignationView {
  id: string
  status: string
  reason: string
  submittedOn: CalendarDate
  requestedLastDay: CalendarDate
  lastWorkingDay: CalendarDate | null
  submittedBy: string | null
  onBehalf: boolean
  decidedBy: string | null
  decidedAt: Date | null
  decisionNote: string | null
  closedBy: string | null
  closedAt: Date | null
  closeNote: string | null
  /** Who accepts it — the person they report to — in words. */
  decidedByWhom: string | null
}

export interface EventView {
  id: string
  kind: string
  effectiveDate: CalendarDate
  details: unknown
  note: string | null
  by: string | null
  at: Date
}

export interface LifecycleView {
  employeeId: string
  fullName: string
  stage: LifecycleStage
  dateOfJoining: CalendarDate | null
  onboardedOn: CalendarDate | null
  probationEndDate: CalendarDate | null
  confirmedOn: CalendarDate | null
  lastWorkingDate: CalendarDate | null
  exitReason: ExitReason | null
  departmentId: string | null
  designationId: string | null
  reportingManagerId: string | null
  resignation: ResignationView | null
  onboarding: Awaited<ReturnType<typeof repo.onboardingFacts>> | null
  history: EventView[]
  settings: LifecycleSettings
  /** What the caller may do here, as the server will allow it. */
  may: {
    completeOnboarding: boolean
    extendProbation: boolean
    confirm: boolean
    transfer: boolean
    promote: boolean
    recordResignation: boolean
    exit: boolean
    /** Their last working day, while it is still ahead: completing the exit before it relieves them early. */
    exitFrom: CalendarDate | null
    acceptResignation: boolean
    acceptAsBackup: boolean
    cancelResignation: boolean
    /** Set for the person's own view. */
    resign: boolean
    withdraw: boolean
  }
  /** Lifecycle work on this record goes to somebody else — whom, in words. */
  goesTo: string | null
  /**
   * Whether the caller sees the history, the resignation and the onboarding
   * facts: the person, whoever runs the lifecycle for them, whoever decides
   * for them, and the Super Admin. Anybody else reading the directory sees
   * the stage and the dates — and no resignation before it is accepted.
   */
  detailed: boolean
}

async function resignationView(ctx: AppContext, r: repo.ResignationRow | null, decidedByWhom: string | null): Promise<ResignationView | null> {
  if (!r) return null
  const [names, own] = await Promise.all([
    repo.namesOfUsers(ctx.db, [r.submittedByUserId, r.decidedByUserId ?? '', r.closedByUserId ?? '']),
    repo.loginUsersOf(ctx.db, r.employeeId),
  ])
  return {
    id: r.id,
    status: r.status,
    reason: r.reason,
    submittedOn: fromDateColumn(r.submittedOn),
    requestedLastDay: fromDateColumn(r.requestedLastDay),
    lastWorkingDay: fromDateColumn(r.lastWorkingDay),
    submittedBy: names.get(r.submittedByUserId) ?? null,
    // Handed in by somebody else — HR recording a letter — not from any login of theirs.
    onBehalf: !own.includes(r.submittedByUserId),
    decidedBy: r.decidedByUserId ? (names.get(r.decidedByUserId) ?? null) : null,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    closedBy: r.closedByUserId ? (names.get(r.closedByUserId) ?? null) : null,
    closedAt: r.closedAt,
    closeNote: r.closeNote,
    decidedByWhom: r.status === 'submitted' ? decidedByWhom : null,
  }
}

async function buildView(ctx: AppContext, person: repo.PersonRow, self: boolean): Promise<LifecycleView> {
  const [today, world, settings] = await Promise.all([companyToday(ctx), approvalWorld(ctx.db, ctx.organizationId), getSettings(ctx)])
  const ownRecord = person.id === ctx.employeeId
  const decision = mayDecide(world.tree, world.rules, person.id, deciderOf(ctx))

  // Lifecycle work: the right, not one's own or a fellow runner's, and never
  // on somebody above the caller in the tree.
  const manages = !self && ctx.can('employee:lifecycle:manage')
  const loaded = manages ? await loadWork(ctx.db, ctx.organizationId, 'lifecycle') : null
  const above = loaded ? aboveCaller(ctx, loaded, person.id) : false
  const work = loaded && !above ? checkWork(ctx, loaded, person.id) : null
  const runs = Boolean(work?.allowed)

  const detailed = self || ownRecord || ctx.can('role:manage') || (manages && !above) || decision.allowed
  const open = person.resignations[0] ?? null
  // A resignation not yet accepted is not announced: the directory shows where they stood before it.
  const stage = detailed ? stageFor(person, today) : stageOf({ ...factsOf(person), resignation: open?.status === 'accepted' ? { status: 'accepted' } : null }, today)
  const [latest, events] = detailed
    ? await Promise.all([repo.latestResignation(ctx.db, person.id), repo.eventsOf(ctx.db, person.id)])
    : [null, []]
  const names = await repo.namesOfUsers(ctx.db, events.map((e) => e.createdByUserId ?? ''))

  const joined = fromDateColumn(person.dateOfJoining)
  const lastDay = fromDateColumn(person.lastWorkingDate)
  // The company owner hands in no resignation: nobody is above them to accept it.
  const isOwner = world.rules.ownerEmployeeId === person.id
  // Offered only where the exit could close every login of theirs. Somebody
  // joining soon may be let go too: they are not coming after all.
  const closable = runs && stage !== 'left' && (await mayCloseLoginsForExit(ctx.db, ctx, person.id))

  const resignation = await resignationView(ctx, latest, latest?.status === 'submitted' ? await approverName(ctx.db, world, person.id) : null)

  return {
    employeeId: person.id,
    fullName: person.fullName,
    stage,
    dateOfJoining: joined,
    onboardedOn: fromDateColumn(person.onboardedOn),
    probationEndDate: fromDateColumn(person.probationEndDate),
    confirmedOn: fromDateColumn(person.confirmedOn),
    lastWorkingDate: lastDay,
    exitReason: detailed ? person.exitReason : null,
    departmentId: person.departmentId,
    designationId: person.designationId,
    reportingManagerId: person.reportingManagerId,
    resignation,
    onboarding: detailed && (stage === 'onboarding' || stage === 'joining_soon') ? await repo.onboardingFacts(ctx.db, person.id) : null,
    history: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      effectiveDate: fromDateColumn(e.effectiveDate),
      details: e.details,
      note: e.note,
      by: e.createdByUserId ? (names.get(e.createdByUserId) ?? null) : null,
      at: e.createdAt,
    })),
    settings,
    may: {
      completeOnboarding: runs && stage === 'onboarding' && (!joined || joined <= today),
      extendProbation: runs && stage === 'probation',
      confirm: runs && stage === 'probation',
      transfer: runs && WORKING.includes(stage),
      promote: runs && WORKING.includes(stage),
      recordResignation: runs && MAY_RESIGN.includes(stage) && !open && !isOwner,
      exit: closable,
      exitFrom: closable && lastDay && lastDay > today ? lastDay : null,
      acceptResignation: Boolean(open && open.status === 'submitted' && decision.allowed && !ownRecord),
      acceptAsBackup: Boolean(open && open.status === 'submitted' && decision.allowed && decision.asBackup && !ownRecord),
      cancelResignation: Boolean(open && detailed && !ownRecord && (decision.allowed || runs)),
      resign: self && MAY_RESIGN.includes(stage) && !open && !isOwner,
      withdraw: self && open?.status === 'submitted',
    },
    goesTo: manages && !runs ? (above ? 'the Super Admin' : (work?.ask ?? null)) : null,
    detailed,
  }
}

/** Somebody's lifecycle, for whoever may read their record. */
export async function lifecycleOf(ctx: AppContext, employeeId: string): Promise<LifecycleView> {
  const person = await repo.findPerson(ctx.db, ctx.scopeFor('employee'), employeeId)
  if (!person) throw NotFound('Employee not found')
  return buildView(ctx, person, false)
}

/**
 * Somebody's lifecycle after a step — or null when the step took them out of
 * the caller's reach (a transfer to a department the caller does not see).
 */
export async function lifecycleIfSeen(ctx: AppContext, employeeId: string): Promise<LifecycleView | null> {
  const person = await repo.findPerson(ctx.db, ctx.scopeFor('employee'), employeeId)
  return person ? buildView(ctx, person, false) : null
}

/** The caller's own — for "My profile", on any login with an employee record. */
export async function myLifecycle(ctx: AppContext): Promise<LifecycleView> {
  if (!ctx.employeeId) throw NotFound('Your login has no employee record.')
  const person = await repo.findPerson(ctx.db, null, ctx.employeeId)
  if (!person) throw NotFound('Your login has no employee record.')
  return buildView(ctx, person, true)
}

export interface SummaryItem {
  employeeId: string
  fullName: string
  employeeCode: string
  department: string | null
  /** The date that matters for the list: joining, probation end, last working day… */
  date: CalendarDate | null
}

export interface LifecycleSummary {
  joiningSoon: SummaryItem[]
  onboarding: SummaryItem[]
  /** On probation, ending within 30 days or already past. */
  probationEnding: SummaryItem[]
  resigned: SummaryItem[]
  servingNotice: SummaryItem[]
  exitDue: SummaryItem[]
}

/** Who needs HR's attention, for the dashboard — within the caller's employee reach. */
export async function summary(ctx: AppContext): Promise<LifecycleSummary> {
  const [people, today, loaded] = await Promise.all([
    repo.peopleInScope(ctx.db, ctx.scopeFor('employee')),
    companyToday(ctx),
    loadWork(ctx.db, ctx.organizationId, 'lifecycle'),
  ])
  const soon = addCalendarDays(today, 30)
  const result: LifecycleSummary = { joiningSoon: [], onboarding: [], probationEnding: [], resigned: [], servingNotice: [], exitDue: [] }
  // The people above the caller are the Super Admin's to take steps on — and
  // a senior's resignation is not the caller's to see before it is accepted.
  for (const p of people.filter((person) => !aboveCaller(ctx, loaded, person.id))) {
    const stage = stageFor(p, today)
    const item = (date: Date | null): SummaryItem => ({
      employeeId: p.id,
      fullName: p.fullName,
      employeeCode: p.employeeCode,
      department: p.department?.name ?? null,
      date: fromDateColumn(date),
    })
    if (stage === 'joining_soon') result.joiningSoon.push(item(p.dateOfJoining))
    else if (stage === 'onboarding') result.onboarding.push(item(p.dateOfJoining))
    else if (stage === 'probation') {
      const end = fromDateColumn(p.probationEndDate)
      if (end && end <= soon) result.probationEnding.push(item(p.probationEndDate))
    } else if (stage === 'resigned') result.resigned.push(item(p.resignations[0]?.requestedLastDay ?? null))
    else if (stage === 'notice_period') result.servingNotice.push(item(p.lastWorkingDate))
    else if (stage === 'exit_due') result.exitDue.push(item(p.lastWorkingDate))
  }
  const byDate = (a: SummaryItem, b: SummaryItem) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.fullName.localeCompare(b.fullName)
  for (const list of Object.values(result)) list.sort(byDate)
  return result
}

// ─── HR's steps ─────────────────────────────────────────────────────────────

export async function completeOnboarding(ctx: AppContext, employeeId: string, note: string | null): Promise<void> {
  await manageable(ctx, employeeId)
  const today = await companyToday(ctx)
  const settings = await getSettings(ctx)
  await withTransaction(ctx.db, async (tx) => {
    const p = await lockedPerson(tx, employeeId)
    const stage = stageFor(p, today)
    if (stage !== 'onboarding') refuseStage(p, stage, 'there is no onboarding to complete')
    const joined = fromDateColumn(p.dateOfJoining)
    if (joined && joined > today) throw BadRequest(`${p.fullName} joins on ${dayLabel(joined)}. Onboarding is completed once they have joined.`)
    await repo.updatePerson(tx, employeeId, {
      onboardedOn: toDateColumn(today),
      // A probation end, if none was set: the company's months from joining.
      ...(!p.probationEndDate && joined ? { probationEndDate: toDateColumn(defaultProbationEnd(joined, settings.probationMonths)) } : {}),
    })
    await repo.addEvent(tx, { organizationId: ctx.organizationId, employeeId, kind: 'onboarding_completed', effectiveDate: toDateColumn(today), note, createdByUserId: ctx.userId })
    await audit(ctx, { action: 'lifecycle.onboarding_completed', entityType: 'employee', entityId: employeeId, details: { employeeId, note } }, tx)
    await tellEmployee(ctx, tx, employeeId, 'Onboarding complete', 'HR has completed your onboarding. Welcome aboard.')
  })
  logger.info('Onboarding completed', { by: ctx.userId, employeeId })
}

export async function extendProbation(ctx: AppContext, employeeId: string, input: { probationEndDate: CalendarDate; note: string }): Promise<void> {
  await manageable(ctx, employeeId)
  const today = await companyToday(ctx)
  await withTransaction(ctx.db, async (tx) => {
    const p = await lockedPerson(tx, employeeId)
    const stage = stageFor(p, today)
    if (stage !== 'probation') refuseStage(p, stage, 'their probation cannot be changed')
    const previous = fromDateColumn(p.probationEndDate)
    if (input.probationEndDate === previous) throw BadRequest(`Their probation already ends on ${dayLabel(previous)}.`)
    assertDateInRange(input.probationEndDate, 'The end of probation', p, null)
    if (input.probationEndDate < today) throw BadRequest('The new end of probation cannot be in the past. Confirm them instead, if they have passed it.')
    const latest = addMonths(today, PROBATION_MONTHS_MAX)
    if (input.probationEndDate > latest) throw BadRequest(`Probation can be extended up to ${PROBATION_MONTHS_MAX} months from today (${dayLabel(latest)}).`)
    await repo.updatePerson(tx, employeeId, { probationEndDate: toDateColumn(input.probationEndDate) })
    await repo.addEvent(tx, {
      organizationId: ctx.organizationId, employeeId, kind: 'probation_extended', effectiveDate: toDateColumn(today),
      details: { from: previous, to: input.probationEndDate }, note: input.note, createdByUserId: ctx.userId,
    })
    await audit(ctx, { action: 'lifecycle.probation_extended', entityType: 'employee', entityId: employeeId, details: { employeeId, from: previous, to: input.probationEndDate, note: input.note } }, tx)
    await tellEmployee(ctx, tx, employeeId, 'Probation extended', `Your probation now ends on ${dayLabel(input.probationEndDate)}. ${input.note}`)
  })
  logger.info('Probation extended', { by: ctx.userId, employeeId })
}

export async function confirm(ctx: AppContext, employeeId: string, input: { confirmedOn: CalendarDate; note: string | null }): Promise<void> {
  await manageable(ctx, employeeId)
  const today = await companyToday(ctx)
  await withTransaction(ctx.db, async (tx) => {
    const p = await lockedPerson(tx, employeeId)
    const stage = stageFor(p, today)
    if (stage !== 'probation') refuseStage(p, stage, 'there is no probation to confirm')
    assertDateInRange(input.confirmedOn, 'The confirmation date', p, today)
    await repo.updatePerson(tx, employeeId, { confirmedOn: toDateColumn(input.confirmedOn) })
    await repo.addEvent(tx, {
      organizationId: ctx.organizationId, employeeId, kind: 'confirmed', effectiveDate: toDateColumn(input.confirmedOn),
      details: { probationEndDate: fromDateColumn(p.probationEndDate) }, note: input.note, createdByUserId: ctx.userId,
    })
    await audit(ctx, { action: 'lifecycle.confirmed', entityType: 'employee', entityId: employeeId, details: { employeeId, confirmedOn: input.confirmedOn, note: input.note } }, tx)
    await tellEmployee(ctx, tx, employeeId, 'You are confirmed', `Your probation is over: you are confirmed from ${dayLabel(input.confirmedOn)}.`)
  })
  logger.info('Employee confirmed', { by: ctx.userId, employeeId })
}

export interface TransferInput {
  departmentId?: string | null | undefined
  /** The Super Admin's alone (the company tree). */
  reportingManagerId?: string | null | undefined
  effectiveDate: CalendarDate
  note: string | null
}

export async function transfer(ctx: AppContext, employeeId: string, input: TransferInput): Promise<void> {
  const before = await manageable(ctx, employeeId)
  const today = await companyToday(ctx)
  const managerChanging = input.reportingManagerId !== undefined && input.reportingManagerId !== before.reportingManagerId
  const departmentChanging = input.departmentId !== undefined && input.departmentId !== before.departmentId
  if (!managerChanging && !departmentChanging) throw BadRequest('Choose a new department or a new reporting manager — nothing would change.')
  if (managerChanging && !ctx.can('role:manage')) {
    throw Forbidden('Who somebody reports to is set by the Super Admin, on Settings → Company Tree. Ask the Super Admin to move them.')
  }
  // The same reach rules as editing the record: nobody moves a person into
  // their own department where that would show them more.
  const placeBefore = { id: before.id, reportingManagerId: before.reportingManagerId, departmentId: before.departmentId }
  const placeAfter = {
    id: before.id,
    reportingManagerId: managerChanging ? (input.reportingManagerId ?? null) : before.reportingManagerId,
    departmentId: departmentChanging ? (input.departmentId ?? null) : before.departmentId,
  }
  assertWithinReach(ctx, placeAfter, false)
  assertNoNewReach(ctx, placeBefore, placeAfter)

  await withTransaction(ctx.db, async (tx) => {
    if (managerChanging) {
      await lockFor(tx, treeLock(ctx.organizationId))
      await assertManagerFits(tx, ctx, employeeId, placeAfter.reportingManagerId)
    }
    const p = await lockedPerson(tx, employeeId)
    const stage = stageFor(p, today)
    if (!WORKING.includes(stage)) refuseStage(p, stage, 'they cannot be transferred')
    assertDateInRange(input.effectiveDate, 'The transfer date', p, today)
    const [fromDepartment, toDepartment] = await Promise.all([
      repo.departmentName(tx, p.departmentId),
      departmentChanging ? repo.departmentName(tx, placeAfter.departmentId) : Promise.resolve(null),
    ])
    if (departmentChanging && placeAfter.departmentId && !toDepartment) throw BadRequest('That department was not found.')
    const [fromManager, toManager] = managerChanging
      ? await Promise.all([repo.employeeName(tx, p.reportingManagerId), repo.employeeName(tx, placeAfter.reportingManagerId)])
      : [null, null]

    await repo.updatePerson(tx, employeeId, {
      ...(departmentChanging ? { departmentId: placeAfter.departmentId } : {}),
      ...(managerChanging ? { reportingManagerId: placeAfter.reportingManagerId } : {}),
    })
    const details = {
      ...(departmentChanging ? { fromDepartment, toDepartment } : {}),
      ...(managerChanging ? { fromManager, toManager, managerFrom: p.reportingManagerId, managerTo: placeAfter.reportingManagerId } : {}),
      effectiveDate: input.effectiveDate,
    }
    await repo.addEvent(tx, { organizationId: ctx.organizationId, employeeId, kind: 'transferred', effectiveDate: toDateColumn(input.effectiveDate), details, note: input.note, createdByUserId: ctx.userId })
    await audit(ctx, { action: 'lifecycle.transferred', entityType: 'employee', entityId: employeeId, details: { employeeId, ...details, note: input.note } }, tx)
    const where = [departmentChanging ? `the ${toDepartment ?? 'no'} department` : null, managerChanging ? (toManager ? `reporting to ${toManager}` : 'with nobody above you') : null].filter(Boolean).join(', ')
    await tellEmployee(ctx, tx, employeeId, 'You have been transferred', `From ${dayLabel(input.effectiveDate)} you are in ${where}.`)
    // Their waiting requests — leave, and a resignation — now go to somebody else, who is told.
    if (managerChanging) await tellNewApprovers(ctx, tx, employeeId)
  })
  logger.info('Employee transferred', { by: ctx.userId, employeeId })
}

export async function promote(ctx: AppContext, employeeId: string, input: { designationId: string; effectiveDate: CalendarDate; note: string | null }): Promise<void> {
  const before = await manageable(ctx, employeeId)
  if (input.designationId === before.designationId) throw BadRequest(`${before.fullName} already has that designation.`)
  const today = await companyToday(ctx)
  await withTransaction(ctx.db, async (tx) => {
    const p = await lockedPerson(tx, employeeId)
    const stage = stageFor(p, today)
    if (!WORKING.includes(stage)) refuseStage(p, stage, 'they cannot be promoted')
    assertDateInRange(input.effectiveDate, 'The promotion date', p, today)
    const [fromDesignation, toDesignation] = await Promise.all([repo.designationName(tx, p.designationId), repo.designationName(tx, input.designationId)])
    if (!toDesignation) throw BadRequest('That designation was not found.')
    await repo.updatePerson(tx, employeeId, { designationId: input.designationId })
    const details = { fromDesignation, toDesignation, effectiveDate: input.effectiveDate }
    await repo.addEvent(tx, { organizationId: ctx.organizationId, employeeId, kind: 'promoted', effectiveDate: toDateColumn(input.effectiveDate), details, note: input.note, createdByUserId: ctx.userId })
    await audit(ctx, { action: 'lifecycle.promoted', entityType: 'employee', entityId: employeeId, details: { employeeId, ...details, note: input.note } }, tx)
    await tellEmployee(ctx, tx, employeeId, 'Congratulations on your promotion', `You are now ${toDesignation}, from ${dayLabel(input.effectiveDate)}.`)
  })
  logger.info('Employee promoted', { by: ctx.userId, employeeId })
}

// ─── Resignation ────────────────────────────────────────────────────────────

/** HR, as notices find them: whoever runs the lifecycle, may do it for this person, and whose employee reach includes them. */
const runnersFor = (employeeId: string) =>
  ({ reaching: { permission: 'employee:lifecycle:manage', resource: 'employee', employeeId, work: 'lifecycle' } }) as const

/** Whoever decides the person's resignation — as with leave — and HR, who runs the exit. */
async function tellAboutResignation(ctx: AppContext, tx: TxDb, employeeId: string, message: string, alsoTheEmployee: boolean, title = 'A resignation'): Promise<void> {
  await notify(ctx, tx, {
    event: 'employment.resignation_submitted',
    to: {
      all: [
        { users: await approverUsers(tx, ctx.organizationId, employeeId) },
        runnersFor(employeeId),
        ...(alsoTheEmployee ? [{ employee: employeeId } as const] : []),
      ],
    },
    title,
    message,
    // The dashboard: "waiting for you" for whoever accepts it, the lifecycle card for HR.
    link: '/dashboard',
    entity: { type: 'employee', id: employeeId },
  })
}

async function createResignationFor(
  ctx: AppContext,
  employeeId: string,
  input: { reason: string; submittedOn: CalendarDate | null; requestedLastDay: CalendarDate | null },
  onBehalf: boolean,
): Promise<void> {
  const today = await companyToday(ctx)
  const settings = await getSettings(ctx)
  await withTransaction(ctx.db, async (tx) => {
    const p = await lockedPerson(tx, employeeId)
    const world = await approvalWorld(tx, ctx.organizationId)
    if (world.rules.ownerEmployeeId === employeeId) {
      throw BadRequest('The company owner does not hand in a resignation in EMS: there is nobody above them to accept it.')
    }
    // Nor anybody whose resignation nobody could ever accept.
    await assertSomebodyDecides(tx, world, employeeId)
    const stage = stageFor(p, today)
    if (!MAY_RESIGN.includes(stage)) {
      if (stage === 'resigned' || stage === 'notice_period') throw Conflict(`${onBehalf ? `${p.fullName} has` : 'You have'} already resigned.`)
      refuseStage(p, stage, 'a resignation cannot be handed in')
    }
    const submittedOn = input.submittedOn ?? today
    assertDateInRange(submittedOn, 'The day it was handed in', p, today)
    const requested = input.requestedLastDay ?? defaultLastDay(submittedOn, settings.noticePeriodDays)
    if (requested < submittedOn) throw BadRequest('The last working day asked for cannot be before the day the resignation is handed in.')
    if (!onBehalf && requested < today) throw BadRequest('The last working day you ask for cannot be in the past.')

    const r = await repo.createResignation(tx, {
      organizationId: ctx.organizationId,
      employeeId,
      reason: input.reason,
      submittedOn: toDateColumn(submittedOn),
      requestedLastDay: toDateColumn(requested),
      submittedByUserId: ctx.userId,
    })
    await repo.addEvent(tx, {
      organizationId: ctx.organizationId, employeeId, kind: 'resignation_submitted', effectiveDate: toDateColumn(submittedOn),
      details: { requestedLastDay: requested, onBehalf }, note: input.reason, createdByUserId: ctx.userId,
    })
    await audit(ctx, {
      action: 'lifecycle.resignation_submitted', entityType: 'employee', entityId: employeeId,
      details: { employeeId, resignationId: r.id, requestedLastDay: requested, submittedOn, onBehalf },
    }, tx)
    await tellAboutResignation(
      ctx, tx, employeeId,
      onBehalf
        ? `HR recorded ${p.fullName}'s resignation, handed in on ${dayLabel(submittedOn)}, asking to leave on ${dayLabel(requested)}.`
        : `${p.fullName} has handed in their resignation, asking to leave on ${dayLabel(requested)}.`,
      onBehalf,
    )
  })
}

/** The caller's own resignation, from any login of theirs. */
export async function submitResignation(ctx: AppContext, input: { reason: string; requestedLastDay: CalendarDate | null }): Promise<void> {
  if (!ctx.employeeId) throw Forbidden('Only somebody on the staff can hand in a resignation, and your login has no employee record.')
  await createResignationFor(ctx, ctx.employeeId, { reason: input.reason, submittedOn: null, requestedLastDay: input.requestedLastDay }, false)
  logger.info('Resignation handed in', { employeeId: ctx.employeeId })
}

/** HR recording a resignation handed in on paper or by email. */
export async function recordResignation(
  ctx: AppContext,
  employeeId: string,
  input: { reason: string; submittedOn: CalendarDate; requestedLastDay: CalendarDate | null },
): Promise<void> {
  await manageable(ctx, employeeId)
  await createResignationFor(ctx, employeeId, input, true)
  logger.info('Resignation recorded', { by: ctx.userId, employeeId })
}

/** Taken back by the person, before it is accepted. */
export async function withdrawResignation(ctx: AppContext, resignationId: string): Promise<void> {
  const r = await repo.findResignation(ctx.db, resignationId)
  if (!r || r.employeeId !== ctx.employeeId) throw NotFound('Resignation not found')
  await withTransaction(ctx.db, async (tx) => {
    const p = await lockedPerson(tx, r.employeeId)
    const moved = await repo.moveResignation(tx, r.id, ['submitted'], { status: 'withdrawn', closedByUserId: ctx.userId, closedAt: new Date() })
    if (moved === 0) throw Conflict('Your resignation has already been accepted, so it can no longer be withdrawn. Talk to the person you report to, or to HR.')
    const today = await companyToday(ctx)
    await repo.addEvent(tx, { organizationId: ctx.organizationId, employeeId: r.employeeId, kind: 'resignation_withdrawn', effectiveDate: toDateColumn(today), createdByUserId: ctx.userId })
    await audit(ctx, { action: 'lifecycle.resignation_withdrawn', entityType: 'employee', entityId: r.employeeId, details: { employeeId: r.employeeId, resignationId: r.id } }, tx)
    // Whoever was told it was handed in is told it is taken back.
    await tellAboutResignation(ctx, tx, r.employeeId, `${p.fullName} has withdrawn their resignation and is staying.`, false, 'Resignation withdrawn')
  })
  logger.info('Resignation withdrawn', { employeeId: r.employeeId })
}

/**
 * The resignation, when the caller decides it — the person the employee
 * reports to, as with leave (Settings → Approvals applies, standing in
 * included). Somebody who cannot see the person is told it does not exist.
 */
async function decidable(ctx: AppContext, resignationId: string): Promise<{ r: repo.ResignationRow; asBackup: boolean; allowed: boolean; seen: boolean }> {
  const r = await repo.findResignation(ctx.db, resignationId)
  if (!r) throw NotFound('Resignation not found')
  const world = await approvalWorld(ctx.db, ctx.organizationId)
  const right = mayDecide(world.tree, world.rules, r.employeeId, deciderOf(ctx))
  const seen = right.allowed || r.employeeId === ctx.employeeId || Boolean(await repo.findPerson(ctx.db, ctx.scopeFor('employee'), r.employeeId))
  if (!seen) throw NotFound('Resignation not found')
  return { r, asBackup: right.asBackup, allowed: right.allowed && r.employeeId !== ctx.employeeId, seen }
}

export async function acceptResignation(ctx: AppContext, resignationId: string, input: { lastWorkingDay: CalendarDate; note: string | null }): Promise<void> {
  const { r, asBackup, allowed } = await decidable(ctx, resignationId)
  if (!allowed) {
    if (r.employeeId === ctx.employeeId) throw Forbidden('You cannot accept your own resignation. It goes to the person you report to.')
    const world = await approvalWorld(ctx.db, ctx.organizationId)
    throw Forbidden(`This resignation is accepted by ${await approverName(ctx.db, world, r.employeeId)}, the person they report to in the company tree.`)
  }
  const today = await companyToday(ctx)
  await withTransaction(ctx.db, async (tx) => {
    const p = await lockedPerson(tx, r.employeeId)
    // Removed from Settings → Users a moment ago: nothing is left to accept.
    if (stageFor(p, today) === 'left') refuseStage(p, 'left', 'their resignation can no longer be accepted')
    const submittedOn = fromDateColumn(r.submittedOn)
    if (input.lastWorkingDay < submittedOn) throw BadRequest(`The last working day cannot be before the resignation was handed in, on ${dayLabel(submittedOn)}.`)
    assertDateInRange(input.lastWorkingDay, 'The last working day', p, null)
    await assertPayOpen(ctx, fromDateColumn(p.lastWorkingDate), input.lastWorkingDay)
    const moved = await repo.moveResignation(tx, r.id, ['submitted'], {
      status: 'accepted', lastWorkingDay: toDateColumn(input.lastWorkingDay), decidedByUserId: ctx.userId, decidedAt: new Date(), decisionNote: input.note,
    })
    if (moved === 0) throw Conflict('This resignation was withdrawn or decided a moment ago. Reload to see it.')
    // Payroll pays to this day and not after.
    await repo.updatePerson(tx, r.employeeId, { lastWorkingDate: toDateColumn(input.lastWorkingDay) })
    await repo.addEvent(tx, {
      organizationId: ctx.organizationId, employeeId: r.employeeId, kind: 'resignation_accepted', effectiveDate: toDateColumn(today),
      details: { lastWorkingDay: input.lastWorkingDay, requestedLastDay: fromDateColumn(r.requestedLastDay), ...(asBackup ? { asBackup } : {}) },
      note: input.note, createdByUserId: ctx.userId,
    })
    await audit(ctx, {
      action: 'lifecycle.resignation_accepted', entityType: 'employee', entityId: r.employeeId,
      details: { employeeId: r.employeeId, resignationId: r.id, lastWorkingDay: input.lastWorkingDay, ...(asBackup ? { asBackup } : {}) },
    }, tx)
    await notify(ctx, tx, {
      event: 'employment.resignation_decided',
      to: { all: [{ employee: r.employeeId }, runnersFor(r.employeeId)] },
      title: 'Resignation accepted',
      message: `${p.fullName}'s resignation is accepted. Last working day: ${dayLabel(input.lastWorkingDay)}.`,
      link: null,
      entity: { type: 'employee', id: r.employeeId },
    })
  })
  logger.info('Resignation accepted', { by: ctx.userId, employeeId: r.employeeId })
}

/**
 * Called off — they are staying. By whoever decides it, or by HR; never by
 * the person (before acceptance they withdraw it). The last working day the
 * acceptance set is taken off again.
 */
export async function cancelResignation(ctx: AppContext, resignationId: string, note: string): Promise<void> {
  const { r, allowed } = await decidable(ctx, resignationId)
  let runs = false
  if (!allowed && r.employeeId !== ctx.employeeId && ctx.can('employee:lifecycle:manage')) {
    await manageable(ctx, r.employeeId)
    runs = true
  }
  if (!allowed && !runs) throw Forbidden('Only the person they report to, or HR, can call off a resignation.')
  await withTransaction(ctx.db, async (tx) => {
    const p = await lockedPerson(tx, r.employeeId)
    const current = await repo.findResignation(tx, r.id)
    if (!current || (current.status !== 'submitted' && current.status !== 'accepted')) throw Conflict('This resignation is no longer open. Reload to see it.')
    const lastDay = fromDateColumn(p.lastWorkingDate)
    const clearsLastDay = current.status === 'accepted' && lastDay !== null && lastDay === fromDateColumn(current.lastWorkingDay)
    if (clearsLastDay) await assertPayOpen(ctx, lastDay, null)
    const moved = await repo.moveResignation(tx, r.id, ['submitted', 'accepted'], { status: 'cancelled', closedByUserId: ctx.userId, closedAt: new Date(), closeNote: note })
    if (moved === 0) throw Conflict('This resignation changed a moment ago. Reload to see it.')
    if (clearsLastDay) await repo.updatePerson(tx, r.employeeId, { lastWorkingDate: null })
    const today = await companyToday(ctx)
    await repo.addEvent(tx, { organizationId: ctx.organizationId, employeeId: r.employeeId, kind: 'resignation_cancelled', effectiveDate: toDateColumn(today), note, createdByUserId: ctx.userId })
    await audit(ctx, {
      action: 'lifecycle.resignation_cancelled', entityType: 'employee', entityId: r.employeeId,
      details: { employeeId: r.employeeId, resignationId: r.id, note, ...(clearsLastDay ? { clearedLastWorkingDate: lastDay } : {}) },
    }, tx)
    await notify(ctx, tx, {
      event: 'employment.resignation_decided',
      to: { employee: r.employeeId },
      title: 'Resignation called off',
      message: `Your resignation has been called off — you are staying. ${note}`,
      link: null,
      entity: { type: 'employee', id: r.employeeId },
    })
    // And whoever decides it and HR, who would otherwise still expect them to go.
    await notify(ctx, tx, {
      event: 'employment.resignation_decided',
      to: { all: [{ users: await approverUsers(tx, ctx.organizationId, r.employeeId) }, runnersFor(r.employeeId)] },
      title: 'Resignation called off',
      message: `${p.fullName}'s resignation has been called off — they are staying. ${note}`,
      link: null,
      entity: { type: 'employee', id: r.employeeId },
    })
  })
  logger.info('Resignation called off', { by: ctx.userId, employeeId: r.employeeId })
}

export interface WaitingResignation {
  id: string
  employeeId: string
  fullName: string
  employeeCode: string
  department: string | null
  designation: string | null
  reason: string
  submittedOn: CalendarDate
  requestedLastDay: CalendarDate
  asBackup: boolean
  decidedBy: string
}

/** Resignations waiting for the caller to accept — as the one asked, or standing in. */
export async function waitingResignations(ctx: AppContext): Promise<WaitingResignation[]> {
  const [rows, world] = await Promise.all([repo.submittedResignations(ctx.db), approvalWorld(ctx.db, ctx.organizationId)])
  const decider = deciderOf(ctx)
  const mine = rows
    .filter((r) => r.employeeId !== ctx.employeeId)
    .map((r) => ({ r, right: mayDecide(world.tree, world.rules, r.employeeId, decider) }))
    .filter(({ right }) => right.allowed)
  const result: WaitingResignation[] = []
  for (const { r, right } of mine) {
    result.push({
      id: r.id,
      employeeId: r.employeeId,
      fullName: r.employee.fullName,
      employeeCode: r.employee.employeeCode,
      department: r.employee.department?.name ?? null,
      designation: r.employee.designation?.name ?? null,
      reason: r.reason,
      submittedOn: fromDateColumn(r.submittedOn),
      requestedLastDay: fromDateColumn(r.requestedLastDay),
      asBackup: right.asBackup,
      decidedBy: await approverName(ctx.db, world, r.employeeId),
    })
  }
  return result
}

// ─── Exit ───────────────────────────────────────────────────────────────────

/**
 * Completes somebody's exit: the reason and the last working day recorded,
 * every login closed (the caller must be allowed to manage each — HR does not
 * close a Super Admin's), the record archived, and an open resignation
 * completed. Payroll pays their last month to that day. Done before an
 * accepted last day, it relieves them early. Somebody who was to join and is
 * not coming leaves with no last working day: they never worked a day.
 */
export async function completeExit(
  ctx: AppContext,
  employeeId: string,
  input: { reason: ExitReason; lastWorkingDate: CalendarDate | null; note: string | null },
): Promise<void> {
  await manageable(ctx, employeeId)
  const today = await companyToday(ctx)
  const closed = await withTransaction(ctx.db, async (tx) => {
    // The roles lock before the person's — the order removing somebody takes.
    await lockFor(tx, rolesLock(ctx.organizationId))
    const p = await lockedPerson(tx, employeeId)
    const stage = stageFor(p, today)
    if (stage === 'left') refuseStage(p, stage, 'their exit is already complete')
    const previous = fromDateColumn(p.lastWorkingDate)
    let lastDay: CalendarDate | null = null
    if (stage === 'joining_soon') {
      if (input.lastWorkingDate) throw BadRequest(`${p.fullName} has not joined yet, so there is no last working day. Leave it empty.`)
    } else {
      if (!input.lastWorkingDate) throw BadRequest('Give their last working day.')
      assertDateInRange(input.lastWorkingDate, 'The last working day', p, today)
      await assertPayOpen(ctx, previous, input.lastWorkingDate)
      lastDay = input.lastWorkingDate
    }

    const users = await closeLoginsForExit(tx, ctx, employeeId)
    await repo.updatePerson(tx, employeeId, {
      lastWorkingDate: lastDay ? toDateColumn(lastDay) : null,
      exitReason: input.reason,
      status: 'inactive',
      archivedAt: new Date(),
    })
    const open = p.resignations[0]
    if (open) await repo.moveResignation(tx, open.id, ['submitted', 'accepted'], { status: 'completed', closedByUserId: ctx.userId, closedAt: new Date() })
    await repo.addEvent(tx, {
      organizationId: ctx.organizationId, employeeId, kind: 'exited', effectiveDate: toDateColumn(lastDay ?? today),
      details: { reason: input.reason, loginsClosed: users.length, ...(lastDay ? {} : { neverJoined: true }) }, note: input.note, createdByUserId: ctx.userId,
    })
    await audit(ctx, {
      action: 'lifecycle.exited', entityType: 'employee', entityId: employeeId,
      details: { employeeId, reason: input.reason, lastWorkingDate: lastDay, previousLastWorkingDate: previous, loginsClosed: users.length, note: input.note },
    }, tx)
    return users
  })
  await endSessionsOf(closed)
  logger.info('Exit completed', { by: ctx.userId, employeeId, loginsClosed: closed.length })
}

// ─── Settings ───────────────────────────────────────────────────────────────

export async function updateSettings(ctx: AppContext, input: LifecycleSettings): Promise<LifecycleSettings> {
  if (!Number.isInteger(input.probationMonths) || input.probationMonths < 0 || input.probationMonths > PROBATION_MONTHS_MAX) {
    throw BadRequest(`Probation is 0 to ${PROBATION_MONTHS_MAX} months.`)
  }
  if (!Number.isInteger(input.noticePeriodDays) || input.noticePeriodDays < 0 || input.noticePeriodDays > NOTICE_DAYS_MAX) {
    throw BadRequest(`The notice period is 0 to ${NOTICE_DAYS_MAX} days.`)
  }
  const before = await getSettings(ctx)
  await withTransaction(ctx.db, async (tx) => {
    await repo.updateLifecycleSettings(tx, ctx.organizationId, input)
    await audit(ctx, { action: 'lifecycle.settings_updated', entityType: 'organization', entityId: ctx.organizationId, details: { ...input, before: { ...before } } }, tx)
  })
  return getSettings(ctx)
}
