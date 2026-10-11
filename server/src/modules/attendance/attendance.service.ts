import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict, Forbidden, LocationRefused, NotFound } from '../../platform/errors/AppError'
import { logger } from '../../platform/logger'
import { isUniqueViolation } from '../../platform/db/errors'
import { zonedToday, toDateColumn, fromDateColumn, dayLabel, addCalendarDays, type CalendarDate } from '../../domain/shared/dates'
import { dayMinimums, hoursBetween } from '../../domain/attendance/hours'
import {
  arrivingForLastNight,
  forWorkedHalf,
  fullDayHoursFor,
  halfDayReason,
  isOvernight,
  measureInstants,
  nextCheckInOpens,
  overnightDayOpen,
  shiftRulesOf,
  stillAtWork,
  withHalfDayLeave,
  type ShiftRow,
} from '../../domain/attendance/shiftRules'
import {
  bestReading,
  checkGeofence,
  effectiveFence,
  geofenceMessage,
  type Fence,
  type GeofenceVerdict,
} from '../../domain/attendance/geofence'
import * as repo from './attendance.repository'
import { companyTimezone } from '../organization/organization.service'
import { withTransaction } from '../../platform/db/transaction'
import { tellAbsent } from './attendanceNotices'
import { issuePunchToken, verifyPunchToken, PUNCH_TOKEN_SECONDS, type PunchAction } from './punchToken'
import { attendanceSecurityOf, findActiveGeofence, getCurrentPolicy } from '../settings/settings.repository'
import { awayOn, payPolicyOn, requestRules } from '../requests/requests.repository'
import { deviceKind, deviceLabel, isPhone, punchSignals, type PunchFlag } from '../../domain/attendance/punchSignals'
import { deviceVerdict, hashDeviceKey } from './punchDevices.service'
import { dropPunchPhoto, storePunchPhoto, type IncomingPhoto, type StoredPhoto } from './punchPhotos.service'
import type { Prisma, PunchRefusal, WorkMode } from '@prisma/client'

/**
 * Punching in and out.
 *
 * The employee punches for THEMSELVES and nobody else. That is not a data
 * scope — it is identity: the row is keyed off `ctx.employeeId`, so there is no
 * employee id in the request for anyone to change. An endpoint that took one
 * would need a scope check; one that does not take one cannot be wrong.
 *
 * Check-in security (client, 11 Oct 2026): a punch is started first
 * (`startPunch`: a signed token, and whether a location is needed); the phone
 * then reads its location several times and sends every reading; the server
 * judges the most precise one against the office fence — at check-in, and at
 * check-out too when the company says so — and keeps the evidence of every
 * punch, refused ones included.
 */

/** One location reading, as the phone took it. */
export interface PunchReading {
  latitude: number
  longitude: number
  accuracyMeters: number
  /** The phone's clock, ms since 1970. */
  at?: number | undefined
}

export interface PunchInput {
  /** From `startPunch`: who is punching, which way, and since when. Required. */
  token?: string | undefined
  /** The burst of readings the phone took, at most ten. None where no location is needed. */
  readings?: PunchReading[] | undefined
  /** The browser's description of itself (client §31), kept short. Never trusted for anything but a flag and "phones only". */
  device?: string | undefined
  /** The browser's own mobile hint (`Sec-CH-UA-Mobile`), and the page's count of touch points. */
  mobileHint?: string | undefined
  touchPoints?: number | undefined
  /** The random key the phone's browser keeps (Layer 6); held here only as its hash. */
  deviceKey?: string | undefined
  /** The selfie taken with it (Layer 5). */
  photo?: IncomingPhoto | undefined
  /** The address the punch came from, for the evidence. */
  ip?: string | undefined
}

export interface PunchResult {
  attendanceId: string
  date: CalendarDate
  checkIn: Date | null
  checkOut: Date | null
  hoursWorked: number | null
  status: string
  geofence: { verified: boolean | null; distanceMeters: number | null; message: string } | null
  /** Where the day was worked from (client §33). */
  workMode: WorkMode | null
  /** Against the shift (client §34–35); null when not measured. */
  lateMinutes: number | null
  earlyLeavingMinutes: number | null
  overtimeMinutes: number | null
  /**
   * The unpaid break the day's own shift takes off its hours at check-out — the
   * shift the day was begun on, not the person's shift now. Null with none.
   */
  breakMinutes: number | null
  /**
   * The hours worked the day needs for a full day, as its check-out will grade
   * it (fullDayHoursFor) — the card counts down to it. Null with no shift.
   */
  fullDayHours: number | null
}

