/**
 * Reading where the phone is — several times, not once (client, 11 Oct 2026).
 *
 * One reading is a guess with an error bar, and the first one a phone gives is
 * usually its worst: it starts from Wi-Fi or the last known fix and sharpens as
 * the GPS settles. So the phone is watched for a few seconds and EVERY reading
 * is kept. The server — never this page — picks the one a punch is judged by,
 * and keeps the rest as evidence (a fake location often sits perfectly still,
 * where a real one moves a little).
 *
 * `coords.accuracy` comes with each reading: dropping it is what made a 30 m
 * fence unusable, because a reading at the desk and one in the car park look
 * the same without it. `enableHighAccuracy` asks for GPS rather than the
 * Wi-Fi/cell estimate — ±15 m against ±2 km indoors — at a few seconds' and a
 * little battery's cost, the right trade for something done twice a day.
 */

/** The longest the phone is watched. */
export const BURST_MS = 10_000
/** The most readings sent; the server takes no more. */
export const BURST_MAX = 10
/**
 * While the browser may be asking "Allow location?", the watch has not begun:
 * this much longer is allowed for somebody to read the question and answer it.
 */
const PROMPT_MS = 30_000
/** Vaguer than this is not a location — the server takes none. */
const VAGUEST_METRES = 10_000

/**
 * Whether this browser is a phone's (or a tablet's), as the server tells it
 * (domain/attendance/punchSignals.ts deviceKind): only a phone has GPS. Used
 * to keep the office's own point from being captured on a laptop, whose
 * location comes from Wi-Fi and can be tens of metres out — the server judges
 * every punch for itself.
 */
export function isPhoneBrowser() {
  const ua = navigator.userAgent ?? ''
  if (/Android|iPhone|iPad|iPod|Mobile|Mobi/i.test(ua)) return true
  if (navigator.userAgentData?.mobile === true) return true
  return /Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
}

/** The location could not be read at all — said by its code, so a check-out can offer to ask HR instead. */
export const LOCATION_UNREAD = 'LOCATION_UNREAD'
const unread = (message) => Object.assign(new Error(message), { code: LOCATION_UNREAD })

/** Whether the site may already read the location: then no question is asked, and the time starts at once. */
async function alreadyAllowed() {
  try {
    return (await navigator.permissions?.query({ name: 'geolocation' }))?.state === 'granted'
  } catch {
    return false
  }
}

function asReading(position) {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyMeters: Math.round(position.coords.accuracy * 10) / 10,
    at: Math.round(position.timestamp),
  }
}

function bestAccuracy(readings) {
  return readings.reduce((best, r) => Math.min(best, r.accuracyMeters), Infinity)
}

/**
 * Watches the location for up to `maxMs` and resolves with every reading.
 * Stops early once there is enough: three readings with one as precise as
 * `target` metres, or after a few seconds one twice as precise — no need to
 * keep somebody standing there when the answer is clear. Rejects only when not
 * a single reading came, in words that say what to do.
 *
 * The time starts when the location can be read: when the site is already
 * allowed, at once; otherwise at the first answer, the browser's question
 * ("Allow location?") given its own time — an iPhone asks again now and then,
 * and reading the question must not use up the seconds a fix indoors needs.
 */
export async function readLocationBurst({ target = 20, maxMs = BURST_MS } = {}) {
  const allowed = await alreadyAllowed()
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(unread('This browser cannot report your location. Use your phone’s browser, or ask HR to mark your attendance.'))
      return
    }
    const readings = []
    let started = Date.now()
    let counting = allowed
    let watchId = null
    let timer = null
    let poll = null
    let done = false

    // From the first answer, the usual time; until then, time to answer the browser's question too.
    function startCounting() {
      if (counting) return
      counting = true
      started = Date.now()
      clearTimeout(timer)
      timer = setTimeout(() => finish(), maxMs)
    }

    function finish(error) {
      if (done) return
      done = true
      if (watchId !== null) navigator.geolocation.clearWatch(watchId)
      clearTimeout(timer)
      clearInterval(poll)
      if (readings.length > 0) resolve(readings.slice(-BURST_MAX))
      else reject(error ?? unread('Your location could not be read. Move near a window and try again.'))
    }

    function enough() {
      if (readings.length === 0) return false
      const best = bestAccuracy(readings)
      return readings.length >= BURST_MAX || (readings.length >= 3 && best <= target) || (Date.now() - started >= 4_000 && best <= target / 2)
    }

    watchId = navigator.geolocation.watchPosition(
      (position) => {
        startCounting()
        // Kilometres out is the phone saying it has no idea: not a reading.
        if (!(position.coords.accuracy <= VAGUEST_METRES)) return
        readings.push(asReading(position))
        if (enough()) finish()
      },
      (error) => {
        // The refusal case is worth its own wording. "Position unavailable"
        // tells somebody nothing about what to do next.
        if (error.code === error.PERMISSION_DENIED) {
          finish(unread('Location access was blocked. Allow it for this site in your browser’s settings, then try again.'))
          return
        }
        // Anything else (a timeout, no fix yet): the question was answered — keep watching until the time is up.
        startCounting()
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: maxMs },
    )
    timer = setTimeout(() => finish(), counting ? maxMs : maxMs + PROMPT_MS)
    // A phone that gives one fix and then nothing new is not kept waiting the full time.
    poll = setInterval(() => { if (enough()) finish() }, 500)
  })
}

/**
 * Where the office is, from a longer watch (Settings → Attendance Security):
 * the readings weighted by how precise each is (1 / accuracy²), the vaguest
 * half left out — a better centre than any one reading.
 */
export function averageReadings(readings) {
  if (readings.length === 0) return null
  const kept = [...readings].sort((a, b) => a.accuracyMeters - b.accuracyMeters).slice(0, Math.max(1, Math.ceil(readings.length / 2)))
  let weight = 0
  let lat = 0
  let lng = 0
  for (const r of kept) {
    const w = 1 / Math.max(1, r.accuracyMeters) ** 2
    weight += w
    lat += r.latitude * w
    lng += r.longitude * w
  }
  return { latitude: lat / weight, longitude: lng / weight, accuracyMeters: kept[0].accuracyMeters, count: readings.length }
}
