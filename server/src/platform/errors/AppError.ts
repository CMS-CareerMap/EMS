/**
 * Every expected failure in the system is an AppError.
 *
 * Services throw; they never build an HTTP response. The single error handler
 * in http/middleware/errorHandler.ts is the only place a status code is set.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
    Error.captureStackTrace?.(this, AppError)
  }
}

export const BadRequest = (message = 'Bad request', details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details)

export const Unauthorized = (message = 'Not authenticated') =>
  new AppError(401, 'UNAUTHENTICATED', message)

export const Forbidden = (message = 'Not permitted') =>
  new AppError(403, 'FORBIDDEN', message)

export const NotFound = (message = 'Not found') =>
  new AppError(404, 'NOT_FOUND', message)

export const Conflict = (message = 'Conflict', details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details)

export const ValidationFailed = (message = 'Validation failed', details?: unknown) =>
  new AppError(422, 'VALIDATION_FAILED', message, details)

/**
 * The request was well formed and the answer is still no, because of the
 * state of things — a payroll run with employees who have no TDS directive.
 * `details` says what has to change for it to succeed.
 */
export const BusinessRule = (message: string, details?: unknown) =>
  new AppError(422, 'BUSINESS_RULE', message, details)

/**
 * A stored file that is missing, or is not the file that was written. It is
 * the server's fault, so a 500 — but a known one, with words a person can act
 * on, instead of "Something went wrong". The details go to the log only.
 */
export const FileUnavailable = (
  message = 'This file could not be read from storage — it is missing or has been altered. The problem has been logged for the administrator.',
) => new AppError(500, 'FILE_UNAVAILABLE', message)

/** A file larger than allowed — the company's cap, or the system's ceiling. */
export const PayloadTooLarge = (message = 'That upload is too large.') =>
  new AppError(413, 'PAYLOAD_TOO_LARGE', message)
