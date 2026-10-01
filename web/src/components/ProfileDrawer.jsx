import { useState } from 'react'
import {
  X, User, Mail, Phone, Building2, Briefcase, ShieldCheck,
  Calendar, UserCheck, KeyRound, Eye, EyeOff, CheckCircle, AlertCircle, Hash,
} from 'lucide-react'
import { changePassword } from '../api/auth'
import { useAuthStore } from '../stores/authStore'
import MyBankAccount from '../features/payroll/MyBankAccount'
import { useEscape } from '../hooks/useEscape'
import { useMyDashboardStats } from '../hooks/useDashboard'
import { roleLabel } from '../lib/roles'
import DataState from './DataState'
import { formatDay } from '../lib/dates'

function formatDate(str) {
  return str ? formatDay(str) : 'N/A'
}

function getPasswordStrength(password) {
  if (!password) return { score: 0, label: '', color: 'bg-gray-200' }

  let score = 0
  if (password.length >= 6) score += 1
  if (password.length >= 8) score += 1
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1
  if (/[0-9]/.test(password) || /[^A-Za-z0-9]/.test(password)) score += 1

  if (score <= 1) return { score: 1, label: 'Weak', color: 'bg-red-500', textColor: 'text-red-600' }
  if (score <= 3) return { score: 2, label: 'Medium', color: 'bg-amber-500', textColor: 'text-amber-600' }
  return { score: 4, label: 'Strong', color: 'bg-green-500', textColor: 'text-green-600' }
}

