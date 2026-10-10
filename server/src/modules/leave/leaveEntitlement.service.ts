import type { AppContext } from '../../platform/context'
import type { ScopedDb } from '../../platform/db/scoped'
import { withTransaction, type TxDb } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { BadRequest, Forbidden, NotFound } from '../../platform/errors/AppError'
import { logger } from '../../platform/logger'
import { addCalendarDays, dayLabel, fromDateColumn, zonedToday, type CalendarDate } from '../../domain/shared/dates'
import { leaveYearBounds, leaveYearLabel, planGrant, proRatedQuota, toHalfDays, yearShare, type GrantEntry, type JoinerGrant } from '../../domain/leave/grant'
import { isUnlimited } from '../../domain/leave/leaveDays'
import { getCurrentPolicy } from '../settings/settings.repository'
import { findTimezone } from '../organization/organization.repository'
import { audit, auditSystem } from '../audit/audit.service'
import { notify } from '../notifications/notify.service'
import { assertWorkGoesUp, checkWork, loadWork } from '../organization/workRules.service'
import { pendingEncashDays, pendingEncashments } from '../requests/requests.repository'
import { leaveYearOf, statementFor } from './leave.service'
import * as repo from './leave.repository'

/**
 * Who gets how much leave, and when it is given (client, 9 Oct 2026).
 *
 * ONE PLAN, EVERY GRANT. The Grant leave button, the terminal command, the
 * nightly job, a new joiner, a change to somebody's days a year, a corrected
 * joining date and a change to a type's days for everybody all work out a
 * person's year by the same rules (domain/leave/grant.ts): their own days a
 * year where they have them, else the type's; what the type gives a joiner;
 * nothing granted twice.
 *
 * A YEAR'S GRANT CHANGED is written as the difference, as an `opening_grant`
 * entry — the year's grant, changed — never an edit: the ledger keeps what was
 * given and what changed it. What a monthly type earns follows the new total.
 * Days already taken or applied for are never taken back: a cut goes only as
 * far as what is left, and says how far that was. HR's own corrections are a
 * different reason (`adjustment`) and are left alone.
 *
 * LOCKS, ALWAYS IN THIS ORDER: the year's grant lock (`leave-grant:…`, which
 * the button takes), then a person's leave lock (`leave-apply:…`, which an
 * application and an approval take). Nothing takes them the other way round.
 */

export interface LeaveYearNow {
  leaveYear: number
  startMonth: number
  today: CalendarDate
}

/** Today's leave year on the company's clock, and the month years start in. */
export async function leaveYearNow(db: ScopedDb, organizationId: string): Promise<LeaveYearNow> {
  const [policy, timezone] = await Promise.all([getCurrentPolicy(db), findTimezone(db, organizationId)])
  const startMonth = policy?.leaveYearStartMonth ?? 4
  const today = zonedToday(new Date(), timezone ?? 'Asia/Kolkata')
  return { leaveYear: leaveYearOf(today, startMonth), startMonth, today }
}

export const grantLock = (organizationId: string, leaveYear: number) => `leave-grant:${organizationId}:${leaveYear}`

/** This year's grant lock and next year's, in that order — for a change that may reach either. */
export async function holdGrantLocks(tx: TxDb, organizationId: string, year: LeaveYearNow): Promise<void> {
  await lockFor(tx, grantLock(organizationId, year.leaveYear))
  await lockFor(tx, grantLock(organizationId, year.leaveYear + 1))
}

export interface GrantPerson {
  id: string
  dateOfJoining: Date | null
  lastWorkingDate: Date | null
  status: string
}

const sumOf = (value: { _sum: { days: unknown } }) => Number(value._sum.days ?? 0)

/**
 * What granting a year to these people would add now: each one's year by the
 * rules, and last year's unused days carried in where the type carries them —
 * once last year has nothing of that type still applied for, or waiting to be
 * encashed: carried once, a carry is never topped up, so days held by a
 * request rejected after the year turned would otherwise lapse. Until then it
 * waits, and the next grant (the nightly one, or the button) carries it.
 */
