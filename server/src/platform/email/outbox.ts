import { logger } from '../logger'
import { emailReady, sendMail } from './mailer'
import * as repo from './outbox.repository'

/**
 * Sends what notices queued (client §45), after the change that queued them
 * has committed. A mail server that is down delays a message; each is tried
 * five times, half a minute or more apart, then given up on — the notice in
 * the app still stands.
 */

const BATCH = 20
const MAX_ATTEMPTS = 5
const EVERY_MS = 30_000
/** Sent mail is kept this long, for "did it go?" questions, then cleared. */
const KEEP_DAYS = 30

let running = false

export async function sendWaitingEmails(): Promise<{ sent: number; failed: number }> {
  if (!emailReady() || running) return { sent: 0, failed: 0 }
  running = true
  let sent = 0
  let failed = 0
  try {
    for (const organizationId of await repo.companiesWithMail()) {
      for (const mail of await repo.waiting(organizationId, BATCH)) {
        try {
          await sendMail({ to: mail.toEmail, subject: mail.subject, text: mail.body })
          await repo.markSent(organizationId, mail.id)
          sent++
        } catch (err) {
          failed++
          const giveUp = mail.attempts + 1 >= MAX_ATTEMPTS
          const message = err instanceof Error ? err.message : String(err)
          await repo.markFailedAttempt(organizationId, mail.id, message, giveUp)
          logger.warn('Email not sent', { id: mail.id, attempt: mail.attempts + 1, gaveUp: giveUp, error: message })
        }
      }
    }
  } finally {
    running = false
  }
  return { sent, failed }
}

async function purge(): Promise<void> {
  const before = new Date(Date.now() - KEEP_DAYS * 86_400_000)
  for (const organizationId of await repo.allCompanies()) await repo.purgeDone(organizationId, before)
}

/** Starts the sender — only when email is set up. Returns a stop function. */
export function startEmailSender(): () => void {
  if (!emailReady()) return () => {}
  const fail = (what: string) => (err: unknown) => logger.error(what, { error: err instanceof Error ? err.message : String(err) })
  const timer = setInterval(() => void sendWaitingEmails().catch(fail('Email sender failed')), EVERY_MS)
  timer.unref()
  const daily = setInterval(() => void purge().catch(fail('Clearing old email failed')), 86_400_000)
  daily.unref()
  logger.info('Email sender started')
  return () => {
    clearInterval(timer)
    clearInterval(daily)
  }
}
