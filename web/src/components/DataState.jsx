import { AlertTriangle, RotateCw } from 'lucide-react'
import { ApiError } from '../api/http'
import { btn } from './ui/styles'

/**
 * What a list or a card shows before, instead of, or around its data.
 *
 * The old screens decided this themselves, and most of them got the same case
 * wrong: a request that FAILED fell through to the empty state, so "Could not
 * reach the server" read as "No employees yet" — an honest-looking lie about
 * the company's data. Every screen now asks one component, in one order:
 *
 *   1. an error, if any query failed — with the server's words, the reference
 *      that finds it in the logs, and a way to try again. Never the data, and
 *      never the empty state, while an error stands (guide §A8).
 *   2. loading, while the first answer is on its way.
 *   3. empty, when the answer is honestly nothing.
 *   4. the data.
 *
 * `query` is one TanStack query result; `queries` is several a screen needs
 * together — it is in error if any is, loading until all have answered.
 * Children may be a function of the data (or of the list of data, for
 * `queries`).
 */

function stateOf(query, queries, keepOnRefetchError = false) {
  const list = queries ?? [query]
  // A screen that asks again on its own may keep its last answer when asking
  // again fails — and says so (below), rather than putting it out of sight.
  const failed = list.filter((q) => q?.isError && !(keepOnRefetchError && q.data !== undefined))
  if (failed.length) {
    return {
      status: 'error',
      error: failed[0].error,
      retry: () => failed.forEach((q) => q.refetch()),
      retrying: failed.some((q) => q.isFetching),
    }
  }
  if (list.some((q) => q?.isLoading)) return { status: 'loading' }
  // A query that is switched off (waiting for a choice) has nothing to show yet.
  if (list.some((q) => q?.data === undefined)) return { status: 'idle' }
  return { status: 'ready', data: queries ? list.map((q) => q.data) : query.data }
}

const emptyByDefault = (data) => Array.isArray(data) && data.length === 0

/** The error, in words, with the reference and a retry. Also used on its own. */
export function QueryError({ error, onRetry, retrying = false, compact = false }) {
  const api = error instanceof ApiError ? error : null
  // Refused is a fact about this person's access, not a fault: no retry.
  const refused = api?.status === 403
  // Asking again helps only when nothing answered, or the server failed. A
  // 400, 404 or 422 is an answer, and the same question gets it again.
  const worthRetrying = !api || api.status === 0 || api.status >= 500
  const message = error?.message || 'Something went wrong.'

  return (
    <div role="alert" className={`flex flex-col items-center text-center gap-2 px-4 ${compact ? 'py-4' : 'py-10'}`}>
      <AlertTriangle className="w-5 h-5 text-amber-500" aria-hidden="true" />
      <p className="text-sm text-gray-700 max-w-md">
        {refused ? message : <>This could not be loaded. {message}</>}
      </p>
      {api?.requestId && <p className="text-xs text-gray-400">Reference: {api.requestId}</p>}
      {worthRetrying && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className={`mt-1 ${btn.soft}`}
        >
          <RotateCw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} aria-hidden="true" />
          {retrying ? 'Trying again…' : 'Try again'}
        </button>
      )}
    </div>
  )
}

function Note({ children, compact }) {
  return <p className={`text-sm text-gray-400 text-center px-4 ${compact ? 'py-4' : 'py-10'}`}>{children}</p>
}

/**
 * For a card or a section.
 *
 *   <DataState query={q} empty="No holidays this year.">
 *     {(holidays) => <List items={holidays} />}
 *   </DataState>
 *
 * `empty` may be words or an element; leave it out and an empty answer goes
 * to the children, for screens that draw their own. `isEmpty` decides what
 * counts as empty when the data is not a plain list.
 *
 * `keepOnRefetchError`, for a screen that asks again on its own (a roster that
 * refreshes every minute): when asking again fails, the last answer stays, under
 * a line that says it could not be refreshed and offers to try again — a dropped
 * connection for a moment does not take the page, or a Check In button on it,
 * away (9 Oct 2026). The first answer failing is still the error above.
 */
export default function DataState({ query, queries, empty, isEmpty = emptyByDefault, loading = 'Loading…', compact = false, keepOnRefetchError = false, children }) {
  const state = stateOf(query, queries, keepOnRefetchError)

  if (state.status === 'error') return <QueryError error={state.error} onRetry={state.retry} retrying={state.retrying} compact={compact} />
  if (state.status === 'loading') return <Note compact={compact}>{loading}</Note>
  if (state.status === 'idle') return null
  if (empty !== undefined && isEmpty(state.data)) return typeof empty === 'string' ? <Note compact={compact}>{empty}</Note> : empty
  const content = typeof children === 'function' ? children(state.data) : children
  const stale = keepOnRefetchError && (queries ?? [query]).filter((q) => q?.isError)
  if (!stale?.length) return content
  return (
    <>
      <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-100 text-xs text-amber-800">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        Could not refresh — showing the last update.
        <button type="button" onClick={() => stale.forEach((q) => q.refetch())} disabled={stale.some((q) => q.isFetching)} className="font-semibold underline underline-offset-2 disabled:no-underline disabled:opacity-60">
          {stale.some((q) => q.isFetching) ? 'Trying again…' : 'Try again'}
        </button>
      </p>
      {content}
    </>
  )
}

/**
 * The same, inside a table's <tbody>: loading, the error and the empty state
 * each take one full-width row, so the header stays where it is.
 */
export function DataRows({ query, queries, colSpan, empty, isEmpty = emptyByDefault, loading = 'Loading…', children }) {
  const state = stateOf(query, queries)
  const row = (content) => (
    <tr>
      <td colSpan={colSpan} className="p-0">{content}</td>
    </tr>
  )

  if (state.status === 'error') return row(<QueryError error={state.error} onRetry={state.retry} retrying={state.retrying} />)
  if (state.status === 'loading') return row(<Note>{loading}</Note>)
  if (state.status === 'idle') return null
  if (empty !== undefined && isEmpty(state.data)) return row(typeof empty === 'string' ? <Note>{empty}</Note> : empty)
  return typeof children === 'function' ? children(state.data) : children
}