export async function planYearFor(db: ScopedDb | TxDb, people: readonly GrantPerson[], year: LeaveYearNow) {
  const ids = people.map((p) => p.id)
  const [types, already, lastYear, lastYearPending, lastYearEncashing, own] = await Promise.all([
    repo.activeLeaveTypes(db),
    repo.grantsMade(db, year.leaveYear),
    repo.ledgerTotals(db, ids, year.leaveYear - 1),
    repo.pendingTotals(db, ids, year.leaveYear - 1),
    pendingEncashments(db, year.leaveYear - 1),
    repo.ownQuotasOf(db, ids),
  ])
  const left = new Map(lastYear.map((t) => [`${t.employeeId}|${t.leaveTypeId}`, sumOf(t)]))
  const waiting = new Set<string>()
  for (const p of lastYearPending) {
    const key = `${p.employeeId}|${p.leaveTypeId}`
    left.set(key, (left.get(key) ?? 0) - sumOf(p))
    if (sumOf(p) > 0) waiting.add(key)
  }
  for (const e of lastYearEncashing) {
    const key = `${e.employeeId}|${e.leaveTypeId}`
    if (left.has(key)) left.set(key, (left.get(key) ?? 0) - Number(e.days ?? 0))
    waiting.add(key)
  }
  const entries = planGrant({
    leaveYear: year.leaveYear,
    startMonth: year.startMonth,
    today: year.today,
    employees: people.map((p) => ({ id: p.id, dateOfJoining: fromDateColumn(p.dateOfJoining), lastWorkingDate: fromDateColumn(p.lastWorkingDate), active: p.status === 'active' })),
    leaveTypes: types.map((t) => ({ id: t.id, annualQuota: Number(t.annualQuota), carryForward: t.carryForward, carryForwardCap: Number(t.carryForwardCap), joinerGrant: t.joinerGrant })),
    already: already.map((a) => ({ employeeId: a.employeeId, leaveTypeId: a.leaveTypeId, reason: a.reason as GrantEntry['reason'] })),
    lastYearLeft: (employeeId, leaveTypeId) => left.get(`${employeeId}|${leaveTypeId}`) ?? 0,
    ownQuota: (employeeId, leaveTypeId) => own.get(`${employeeId}|${leaveTypeId}`) ?? null,
    lastYearSettled: (employeeId, leaveTypeId) => !waiting.has(`${employeeId}|${leaveTypeId}`),
  })
  return { entries, types }
}

/**
 * The people a grant nobody asked for may reach: only those with nothing at all
 * in the year's ledger. Somebody whose balance HR has already set — by a grant,
 * or by hand with corrections — is left to HR's Grant leave button, which shows
 * what it would add before it adds it. Without this the first night after
 * going live gave a full year on top of balances HR had typed in.
 */
async function untouchedIn<T extends { id: string }>(db: ScopedDb | TxDb, people: readonly T[], leaveYear: number): Promise<T[]> {
  const touched = await repo.peopleWithEntries(db, people.map((p) => p.id), leaveYear)
  return people.filter((p) => !touched.has(p.id))
}

/** What a grant gives INTO the year — not the days carried out of last year to match. */
export function grantSummary(entries: readonly GrantEntry[], leaveYear: number) {
  const into = entries.filter((e) => e.leaveYear === leaveYear)
  return {
    entries: into.length,
    people: new Set(into.map((e) => e.employeeId)).size,
    days: toHalfDays(into.reduce((a, e) => a + e.days, 0)),
  }
}

async function writeEntries(tx: TxDb, organizationId: string, entries: readonly GrantEntry[], by: string | null): Promise<void> {
  await repo.addLedgerEntries(tx, entries.map((e) => ({
    organizationId,
    employeeId: e.employeeId,
    leaveTypeId: e.leaveTypeId,
    leaveYear: e.leaveYear,
    days: e.days,
    reason: e.reason,
    note: e.note,
    createdByUserId: by,
  })))
}

/**
 * A new joiner's own days a year, given when they are added (Add Employee →
 * Leave): saved before their grant, so the grant is reckoned from them. Only
 * by whoever manages leave balances; each type once, and still in use.
 */
export async function saveJoinerEntitlements(
  ctx: AppContext,
  tx: TxDb,
  employeeId: string,
  list: readonly { leaveTypeId: string; days: number }[],
): Promise<void> {
  if (list.length === 0) return
  if (!ctx.can('leave:balance:manage')) {
    throw Forbidden('Days a year of leave are set by whoever manages leave balances. Add the employee without them; HR can set them on the profile.')
  }
  for (const entry of list) {
    const type = await repo.activeLeaveType(tx, entry.leaveTypeId)
    if (!type) throw NotFound('One of those leave types does not exist any more. Reload and try again.')
    await repo.saveEntitlement(tx, {
      organizationId: ctx.organizationId,
      employeeId,
      leaveTypeId: type.id,
      annualQuota: entry.days,
      note: 'Set when they were added',
      updatedByUserId: ctx.userId,
    })
    await audit(ctx, {
      action: 'leave.entitlement_changed',
      entityType: 'employee',
      entityId: employeeId,
      details: { employeeId, leaveType: type.code, leaveTypeName: type.name, from: null, to: entry.days, companyDays: Number(type.annualQuota), daysChanged: 0, notTakenBack: 0, note: 'Set when they were added' },
    }, tx)
  }
}

// ── Granted without anybody pressing Grant ──────────────────────────────────

