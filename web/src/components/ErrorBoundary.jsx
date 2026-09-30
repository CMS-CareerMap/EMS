import { Component } from 'react'
import { AlertTriangle, RotateCw, LayoutDashboard } from 'lucide-react'

/**
 * What the screen shows when a page throws while drawing — instead of the
 * whole app going white.
 *
 * The audit found a Documents page that white-screened on one null, with no
 * boundary anywhere, so the only way out was to guess the URL of another page.
 * Now a page's crash stays inside the page: the sidebar and the top bar keep
 * working, the person is told plainly, and they can try again or leave.
 *
 * Two kinds of crash, told apart because the cure differs:
 *
 *   a new version   After a deploy the old page's code files are gone from the
 *                   server, so opening a page not visited yet fails to load
 *                   its chunk. Trying again cannot help; reloading gets the new
 *                   version. That is said in those words.
 *   anything else   A fault in the page. "Try again" draws it afresh (a
 *                   passing bad answer may have gone); the details go to the
 *                   browser console for whoever is asked to look.
 *
 * `resetKey` clears the error when it changes — Layout passes the path, so
 * moving to another page from the sidebar leaves the broken one behind.
 *
 * `onReset` runs before "Try again" draws the page afresh. Layout uses it to
 * throw away every cached answer — the broken page is unmounted, so its query
 * is no longer "active" — or the page would be handed the very same answer
 * and break again.
 */

/** Vite's and the browsers' words for a code file that could not be fetched. */
function isStaleChunk(error) {
  const message = String(error?.message ?? error ?? '')
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|ChunkLoadError/i.test(message)
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // The one place a console line is the right tool: the person sees plain
    // words, and whoever debugs it needs the stack.
    console.error('A page failed to draw', error, info?.componentStack)
  }

  componentDidUpdate(previous) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const stale = isStaleChunk(error)
    const whole = this.props.whole ?? false

    return (
      <div role="alert" className={`flex items-center justify-center px-4 ${whole ? 'min-h-screen bg-[#F8FAFC]' : 'py-16'}`}>
        <div className="max-w-md w-full bg-white border border-gray-200 rounded-2xl shadow-sm p-6 text-center space-y-3">
          <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto" aria-hidden="true" />
          <h2 className="text-base font-semibold text-gray-900">
            {stale ? 'A new version of EMS is available' : 'This page ran into a problem'}
          </h2>
          <p className="text-sm text-gray-600">
            {stale
              ? 'The app was updated while this tab was open. Reload to get the new version — nothing you saved is lost.'
              : 'Something on this page failed to show. Nothing was saved or changed by it. Try again, or go back to the dashboard.'}
          </p>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            {stale ? (
              <button type="button" onClick={() => window.location.reload()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
                <RotateCw className="w-4 h-4" aria-hidden="true" /> Reload
              </button>
            ) : (
              <button type="button" onClick={() => { this.props.onReset?.(); this.setState({ error: null }) }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
                <RotateCw className="w-4 h-4" aria-hidden="true" /> Try again
              </button>
            )}
            {/* A plain link, not the router: if the app itself is what broke, a full load is the way out. */}
            <a href="/dashboard"
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50">
              <LayoutDashboard className="w-4 h-4" aria-hidden="true" /> Go to the dashboard
            </a>
          </div>
        </div>
      </div>
    )
  }
}