/** The caller's own employee record, plus the shift the day is measured against. */
async function loadSelf(ctx: AppContext) {
  if (!ctx.employeeId) {
    // An administrator with no HR record has nothing to punch. Saying so beats
    // a 500 from a null id further down.
    throw Forbidden('Your account has no employee record, so attendance does not apply to you.')
  }

  // A punch is always one's own day.
  const employee = await repo.findEmployeeWithShift(ctx.db, { scope: 'SELF', employeeId: ctx.employeeId }, ctx.employeeId)
  if (!employee) throw NotFound('Employee record not found')
  return employee
}

type Self = Awaited<ReturnType<typeof loadSelf>>

/**
 * The app's punches are for people on app attendance. Somebody on the
 * biometric machine or marked by HR has their day recorded there; an app punch
 * from them would carry no proof at all, so it is refused rather than taken on
 * trust — on the way out as on the way in.
 */
function assertPunchesInApp(employee: Self, action: PunchAction) {
  if (employee.attendanceMode === 'app') return
  const verb = action === 'in' ? 'checked in' : 'checked out'
  throw Forbidden(employee.attendanceMode === 'biometric'
    ? `Your attendance is recorded by the biometric machine, not ${verb} on the app.`
    : `Your attendance is marked by HR, not ${verb} on the app.`)
}

/** What a punch needs of the phone's location. */
interface LocationPlan {
  /** Readings must come with it. */
  needed: boolean
  /** And the best of them be inside this fence. Null: read and kept, not checked. */
  fence: Fence | null
}

/**
 * The office fence, as the company set it. FAIL CLOSED (client, 11 Oct 2026):
 * with no office set, a punch at the office cannot be confirmed, so it is
 * refused. Until then nobody was checked at all, one deleted setting away from
 * attendance from anywhere.
 */
async function officeFence(ctx: AppContext, action: PunchAction): Promise<Fence> {
  const office = await findActiveGeofence(ctx.db)
  if (!office) {
    throw Forbidden(`The office location is not set yet, so ${action === 'in' ? 'checking in' : 'checking out'} at the office cannot be confirmed. Ask your Super Admin to set it in Settings → Attendance Security.`)
  }
  return {
    latitude: Number(office.latitude),
    longitude: Number(office.longitude),
    radiusMeters: office.radiusMeters,
    maxAccuracyMeters: office.maxAccuracyMeters,
  }
}

/**
 * The day the caller is on: today's — or, while today's has not begun,
 * yesterday's (client §34):
 *   - still open: a 22:00 to 06:00 shift's morning, or a long day that ran
 *     past midnight (until three hours before the shift starts again), is
 *     checked out of on the next calendar day — never past twenty hours;
 *   - checked out of a night shift this morning, by somebody still on nights:
 *     that night stays the day shown until the next check-in opens, so a
 *     Check In pressed at 06:01 cannot take tonight's place.
 */
async function currentDay(ctx: AppContext, employee: { id: string; shift: ShiftRow | null }, today: CalendarDate, timezone: string, now: Date) {
  const row = await repo.findDayWithShift(ctx.db, employee.id, toDateColumn(today))
  if (row?.checkIn) return { row, date: today }
  const yesterday = addCalendarDays(today, -1)
  const before = await repo.findDayWithShift(ctx.db, employee.id, toDateColumn(yesterday))
  if (before?.checkIn) {
    // Today's has not begun (above), so yesterday's is the day while it is still open.
    if (stillAtWork({ date: yesterday, today, checkIn: before.checkIn, checkOut: before.checkOut, rules: shiftRulesOf(before.shift), timezone, now, checkedInToday: false })) {
      return { row: before, date: yesterday }
    }
    if (before.checkOut && isOvernight(shiftRulesOf(employee.shift)) && overnightDayOpen({ rules: shiftRulesOf(before.shift), date: yesterday, timezone, now })) {
      return { row: before, date: yesterday }
    }
  }
  return { row, date: today }
}

/**
 * Everything a check-in is refused for before its location is looked at, and
 * what it needs of the location. Shared by `startPunch` and `punchIn`, so the
 * button and the punch never disagree on whether a location is needed.
 */