/**
 * A new joiner's share of this leave year, given the moment they are added
 * (client, 9 Oct 2026) — by each type's rule for joiners and any days of their
 * own. Only with a joining date: without one their share is not known, and the
 * Grant leave button names them for HR. Nothing is granted twice. In the
 * caller's transaction, after the people are written.
 */
export async function grantOnJoining(ctx: AppContext, tx: TxDb, employeeIds: readonly string[]): Promise<number> {
  if (employeeIds.length === 0) return 0
  const year = await leaveYearNow(ctx.db, ctx.organizationId)
  await lockFor(tx, grantLock(ctx.organizationId, year.leaveYear))
  const people = await untouchedIn(tx, (await repo.everybodyHere(tx, employeeIds)).filter((p) => p.dateOfJoining), year.leaveYear)
  if (people.length === 0) return 0
  const { entries } = await planYearFor(tx, people, year)
  if (entries.length === 0) return 0
  await writeEntries(tx, ctx.organizationId, entries, ctx.userId)
  const summary = grantSummary(entries, year.leaveYear)
  await audit(ctx, {
    action: 'leave.granted',
    entityType: 'leave_year',
    details: { leaveYear: year.leaveYear, label: leaveYearLabel(year.leaveYear, year.startMonth), ...summary, via: 'joining' },
  }, tx)
  return summary.people
}

/**
 * Of a planned grant, what may be given with nobody asking: a year's grant to
 * somebody with nothing in that year yet; and a carry that waited for last
 * year to settle, to somebody whose year was granted (an opening grant of that
 * type). A balance HR set up by hand is HR's.
 */
async function asNobodyAsked(tx: TxDb, planned: readonly GrantEntry[], leaveYear: number): Promise<GrantEntry[]> {
  const touched = await repo.peopleWithEntries(tx, [...new Set(planned.map((e) => e.employeeId))], leaveYear)
  const granted = await grantedIn(tx, leaveYear)
  return planned.filter((e) => !touched.has(e.employeeId) || (e.reason === 'carry_forward' && granted.has(`${e.employeeId}|${e.leaveTypeId}`)))
}

/**
 * The year's grant with nobody signed in: the nightly job (deploy/crontab), so
 * a new leave year — and its carry forward — is in everybody's balance on its
 * first morning, and anybody missed since is caught; and `npm run grant-leave`
 * from the server's terminal.
 *
 * The job grants only people with a joining date (a share for somebody whose
 * joining is unknown would be a guess), and only what nobody has set up by
 * hand (asNobodyAsked); the terminal, like the button, grants the full plan —
 * the full year to somebody with no joining date — as it always has. A dry run
 * plans and writes nothing.
 */
export async function grantWithNobodySignedIn(
  db: ScopedDb,
  organizationId: string,
  options: { leaveYear?: number | undefined; withoutJoiningDate: boolean; apply: boolean; via: 'nightly' | 'terminal' },
) {
  const now = await leaveYearNow(db, organizationId)
  const year: LeaveYearNow = { ...now, leaveYear: options.leaveYear ?? now.leaveYear }
  const label = leaveYearLabel(year.leaveYear, year.startMonth)
  const run = async (tx: TxDb) => {
    const people = (await repo.everybodyHere(tx)).filter((p) => options.withoutJoiningDate || p.dateOfJoining)
    const { entries: planned } = await planYearFor(tx, people, year)
    const entries = options.via === 'nightly' ? await asNobodyAsked(tx, planned, year.leaveYear) : planned
    const summary = { ...grantSummary(entries, year.leaveYear), label, considered: people.length, proRated: entries.filter((e) => e.reason === 'opening_grant' && e.note).length, carried: entries.filter((e) => e.reason === 'carry_forward' && e.leaveYear === year.leaveYear).length }
    if (!options.apply || entries.length === 0) return summary
    await writeEntries(tx, organizationId, entries, null)
    await auditSystem(tx, organizationId, {
      action: 'leave.granted',
      entityType: 'leave_year',
      details: { leaveYear: year.leaveYear, label, entries: summary.entries, people: summary.people, days: summary.days, via: options.via },
    })
    await notify({ userId: '', organizationId }, tx, {
      event: 'leave.balance_changed',
      to: { employees: [...new Set(entries.filter((e) => e.leaveYear === year.leaveYear).map((e) => e.employeeId))] },
      title: `Your ${label} leave has been added`,
      message: year.leaveYear <= now.leaveYear
        ? 'Your leave for the year is in your balance. Leave → Leave Balance shows each type.'
        : `It shows in Leave → Leave Balance when the ${label} leave year begins on ${dayLabel(leaveYearBounds(year.leaveYear, year.startMonth).from)}.`,
      link: '/leave',
    })
    return summary
  }
  return withTransaction(db, async (tx) => {
    // The same lock as the button: the two never grant the same year at once.
    await lockFor(tx, grantLock(organizationId, year.leaveYear))
    return run(tx)
  })
}

