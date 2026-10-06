import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Eye, EyeOff, CheckCircle, AlertCircle, KeyRound } from 'lucide-react'
import { changePassword } from '../api/auth'
import { useAuthStore } from '../stores/authStore'
import MyBankAccount from '../features/payroll/MyBankAccount'
import MyEmployment from '../features/employees/MyEmployment'
import MyDetails from '../features/requests/MyDetails'
import { useMyDashboardStats } from '../hooks/useDashboard'
import { roleLabel } from '../lib/roles'
import { passwordSetterName } from '../lib/logins'
import DataState from '../components/DataState'
import ProfileCover from '../components/ui/ProfileCover'
import { TabPanel } from '../components/ui/Tabs'
import { Card, Chip } from '../components/ui/bits'
import { btn, field } from '../components/ui/styles'
import { formatDay } from '../lib/dates'

/**
 * My Profile — who is signed in, what HR holds about them, their employment,
 * their salary account and their password. A page of its own (it was a
 * drawer), opened from the user menu.
 */
export default function MyProfile() {
  const { user, profile, role, roleName, can } = useAuthStore()
  const [params, setParams] = useSearchParams()

  // The session carries who somebody is, not their HR record. Department,
  // designation, joining date, phone and manager come from their own summary
  // — only for a role that may open its own dashboard (since Day 21 one can be
  // made without).
  const mine = useMyDashboardStats({ enabled: Boolean(profile) && can('dashboard:read') })
  const details = !mine.isError && mine.data?.profile ? { ...profile, ...mine.data.profile } : profile

  const tabs = [
    { key: 'about', label: 'About me' },
    ...(profile ? [{ key: 'details', label: 'My details' }, { key: 'employment', label: 'My employment' }] : []),
    // A salary account belongs to an employee record; a login without one has none to show or send.
    ...(profile && can('payslip:read') ? [{ key: 'bank', label: 'Salary account' }] : []),
    { key: 'password', label: 'Password' },
  ]
  const tab = tabs.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'about'
  const setTab = (key) => setParams({ tab: key }, { replace: true })

  const displayName = profile?.full_name || user?.email?.split('@')[0] || 'User'
  const displayRole = roleLabel(role, roleName) || 'User'

  return (
    <div className="space-y-4">
      <ProfileCover
        name={displayName}
        line={[details?.designation, details?.department, profile?.employee_id && `#${profile.employee_id}`].filter(Boolean).join(' · ') || user?.email}
        chips={<Chip tone="brand" dot={false}>{displayRole}</Chip>}
        tabs={tabs} tab={tab} onTab={setTab} panelId="my-profile-panel"
      />

      <TabPanel id="my-profile-panel" tab={tabs.length > 1 ? tab : null}>
      {tab === 'about' && (
        <Card title="Personal & employment details">
          <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
            <Fact label="Full name" value={displayName} />
            {profile && <Fact label="Employee ID" value={profile.employee_id} mono />}
            <Fact label="Email address" value={profile?.email || user?.email} />
            <Fact label="System role" value={displayRole} />
            {/* What HR holds comes from the summary, not the session: shown together, or the error in their place. */}
            {profile && (
              <DataState query={mine} compact>
                {() => (
                  <>
                    <Fact label="Phone number" value={details?.phone} />
                    <Fact label="Department" value={details?.department} />
                    <Fact label="Designation" value={details?.designation} />
                    <Fact label="Date of joining" value={details?.date_of_joining ? formatDay(details.date_of_joining) : null} />
                    <Fact label="Reporting manager" value={details?.reporting_manager_name
                      ? `${details.reporting_manager_name}${details.reporting_manager_designation ? ` · ${details.reporting_manager_designation}` : ''}`
                      : 'None'} />
                  </>
                )}
              </DataState>
            )}
          </dl>
          {!profile && (
            <p className="mt-4 text-xs text-gray-500">
              This login has no employee record, so it has no employment details, payslips or salary account.
            </p>
          )}
        </Card>
      )}

      {tab === 'details' && profile && <Card><MyDetails /></Card>}
      {tab === 'employment' && profile && <Card><MyEmployment /></Card>}
      {tab === 'bank' && profile && <Card><MyBankAccount /></Card>}
      {tab === 'password' && <PasswordCard />}
      </TabPanel>
    </div>
  )
}

function Fact({ label, value, mono = false }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold text-gray-500">{label}</dt>
      <dd className={`text-sm font-semibold text-gray-900 mt-0.5 wrap-break-word ${mono ? 'font-mono' : ''}`}>{value || 'Not recorded'}</dd>
    </div>
  )
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
  return { score: 4, label: 'Strong', color: 'bg-emerald-500', textColor: 'text-emerald-600' }
}