async function prepareCheckIn(ctx: AppContext, employee: Self, now: Date, timezone: string) {
  const today = zonedToday(now, timezone)

  const { row: current, date: onDay } = await currentDay(ctx, employee, today, timezone, now)

  // Still on an earlier day: that one is closed by checking out, not by a new one.
  if (onDay !== today) {
    if (current?.checkOut) {
      const opens = nextCheckInOpens(shiftRulesOf(current.shift))
      throw Conflict(`Your night shift of ${dayLabel(onDay)} is checked out.${opens ? ` The next check-in opens at ${opens}.` : ''}`)
    }
    throw Conflict(`You are still checked in from ${dayLabel(onDay)}. Check out first.`)
  }

  // The client asked for ONE punch pair per day. A second check-in is a
  // double-tap or a confused user, not a new working day.
  if (current?.checkIn) {
    throw Conflict('You have already checked in today.')
  }

  // On a night shift, arriving between midnight and the shift's end is late
  // for last night's shift, not early for tonight's — filed under yesterday,
  // so tonight's check-in is still free.
  let date = today
  let existing = current
  if (arrivingForLastNight({ rules: shiftRulesOf(employee.shift), today, timezone, now })) {
    const yesterday = addCalendarDays(today, -1)
    const before = await repo.findDayWithShift(ctx.db, employee.id, toDateColumn(yesterday))
    if (!before?.checkIn) {
      date = yesterday
      existing = before
    }
  }

  // The employee lifecycle: a day before joining, or after the last working
  // day, is not a working day of theirs.
  const joined = fromDateColumn(employee.dateOfJoining)
  if (joined && date < joined) {
    throw Forbidden(`You join on ${dayLabel(joined)}. Checking in opens on your first day.`)
  }
  const lastDay = fromDateColumn(employee.lastWorkingDate)
  if (lastDay && date > lastDay) {
    throw Forbidden(`Your last working day was ${dayLabel(lastDay)}, so there is nothing to check in to.`)
  }

  // A day of approved leave is the leave. Somebody who comes in after all has
  // the leave reversed first — or the balance would be charged for a day worked.
  // A half day's leave leaves the other half to work, so that is checked in.
  const leave = await repo.approvedLeaveOn(ctx.db, employee.id, date)
  if (existing?.status === 'on_leave' && leave?.kind === 'full') {
    throw Conflict(`${date === today ? 'Today is' : `${dayLabel(date)} is`} a day of approved leave. If you are working, ask for the leave to be reversed first.`)
  }

  // Away from the office on an approved request, or remote by arrangement
  // (client §32–33): the office location is not asked for — unless the company
  // wants a location reading even when working from home.
  const away = await awayOn(ctx.db, employee.id, toDateColumn(date))
  const workMode: WorkMode = away === 'work_from_home' ? 'wfh' : away === 'on_duty' ? 'on_duty' : employee.workArrangement === 'remote' ? 'remote' : 'office'
  const plan: LocationPlan = workMode === 'office'
    ? { needed: true, fence: await officeFence(ctx, 'in') }
    : { needed: Boolean(away && (await requestRules(ctx.db, ctx.organizationId))?.wfhGpsRequired), fence: null }

  return { today, date, existing, leave, workMode, plan }
}

/**
 * Everything a check-out is refused for before its location is looked at, and
 * what it needs of the location: on an office day, the fence again when the
 * company checks check-outs (Settings → Attendance Security, on to start).
 */
async function prepareCheckOut(ctx: AppContext, employee: Self, now: Date, timezone: string) {
  // Today's day — or last night's, on an overnight shift that ends this morning.
  const { row, date } = await currentDay(ctx, employee, zonedToday(now, timezone), timezone, now)

  if (!row?.checkIn) {
    throw BadRequest('You have not checked in today, so there is nothing to check out of.')
  }

  if (row.checkOut) {
    throw Conflict('You have already checked out today.')
  }

  // Where the day was checked into from; a day HR began, which says nothing, is an office day unless they work remotely.
  const workMode: WorkMode = row.workMode ?? (employee.workArrangement === 'remote' ? 'remote' : 'office')
  const security = await attendanceSecurityOf(ctx.db, ctx.organizationId)
  const plan: LocationPlan = workMode === 'office' && security?.punchCheckOutLocation !== false
    ? { needed: true, fence: await officeFence(ctx, 'out') }
    : { needed: false, fence: null }

  return { row, date, workMode, plan }
}

/**
 * The reading a punch is judged by: the most precise of the burst, chosen
 * here. Refused when one is needed and none came — FAIL CLOSED, so declining
 * the browser's location prompt is not a way round the fence.
 */
function readingFor(plan: LocationPlan, readings: readonly PunchReading[], action: PunchAction, workMode: WorkMode): PunchReading | null {
  const best = bestReading(readings)
  if (plan.needed && !best) {
    throw Forbidden(workMode === 'office'
      ? `Location is required to ${action === 'in' ? 'check in' : 'check out'}. Allow location access in your browser and try again.`
      : 'Location is required to check in, even when working from home or on duty. Allow location access in your browser and try again.')
  }
  return best
}