// ── The leave year's end: days that will lapse (client, 10 Oct 2026) ───────

/** The year-end reminder's lead: how many days before the year ends people are told. */
export async function leaveReminder(ctx: AppContext) {
  return { days: await repo.reminderDaysOf(ctx.db, ctx.organizationId) }
}

/** Changes the lead (Settings → Leave Config), audited with what it was. */
export async function setLeaveReminder(ctx: AppContext, days: number) {
  return withTransaction(ctx.db, async (tx) => {
    const before = await repo.reminderDaysOf(tx, ctx.organizationId)
    await repo.saveReminderDays(tx, ctx.organizationId, days)
    await audit(ctx, { action: 'leave.reminder_updated', entityType: 'organization', entityId: ctx.organizationId, details: { days, before } }, tx)
    return { days }
  })
}

/**
 * Before the leave year ends, each employee is told what of their leave will
 * lapse (client, 10 Oct 2026): what is left of each type — less what is
 * applied for or waiting to be encashed — that does not carry into next year:
 * all of it for a type that does not carry, what is over the cap for one that
 * does. Unpaid leave with no limit has nothing to lose.
 *
 * Run by the nightly job (scripts/maintenance.ts) from the day the year has
 * the company's lead of days left (Settings → Leave Config, 30 to start) —
 * once a year each: a person already told is not told again, so a night
 * missed is caught the next. Somebody leaving before the year ends is not
 * told: their leave is settled on leaving. A dry run counts and sends nothing.
 */
export async function remindLeaveYearEnd(db: ScopedDb, organizationId: string, options: { apply: boolean; asOf?: CalendarDate | undefined }) {
  const today = await leaveYearNow(db, organizationId)
  // `asOf`: another day taken as today — for a test, or a dry run of a night to come.
  const now = options.asOf ? { ...today, today: options.asOf, leaveYear: leaveYearOf(options.asOf, today.startMonth) } : today
  const lastDay = addCalendarDays(leaveYearBounds(now.leaveYear, now.startMonth).nextFrom, -1)
  const label = leaveYearLabel(now.leaveYear, now.startMonth)
  const lead = await repo.reminderDaysOf(db, organizationId)
  const daysLeft = Math.round((Date.parse(lastDay) - Date.parse(now.today)) / 86_400_000)
  if (daysLeft < 0 || daysLeft > lead) return { due: false, label, people: 0, days: 0 }

  return withTransaction(db, async (tx) => {
    // One run at a time: two at once (the night's and one by hand) would each find nobody told yet.
    await lockFor(tx, `leave-reminder:${organizationId}:${now.leaveYear}`)
    const people = (await repo.everybodyHere(tx)).filter((p) => {
      const leaves = fromDateColumn(p.lastWorkingDate)
      return p.status === 'active' && !(leaves && leaves <= lastDay)
    })
    const ids = people.map((p) => p.id)
    const [types, ledger, pending, encashing, own] = await Promise.all([
      repo.activeLeaveTypes(tx),
      repo.ledgerTotals(tx, ids, now.leaveYear),
      repo.pendingTotals(tx, ids, now.leaveYear),
      pendingEncashments(tx, now.leaveYear),
      repo.ownQuotasOf(tx, ids),
    ])
    const balance = new Map(ledger.map((l) => [`${l.employeeId}|${l.leaveTypeId}`, sumOf(l)]))
    const held = new Map(pending.map((p) => [`${p.employeeId}|${p.leaveTypeId}`, sumOf(p)]))
    const encash = new Map<string, number>()
    for (const e of encashing) encash.set(`${e.employeeId}|${e.leaveTypeId}`, (encash.get(`${e.employeeId}|${e.leaveTypeId}`) ?? 0) + Number(e.days ?? 0))
    // Kept apart from the notice, which they may clear from the bell: told once is told.
    const told = await repo.toldOfYearEnd(tx, ids, now.leaveYear)

    let reached = 0
    let total = 0
    for (const person of people) {
      if (told.has(person.id)) continue
      const lines: string[] = []
      let lapsing = 0
      for (const type of types) {
        const key = `${person.id}|${type.id}`
        // Unpaid days left over are nothing lost: never urged to be taken.
        if (!type.isPaid || isUnlimited(type.isPaid, own.get(key) ?? Number(type.annualQuota))) continue
        const left = toHalfDays((balance.get(key) ?? 0) - (held.get(key) ?? 0) - (encash.get(key) ?? 0))
        if (left <= 0) continue
        const cap = Number(type.carryForwardCap)
        const lapse = type.carryForward ? toHalfDays(Math.max(0, left - cap)) : left
        if (lapse <= 0) continue
        lapsing = toHalfDays(lapsing + lapse)
        lines.push(type.carryForward ? `${type.name} ${dayCount(lapse)} (beyond the ${dayCount(cap)} that carry)` : `${type.name} ${dayCount(lapse)}`)
      }
      if (lapsing === 0) continue
      reached += 1
      total = toHalfDays(total + lapsing)
      if (!options.apply) continue
      await repo.markToldOfYearEnd(tx, { organizationId, employeeId: person.id, leaveYear: now.leaveYear, days: lapsing })
      await notify({ userId: '', organizationId }, tx, {
        event: 'leave.year_ending',
        to: { employee: person.id },
        title: `${dayCount(lapsing)} of leave will lapse on ${dayLabel(lastDay)}`,
        message: `Your ${label} leave year ends on ${dayLabel(lastDay)}. Unless you use them, these will lapse: ${lines.join(', ')}.`,
        link: '/leave?tab=balance',
        entity: { type: 'leave_year_end', id: `${now.leaveYear}:${person.id}` },
      })
    }
    return { due: true, label, people: reached, days: total }
  })
}

