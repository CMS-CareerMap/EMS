import { useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { Eye, EyeOff, Lock, Mail, AlertCircle, CheckCircle2 } from 'lucide-react'
import { login } from '../api/auth'
import { useAuthStore } from '../stores/authStore'
import AuthShell from '../components/AuthShell'
import { btn } from '../components/ui/styles'

const inputCls = 'w-full h-11 border border-gray-200 rounded-[10px] pl-10 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500'

export default function SignIn() {
  const { user, loading, setSession } = useAuthStore()

  // Set by the set-password page, so the person lands here with their address
  // filled in and told what just happened.
  const passwordSetFor = useLocation().state?.passwordSetFor ?? ''

  const [email, setEmail] = useState(passwordSetFor)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // Already signed in — send them on. After the hooks, never before.
  if (!loading && user) return <Navigate to="/dashboard" replace />

  async function handleSignIn(e) {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      // One field, one request. The server turns an employee code into the
      // account behind the password check, so an unknown code reads exactly
      // like a wrong password — the sign-in page never reads the directory.
      const session = await login(email.trim(), password)
      setSession(session)
    } catch (err) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  function handleForgotPassword() {
    // There is no self-service reset: an administrator issues a reset link
    // from Settings → Users. Say that, rather than show a button that looks
    // like it sent something.
    setError('Ask your administrator for a password reset link. They can create one from Settings → Users.')
  }

  return (
    <AuthShell>
      <h2 className="text-2xl font-extrabold tracking-tight text-gray-900">Welcome back</h2>
      <p className="text-sm text-gray-500 mt-1 mb-7">Sign in to your account to continue</p>

      <form onSubmit={handleSignIn} className="space-y-4">
        {passwordSetFor && !error && (
          <div className="flex items-start gap-3 p-3 rounded-[10px] bg-emerald-50 border border-emerald-200">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
            <p className="text-sm text-emerald-800">Password saved. Sign in with it now.</p>
          </div>
        )}

        {error && (
          <div role="alert" className="flex items-start gap-3 p-3 rounded-[10px] bg-red-50 border border-red-200">
            <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        <label className="block space-y-1.5">
          <span className="text-[13px] font-semibold text-gray-700">Work Email or Employee ID</span>
          <span className="relative block">
            <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
            <input type="text" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="Your work email or employee ID" className={inputCls} />
          </span>
          {/* An Employee ID names a person; somebody with two logins (Day 23) picks one by its email. */}
          <span className="block text-xs text-gray-400">Have two logins? Sign in with the email of the one you want.</span>
        </label>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="signin-password" className="text-[13px] font-semibold text-gray-700">Password</label>
            <button type="button" onClick={handleForgotPassword} className="text-xs text-brand-600 hover:text-brand-800 font-semibold">
              Forgot password?
            </button>
          </div>
          <div className="relative">
            <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
            <input id="signin-password" type={showPassword ? 'text' : 'password'} required autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" className={`${inputCls} pr-10`} />
            <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <button type="submit" disabled={submitting} className={`${btn.gradient} w-full h-11! text-sm! mt-2`}>
          {submitting ? (
            <>
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Signing in…
            </>
          ) : 'Sign In'}
        </button>
      </form>

      <p className="text-xs text-gray-400 text-center mt-7 leading-relaxed">
        Access is restricted to CareerMap Solutions employees.<br />
        Contact HR if you need assistance.
      </p>
    </AuthShell>
  )
}
