import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { restoreSession } from './api/auth'
import { onSessionEnded } from './api/http'
import { useAuthStore } from './stores/authStore'
import { ROUTE_PERMISSIONS } from './config/navigation'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import SignIn from './pages/SignIn'
import SetPassword from './pages/SetPassword'
import Dashboard from './pages/Dashboard'
import Employees from './pages/Employees'
import Attendance from './pages/Attendance'
import Leave from './pages/Leave'
import Payroll from './pages/Payroll'
import MyPayslips from './pages/MyPayslips'
import Reports from './pages/Reports'
import Documents from './pages/Documents'
import Settings from './pages/Settings'

export default function App() {
  const { setSession, clearAuth } = useAuthStore()

  useEffect(() => {
    let cancelled = false

    /**
     * On boot the access token is gone — it only ever lived in memory — but the
     * refresh cookie may still be there. One call settles it: a fresh token and
     * the current user, or a 401 meaning nobody is signed in.
     *
     * A failure here is the ordinary "not logged in" path, not an error worth
     * showing. Anything genuinely wrong surfaces on the next real request.
     */
    restoreSession()
      .then((user) => {
        if (!cancelled) setSession(user)
      })
      .catch(() => {
        if (!cancelled) clearAuth()
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

  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      {/* Public: whoever opens an invitation is, by definition, not signed in. */}
      <Route path="/set-password" element={<SetPassword />} />

      <Route element={<Layout />}>
        {/* Everyone who is signed in. */}
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
      </Route>

      <Route path="*" element={<Navigate to="/signin" replace />} />
    </Routes>
  )
}
