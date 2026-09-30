import { useEffect, useState, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { restoreSession } from './api/auth'
import { ApiError, onSessionEnded } from './api/http'
import { useAuthStore } from './stores/authStore'
import { ROUTE_PERMISSIONS } from './config/navigation'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import SignIn from './pages/SignIn'
import SetPassword from './pages/SetPassword'

/*
 * Every page past sign-in is its own file, fetched the first time it is
 * opened. The sign-in screen used to download the whole app — charts
 * included, over 100 KB of them — before anybody had typed a password. Layout
 * holds the Suspense that shows while a page arrives, and the boundary that
 * catches one that fails to.
 */
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Employees = lazy(() => import('./pages/Employees'))
const Attendance = lazy(() => import('./pages/Attendance'))
const Leave = lazy(() => import('./pages/Leave'))
const Payroll = lazy(() => import('./pages/Payroll'))
const MyPayslips = lazy(() => import('./pages/MyPayslips'))
const Reports = lazy(() => import('./pages/Reports'))
const Documents = lazy(() => import('./pages/Documents'))
const Settings = lazy(() => import('./pages/Settings'))
const NotFound = lazy(() => import('./pages/NotFound'))

export default function App() {
  const { setSession, clearAuth } = useAuthStore()
  // Set when the first refresh could not be answered at all — as opposed to
  // answered "nobody is signed in".
  const [unreachable, setUnreachable] = useState(null)

  useEffect(() => {
    let cancelled = false

    /**
     * On boot the access token is gone — it only ever lived in memory — but the
     * refresh cookie may still be there. One call settles it: a fresh token and
     * the current user, or a 401 meaning nobody is signed in.
     *
     * A refusal here is the ordinary "not logged in" path, not an error worth
     * showing. No answer at all — offline, or the server restarting during a
     * deploy — is different: sending that person to sign in would tell them
     * their session had ended when it had not. They are told the truth and
     * can try again.
     */
    restoreSession()
      .then((user) => {
        if (!cancelled) setSession(user)
      })
      .catch((error) => {
        if (cancelled) return
        // Any considered answer (401, 403) is "not signed in". No answer, a
        // server error, or the loop guard's 429 is not an answer about them.
        const answered = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429
        if (answered) clearAuth()
        else setUnreachable(error)
      })

    // Fires when a refresh fails mid-session: the cookie expired, or the
    // server revoked the family because a token was reused. Either way this
    // person is no longer signed in, and the guard in Layout sends them out.
    const stopListening = onSessionEnded(() => clearAuth())

    return () => {
      cancelled = true
      stopListening()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (unreachable) {
    return (
      <div role="alert" className="min-h-screen flex items-center justify-center bg-[#F8FAFC] px-4">
        <div className="max-w-md w-full bg-white border border-gray-200 rounded-2xl shadow-sm p-6 text-center space-y-3">
          <h1 className="text-base font-semibold text-gray-900">EMS cannot be reached right now</h1>
          <p className="text-sm text-gray-600">{unreachable.message || 'The server did not answer.'} Nothing has been lost, and you are still signed in.</p>
          <button type="button" onClick={() => window.location.reload()}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
            Try again
          </button>
        </div>
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      {/* Public: whoever opens an invitation is, by definition, not signed in. */}
      <Route path="/set-password" element={<SetPassword />} />

      <Route element={<Layout />}>
        {/* Everyone who is signed in. */}
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />

        {/*
          Routes are gated on PERMISSIONS, not role names, and the permission
          for each path comes from config/navigation.js — the same list the
          sidebar renders from. One source, so a link can never be visible and
          unreachable, or hidden and reachable.

          This only decides what is rendered. Every endpoint re-checks on the
          server, so a user who edits their own permission list in a console
          gets a page that returns 403 from every call it makes.
        */}
        <Route element={<ProtectedRoute permission={ROUTE_PERMISSIONS['/employees']} />}>
          <Route path="/employees" element={<Employees />} />
        </Route>

        <Route element={<ProtectedRoute permission={ROUTE_PERMISSIONS['/attendance']} />}>
          <Route path="/attendance" element={<Attendance />} />
        </Route>

        <Route element={<ProtectedRoute permission={ROUTE_PERMISSIONS['/leave']} />}>
          <Route path="/leave" element={<Leave />} />
        </Route>

        <Route element={<ProtectedRoute permission={ROUTE_PERMISSIONS['/payroll']} />}>
          <Route path="/payroll" element={<Payroll />} />
        </Route>

        <Route element={<ProtectedRoute permission={ROUTE_PERMISSIONS['/payslips']} />}>
          <Route path="/payslips" element={<MyPayslips />} />
        </Route>

        <Route element={<ProtectedRoute permission={ROUTE_PERMISSIONS['/documents']} />}>
          <Route path="/documents" element={<Documents />} />
        </Route>

        <Route element={<ProtectedRoute permission={ROUTE_PERMISSIONS['/reports']} />}>
          <Route path="/reports" element={<Reports />} />
        </Route>

        <Route element={<ProtectedRoute permission={ROUTE_PERMISSIONS['/settings']} />}>
          <Route path="/settings" element={<Settings />} />
        </Route>

        {/*
          Any other address. Inside Layout, so somebody signed out is still
          sent to sign in (Layout's guard), and somebody signed in is told the
          page does not exist rather than being shown the sign-in screen.
        */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