// ── A year's grant changed ──────────────────────────────────────────────────

type Difference = {
  employeeId: string
  leaveTypeId: string
  leaveYear: number
  note: string
} & (
  /** What the year's grant should come to — an own number of days, a type's new days. */
  | { target: number; delta?: never }
  /** What one change alone moves it by — a corrected joining date, all else as it was. */
  | { delta: number; target?: never }
)

/** One person's grant of one type in a year, as granted: its opening grant and every change to it. */
async function yearGrantOf(tx: TxDb, employeeId: string, leaveTypeId: string, leaveYear: number): Promise<number> {
  return sumOf((await repo.grantTotals(tx, [employeeId], leaveYear, leaveTypeId))[0] ?? { _sum: { days: 0 } })
}

/**
 * Changes one person's grant of one type and year — to `target`, or by
 * `delta` — as an `opening_grant` entry with the change's note. A cut goes
 * only as far as what is left once days applied for — as leave, or to be
 * encashed — are held back. Under the person's leave lock.
 */
async function setYearGrant(tx: TxDb, organizationId: string, change: Difference, by: string | null): Promise<{ applied: number; short: number }> {
  await lockFor(tx, `leave-apply:${change.employeeId}`)
  const wanted = change.delta !== undefined
    ? toHalfDays(change.delta)
    : toHalfDays(change.target - (await yearGrantOf(tx, change.employeeId, change.leaveTypeId, change.leaveYear)))
  if (wanted === 0) return { applied: 0, short: 0 }
  let applied = wanted
  if (wanted < 0) {
    const [balance, pendingLeave, encashing] = await Promise.all([
      repo.balanceOn(tx, change.employeeId, change.leaveTypeId, change.leaveYear),
      repo.pendingDays(tx, change.employeeId, change.leaveTypeId, change.leaveYear),
      pendingEncashDays(tx, change.employeeId, change.leaveTypeId, change.leaveYear),
    ])
    const room = Math.max(0, toHalfDays(balance - pendingLeave - encashing))
    applied = -Math.min(-wanted, room)
  }
  if (applied !== 0) {
    await repo.addLedgerEntry(tx, {
      organizationId,
      employeeId: change.employeeId,
      leaveTypeId: change.leaveTypeId,
      leaveYear: change.leaveYear,
      days: applied,
      reason: 'opening_grant',
      note: change.note,
      createdByUserId: by,
    })
  }
  return { applied, short: toHalfDays(applied - wanted) }
}

/** Who has been granted which type in a year: `employeeId|leaveTypeId`. */
async function grantedIn(tx: TxDb, leaveYear: number): Promise<Set<string>> {
  return new Set((await repo.grantsMade(tx, leaveYear)).filter((g) => g.reason === 'opening_grant').map((g) => `${g.employeeId}|${g.leaveTypeId}`))
}

/** The years a change can reach: this one, and next if it has been granted in advance. */
const yearsOf = (year: LeaveYearNow) => [year.leaveYear, year.leaveYear + 1]

const dayCount = (n: number) => `${n} day${Math.abs(n) === 1 ? '' : 's'}`

export interface ChangeOutcome {
  /** Days added (positive) or taken away (negative), across the years changed. */
  days: number
  /** Days a cut could not take: already taken or applied for. */
  short: number
  people: number
}

/**
 * A type's days a year changed for everybody (Settings → Leave Config). From
 * the next leave year everybody gets the new number — a year already granted
 * in advance is changed to match, and given to whoever it was granted to with
 * none of this type. `thisYear` changes this year's balances too, the same
 * way. People with days of their own keep theirs.
 *
 * Left for next year, a type nobody had this year (0 days until now) is
 * marked as given at 0 for everybody already given this year: without the
 * mark, the next grant — the nightly one, or the button — would give it for
 * this year after all.
 *
 * Inside the settings change's transaction; the caller has checked who may.
 */