/** One punch's evidence row. */
function evidenceOf(ctx: AppContext, e: {
  employeeId: string
  date: CalendarDate
  action: PunchAction
  startedAt: Date
  workMode: WorkMode
  plan: LocationPlan
  best: PunchReading | null
  verdict: GeofenceVerdict | null
  input: PunchInput
  attendanceId?: string | undefined
  refusedFor?: PunchRefusal | undefined
  flags?: PunchFlag[] | undefined
  deviceKeyHash?: string | null | undefined
  photo?: StoredPhoto | null | undefined
}): Prisma.PunchEvidenceUncheckedCreateInput {
  const readings = e.input.readings ?? []
  return {
    organizationId: ctx.organizationId,
    employeeId: e.employeeId,
    date: toDateColumn(e.date),
    attendanceId: e.attendanceId ?? null,
    action: e.action,
    refusedFor: e.refusedFor ?? null,
    startedAt: e.startedAt,
    workMode: e.workMode,
    latitude: e.best ? e.best.latitude : null,
    longitude: e.best ? e.best.longitude : null,
    accuracyMeters: e.best ? Math.round(e.best.accuracyMeters) : null,
    distanceMeters: e.verdict ? e.verdict.distanceMeters : null,
    fenceApplied: Boolean(e.plan.fence),
    // As the phone gave them, nothing added; left out (null) when none came.
    ...(readings.length
      ? { readings: readings.map((r) => ({ latitude: r.latitude, longitude: r.longitude, accuracyMeters: r.accuracyMeters, at: r.at ?? null })) }
      : {}),
    ip: e.input.ip ? e.input.ip.slice(0, 64) : null,
    userAgent: e.input.device ? e.input.device.slice(0, 255) : null,
    flags: e.flags ?? [],
    deviceKeyHash: e.deviceKeyHash ?? null,
    photoKey: e.photo ? e.photo.key : null,
    photoSha: e.photo ? e.photo.sha256 : null,
    photoBytes: e.photo ? e.photo.bytes : null,
  }
}

const phoneOf = (input: PunchInput) => isPhone({ userAgent: input.device, mobileHint: input.mobileHint, touchPoints: input.touchPoints })

type Security = Awaited<ReturnType<typeof attendanceSecurityOf>>

/**
 * Everything a punch is refused for before its location is judged (client,
 * 11 Oct 2026) — each refusal kept as evidence:
 *   - PHONES ONLY (Layer 3, on to start): a punch that needs the location,
 *     from a computer — a computer's browser can be told any location with its
 *     own developer tools, no app needed. A punch needing none is not asked.
 *   - ONE PHONE (Layer 6, off to start): from a phone HR has not approved.
 *   - SELFIE (Layer 5, off to start): with no photo — at the punch, not its
 *     start, which comes before the photo is taken.
 */
async function gate(ctx: AppContext, g: {
  employeeId: string
  date: CalendarDate
  action: PunchAction
  startedAt: Date
  workMode: WorkMode
  plan: LocationPlan
  input: PunchInput
  security: Security
  atStart: boolean
}): Promise<{ keyHash: string | null }> {
  const keyHash = hashDeviceKey(g.input.deviceKey)
  const verb = g.action === 'in' ? 'Check in' : 'Check out'
  const refuse = async (refusedFor: PunchRefusal, flags: PunchFlag[], message: string): Promise<never> => {
    await repo.recordPunch(ctx.db, evidenceOf(ctx, { employeeId: g.employeeId, date: g.date, action: g.action, startedAt: g.startedAt, workMode: g.workMode, plan: g.plan, best: null, verdict: null, input: g.input, refusedFor, flags, deviceKeyHash: keyHash }))
    throw Forbidden(message)
  }
  if (g.plan.needed && g.security?.punchPhoneOnly !== false && !phoneOf(g.input)) {
    await refuse('not_phone', ['not_a_phone'], `${verb} from your phone. A computer cannot be used here: its browser can be told any location.`)
  }
  if (g.security?.punchOneDevice) {
    const verdict = await deviceVerdict(ctx, g.employeeId, keyHash, deviceLabel(g.input.device))
    if (verdict === 'waiting') await refuse('device_waiting', [], 'This phone is not the one registered for you. HR has been asked to approve it — try again once they have.')
    if (verdict === 'no_key') await refuse('device_waiting', [], 'This browser cannot keep its registration. Use your phone’s usual browser — not a private window — with this site’s data allowed.')
  }
  if (!g.atStart && g.security?.punchSelfie && !g.input.photo) {
    await refuse('no_photo', [], `${verb} with your photo: the company asks for one with every punch.`)
  }
  return { keyHash }
}

