import { useEffect, useState, Suspense } from 'react'
import { Outlet, useLocation, Navigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import BottomNav from './BottomNav'
import MobileMenu from './MobileMenu'
import CommandPalette from './CommandPalette'
import ErrorBoundary from './ErrorBoundary'
import { useAuthStore } from '../stores/authStore'
import { PAGE_TITLES } from '../config/navigation'

/**
 * Every signed-in page: the white bar across the top, the narrow menu on the
 * left (a tab bar along the bottom on a phone), and the page.
 */
export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const { user, loading } = useAuthStore()
  const location = useLocation()
  const queryClient = useQueryClient()

  // The browser tab names the page. A profile is under /employees/…; any
  // other address is the app's own name.
  useEffect(() => {
    const path = location.pathname
    const name = PAGE_TITLES[path] ?? (path.startsWith('/employees/') ? 'Employee' : null)
    document.title = name ? `${name} · EMS` : 'EMS — CareerMap Solutions'
  }, [location.pathname])

  // Ctrl K (⌘K on a Mac) opens search from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-canvas">
        <div className="flex flex-col items-center gap-4">
          <img src="/logo-wide.png" alt="EMS" className="h-12 w-auto" />
          <svg className="animate-spin w-6 h-6 text-brand-600" fill="none" viewBox="0 0 24 24" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <p className="text-sm text-gray-500">Loading…</p>
        </div>
      </div>
    )
  }

  if (!user) return <Navigate to="/signin" replace />

  return (
    <div className="flex flex-col h-dvh bg-canvas overflow-hidden">
      <TopBar onMenuClick={() => setMenuOpen(true)} onSearch={() => setSearchOpen(true)} />

      <div className="flex flex-1 min-h-0">
        {/* The menu, from a tablet up. */}
        <div className="hidden md:flex shrink-0">
          <Sidebar />
        </div>

        {/* Room at the foot for the phone's tab bar, which shows until md — sm:p-6 alone would take it away from 640px. */}
        <main className="flex-1 min-w-0 overflow-y-auto px-4 pt-4 sm:px-6 sm:pt-6 pb-24 md:pb-6">
          {/*
            A page that throws stays inside this box: the menu and the top bar
            go on working. Keyed on the path, so choosing another page leaves
            the broken one behind.
          */}
          <ErrorBoundary resetKey={location.pathname} onReset={() => queryClient.resetQueries()}>
            <Suspense fallback={<p className="text-sm text-gray-400 text-center py-16">Loading…</p>}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      <BottomNav onMore={() => setMenuOpen(true)} />
      {menuOpen && <MobileMenu onClose={() => setMenuOpen(false)} />}
      {searchOpen && <CommandPalette onClose={() => setSearchOpen(false)} />}
    </div>
  )
}
