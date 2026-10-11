/**
 * Is this person at the office?
 *
 * Pure geometry and one decision rule. No request, no database, no GPS — the
 * reading is passed in, which is what lets every borderline case be tested
 * without standing in a car park.
 */

const EARTH_RADIUS_METRES = 6_371_008.8

/**
 * The client's fence (11 Oct 2026): check-in and check-out within 15–20 m of
 * the office — "not a metre more". These bound the settings, and the check
 * itself never uses a wider radius or a vaguer reading than the maximum,
 * whatever a stored office says.
 */
export const FENCE_LIMITS = {
  radius: { min: 15, max: 20 },
  accuracy: { min: 10, max: 20 },
} as const

export interface Coordinates {
  latitude: number
  longitude: number
}

export interface Reading extends Coordinates {
  /**
   * The browser's own estimate of how wrong it might be, in metres.
   *
   * This is the number everybody ignores, and ignoring it is what makes a 20 m
   * geofence unusable. A phone saying "I am here, give or take 60 metres" has
   * not located anybody.
   */
  accuracyMeters: number
  /** When the phone took it, as the phone's clock says (ms since 1970). */
  at?: number | undefined
}

export interface Fence extends Coordinates {
  radiusMeters: number
  /** A reading vaguer than this decides nothing and is refused as unusable. */
  maxAccuracyMeters: number
}

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than a flat-earth approximation. At these distances the
 * difference is centimetres and either would do — but the flat version needs a
 * cos(latitude) correction that is easy to forget, and forgetting it makes
 * east-west distances wrong by a factor that grows with latitude. The correct
 * formula costs nothing here.
 */
export function distanceMeters(a: Coordinates, b: Coordinates): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180

  const lat1 = toRadians(a.latitude)
  const lat2 = toRadians(b.latitude)
  const deltaLat = toRadians(b.latitude - a.latitude)
  const deltaLon = toRadians(b.longitude - a.longitude)

  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2

  return Math.round(2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h))))
}

export type GeofenceVerdict =
  /** Inside the fence, and the reading was precise enough to say so. */
  | { result: 'inside'; distanceMeters: number; accuracyMeters: number }
  /** Outside the fence, and the reading was precise enough to say so. */
  | { result: 'outside'; distanceMeters: number; accuracyMeters: number }
  /** The reading is too vague to decide either way. */
  | { result: 'unreliable'; distanceMeters: number; accuracyMeters: number }

/** The fence as it is applied: never wider, and never more forgiving of a vague reading, than the limits. */
export function effectiveFence(fence: Fence): Fence {
  return {
    latitude: fence.latitude,
    longitude: fence.longitude,
    radiusMeters: Math.min(fence.radiusMeters, FENCE_LIMITS.radius.max),
    maxAccuracyMeters: Math.min(fence.maxAccuracyMeters, FENCE_LIMITS.accuracy.max),
  }
}

/**
 * THREE ANSWERS, NOT TWO.
 *
 * A reading vaguer than `maxAccuracyMeters` is `unreliable` — neither accepted
 * nor refused; the person is asked to try again near a window. Saying "I
 * cannot tell" is the only honest answer when the error bar is wider than the
 * thing being measured.
 *
 * A precise enough reading is inside only if ITS POINT is within the radius.
 * Nothing is added for the reading's own uncertainty: the client wants the
 * fence to mean what it says — 20 m is 20 m, not 20 m plus whatever the phone
 * was unsure of (11 Oct 2026). Until then the accuracy was given to the person
 * (`distance − accuracy`), which let a 30 m fence accept a reading 74 m out.
 */
export function checkGeofence(reading: Reading, fence: Fence): GeofenceVerdict {
  const applied = effectiveFence(fence)
  const distance = distanceMeters(reading, applied)
  const accuracy = Math.max(0, Math.round(reading.accuracyMeters))

  // Checked BEFORE the distance comparison. A reading that cannot be trusted
  // must not be allowed through just because its centre happens to land inside.
  if (accuracy > applied.maxAccuracyMeters) {
    return { result: 'unreliable', distanceMeters: distance, accuracyMeters: accuracy }
  }

  return distance <= applied.radiusMeters
    ? { result: 'inside', distanceMeters: distance, accuracyMeters: accuracy }
    : { result: 'outside', distanceMeters: distance, accuracyMeters: accuracy }
}

/**
 * The reading a punch is judged by, of the several the phone took: the most
 * precise one, and of equally precise ones the latest. Chosen here — never by
 * the browser — so the page cannot pick a convenient one. Null with none.
 */
export function bestReading<T extends Reading>(readings: readonly T[]): T | null {
  let best: T | null = null
  for (const reading of readings) {
    if (
      !best ||
      reading.accuracyMeters < best.accuracyMeters ||
      (reading.accuracyMeters === best.accuracyMeters && (reading.at ?? 0) >= (best.at ?? 0))
    ) {
      best = reading
    }
  }
  return best
}

/** What to tell the person, in words they can act on. */
export function geofenceMessage(verdict: GeofenceVerdict, fence: Fence, action: 'in' | 'out' = 'in'): string {
  const applied = effectiveFence(fence)
  const what = action === 'in' ? 'Check in' : 'Check out'
  switch (verdict.result) {
    case 'inside':
      return 'Location confirmed'
    case 'outside':
      return `You appear to be ${verdict.distanceMeters} m from the office. ${what} is allowed within ${applied.radiusMeters} m.`
    case 'unreliable':
      return `Your location could not be confirmed precisely enough (accurate to about ${verdict.accuracyMeters} m; ${applied.maxAccuracyMeters} m is needed). Move near a window, wait a few seconds, then try again.`
  }
}
