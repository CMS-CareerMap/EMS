/**
 * The signs a punch may not be what it seems (client, 11 Oct 2026). Pure: a
 * punch's readings and where it came from in, flags out.
 *
 * Flags, never verdicts. A web page cannot tell a fake-location app from the
 * phone's own GPS — the browser hands both over the same way — so each of these
 * is a sign for HR to look at, with the rest of the evidence, never a reason on
 * its own to refuse a punch. The one block among them, "phones only", is the
 * company's own setting, and a determined person can still get round it.
 */

export type PunchFlag =
  /** Every reading of the burst exactly the same: real GPS moves a little; a fake one often sits still. */
  | 'frozen_readings'
  /** The very same point, to the last digit, as an earlier day's punch: real readings never repeat that exactly. */
  | 'repeated_spot'
  /** More precise than a phone indoors manages: a fake location often claims a metre or two, or none. */
  | 'too_precise'
  /** The reading's own time far from the server's: taken earlier, or the phone's clock set. */
  | 'stale_reading'
  /** From a computer, with "phones only" off: a computer's browser can be told any location. */
  | 'not_a_phone'
  /** A phone not seen in the person's punches of the last two months, with "one phone" off — or no phone key at all. */
  | 'new_device'
  /** The very same photo, to the byte, as an earlier punch of theirs: a live camera never gives the same file twice. */
  | 'repeated_photo'
  /** A Mac's browser claiming a touch screen: an iPad says it is a Mac — and so can a laptop told to. Taken as a phone, and said. */
  | 'mac_with_touch'
  /**
   * A location kept but not fenced (Location + Selfie, wherever they are) vaguer than 100 m. Since
   * 25 Oct 2026 a reading vaguer than the company's precise-location limit (100 m to start) is
   * refused before this is asked; one taken under a limit set higher (up to 500 m — a warehouse's
   * metal roof) is said, so HR knows the record says little.
   */
  | 'location_vague'

export interface SignalReading {
  latitude: number
  longitude: number
  accuracyMeters: number
  /** The phone's clock, ms since 1970. */
  at?: number | undefined
}

/** A reading of 2 m or better, indoors, is not one a phone gives. */
export const TOO_PRECISE_METRES = 2
/** A reading older (or newer) than this against the server's clock is not this punch's. */
export const STALE_MS = 2 * 60 * 1000
/** A location kept but not fenced, vaguer than this, does not say which site somebody stood at. */
export const VAGUE_METRES = 100

/** Latitude and longitude as stored (seven decimals): what "the same point" means. */
const point = (r: { latitude: number; longitude: number }) => `${r.latitude.toFixed(7)},${r.longitude.toFixed(7)}`

export interface DeviceHints {
  userAgent: string | null | undefined
  mobileHint?: string | null | undefined
  touchPoints?: number | null | undefined
}

/**
 * What punched, as the browser tells it: a phone (or tablet) by its own
 * description or the browser's mobile hint; a Mac's browser with a touch
 * screen — how an iPad describes itself, and what a laptop can be made to
 * say by a page's count of touch points, which the request carries — taken as
 * a phone but flagged; otherwise a computer.
 */
export function deviceKind(device: DeviceHints): 'phone' | 'mac_with_touch' | 'computer' {
  const ua = device.userAgent ?? ''
  if (/Android|iPhone|iPad|iPod|Mobile|Mobi/i.test(ua)) return 'phone'
  if (device.mobileHint === '?1') return 'phone'
  return /Macintosh/i.test(ua) && (device.touchPoints ?? 0) > 1 ? 'mac_with_touch' : 'computer'
}

/** Whether the browser that punched passes "phones only". */
export const isPhone = (device: DeviceHints): boolean => deviceKind(device) !== 'computer'

export function punchSignals(input: {
  readings: readonly SignalReading[]
  /** The reading the punch was judged by; null with none. */
  best: SignalReading | null
  /** The server's clock, ms since 1970. */
  now: number
  /** This person's earlier punches' points, other days. */
  earlierPoints: readonly { latitude: number; longitude: number }[]
  kind: ReturnType<typeof deviceKind>
  /**
   * A Location + Selfie reading — kept wherever they stand, never fenced: the one
   * whose vagueness is said. A fenced one too vague is refused; a work-from-home
   * day's is not judged at all, as before Location + Selfie.
   */
  keptAnywhere?: boolean | undefined
}): PunchFlag[] {
  const flags: PunchFlag[] = []
  const { readings, best } = input
  if (readings.length >= 3) {
    const first = readings[0]!
    if (readings.every((r) => point(r) === point(first) && r.accuracyMeters === first.accuracyMeters)) flags.push('frozen_readings')
  }
  if (best && input.earlierPoints.some((p) => point(p) === point(best))) flags.push('repeated_spot')
  if (best && best.accuracyMeters <= TOO_PRECISE_METRES) flags.push('too_precise')
  if (best && best.at !== undefined && Math.abs(input.now - best.at) > STALE_MS) flags.push('stale_reading')
  if (input.kind === 'computer') flags.push('not_a_phone')
  if (input.kind === 'mac_with_touch') flags.push('mac_with_touch')
  if (best && input.keptAnywhere && best.accuracyMeters > VAGUE_METRES) flags.push('location_vague')
  return flags
}

/** "Android · Chrome", from a browser's description of itself — a phone's label, enough to tell one from another. */
export function deviceLabel(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null
  const os = /iPhone|iPad/.test(userAgent) ? 'iPhone/iPad' : /Android/.test(userAgent) ? 'Android' : /Windows/.test(userAgent) ? 'Windows' : /Mac OS X|Macintosh/.test(userAgent) ? 'Mac' : /Linux/.test(userAgent) ? 'Linux' : 'Unknown'
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /SamsungBrowser/.test(userAgent) ? 'Samsung Internet' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'a browser'
  return `${os} · ${browser}`
}

/** What each flag means, in words HR can act on. */
export const PUNCH_FLAG_WORDS: Record<PunchFlag, string> = {
  frozen_readings: 'Every reading exactly the same — a real phone’s location moves a little',
  repeated_spot: 'The very same point as an earlier day, to the last digit',
  too_precise: 'More precise than a phone indoors manages',
  stale_reading: 'The reading’s time was far from the server’s',
  not_a_phone: 'From a computer, not a phone',
  new_device: 'From a phone not used in the last two months',
  repeated_photo: 'The very same photo as an earlier punch — a camera never gives the same one twice',
  mac_with_touch: 'An iPad — or a computer claiming a touch screen',
  location_vague: 'The location was too vague to say where (over 100 m) — precise location may be off on the phone',
}
