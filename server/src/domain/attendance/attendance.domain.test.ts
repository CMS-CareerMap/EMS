import { describe, it, expect } from 'vitest'
import { hoursBetween, hoursBetweenWallClock, classifyDay, totalHours } from './hours'
import { distanceMeters, checkGeofence, bestReading, effectiveFence, geofenceMessage, FENCE_LIMITS, type Fence } from './geofence'
import { zonedToday, zonedMinutes, parseWallClock, isCalendarDate, fromDateColumn } from '../shared/dates'

/**
 * The domain layer, tested without a database, a request or a clock.
 *
 * Every awkward case here — midnight, a night shift, a vague GPS reading, the
 * half hour either side of a date boundary — is the kind that appears once a
 * month in production and is impossible to reproduce on demand. Pure functions
 * mean they can simply be asked about directly.
 */

describe('what day is it, in the company timezone', () => {
  it('reads a normal working morning as that day', () => {
    // 09:00 IST on 15 April.
    const instant = new Date('2026-04-15T03:30:00Z')
    expect(zonedToday(instant, 'Asia/Kolkata')).toBe('2026-04-15')
  })

  it('does NOT roll a late-evening punch into the next day', () => {
    // 23:30 IST on 15 April is 18:00 UTC the same day — easy case.
    expect(zonedToday(new Date('2026-04-15T18:00:00Z'), 'Asia/Kolkata')).toBe('2026-04-15')
  })

  it('does NOT roll a night-shift punch back into yesterday', () => {
    // 00:30 IST on 16 April is 19:00 UTC on the 15th. toISOString() would file
    // this under the 15th, and one employee's hours would never add up.
    const instant = new Date('2026-04-15T19:00:00Z')

    // Read as a UTC calendar, the instant is still the 15th.
    expect(fromDateColumn(instant)).toBe('2026-04-15')
    expect(zonedToday(instant, 'Asia/Kolkata')).toBe('2026-04-16')
  })

  it('gives different answers for different companies at the same instant', () => {
    // The same moment, and it is not the same date everywhere. This is why the
    // timezone is an argument and not a constant.
    const instant = new Date('2026-04-15T19:00:00Z')
    expect(zonedToday(instant, 'Asia/Kolkata')).toBe('2026-04-16')
    expect(zonedToday(instant, 'Europe/London')).toBe('2026-04-15')
    expect(zonedToday(instant, 'America/New_York')).toBe('2026-04-15')
  })

  it('reads the wall clock in the company timezone', () => {
    expect(zonedMinutes(new Date('2026-04-15T03:30:00Z'), 'Asia/Kolkata')).toBe(9 * 60)
  })

  it('parses a shift label', () => {
    expect(parseWallClock('09:30')).toBe(570)
    expect(parseWallClock('00:00')).toBe(0)
    expect(parseWallClock('23:59')).toBe(1439)
    expect(parseWallClock('25:00')).toBeNull()
    expect(parseWallClock('nine')).toBeNull()
  })

  it('knows 31 February is not a day', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true)
    expect(isCalendarDate('2026-02-31')).toBe(false)
    expect(isCalendarDate('2026-13-01')).toBe(false)
  })
})

describe('hours worked', () => {
  const at = (iso: string) => new Date(iso)

  it('counts a normal nine-to-six day with an hour off', () => {
    const result = hoursBetween(at('2026-04-15T03:30:00Z'), at('2026-04-15T12:30:00Z'), 60)
    expect(result.hours).toBe(8)
  })

  it('counts an overnight shift correctly', () => {
    // 22:00 to 06:00 the next morning. The timestamps carry their own dates, so
    // this needs no special handling — which is exactly why check-in is an
    // instant and not a time-on-a-row.
    const result = hoursBetween(at('2026-04-15T16:30:00Z'), at('2026-04-16T00:30:00Z'), 60)
    expect(result.hours).toBe(7)
  })

  it('never returns negative hours', () => {
    const result = hoursBetween(at('2026-04-15T12:00:00Z'), at('2026-04-15T09:00:00Z'), 60)

    // A negative number here would quietly REDUCE a monthly total, which is far
    // worse than a zero somebody notices.
    expect(result.hours).toBe(0)
    expect(result.warning).toMatch(/before check-in/)
  })

  it('caps a forgotten check-out at 24 hours instead of reporting a week', () => {
    const result = hoursBetween(at('2026-04-15T03:30:00Z'), at('2026-04-22T03:30:00Z'), 60)

    expect(result.hours).toBe(24)
    expect(result.warning).toMatch(/24 hours/)
  })

  it('does not let a break exceed the time worked', () => {
    const result = hoursBetween(at('2026-04-15T03:30:00Z'), at('2026-04-15T03:45:00Z'), 60)
    expect(result.hours).toBe(0)
  })

  it('reads a wall-clock entry that wraps past midnight', () => {
    // HR typing 22:00 and 06:00 for a manual night-shift correction.
    const result = hoursBetweenWallClock(22 * 60, 6 * 60, 60)

    expect(result.hours).toBe(7)
    expect(result.warning).toMatch(/overnight/)
  })

  it('reads an ordinary wall-clock entry without warning', () => {
    const result = hoursBetweenWallClock(9 * 60 + 30, 18 * 60 + 30, 60)
    expect(result.hours).toBe(8)
    expect(result.warning).toBeUndefined()
  })
})