export default function ProfileDrawer() {
  const { user, profile, role, roleName, profileDrawerOpen, setProfileDrawerOpen, setSession, can } = useAuthStore()
  // The session carries who somebody is, not their HR record. Department,
  // designation, joining date, phone and manager come from their own summary,
  // asked for only when the drawer is open — so the rows show what HR holds
  // instead of "N/A" for things that are on file.
  const mine = useMyDashboardStats({ enabled: profileDrawerOpen && Boolean(profile) })
  const details = !mine.isError && mine.data?.profile ? { ...profile, ...mine.data.profile } : profile

  // Form states
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // Show/Hide password toggles
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  // Status state
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState(null) // { type: 'success' | 'error', message: string }


  // Escape closes the drawer — unless a dialog is open on top of it (sending
  // in a bank account), which closes first.
  useEscape(() => {
    if (profileDrawerOpen) handleClose()
  })

  if (!profileDrawerOpen) return null

  function handleClose() {
    resetForm()
    setProfileDrawerOpen(false)
  }

  function resetForm() {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setShowCurrent(false)
    setShowNew(false)
    setShowConfirm(false)
    setToast(null)
  }

  const strength = getPasswordStrength(newPassword)

  async function handleUpdatePassword(e) {
    e.preventDefault()
    setToast(null)

    if (!currentPassword) {
      setToast({ type: 'error', message: 'Please enter your current password.' })
      return
    }

    if (!newPassword || newPassword.length < 10) {
      setToast({ type: 'error', message: 'New password must be at least 10 characters.' })
      return
    }

    if (newPassword !== confirmPassword) {
      setToast({ type: 'error', message: 'New password and confirm password do not match.' })
      return
    }

    setLoading(true)

    try {
      // The old path changed it through the hosted auth service, which did
      // NOT verify the current password — it only needed a valid session. So
      // anyone at an unlocked laptop could change the password and lock the
      // owner out. The server endpoint requires the current password, and the
      // field above was collected and then thrown away.
      //
      // It also ends every other session and returns a fresh one, so this tab
      // stays signed in and any other device is pushed out.
      const session = await changePassword(currentPassword, newPassword)
      setSession(session)

      // The security notice in the bell is written by the server now — for a
      // change made from any device, not just this page.
      setToast({ type: 'success', message: 'Password updated. Other devices have been signed out.' })

      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'An error occurred.' })
    } finally {
      setLoading(false)
    }
  }

  const displayName = profile?.full_name || user?.email?.split('@')[0] || 'User'
  const displayRole = roleLabel(role, roleName) || 'Employee'
  const initials = displayName
    .split(' ')
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase()

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">

      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm transition-opacity"
        onClick={handleClose}
      />

      {/* Drawer Panel */}
      <div className="fixed inset-y-0 right-0 max-w-full flex pl-10">
        <div className="w-screen max-w-md bg-white shadow-2xl flex flex-col z-50">

          {/* Header */}
          <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between bg-white shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-blue-50 text-blue-600">
                <User className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-gray-900 leading-none">My Profile</h2>
                <p className="text-xs text-gray-500 mt-1">Personal information & account settings</p>
              </div>
            </div>
            <button
              onClick={handleClose}
              className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Scrollable Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">

            {/* Profile Avatar Card */}
            <div className="bg-linear-to-r from-blue-600 to-blue-700 rounded-2xl p-6 text-white flex items-center gap-4 shadow-sm">
              <div className="w-16 h-16 rounded-full bg-white/20 border-2 border-white/40 flex items-center justify-center shrink-0">
                <span className="text-2xl font-bold text-white">{initials}</span>
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-xl font-bold text-white truncate">{displayName}</h3>
                <p className="text-blue-100 text-sm truncate mt-0.5">{details?.designation ?? ''}</p>
                <div className="flex items-center gap-2 mt-2">
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-white/20 text-white border border-white/30">
                    {displayRole}
                  </span>
                  {profile?.employee_id && (
                    <span className="text-xs text-blue-200 font-mono">
                      #{profile.employee_id}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Personal Information Section */}
            <div className="space-y-3">
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Personal & Employment Details
              </h4>
              <div className="bg-gray-50 rounded-xl p-4 divide-y divide-gray-200/60 border border-gray-100">

                <div className="py-2.5 flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2.5 text-gray-500">
                    <User className="w-4 h-4 text-blue-500" />
                    <span>Full Name</span>
                  </div>
                  <span className="font-medium text-gray-900">{displayName}</span>
                </div>

                {profile && (
                  <>
                <div className="py-2.5 flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2.5 text-gray-500">
                    <Hash className="w-4 h-4 text-blue-500" />
                    <span>Employee ID</span>
                  </div>
                  <span className="font-mono font-medium text-gray-900">{profile?.employee_id || 'N/A'}</span>
                </div>
                  </>
                )}

                <div className="py-2.5 flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2.5 text-gray-500">
                    <Mail className="w-4 h-4 text-blue-500" />
                    <span>Email Address</span>
                  </div>
                  <span className="font-medium text-gray-900 truncate max-w-50" title={profile?.email || user?.email}>
                    {profile?.email || user?.email || 'N/A'}
                  </span>
                </div>

                <div className="py-2.5 flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2.5 text-gray-500">
                    <ShieldCheck className="w-4 h-4 text-blue-500" />
                    <span>System Role</span>
                  </div>
                  <span className="font-medium text-gray-900">{displayRole}</span>
                </div>

                {/* What HR holds comes from the summary, not the session: shown together, or the error in their place. */}
                {profile && (
                  <DataState query={mine} compact>
                    {() => (
                      <>
                        <div className="py-2.5 flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2.5 text-gray-500">
                            <Phone className="w-4 h-4 text-blue-500" />
                            <span>Phone Number</span>
                          </div>
                          <span className="font-medium text-gray-900">{details?.phone || 'N/A'}</span>
                        </div>

                        <div className="py-2.5 flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2.5 text-gray-500">
                            <Building2 className="w-4 h-4 text-blue-500" />
                            <span>Department</span>
                          </div>
                          <span className="font-medium text-gray-900">{details?.department || 'N/A'}</span>
                        </div>

                        <div className="py-2.5 flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2.5 text-gray-500">
                            <Briefcase className="w-4 h-4 text-blue-500" />
                            <span>Designation</span>
                          </div>
                          <span className="font-medium text-gray-900">{details?.designation || 'N/A'}</span>
                        </div>

                        <div className="py-2.5 flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2.5 text-gray-500">
                            <Calendar className="w-4 h-4 text-blue-500" />
                            <span>Date of Joining</span>
                          </div>
                          <span className="font-medium text-gray-900">{formatDate(details?.date_of_joining)}</span>
                        </div>

                        <div className="py-2.5 flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2.5 text-gray-500">
                            <UserCheck className="w-4 h-4 text-blue-500" />
                            <span>Reporting Manager</span>
                          </div>
                          <span className="font-medium text-gray-900 text-right">
                            {details?.reporting_manager_name ? (
                              <>
                                {details.reporting_manager_name}
                                {details.reporting_manager_designation && (
                                  <span className="block text-xs text-gray-400 font-normal">
                                    {details.reporting_manager_designation}
                                  </span>
                                )}
                              </>
                            ) : (
                              'None'
                            )}
                          </span>
                        </div>
                      </>
                    )}
                  </DataState>
                )}

              </div>
              {!profile && (
                <p className="mt-2 text-xs text-gray-500">
                  This login has no employee record, so it has no employment details, payslips or salary account.
                </p>
              )}
            </div>

            {/* Divider */}
            <hr className="border-gray-100" />

            {/* Bank Account for Salary Credit Section */}
            {/* A salary account belongs to an employee record; a login without one has none to show or send. */}
            {can('payslip:read') && profile && <MyBankAccount />}

            {/* Divider */}
            <hr className="border-gray-100" />

            {/* Edit Password Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-blue-600" />
                <h4 className="text-sm font-bold text-gray-900">Edit Password</h4>
              </div>

              {/* Toast / Notification */}
              {toast && (
                <div
                  className={`flex items-start gap-2.5 p-3 rounded-xl border text-xs leading-relaxed transition-all ${toast.type === 'success'
                    ? 'bg-green-50 border-green-200 text-green-700'
                    : 'bg-red-50 border-red-200 text-red-700'
                    }`}
                >
                  {toast.type === 'success' ? (
                    <CheckCircle className="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                  )}
                  <span className="flex-1 font-medium">{toast.message}</span>
                </div>
              )}

              <form onSubmit={handleUpdatePassword} className="space-y-3.5">

                {/* Current Password */}
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-600">Current Password</label>
                  <div className="relative">
                    <input
                      type={showCurrent ? 'text' : 'password'}
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      placeholder="Enter current password"
                      className="w-full border border-gray-300 rounded-lg pl-3 pr-10 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCurrent(!showCurrent)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showCurrent ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                {/* New Password */}
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-600">New Password</label>
                  <div className="relative">
                    <input
                      type={showNew ? 'text' : 'password'}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Enter new password"
                      className="w-full border border-gray-300 rounded-lg pl-3 pr-10 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNew(!showNew)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showNew ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  {/* Password Strength Meter */}
                  {newPassword && (
                    <div className="space-y-1 pt-1">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-gray-400">Password Strength:</span>
                        <span className={`font-semibold ${strength.textColor}`}>{strength.label}</span>
                      </div>
                      <div className="grid grid-cols-4 gap-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        {[1, 2, 3, 4].map((step) => (
                          <div
                            key={step}
                            className={`h-full transition-colors ${step <= strength.score ? strength.color : 'bg-gray-200'
                              }`}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Confirm New Password */}
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-600">Confirm New Password</label>
                  <div className="relative">
                    <input
                      type={showConfirm ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Confirm new password"
                      className={`w-full border rounded-lg pl-3 pr-10 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 ${confirmPassword && confirmPassword !== newPassword ? 'border-red-400 bg-red-50/50' : 'border-gray-300'
                        }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirm(!showConfirm)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showConfirm ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  {confirmPassword && confirmPassword !== newPassword && (
                    <p className="text-[11px] text-red-500 mt-0.5">Passwords do not match</p>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="px-3.5 py-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 text-xs font-medium transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-xs font-medium transition-colors flex items-center gap-1.5"
                  >
                    {loading ? (
                      <>
                        <svg className="animate-spin w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                        </svg>
                        <span>Updating…</span>
                      </>
                    ) : (
                      <span>Update Password</span>
                    )}
                  </button>
                </div>

              </form>
            </div>

          </div>

        </div>
      </div>

    </div>
  )
}