/** The signs this punch may not be what it seems (Layer 4): for the evidence, never a refusal. */
async function signalsOf(ctx: AppContext, employeeId: string, date: CalendarDate, input: PunchInput, best: PunchReading | null, device: { keyHash: string | null; oneDevice: boolean }): Promise<PunchFlag[]> {
  const kind = deviceKind({ userAgent: input.device, mobileHint: input.mobileHint, touchPoints: input.touchPoints })
  const flags: PunchFlag[] = best
    ? punchSignals({ readings: input.readings ?? [], best, now: Date.now(), earlierPoints: await repo.earlierPunchPoints(ctx.db, employeeId, date), kind })
    : kind === 'computer' ? ['not_a_phone'] : kind === 'mac_with_touch' ? ['mac_with_touch'] : []
  // Another phone than the person's of the last two months — said when "one phone" is off; on, it waits for HR instead.
  // A punch with no key at all is not the page's: said the same way, once there are earlier ones to go by.
  if (!device.oneDevice) {
    const earlier = await repo.earlierDeviceHashes(ctx.db, employeeId, date)
    if (earlier.size > 0 && (!device.keyHash || !earlier.has(device.keyHash))) flags.push('new_device')
  }
  return flags
}

/** Refused punches a day that keep their photo: enough to show the room behind them, never a way to fill the storage. */
const REFUSED_PHOTOS_A_DAY = 3

/**
 * The selfie to keep with this punch — only when the company asks for one
 * (Layer 5), and with a refused punch only the first few of the day: the
 * room behind somebody punching from home is the evidence, the tenth try is
 * not. Stored before the punch is written; dropped if the punch is not. The
 * very same photo as an earlier punch of theirs, to the byte, is flagged: a
 * live camera never gives the same file twice.
 */
async function photoToKeep(ctx: AppContext, employeeId: string, date: CalendarDate, input: PunchInput, security: Security, verdict: GeofenceVerdict | null, flags: PunchFlag[]): Promise<StoredPhoto | null> {
  if (!input.photo || !security?.punchSelfie) return null
  const refused = verdict !== null && verdict.result !== 'inside'
  if (refused && (await repo.refusedPhotosOn(ctx.db, employeeId, date)) >= REFUSED_PHOTOS_A_DAY) return null
  const photo = await storePunchPhoto(ctx, employeeId, input.photo)
  if (await repo.photoSeenBefore(ctx.db, employeeId, photo.sha256)) flags.push('repeated_photo')
  return photo
}

/**
 * A punch the fence refused: kept as evidence — "tried from 2 km away at
 * 09:58" is exactly what HR needs to see — then refused, in words the person
 * can act on. Three outcomes, not two: "unreliable" is said differently from
 * "outside", because one means go to the office and the other move near a
 * window.
 */
async function refuseAtFence(ctx: AppContext, evidence: Prisma.PunchEvidenceUncheckedCreateInput, verdict: GeofenceVerdict, fence: Fence, action: PunchAction, date: CalendarDate): Promise<never> {
  await repo.recordPunch(ctx.db, evidence)
  logger.warn(`Punch-${action} refused by geofence`, {
    employeeId: evidence.employeeId,
    result: verdict.result,
    distanceMeters: verdict.distanceMeters,
    accuracyMeters: verdict.accuracyMeters,
  })
  throw LocationRefused(geofenceMessage(verdict, fence, action), { action, reason: verdict.result, date })
}

export interface PunchStart {
  token: string
  expiresInSeconds: number
  /** Whether to read the phone's location — and, when the office fence applies, its radius and the accuracy it needs. */
  locationNeeded: boolean
  radiusMeters: number | null
  accuracyMeters: number | null
  /** Whether to take a selfie with it (Layer 5). */
  photoNeeded: boolean
}

/**
 * Pressing Check In or Check Out (client, 11 Oct 2026): whatever would refuse
 * the punch is said now, before the phone spends ten seconds reading its
 * location; otherwise a start token, and whether — and how precisely — the
 * location is needed.
 */
export async function startPunch(ctx: AppContext, action: PunchAction, device: PunchInput = {}): Promise<PunchStart> {
  const employee = await loadSelf(ctx)
  assertPunchesInApp(employee, action)
  const timezone = await companyTimezone(ctx)
  const now = new Date()
  const { plan, date, workMode } = action === 'in' ? await prepareCheckIn(ctx, employee, now, timezone) : await prepareCheckOut(ctx, employee, now, timezone)
  const security = await attendanceSecurityOf(ctx.db, ctx.organizationId)
  // From a computer, or a phone not theirs: said now, before the location is read — and kept.
  await gate(ctx, { employeeId: employee.id, date, action, startedAt: now, workMode, plan, input: device, security, atStart: true })
  const applied = plan.fence ? effectiveFence(plan.fence) : null
  return {
    token: issuePunchToken({ userId: ctx.userId, employeeId: employee.id }, action, now.getTime()),
    expiresInSeconds: PUNCH_TOKEN_SECONDS,
    locationNeeded: plan.needed,
    radiusMeters: applied ? applied.radiusMeters : null,
    accuracyMeters: applied ? applied.maxAccuracyMeters : null,
    photoNeeded: security?.punchSelfie === true,
  }
}