export async function applyTypeQuotaChange(
  ctx: AppContext,
  tx: TxDb,
  type: { id: string; name: string; isPaid: boolean; joinerGrant: JoinerGrant },
  quota: number,
  thisYear: boolean,
): Promise<ChangeOutcome> {
  const year = await leaveYearNow(ctx.db, ctx.organizationId)
  await holdGrantLocks(tx, ctx.organizationId, year)
  const own = await repo.ownQuotasOfType(tx, type.id)
  const people = new Map((await repo.everybodyHere(tx)).filter((p) => p.status === 'active').map((p) => [p.id, p]))
  const outcome: ChangeOutcome = { days: 0, short: 0, people: 0 }
  const touched = new Set<string>()
  for (const leaveYear of yearsOf(year)) {
    const [granted, givenTheYear] = await Promise.all([grantedIn(tx, leaveYear), repo.peopleGrantedIn(tx, leaveYear)])
    const later = leaveYear === year.leaveYear && !thisYear
    // In one order, so two changes never wait on each other's people.
    for (const id of [...people.keys()].sort()) {
      if (own.has(id) || !givenTheYear.has(id)) continue
      const hasIt = granted.has(`${id}|${type.id}`)
      const target = proRatedQuota(quota, fromDateColumn(people.get(id)!.dateOfJoining), leaveYear, year.startMonth, type.joinerGrant)
      if (later) {
        // From next year: a type they had none of is marked as given at 0, so no grant gives it this year.
        if (!hasIt && target > 0) {
          await repo.addLedgerEntry(tx, {
            organizationId: ctx.organizationId, employeeId: id, leaveTypeId: type.id, leaveYear, days: 0, reason: 'opening_grant',
            note: `${type.name}: ${dayCount(quota)} a year from the next leave year`, createdByUserId: ctx.userId,
          })
        }
        continue
      }
      const result = await setYearGrant(tx, ctx.organizationId, {
        employeeId: id, leaveTypeId: type.id, leaveYear, target,
        note: `${type.name} changed to ${dayCount(quota)} a year`,
      }, ctx.userId)
      if (result.applied !== 0 || result.short !== 0) touched.add(id)
      outcome.days = toHalfDays(outcome.days + result.applied)
      outcome.short = toHalfDays(outcome.short + result.short)
    }
  }
  outcome.people = touched.size
  if (touched.size > 0) {
    await notify(ctx, tx, {
      event: 'leave.balance_changed',
      to: { employees: [...touched] },
      title: `${type.name} is now ${dayCount(quota)} a year`,
      message: `Your ${type.name} balance has been changed to match. Leave → Leave Balance shows it.`,
      link: '/leave',
    })
  }
  return outcome
}

/**
 * Somebody's joining date corrected: each year already granted to them is
 * moved by what the new date alone changes — their share under the old date
 * and under the new, by the same days a year and joiner rule — so nothing
 * else (a type's days changed "from next year") is brought in with it. A year
 * not given to them at all yet — they had no date before — is granted now.
 * Inside the employee change's transaction, which took the grant locks
 * (holdGrantLocks) before the person's leave lock.
 */
export async function afterJoiningChanged(ctx: AppContext, tx: TxDb, employeeId: string, joinedBefore: CalendarDate | null): Promise<ChangeOutcome> {
  const year = await leaveYearNow(ctx.db, ctx.organizationId)
  const person = (await repo.everybodyHere(tx, [employeeId]))[0]
  const outcome: ChangeOutcome = { days: 0, short: 0, people: 0 }
  if (!person || person.status !== 'active') return outcome
  const joined = fromDateColumn(person.dateOfJoining)
  const [types, own] = await Promise.all([repo.activeLeaveTypes(tx), repo.ownQuotasOf(tx, [employeeId])])
  for (const leaveYear of yearsOf(year)) {
    const granted = await grantedIn(tx, leaveYear)
    for (const type of types) {
      if (!granted.has(`${employeeId}|${type.id}`)) continue
      // Marked as given at 0 (a type's days left for next year): nothing of it to move.
      const given = await yearGrantOf(tx, employeeId, type.id, leaveYear)
      if (given === 0) continue
      const before = yearShare(joinedBefore, leaveYear, year.startMonth, type.joinerGrant)
      const after = yearShare(joined, leaveYear, year.startMonth, type.joinerGrant)
      if (before === after) continue
      // The same days a year as they were given, for the new share of the year;
      // with no share before (it should not have been given), by the rules now.
      const quota = own.get(`${employeeId}|${type.id}`) ?? Number(type.annualQuota)
      const target = before > 0 ? toHalfDays((given * after) / before) : proRatedQuota(quota, joined, leaveYear, year.startMonth, type.joinerGrant)
      const delta = toHalfDays(target - given)
      if (delta === 0) continue
      const result = await setYearGrant(tx, ctx.organizationId, {
        employeeId, leaveTypeId: type.id, leaveYear, delta,
        note: joined ? `Joining date corrected to ${dayLabel(joined)}` : 'Joining date cleared',
      }, ctx.userId)
      outcome.days = toHalfDays(outcome.days + result.applied)
      outcome.short = toHalfDays(outcome.short + result.short)
    }
  }
  // This year, for a person given nothing of it — no joining date until now.
  if (joined && (await untouchedIn(tx, [person], year.leaveYear)).length > 0) {
    const { entries } = await planYearFor(tx, [person], year)
    if (entries.length > 0) {
      await writeEntries(tx, ctx.organizationId, entries, ctx.userId)
      outcome.days = toHalfDays(outcome.days + grantSummary(entries, year.leaveYear).days)
      await audit(ctx, {
        action: 'leave.granted',
        entityType: 'leave_year',
        details: { leaveYear: year.leaveYear, label: leaveYearLabel(year.leaveYear, year.startMonth), ...grantSummary(entries, year.leaveYear), via: 'joining' },
      }, tx)
    }
  }
  outcome.people = outcome.days !== 0 || outcome.short !== 0 ? 1 : 0
  return outcome
}

