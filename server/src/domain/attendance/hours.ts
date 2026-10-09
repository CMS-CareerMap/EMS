/**
 * How long somebody worked.
 *
 * Pure arithmetic. No Date.now(), no timezone lookups, no database — every
 * value is passed in, which is what lets the awkward cases be tested directly
 * instead of by arranging for midnight to happen.
 */

const MINUTES_PER_DAY = 24 * 60

/** Two decimal places. 7.4999 hours is 7.5, not 7.49. */
function round(hours: number): number {
  return Math.round(hours * 100) / 100
}

export interface HoursResult {
  hours: number
  /** Present when the numbers are usable but something about them is odd. */
  warning?: string
}

/**
 * Hours between two instants, minus an unpaid break.
 *
 * Across midnight needs no special handling here: the timestamps carry their
 * own dates, so a punch-in at 22:00 and a punch-out at 06:00 the next morning
 * are simply eight hours apart. That is the whole reason check-in and check-out
 * are instants rather than wall-clock times on a row that has one date.
 */
export function hoursBetween(
  checkIn: Date,
  checkOut: Date,
  breakMinutes: number,
): HoursResult {
  const elapsedMinutes = (checkOut.getTime() - checkIn.getTime()) / 60_000

  if (elapsedMinutes < 0) {
    // Only reachable through manual entry or a corrected row. Returning zero
    // with a warning beats returning a negative number that would quietly
    // reduce somebody's monthly total.
    return { hours: 0, warning: 'Check-out is before check-in' }
  }

  if (elapsedMinutes > MINUTES_PER_DAY) {
    return {
      hours: round(MINUTES_PER_DAY / 60),
      warning: 'More than 24 hours between check-in and check-out; capped at 24',
    }
  }

  // The break only comes off time that was actually worked. Subtracting an
  // hour from a fifteen-minute shift would produce negative hours.
  const worked = Math.max(0, elapsedMinutes - Math.max(0, breakMinutes))

  return { hours: round(worked / 60) }
}

/**
 * Hours between two WALL-CLOCK times, where the end may be on the next day.
 *
 * For manual entry, where HR types "22:00" and "06:00" and means an overnight
 * shift. There are no dates to compare, so the rule is: an end earlier than the
 * start means it wrapped past midnight.
 *
 * That rule is an assumption, and it has one failure it cannot detect — an
 * entry of 09:00 to 08:00 meaning twenty-three hours would be read the same way
 * as a typo. The cap above catches the extreme; the warning covers the rest.
 */
export function hoursBetweenWallClock(
  startMinutes: number,
  endMinutes: number,
  breakMinutes: number,
): HoursResult {
  const wrapped = endMinutes <= startMinutes
  const elapsed = wrapped ? MINUTES_PER_DAY - startMinutes + endMinutes : endMinutes - startMinutes

  const worked = Math.max(0, elapsed - Math.max(0, breakMinutes))
  const result: HoursResult = { hours: round(worked / 60) }

  if (wrapped) result.warning = 'Treated as an overnight shift'
  return result
}

/** Worked at least this fraction of the shift to earn a half day. */
const HALF_DAY_FRACTION = 0.5
/** Worked at least this fraction to count as a full day. */
const FULL_DAY_FRACTION = 0.75

/**
 * The hours a full and a half day need on a shift, as classifyDay reads them:
 * its own minimums, or fractions of its hours (a half day never more than a
 * full one). Exact — round only to show them.
 */
export function dayMinimums(
  expectedHours: number,
  minimums: { full: number | null; half: number | null } = { full: null, half: null },
): { full: number; half: number } {
  const expected = expectedHours > 0 ? expectedHours : 0
  const full = minimums.full ?? expected * FULL_DAY_FRACTION
  return { full, half: Math.min(minimums.half ?? expected * HALF_DAY_FRACTION, full) }
}

export interface DayClassification {
  status: 'present' | 'half_day' | 'absent'
  shortfallHours: number
}

/**
 * Whether a day counts as full, half or absent against the shift.
 *
 * The shift's own minimums decide, when it has them (Settings → Organisation →
 * Shifts). The client's (8 Oct 2026), given to the shifts a company starts
 * with: 8 hours a full day and 4.5 a half day on a nine-hour shift. A shift
 * without them falls back on fractions of its EXPECTED hours, so a six-hour
 * shift still gets a sensible half day.
 */
export function classifyDay(
  worked: number,
  expectedHours: number,
  /** The shift's own minimums (client §34), when it has them — hours, not fractions. */
  minimums: { full: number | null; half: number | null } = { full: null, half: null },
): DayClassification {
  const expected = expectedHours > 0 ? expectedHours : 0
  const shortfall = round(Math.max(0, expected - worked))

  if (expected > 0 && (minimums.full !== null || minimums.half !== null)) {
    const { full, half } = dayMinimums(expected, minimums)
    if (worked < half) return { status: 'absent', shortfallHours: shortfall }
    if (worked < full) return { status: 'half_day', shortfallHours: shortfall }
    return { status: 'present', shortfallHours: shortfall }
  }

  // A half day means HALF. Below that it is absent — anything looser pays a
  // half day for two hours of work, which is a decision nobody made on purpose.
  // Only for a shift with no minimums of its own; the client gave theirs.
  if (expected > 0 && worked < expected * HALF_DAY_FRACTION) {
    return { status: 'absent', shortfallHours: shortfall }
  }

  if (expected > 0 && worked < expected * FULL_DAY_FRACTION) {
    return { status: 'half_day', shortfallHours: shortfall }
  }

  return { status: 'present', shortfallHours: shortfall }
}

/** Sums a month of daily hours. Kept here so rounding happens in one place. */
export function totalHours(daily: number[]): number {
  return round(daily.reduce((sum, hours) => sum + hours, 0))
}