export async function punchIn(ctx: AppContext, input: PunchInput): Promise<PunchResult> {
  const employee = await loadSelf(ctx)
  assertPunchesInApp(employee, 'in')
  const startedAt = verifyPunchToken(input.token, { userId: ctx.userId, employeeId: employee.id }, 'in')
  // Never the machine clock's idea of a day. See domain/shared/dates.
  const timezone = await companyTimezone(ctx)
  const now = new Date()

  const { date, existing, leave, workMode, plan } = await prepareCheckIn(ctx, employee, now, timezone)
  const security = await attendanceSecurityOf(ctx.db, ctx.organizationId)
  const { keyHash } = await gate(ctx, { employeeId: employee.id, date, action: 'in', startedAt, workMode, plan, input, security, atStart: false })

  const best = readingFor(plan, input.readings ?? [], 'in', workMode)
  const verdict = plan.fence && best ? checkGeofence(best, plan.fence) : null
  const flags = await signalsOf(ctx, employee.id, date, input, best, { keyHash, oneDevice: security?.punchOneDevice === true })
  const photo = await photoToKeep(ctx, employee.id, date, input, security, verdict, flags)
  const evidence = { employeeId: employee.id, date, action: 'in' as const, startedAt, workMode, plan, best, verdict, input, flags, deviceKeyHash: keyHash, photo }
  if (verdict && verdict.result !== 'inside') {
    await refuseAtFence(ctx, evidenceOf(ctx, { ...evidence, refusedFor: verdict.result }), verdict, plan.fence!, 'in', date)
  }

  const expectedHours = employee.shift ? Number(employee.shift.expectedHours) : null
  // How late, against the shift's start (client §34). The rest waits for the check-out.
  // A morning on leave starts the worked half at the middle of the shift.
  const shiftRules = shiftRulesOf(employee.shift)
  const { lateMinutes } = measureInstants({ rules: leave?.kind === 'half' ? forWorkedHalf(shiftRules, leave.session) : shiftRules, date, timezone, checkIn: now, checkOut: null, hoursWorked: null })

  const data = {
    checkIn: now,
    source: 'punch' as const,
    status: 'present' as const,
    shiftId: employee.shiftId,
    expectedHours,
    checkInLatitude: best ? best.latitude : null,
    checkInLongitude: best ? best.longitude : null,
    checkInDistanceMeters: verdict?.distanceMeters ?? null,
    checkInAccuracyMeters: verdict?.accuracyMeters ?? null,
    // Null, not false, when no check applied. "We did not look" and "we looked
    // and they were elsewhere" are different facts.
    geofenceVerified: verdict ? true : null,
    workMode,
    checkInDevice: input.device ? input.device.slice(0, 255) : null,
    lateMinutes,
  }

  // The day and its evidence together: neither is kept without the other — nor the photo.
  const row = await withTransaction(ctx.db, async (tx) => {
    const day = existing
      ? // Written only if still without a check-in: two taps at once check in once.
        await repo.checkInIf(tx, existing.id, data)
      : await repo
          .createDay(tx, { organizationId: ctx.organizationId, employeeId: employee.id, date: toDateColumn(date), ...data })
          .catch((err: unknown) => {
            // Two taps at once: the other one created today's row a moment ago,
            // and the unique index refused this one. That is a 409, not a 500.
            if (isUniqueViolation(err)) throw Conflict('You have already checked in today.')
            throw err
          })
    if (!day) throw Conflict('You have already checked in today.')
    await repo.recordPunch(tx, evidenceOf(ctx, { ...evidence, attendanceId: day.id }))
    return day
  }).catch(async (err: unknown) => {
    await dropPunchPhoto(photo)
    throw err
  })

  logger.info('Punched in', { employeeId: employee.id, date })

  return {
    attendanceId: row.id,
    date,
    checkIn: row.checkIn,
    checkOut: null,
    hoursWorked: null,
    status: row.status,
    geofence: verdict
      ? {
          verified: true,
          distanceMeters: verdict.distanceMeters,
          message: geofenceMessage(verdict, plan.fence!),
        }
      : null,
    workMode,
    lateMinutes: row.lateMinutes,
    earlyLeavingMinutes: null,
    overtimeMinutes: null,
    breakMinutes: employee.shift?.breakMinutes ?? null,
    fullDayHours: fullDayHoursFor(shiftRules, expectedHours, leave?.kind === 'half' ? leave.session : null),
  }
}