// ── One person's own days a year (the profile's Leave tab) ──────────────────

/** Whose leave the caller may see here: somebody their leave scope reaches, still here. */
async function personInReach(ctx: AppContext, employeeId: string) {
  const person = await repo.activeEmployee(ctx.db, ctx.scopeFor('leave'), employeeId)
  if (!person) throw NotFound('No such employee')
  return person
}

/**
 * One person's leave for the profile: each type's days a year — the company's
 * and theirs, where they have their own — and this year's grant, what is
 * taken, applied for and left. With whether the caller may change their days
 * (the record rules, Day 22: never one's own, never a senior's).
 */
export async function personLeave(ctx: AppContext, employeeId: string) {
  const person = await personInReach(ctx, employeeId)
  const year = await leaveYearNow(ctx.db, ctx.organizationId)
  const [types, own, ledger, pending, taken, granted, work] = await Promise.all([
    repo.activeLeaveTypes(ctx.db),
    repo.entitlementsOf(ctx.db, employeeId),
    repo.ledgerTotals(ctx.db, [employeeId], year.leaveYear),
    repo.pendingTotals(ctx.db, [employeeId], year.leaveYear),
    repo.takenTotals(ctx.db, [employeeId], year.leaveYear),
    repo.grantTotals(ctx.db, [employeeId], year.leaveYear),
    loadWork(ctx.db, ctx.organizationId, 'leave_balance'),
  ])
  const by = <T extends { leaveTypeId: string }>(rows: T[]) => new Map(rows.map((r) => [r.leaveTypeId, r]))
  const ownBy = by(own)
  const ledgerBy = by(ledger)
  const pendingBy = by(pending)
  const takenBy = by(taken)
  const grantedBy = by(granted)
  const check = checkWork(ctx, work, employeeId)
  return {
    employeeId: person.id,
    fullName: person.fullName,
    leaveYear: year.leaveYear,
    label: leaveYearLabel(year.leaveYear, year.startMonth),
    mayChange: ctx.can('leave:balance:manage') && check.allowed,
    changeGoesTo: check.allowed ? null : check.ask,
    types: types.map((t) => {
      const mine = ownBy.get(t.id)
      const companyDays = Number(t.annualQuota)
      const days = mine ? Number(mine.annualQuota) : companyDays
      const balance = ledgerBy.has(t.id) ? sumOf(ledgerBy.get(t.id)!) : 0
      const held = pendingBy.has(t.id) ? sumOf(pendingBy.get(t.id)!) : 0
      return {
        leaveTypeId: t.id,
        code: t.code,
        name: t.name,
        isPaid: t.isPaid,
        companyDays,
        ownDays: mine ? Number(mine.annualQuota) : null,
        ownNote: mine?.note ?? null,
        unlimited: isUnlimited(t.isPaid, days),
        granted: grantedBy.has(t.id) ? sumOf(grantedBy.get(t.id)!) : 0,
        taken: takenBy.has(t.id) ? toHalfDays(-sumOf(takenBy.get(t.id)!)) : 0,
        pending: held,
        available: toHalfDays(balance - held),
      }
    }),
  }
}

/** One person's statement of a type, for HR on the profile: the same passbook the person sees. */
export async function personStatement(ctx: AppContext, employeeId: string, leaveTypeId: string, requestedYear?: number) {
  await personInReach(ctx, employeeId)
  const year = await leaveYearNow(ctx.db, ctx.organizationId)
  return { ...(await statementFor(ctx.db, employeeId, leaveTypeId, requestedYear ?? year.leaveYear)), startMonth: year.startMonth }
}

export interface EntitlementInput {
  employeeId: string
  leaveTypeId: string
  /** Their own days a year; null: the company's again. */
  days: number | null
  note: string
}

