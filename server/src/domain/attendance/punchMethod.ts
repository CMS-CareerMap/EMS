/**
 * How an app punch is proved (client, 14 Oct 2026): the Super Admin chooses
 * exactly one method — never none — and the punch follows it, nothing more
 * and nothing less. Pure: a method in, what it asks of the phone out.
 *
 *   - location: inside the office fence — the one saved — on an office day.
 *   - selfie: a live photo, from anywhere.
 *   - location_selfie: wherever the person is — one of several warehouses,
 *     say — their current location is read (none, no punch) and kept with a
 *     live photo. Nothing is checked against an office, and no office is
 *     needed: where they stood is on the record for HR (client, 14 Oct 2026).
 */

export const PUNCH_METHODS = ['location', 'selfie', 'location_selfie'] as const

export type PunchMethod = (typeof PUNCH_METHODS)[number]

export interface MethodNeeds {
  /** The phone's location must be read. */
  location: boolean
  /** …and judged against the saved office's fence (office days). Only the Location method. */
  fence: boolean
  /** A live photo from the front camera. */
  selfie: boolean
}

export function methodNeeds(method: PunchMethod): MethodNeeds {
  return { location: method !== 'selfie', fence: method === 'location', selfie: method !== 'location' }
}

/** The method as a person says it — in the audit log and in messages. */
export const PUNCH_METHOD_WORDS: Readonly<Record<PunchMethod, string>> = {
  location: 'location',
  selfie: 'selfie',
  location_selfie: 'location + selfie',
}