function PasswordCard() {
  const setSession = useAuthStore((state) => state.setSession)
  // Whose this login's password is (Settings → Passwords): the company's — set
  // by HR or the Super Admin — or the person's own to change.
  const own = useAuthStore((state) => state.passwords.own)
  const kind = useAuthStore((state) => state.passwords.kind)
  const minLength = useAuthStore((state) => state.passwords.rules.passwordMinLength)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [show, setShow] = useState({ current: false, next: false, confirm: false })
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState(null) // { type: 'success' | 'error', message }

  const strength = getPasswordStrength(newPassword)
  const reset = () => {
    setCurrentPassword(''); setNewPassword(''); setConfirmPassword('')
    setShow({ current: false, next: false, confirm: false }); setNotice(null)
  }

  async function handleUpdatePassword(e) {
    e.preventDefault()
    setNotice(null)
    if (!currentPassword) return setNotice({ type: 'error', message: 'Please enter your current password.' })
    if (!newPassword || newPassword.length < minLength) return setNotice({ type: 'error', message: `New password must be at least ${minLength} characters.` })
    if (newPassword !== confirmPassword) return setNotice({ type: 'error', message: 'New password and confirm password do not match.' })

    setLoading(true)
    try {
      // The server requires the current password, ends every other session and
      // returns a fresh one, so this tab stays signed in and any other device
      // is pushed out. The security notice in the bell is written by the server.
      const session = await changePassword(currentPassword, newPassword)
      setSession(session)
      setNotice({ type: 'success', message: 'Password updated. Other devices have been signed out.' })
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('')
    } catch (err) {
      setNotice({ type: 'error', message: err.message || 'An error occurred.' })
    } finally {
      setLoading(false)
    }
  }

  const input = (key, value, set, placeholder, invalid = false) => (
    <div className="relative">
      <input type={show[key] ? 'text' : 'password'} value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder}
        className={`w-full pr-10 ${field} ${invalid ? 'border-red-400 bg-red-50/50' : ''}`} />
      <button type="button" onClick={() => setShow((s) => ({ ...s, [key]: !s[key] }))} aria-label={show[key] ? 'Hide password' : 'Show password'}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
        {show[key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  )

  // Not theirs to change: said plainly, with who does — instead of a form the server would refuse.
  if (own === 'company') {
    const who = passwordSetterName(kind)
    return (
      <Card title="Password" subtitle="Your password is set for you.">
        <div className="flex items-start gap-2.5 p-3 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-700 max-w-xl">
          <KeyRound className="w-4 h-4 shrink-0 mt-0.5 text-gray-500" aria-hidden="true" />
          <p>
            At this company {who} sets your password, and you cannot change it here. If you have forgotten it, or think
            somebody else knows it, ask {who} to set a new one. You will be signed out everywhere and told in the app.
          </p>
        </div>
      </Card>
    )
  }

  return (
    <Card title="Edit password" subtitle={`At least ${minLength} characters. Changing it signs out your other devices.`}>
      <form onSubmit={handleUpdatePassword} className="space-y-4 max-w-md">
        {notice && (
          <div className={`flex items-start gap-2.5 p-3 rounded-xl border text-xs leading-relaxed ${notice.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700'}`}>
            {notice.type === 'success' ? <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
            <span className="flex-1 font-medium">{notice.message}</span>
          </div>
        )}
        <label className="block space-y-1.5">
          <span className="text-xs font-semibold text-gray-600">Current Password</span>
          {input('current', currentPassword, setCurrentPassword, 'Enter current password')}
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-semibold text-gray-600">New Password</span>
          {input('next', newPassword, setNewPassword, 'Enter new password')}
          {newPassword && (
            <span className="block space-y-1 pt-1">
              <span className="flex items-center justify-between text-[11px]">
                <span className="text-gray-400">Password Strength:</span>
                <span className={`font-semibold ${strength.textColor}`}>{strength.label}</span>
              </span>
              <span className="grid grid-cols-4 gap-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                {[1, 2, 3, 4].map((step) => <span key={step} className={`h-full ${step <= strength.score ? strength.color : 'bg-gray-200'}`} />)}
              </span>
            </span>
          )}
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-semibold text-gray-600">Confirm New Password</span>
          {input('confirm', confirmPassword, setConfirmPassword, 'Confirm new password', Boolean(confirmPassword) && confirmPassword !== newPassword)}
          {confirmPassword && confirmPassword !== newPassword && <span className="block text-[11px] text-red-500">Passwords do not match</span>}
        </label>
        <div className="flex items-center gap-2 pt-1">
          <button type="button" onClick={reset} className={btn.secondary}>Cancel</button>
          <button type="submit" disabled={loading} className={btn.primary}>
            {loading ? 'Updating…' : <><KeyRound className="w-4 h-4" aria-hidden="true" />Update Password</>}
          </button>
        </div>
      </form>
    </Card>
  )
}