/**
 * Sets — or clears — one person's own days a year of a type, and changes the
 * years already granted to them to match at once: 12 → 15 adds 3 now. Their
 * share of a year they joined in is worked out by the type's rule for joiners,
 * as their grant was. Whoever holds `leave:balance:manage`, within their leave
 * scope, and by the record rules: never one's own days, never a senior's.
 */
export async function setEntitlement(ctx: AppContext, input: EntitlementInput) {
  const person = await personInReach(ctx, input.employeeId)
  const type = await repo.activeLeaveType(ctx.db, input.leaveTypeId)
  if (!type) throw NotFound('No such leave type')
  await assertWorkGoesUp(ctx, ctx.db, 'leave_balance', input.employeeId)
  const year = await leaveYearNow(ctx.db, ctx.organizationId)
  const note = input.note.trim()
  const companyDays = Number(type.annualQuota)

  const result = await withTransaction(ctx.db, async (tx) => {
    await holdGrantLocks(tx, ctx.organizationId, year)
    const before = (await repo.entitlementsOf(tx, input.employeeId)).find((e) => e.leaveTypeId === type.id)
    const ownBefore = before ? Number(before.annualQuota) : null
    if (ownBefore === input.days) throw BadRequest(input.days === null ? `${person.fullName} already has the company’s ${type.name}.` : `${person.fullName} already has ${dayCount(input.days)} of ${type.name} a year.`)
    if (input.days === null) {
      await repo.removeEntitlement(tx, input.employeeId, type.id)
    } else {
      await repo.saveEntitlement(tx, {
        organizationId: ctx.organizationId,
        employeeId: input.employeeId,
        leaveTypeId: type.id,
        annualQuota: input.days,
        note,
        updatedByUserId: ctx.userId,
      })
    }
    const quota = input.days ?? companyDays
    const window = await repo.employmentWindow(tx, input.employeeId)
    const joined = fromDateColumn(window?.dateOfJoining)
    const outcome: ChangeOutcome = { days: 0, short: 0, people: 0 }
    for (const leaveYear of yearsOf(year)) {
      const granted = await grantedIn(tx, leaveYear)
      if (!granted.has(`${input.employeeId}|${type.id}`)) continue
      const r = await setYearGrant(tx, ctx.organizationId, {
        employeeId: input.employeeId, leaveTypeId: type.id, leaveYear,
        target: proRatedQuota(quota, joined, leaveYear, year.startMonth, type.joinerGrant),
        note: input.days === null ? `Back to the company’s ${dayCount(companyDays)} a year — ${note}` : `Own entitlement: ${dayCount(quota)} a year — ${note}`,
      }, ctx.userId)
      outcome.days = toHalfDays(outcome.days + r.applied)
      outcome.short = toHalfDays(outcome.short + r.short)
    }
    // A type they had none of this year (no days a year until now), granted now — when their share is known.
    const granted = await grantedIn(tx, year.leaveYear)
    if (!granted.has(`${input.employeeId}|${type.id}`) && joined) {
      const people = await repo.everybodyHere(tx, [input.employeeId])
      const entries = (await planYearFor(tx, people, year)).entries.filter((e) => e.leaveTypeId === type.id)
      if (entries.length > 0) {
        await writeEntries(tx, ctx.organizationId, entries, ctx.userId)
        outcome.days = toHalfDays(outcome.days + grantSummary(entries, year.leaveYear).days)
      }
    }

    await audit(ctx, {
      action: 'leave.entitlement_changed',
      entityType: 'employee',
      entityId: input.employeeId,
      details: {
        employeeId: input.employeeId,
        leaveType: type.code,
        leaveTypeName: type.name,
        from: ownBefore,
        to: input.days,
        companyDays,
        daysChanged: outcome.days,
        notTakenBack: outcome.short,
        note,
      },
    }, tx)
    const changed = outcome.days !== 0
      ? ` ${outcome.days > 0 ? `${dayCount(outcome.days)} added to` : `${dayCount(-outcome.days)} taken from`} your balance.`
      : ''
    await notify(ctx, tx, {
      event: 'leave.balance_changed',
      to: { employee: input.employeeId },
      title: `${type.name}: ${isUnlimited(type.isPaid, quota) ? 'no limit' : `${dayCount(quota)} a year`}`,
      message: `${input.days === null ? `You now have the company’s ${type.name}.` : `Your ${type.name} is now ${dayCount(quota)} a year.`}${changed} Reason: ${note}`,
      link: '/leave',
    })
    return outcome
  })

  logger.info('Leave entitlement changed', { by: ctx.userId, employeeId: input.employeeId, leaveType: type.code, days: input.days })
  return { employeeId: input.employeeId, leaveTypeId: type.id, ownDays: input.days, balanceChange: result.days, notTakenBack: result.short }
}
