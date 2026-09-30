import { describe, it, expect } from 'vitest'
import { isEnabled, isNotificationEvent, NOTIFICATION_EVENTS, NOTIFICATION_EVENT_KEYS } from './events'

describe('the notification catalogue', () => {
  it('sends every event unless the company switched it off', () => {
    expect(isEnabled('leave.submitted', new Map())).toBe(true)
    expect(isEnabled('leave.submitted', new Map([['leave.submitted', false]]))).toBe(false)
  })

  it('always sends a security notice, whatever was saved', () => {
    expect(isEnabled('account.password_changed', new Map([['account.password_changed', false]]))).toBe(true)
  })

  it('names what Settings promised before notices existed', () => {
    for (const event of ['leave.submitted', 'leave.decided', 'leave.withdrawn', 'payslip.ready', 'document.submitted', 'document.decided']) {
      expect(isNotificationEvent(event)).toBe(true)
    }
    expect(isNotificationEvent('made.up')).toBe(false)
  })

  it('says for every event whom it tells', () => {
    for (const key of NOTIFICATION_EVENT_KEYS) {
      expect(NOTIFICATION_EVENTS[key].tells.length).toBeGreaterThan(5)
      expect(NOTIFICATION_EVENTS[key].label.length).toBeGreaterThan(5)
    }
  })
})
