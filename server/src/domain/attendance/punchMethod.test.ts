import { describe, it, expect } from 'vitest'
import { methodNeeds, PUNCH_METHODS, PUNCH_METHOD_WORDS } from './punchMethod'

/**
 * The punch method (client, 14 Oct 2026): exactly one, and each asks for at
 * least one proof — there is no method that asks for nothing.
 */
describe('the punch method', () => {
  it('asks for what it says, and nothing more — only Location checks the office', () => {
    expect(methodNeeds('location')).toEqual({ location: true, fence: true, selfie: false })
    expect(methodNeeds('selfie')).toEqual({ location: false, fence: false, selfie: true })
    // Wherever the person is: the location read and kept, never checked against an office.
    expect(methodNeeds('location_selfie')).toEqual({ location: true, fence: false, selfie: true })
  })

  it('never asks for nothing — "at least one layer" is in the list itself', () => {
    for (const method of PUNCH_METHODS) {
      const needs = methodNeeds(method)
      expect(needs.location || needs.selfie, method).toBe(true)
    }
  })

  it('has words for every method', () => {
    for (const method of PUNCH_METHODS) expect(PUNCH_METHOD_WORDS[method].length, method).toBeGreaterThan(3)
  })
})
