import { useState, Suspense } from 'react'
import { Outlet, useLocation, Navigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import ProfileDrawer from './ProfileDrawer'
import ErrorBoundary from './ErrorBoundary'
import { useAuthStore } from '../stores/authStore'

const PAGE_TITLES = {
  '/dashboard': 'Dashboard',
  '/employees': 'Employees',
  '/attendance': 'Attendance',
  '/leave': 'Leave Management',
  '/payroll': 'Payroll',
  '/payslips': 'My Payslips',
  '/documents': 'Documents',
  '/reports': 'Reports',
  '/settings': 'Settings',
}

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { user, loading } = useAuthStore()
  const location = useLocation()
  const queryClient = useQueryClient()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC]">
        <div className="flex flex-col items-center gap-3">
          <svg className="animate-spin w-8 h-8 text-blue-600" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <p className="text-sm text-gray-500">Loading…</p>
        </div>
      </div>
    )
  }

  if (!user) return <Navigate to="/signin" replace />

  const title = PAGE_TITLES[location.pathname] ?? 'EMS'

  return (
    <div className="flex h-screen bg-[#F8FAFC] overflow-hidden">

      {/* Sidebar — desktop (always visible) */}
      <div className="hidden lg:flex shrink-0">
        <Sidebar />
      </div>

      {/* Sidebar — mobile (overlay) */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="relative z-50 flex">
            <Sidebar mobile onClose={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopBar title={title} onMenuClick={() => setSidebarOpen(true)} />

        <main className="flex-1 overflow-y-auto p-6">
          {/*
            A page that throws stays inside this box: the sidebar and the top
            bar go on working. Keyed on the path, so choosing another page
            leaves the broken one behind.
          */}
          <ErrorBoundary resetKey={location.pathname} onReset={() => queryClient.resetQueries()}>
            <Suspense fallback={<p className="text-sm text-gray-400 text-center py-16">Loading…</p>}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      {/* Profile Drawer */}
      <ProfileDrawer />
    </div>
  )
}
