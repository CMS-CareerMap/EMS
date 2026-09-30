/**
 * The only place in this app that talks to the network.
 *
 * Three decisions are worth understanding before changing anything here.
 *
 * 1. THE ACCESS TOKEN LIVES IN A VARIABLE, NOT IN localStorage.
 *    Anything in localStorage is readable by any script that runs on the page,
 *    including one injected through a dependency. A token held in a module
 *    variable dies with the tab, and the refresh cookie — which JavaScript
 *    cannot read at all — is what survives a reload. That is the entire reason
 *    there are two tokens instead of one.
 *
 * 2. EVERY FAILURE THROWS.
 *    The audit found zero error handlers in the old codebase, because the old
 *    client returned `{ data, error }` and nobody checked `error`. A function
 *    that throws cannot be ignored: TanStack Query marks the query failed, the
 *    global handler in main.jsx shows a toast, and the page cannot render
 *    success state over a failure. Silent failure stops being possible.
 *
 * 3. REFRESH IS SINGLE-FLIGHT.
 *    The server rotates refresh tokens, and a token can be spent exactly once —
 *    presenting one twice is treated as theft and kills the session. So if four
 *    queries expire together, four parallel refreshes would log the user out.
 *    `refreshInFlight` makes the other three wait for the first.
 */

const BASE = '/api'

/** A failed request. Carries the server's error contract, not a bare string. */
export class ApiError extends Error {
  constructor({ status, code, message, details, requestId }) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
    this.requestId = requestId
  }

  /** True when the user simply needs to sign in again. */
  get isAuthError() {
    return this.status === 401
  }
}

let accessToken = null

export function setAccessToken(token) {
  accessToken = token
}

export function clearAccessToken() {
  accessToken = null
}

/** Listeners for "the session is gone" — App.jsx uses this to send you to /signin. */
const sessionEndedHandlers = new Set()

export function onSessionEnded(handler) {
  sessionEndedHandlers.add(handler)
  return () => sessionEndedHandlers.delete(handler)
}

function announceSessionEnded() {
  clearAccessToken()
  for (const handler of sessionEndedHandlers) handler()
}

async function send(method, path, body, { withAuth = true } = {}) {
  const headers = {
    // Required by the server on cookie-authenticated routes, and harmless
    // everywhere else. A cross-site page cannot set it.
    'X-Requested-With': 'ems',
  }

  // A file upload is a multipart form, and the browser writes its own
  // Content-Type for it — with the boundary. Setting one here would break it.
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json'
  if (withAuth && accessToken) headers.Authorization = `Bearer ${accessToken}`

  return fetch(`${BASE}${path}`, {
    method,
    headers,
    // Sends the refresh cookie. Same-origin in both development (Vite proxy)
    // and production (Nginx), so this is never a cross-site request.
    credentials: 'same-origin',
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  })
}

async function toResult(response) {
  // 204 has no body to parse.
  if (response.status === 204) return null

  let payload
  try {
    payload = await response.json()
  } catch {
    throw new ApiError({
      status: response.status,
      code: 'BAD_RESPONSE',
      message: 'The server sent a response this app could not read.',
    })
  }

  if (!response.ok) {
    const error = payload?.error ?? {}
    throw new ApiError({
      status: response.status,
      code: error.code ?? 'UNKNOWN',
      message: error.message ?? 'Something went wrong.',
      details: error.details,
      requestId: error.requestId,
    })
  }

  return payload
}

let refreshInFlight = null

/**
 * Trades the refresh cookie for a new access token. Concurrent callers share
 * one request — see note 3 above.
 */
export function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = send('POST', '/auth/refresh', {}, { withAuth: false })
      .then(toResult)
      .then((payload) => {
        setAccessToken(payload.data.accessToken)
        return payload.data
      })
      .finally(() => {
        refreshInFlight = null
      })
  }
  return refreshInFlight
}

/**
 * Make a request, refreshing once if the access token has expired.
 *
 * The retry is deliberately limited to one attempt on one condition. A loop
 * here would turn an expired session into a storm of requests against the very
 * endpoint that is rejecting them.
 */
export async function request(method, path, body, options = {}) {
  const response = await send(method, path, body, options)

  if (response.status !== 401 || options.retrying || path.startsWith('/auth/')) {
    return toResult(response)
  }

  try {
    await refreshSession()
  } catch {
    announceSessionEnded()
    throw new ApiError({
      status: 401,
      code: 'SESSION_EXPIRED',
      message: 'Your session has expired. Please sign in again.',
    })
  }

  return toResult(await send(method, path, body, { ...options, retrying: true }))
}

/**
 * A file the server sends — a payslip PDF, the bank transfer CSV — with the
 * same sign-in and the same one refresh as every other request. An error still
 * arrives as JSON and is thrown as an ApiError, so a refused download reads
 * like any other refusal.
 */
async function download(path) {
  let response = await send('GET', path)
  if (response.status === 401 && !path.startsWith('/auth/')) {
    try {
      await refreshSession()
    } catch {
      announceSessionEnded()
      throw new ApiError({ status: 401, code: 'SESSION_EXPIRED', message: 'Your session has expired. Please sign in again.' })
    }
    response = await send('GET', path)
  }

  if (!response.ok) {
    await toResult(response)
    throw new ApiError({ status: response.status, code: 'UNKNOWN', message: 'That file could not be downloaded.' })
  }

  const disposition = response.headers.get('Content-Disposition') ?? ''
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'download'
  return { blob: await response.blob(), filename }
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
  /** A multipart form — a file and its fields. POST unless told otherwise. */
  upload: (path, form, method = 'POST') => request(method, path, form),
  download,
}

/**
 * A stored file as a blob, to show inside the page — a photo of a document,
 * a PDF in a frame. It still arrives through the authenticated route with its
 * attachment headers; the page makes its own object URL for it.
 */
export async function fetchBlob(path) {
  const { blob } = await download(path)
  return blob
}

/** Downloads a file from the API and hands it to the browser to save. */
export async function saveFromApi(path) {
  const { blob, filename } = await download(path)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked after the click has been handled, not before.
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return filename
}