export async function punchOut(ctx: AppContext, input: PunchInput): Promise<PunchResult> {
  const employee = await loadSelf(ctx)
  assertPunchesInApp(employee, 'out')
  const startedAt = verifyPunchToken(input.token, { userId: ctx.userId, employeeId: employee.id }, 'out')
  // Never the machine clock's idea of a day. See domain/shared/dates.
  const timezone = await companyTimezone(ctx)
  const now = new Date()

  const { row, date: today, workMode, plan } = await prepareCheckOut(ctx, employee, now, timezone)
  const security = await attendanceSecurityOf(ctx.db, ctx.organizationId)
  const { keyHash } = await gate(ctx, { employeeId: employee.id, date: today, action: 'out', startedAt, workMode, plan, input, security, atStart: false })

  // At the office on an office day (client, 11 Oct 2026) — refused outside,
  // and the page offers to ask HR to record the check-out instead. With the
  // setting off, a reading that came is still kept, unchecked.
  const best = readingFor(plan, input.readings ?? [], 'out', workMode)
  const verdict = plan.fence && best ? checkGeofence(best, plan.fence) : null
  const flags = await signalsOf(ctx, employee.id, today, input, best, { keyHash, oneDevice: security?.punchOneDevice === true })
  const photo = await photoToKeep(ctx, employee.id, today, input, security, verdict, flags)
  const evidence = { employeeId: employee.id, date: today, action: 'out' as const, startedAt, workMode, plan, best, verdict, input, flags, deviceKeyHash: keyHash, photo }
  if (verdict && verdict.result !== 'inside') {
    await refuseAtFence(ctx, evidenceOf(ctx, { ...evidence, refusedFor: verdict.result }), verdict, plan.fence!, 'out', today)
  }

  const breakMinutes = row.shift?.breakMinutes ?? 0
  const { hours, warning } = hoursBetween(row.checkIn!, now, breakMinutes)

  // Measured against the shift the day began on, with the hours it was
  // expected to be when it began (both kept on the row); its break and rules
  // are read as the shift stands now.
  const rules = shiftRulesOf(row.shift)
  const asBegun = rules && row.expectedHours ? { ...rules, expectedHours: Number(row.expectedHours) } : null
  // Half the day on approved leave: the worked half is graded as a half.
  const leave = await repo.approvedLeaveOn(ctx.db, employee.id, today)
  const halfLeave = leave?.kind === 'half'
  const measure = measureInstants({
    rules: leave?.kind === 'half' ? forWorkedHalf(asBegun, leave.session) : asBegun,
    date: today,
    timezone,
    checkIn: row.checkIn!,
    checkOut: now,
    hoursWorked: hours,
  })
  const classification = halfLeave ? withHalfDayLeave(measure.classification) : measure.classification
  const why = [warning, halfDayReason(measure)].filter(Boolean)

  const updated = await withTransaction(ctx.db, async (tx) => {
    // Closed only if still open: two taps at once close the day once, and tell once.
    const day = await repo.closeDayIf(tx, row.id, {
      checkOut: now,
      hoursWorked: hours,
      lateMinutes: measure.lateMinutes,
      earlyLeavingMinutes: measure.earlyLeavingMinutes,
      overtimeMinutes: measure.overtimeMinutes,
      ...(classification ? { status: classification.status } : {}),
      ...(why.length ? { note: [row.note, ...why].filter(Boolean).join(' · ') } : {}),
    })
    if (!day) throw Conflict('You have already checked out today.')
    // Short of a half day: the day is absent — told, with the way to apply leave for it (client, 10 Oct 2026).
    // With the check-out it came from: neither is kept without the other.
    if (day.status === 'absent' && row.status !== 'absent') await tellAbsent(ctx, tx, employee.id, [today], { includeActor: true })
    await repo.recordPunch(tx, evidenceOf(ctx, { ...evidence, attendanceId: day.id }))
    return day
  }).catch(async (err: unknown) => {
    await dropPunchPhoto(photo)
    throw err
  })

  logger.info('Punched out', { employeeId: employee.id, date: today, hours })

  return {
    attendanceId: updated.id,
    date: today,
    checkIn: updated.checkIn,
    checkOut: updated.checkOut,
    hoursWorked: hours,
    status: updated.status,
    geofence: verdict
      ? { verified: true, distanceMeters: verdict.distanceMeters, message: geofenceMessage(verdict, plan.fence!, 'out') }
      : null,
    workMode: updated.workMode,
    lateMinutes: updated.lateMinutes,
    earlyLeavingMinutes: updated.earlyLeavingMinutes,
    overtimeMinutes: updated.overtimeMinutes,
    breakMinutes: row.shift?.breakMinutes ?? null,
    fullDayHours: fullDayHoursFor(rules, row.expectedHours ? Number(row.expectedHours) : null, leave?.kind === 'half' ? leave.session : null),
  }
}