describe('classifying a day against the shift', () => {
  // The client's shift is nine hours (§A1.5).
  const SHIFT = 9

  it('counts a full day as present', () => {
    expect(classifyDay(8.5, SHIFT).status).toBe('present')
    expect(classifyDay(9, SHIFT).status).toBe('present')
  })

  it('counts at least half a shift as a half day', () => {
    expect(classifyDay(5, SHIFT).status).toBe('half_day')
    expect(classifyDay(4.5, SHIFT).status).toBe('half_day')
  })

  it('counts less than half a shift as absent, not as a half day', () => {
    // 3 of 9 hours is a third of a day. Paying half a day for it is a decision
    // nobody made on purpose.
    expect(classifyDay(4.4, SHIFT).status).toBe('absent')
    expect(classifyDay(3, SHIFT).status).toBe('absent')
    expect(classifyDay(1, SHIFT).status).toBe('absent')
  })

  it('scales with the shift rather than using fixed hours', () => {
    // Three hours is half of a six-hour shift, and a third of a nine-hour one.
    // The same number, two different answers — which is the point of scaling.
    expect(classifyDay(3, 6).status).toBe('half_day')
    expect(classifyDay(3, 9).status).toBe('absent')
  })

  it('reports the shortfall', () => {
    expect(classifyDay(7.5, SHIFT).shortfallHours).toBe(1.5)
    expect(classifyDay(10, SHIFT).shortfallHours).toBe(0)
  })

  it("follows the client's own day on their nine-hour shift: 8 h full, 4.5 h half (8 Oct 2026)", () => {
    const CLIENT = { full: 8, half: 4.5 }
    // Hours as they are stored: two decimals of an hour.
    const worked = (h: number, m: number) => Math.round((h + m / 60) * 100) / 100
    expect(classifyDay(worked(9, 0), SHIFT, CLIENT).status).toBe('present')
    expect(classifyDay(worked(8, 0), SHIFT, CLIENT).status).toBe('present')
    expect(classifyDay(worked(7, 59), SHIFT, CLIENT).status).toBe('half_day')
    expect(classifyDay(worked(6, 45), SHIFT, CLIENT).status).toBe('half_day') // present under the old three quarters
    expect(classifyDay(worked(4, 30), SHIFT, CLIENT).status).toBe('half_day')
    expect(classifyDay(worked(4, 29), SHIFT, CLIENT).status).toBe('absent')
    expect(classifyDay(0, SHIFT, CLIENT).status).toBe('absent')
  })

  it('adds a month up without rounding drift', () => {
    // Twenty days of 7.77 hours. Rounding each one first would lose minutes.
    expect(totalHours(Array(20).fill(7.77))).toBe(155.4)
  })
})

