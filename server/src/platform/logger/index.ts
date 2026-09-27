import { env } from '../../config/env'
import { isoInstant } from '../../domain/shared/dates'

/**
 * Structured logging.
 *
 * In production every line is JSON so a log collector can index it. In
 * development it is readable. Either way the requestId travels with the line,
 * which is how a user's "it broke at 3pm" becomes a single grep.
 *
 * Day 20 swaps the transport for pino. The call sites do not change.
 */

type Level = 'debug' | 'info' | 'warn' | 'error'
type Fields = Record<string, unknown>

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MIN = env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug

/** Never let a secret reach the log, however it was passed in. */
const REDACT = new Set([
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'secret',
  'bankAccount',
  'ifsc',
  'pan',
])

function redact(fields: Fields): Fields {
  const out: Fields = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] = REDACT.has(k) ? '[redacted]' : v
  }
  return out
}

function emit(level: Level, message: string, fields: Fields = {}): void {
  if (LEVELS[level] < MIN) return

  const safe = redact(fields)

  if (env.NODE_ENV === 'production') {
    console[level === 'debug' ? 'log' : level](
      JSON.stringify({ level, time: isoInstant(new Date()), message, ...safe }),
    )
    return
  }

  const detail = Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : ''
  console[level === 'debug' ? 'log' : level](`${level.toUpperCase().padEnd(5)} ${message}${detail}`)
}

export const logger = {
  debug: (message: string, fields?: Fields) => emit('debug', message, fields),
  info: (message: string, fields?: Fields) => emit('info', message, fields),
  warn: (message: string, fields?: Fields) => emit('warn', message, fields),
  error: (message: string, fields?: Fields) => emit('error', message, fields),
}