/** Today's row for the caller, so the UI knows which button to show. */
export async function myToday(ctx: AppContext): Promise<PunchResult | null> {
  const employee = await loadSelf(ctx)
  // Never the machine clock's idea of a day. See domain/shared/dates.
  const timezone = await companyTimezone(ctx)
  const now = new Date()
  // Last night's shift, until it is checked out of, is still the day to show.
  const { row, date: today } = await currentDay(ctx, employee, zonedToday(now, timezone), timezone, now)
  if (!row) return null
  // While the day is open, the hours a full day needs: half of them on a day half on leave.
  const leave = row.checkIn && !row.checkOut ? await repo.approvedLeaveOn(ctx.db, employee.id, today) : null
  const fullDayHours = fullDayHoursFor(shiftRulesOf(row.shift), row.expectedHours ? Number(row.expectedHours) : null, leave?.kind === 'half' ? leave.session : null)

  return {
    attendanceId: row.id,
    date: today,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    hoursWorked: row.hoursWorked ? Number(row.hoursWorked) : null,
    status: row.status,
    geofence:
      row.geofenceVerified === null
        ? null
        : {
            verified: row.geofenceVerified,
            distanceMeters: row.checkInDistanceMeters,
            message: row.geofenceVerified ? 'Location confirmed' : 'Location not confirmed',
          },
    workMode: row.workMode,
    lateMinutes: row.lateMinutes,
    earlyLeavingMinutes: row.earlyLeavingMinutes,
    overtimeMinutes: row.overtimeMinutes,
    breakMinutes: row.shift?.breakMinutes ?? null,
    fullDayHours,
  }
}

export interface Workplace {
  /** Where today is worked from, as check-in will record it (client §33). */
  workMode: WorkMode
  /** Whether check-in will ask for a location reading — the app asks the browser only then. */
  locationNeeded: boolean
  /** Whether an office day's check-out is checked against the office too (Settings → Attendance Security). */
  checkOutLocationNeeded: boolean
  /** Whether the company pays overtime (client §35) — the app offers a claim only then. */
  overtimeEnabled: boolean
  /**
   * Their shift as it stands, for the day's timeline and the Timings card; null
   * with none set. With the hours worked a full and a half day need on it (client,
   * 8 Oct 2026: people should see the rule their day is marked by).
   */
  shift: { name: string; startTime: string; endTime: string; breakMinutes: number; fullDayHours: number; halfDayHours: number } | null
  /** The company's weekly off days, 0 = Sunday. */
  weeklyOffDays: number[]
  /** The day they joined: their attendance log starts there, not with days before it shown as missed. */
  dateOfJoining: CalendarDate | null
}

/** Today's workplace for the caller: office, or away on an approved request, or remote. */
export async function myWorkplace(ctx: AppContext): Promise<Workplace> {
  const employee = await loadSelf(ctx)
  const today = zonedToday(new Date(), await companyTimezone(ctx))
  const [away, payPolicy, policy] = await Promise.all([
    awayOn(ctx.db, employee.id, toDateColumn(today)),
    payPolicyOn(ctx.db, toDateColumn(today)),
    getCurrentPolicy(ctx.db),
  ])
  const workMode: WorkMode = away === 'work_from_home' ? 'wfh' : away === 'on_duty' ? 'on_duty' : employee.workArrangement === 'remote' ? 'remote' : 'office'
  const overtimeEnabled = Boolean(payPolicy?.overtimeEnabled)
  const s = employee.shift
  const minimums = s
    ? dayMinimums(Number(s.expectedHours), {
        full: s.minFullDayHours === null ? null : Number(s.minFullDayHours),
        half: s.minHalfDayHours === null ? null : Number(s.minHalfDayHours),
      })
    : null
  const about = {
    overtimeEnabled,
    shift: s && minimums
      ? { name: s.name, startTime: s.startTime, endTime: s.endTime, breakMinutes: s.breakMinutes, fullDayHours: minimums.full, halfDayHours: minimums.half }
      : null,
    weeklyOffDays: policy?.weeklyOffDays ?? [0],
    dateOfJoining: fromDateColumn(employee.dateOfJoining),
  }
  if (employee.attendanceMode !== 'app') return { workMode, locationNeeded: false, checkOutLocationNeeded: false, ...about }
  // An office day always needs the location: with no office set, the punch is refused (client, 11 Oct 2026).
  if (workMode === 'office') {
    const security = await attendanceSecurityOf(ctx.db, ctx.organizationId)
    return { workMode, locationNeeded: true, checkOutLocationNeeded: security?.punchCheckOutLocation !== false, ...about }
  }
  const gpsWhenAway = Boolean(away && (await requestRules(ctx.db, ctx.organizationId))?.wfhGpsRequired)
  return { workMode, locationNeeded: gpsWhenAway, checkOutLocationNeeded: false, ...about }
}