describe('the geofence', () => {
  /** The client's office, roughly. */
  const OFFICE = { latitude: 18.5204303, longitude: 73.8567437 }
  const FENCE: Fence = { ...OFFICE, radiusMeters: 30, maxAccuracyMeters: 50 }

  it('measures a known distance', () => {
    // Roughly 111 m north.
    const north = { latitude: 18.5214303, longitude: 73.8567437 }
    expect(distanceMeters(OFFICE, north)).toBeGreaterThan(100)
    expect(distanceMeters(OFFICE, north)).toBeLessThan(120)
  })

  it('does not get east-west distances wrong', () => {
    // A flat-earth approximation without the cos(latitude) correction gets this
    // wrong by about 5% at Pune's latitude, and worse further north.
    const east = { latitude: 18.5204303, longitude: 73.8577437 }
    expect(distanceMeters(OFFICE, east)).toBeGreaterThan(95)
    expect(distanceMeters(OFFICE, east)).toBeLessThan(110)
  })

  it('accepts somebody at their desk with a good reading', () => {
    const verdict = checkGeofence({ ...OFFICE, accuracyMeters: 10 }, FENCE)
    expect(verdict.result).toBe('inside')
  })

  it('refuses somebody across the road with a good reading', () => {
    const away = { latitude: 18.5224303, longitude: 73.8567437, accuracyMeters: 10 }
    const verdict = checkGeofence(away, FENCE)

    expect(verdict.result).toBe('outside')
    expect(verdict.distanceMeters).toBeGreaterThan(200)
  })

  it('refuses to decide when the reading is too vague', () => {
    // Standing exactly at the office, but the phone says ±80 m. The centre is
    // inside — and allowing it would mean the car park works too, because that
    // reading cannot tell them apart.
    const verdict = checkGeofence({ ...OFFICE, accuracyMeters: 80 }, FENCE)

    expect(verdict.result).toBe('unreliable')
    expect(verdict.accuracyMeters).toBe(80)
  })

  it('checks accuracy BEFORE distance, so a lucky centre does not sneak through', () => {
    const verdict = checkGeofence({ ...OFFICE, accuracyMeters: 200 }, FENCE)
    expect(verdict.result).not.toBe('inside')
  })

  /** A point this many metres due north of the office. */
  const north = (metres: number) => ({ latitude: OFFICE.latitude + metres / 111_194.93, longitude: OFFICE.longitude })

  it('takes no benefit of the doubt: the point itself must be inside (client, 11 Oct 2026)', () => {
    // 25 m away with ±10 m: once let in as "could be 15 m"; now outside a 20 m fence.
    const verdict = checkGeofence({ ...north(25), accuracyMeters: 10 }, { ...OFFICE, radiusMeters: 20, maxAccuracyMeters: 20 })
    expect(verdict.distanceMeters).toBe(25)
    expect(verdict.result).toBe('outside')
  })

  it('is exact at the edge: 20 m is in, 21 m is out', () => {
    const fence: Fence = { ...OFFICE, radiusMeters: 20, maxAccuracyMeters: 20 }
    expect(checkGeofence({ ...north(20), accuracyMeters: 5 }, fence)).toMatchObject({ result: 'inside', distanceMeters: 20 })
    expect(checkGeofence({ ...north(21), accuracyMeters: 5 }, fence)).toMatchObject({ result: 'outside', distanceMeters: 21 })
  })

  it('never applies a wider fence or a vaguer reading than the limits, whatever is stored', () => {
    // FENCE says 30 m and ±50 m; the check is 20 m and ±20 m.
    expect(checkGeofence({ ...north(25), accuracyMeters: 5 }, FENCE).result).toBe('outside')
    expect(checkGeofence({ ...OFFICE, accuracyMeters: 25 }, FENCE).result).toBe('unreliable')
    expect(effectiveFence(FENCE)).toMatchObject({ radiusMeters: FENCE_LIMITS.radius.max, maxAccuracyMeters: FENCE_LIMITS.accuracy.max })
    // A tighter stored fence is kept as it is.
    expect(effectiveFence({ ...OFFICE, radiusMeters: 15, maxAccuracyMeters: 10 })).toMatchObject({ radiusMeters: 15, maxAccuracyMeters: 10 })
  })

  it('handles a tight 15 m fence, which is what the client asked for', () => {
    const tight: Fence = { ...OFFICE, radiusMeters: 15, maxAccuracyMeters: 15 }

    expect(checkGeofence({ ...OFFICE, accuracyMeters: 8 }, tight).result).toBe('inside')
    expect(checkGeofence({ ...north(16), accuracyMeters: 8 }, tight).result).toBe('outside')
    // The same spot with a typical indoor reading cannot be confirmed — which
    // is the cost of 15 m, and why the client was told about it.
    expect(checkGeofence({ ...OFFICE, accuracyMeters: 40 }, tight).result).toBe('unreliable')
  })

  it('judges a punch by its most precise reading, the latest of equals', () => {
    const readings = [
      { ...north(30), accuracyMeters: 25, at: 1 },
      { ...north(5), accuracyMeters: 8, at: 2 },
      { ...north(6), accuracyMeters: 8, at: 3 },
      { ...north(2), accuracyMeters: 12, at: 4 },
    ]
    expect(bestReading(readings)).toBe(readings[2])
    expect(bestReading([])).toBeNull()
  })

  it('says what to do, for check-in and check-out', () => {
    const fence: Fence = { ...OFFICE, radiusMeters: 20, maxAccuracyMeters: 20 }
    expect(geofenceMessage(checkGeofence({ ...north(40), accuracyMeters: 5 }, fence), fence, 'out')).toBe('You appear to be 40 m from the office. Check out is allowed within 20 m.')
    expect(geofenceMessage(checkGeofence({ ...OFFICE, accuracyMeters: 35 }, fence), fence)).toMatch(/accurate to about 35 m; 20 m is needed/)
  })
})
