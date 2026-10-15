import { describe, it, expect } from 'vitest'
import { deviceKind, isPhone, punchSignals, STALE_MS, VAGUE_METRES } from './punchSignals'

const at = (n: number) => 1_760_000_000_000 + n
const real = [
  { latitude: 18.5590012, longitude: 73.7868031, accuracyMeters: 14, at: at(0) },
  { latitude: 18.5590041, longitude: 73.7867998, accuracyMeters: 11, at: at(1_000) },
  { latitude: 18.5590027, longitude: 73.7868016, accuracyMeters: 9, at: at(2_000) },
]
const base = { readings: real, best: real[2]!, now: at(3_000), earlierPoints: [], kind: 'phone' as const }

describe('the signs a punch may not be what it seems (client, 11 Oct 2026)', () => {
  it('a real phone’s burst says nothing', () => {
    expect(punchSignals(base)).toEqual([])
  })

  it('every reading the same, to the last digit: frozen', () => {
    const frozen = [0, 1_000, 2_000].map((n) => ({ latitude: 18.559, longitude: 73.7868, accuracyMeters: 5, at: at(n) }))
    expect(punchSignals({ ...base, readings: frozen, best: frozen[2]! })).toEqual(['frozen_readings'])
    // Two readings are too few to say.
    expect(punchSignals({ ...base, readings: frozen.slice(0, 2), best: frozen[1]! })).toEqual([])
  })

  it('the very same point as an earlier day: repeated', () => {
    expect(punchSignals({ ...base, earlierPoints: [{ latitude: 18.5590027, longitude: 73.7868016 }] })).toEqual(['repeated_spot'])
    // A centimetre off is a real reading.
    expect(punchSignals({ ...base, earlierPoints: [{ latitude: 18.5590028, longitude: 73.7868016 }] })).toEqual([])
  })

  it('2 m or better: too precise for a phone indoors', () => {
    expect(punchSignals({ ...base, best: { ...real[2]!, accuracyMeters: 2 } })).toEqual(['too_precise'])
    expect(punchSignals({ ...base, best: { ...real[2]!, accuracyMeters: 3 } })).toEqual([])
  })

  it('a reading whose time is far from the server’s: stale', () => {
    expect(punchSignals({ ...base, now: at(2_000 + STALE_MS + 1) })).toEqual(['stale_reading'])
    expect(punchSignals({ ...base, best: { ...real[2]!, at: undefined }, now: at(10 * STALE_MS) })).toEqual([])
  })

  it('a Location + Selfie reading vaguer than 100 m: flagged — a fenced one is refused instead, and a work-from-home day’s is not judged, as before', () => {
    const vague = { ...real[2]!, accuracyMeters: VAGUE_METRES + 1 }
    expect(punchSignals({ ...base, best: vague, readings: [vague], keptAnywhere: true })).toEqual(['location_vague'])
    // The office fence (refused instead), or a reading kept on a day away under Location: not this flag.
    expect(punchSignals({ ...base, best: vague, readings: [vague], keptAnywhere: false })).toEqual([])
    expect(punchSignals({ ...base, best: vague, readings: [vague] })).toEqual([])
    const fine = { ...real[2]!, accuracyMeters: VAGUE_METRES }
    expect(punchSignals({ ...base, best: fine, readings: [fine], keptAnywhere: true })).toEqual([])
  })

  it('from a computer: not a phone; a Mac with a touch screen: said too', () => {
    expect(punchSignals({ ...base, kind: 'computer' })).toEqual(['not_a_phone'])
    expect(punchSignals({ ...base, kind: 'mac_with_touch' })).toEqual(['mac_with_touch'])
  })

  it('tells a phone from a computer by what the browser says', () => {
    expect(isPhone({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36' })).toBe(true)
    expect(isPhone({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' })).toBe(true)
    expect(isPhone({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0' })).toBe(false)
    expect(isPhone({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0', mobileHint: '?1' })).toBe(true)
    // An iPad says it is a Mac — with a touch screen: taken, and flagged, since a laptop can say the same.
    expect(isPhone({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', touchPoints: 5 })).toBe(true)
    expect(deviceKind({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', touchPoints: 5 })).toBe('mac_with_touch')
    expect(isPhone({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', touchPoints: 0 })).toBe(false)
    expect(isPhone({ userAgent: null })).toBe(false)
  })
})
