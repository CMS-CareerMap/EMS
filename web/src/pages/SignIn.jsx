import { useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { Eye, EyeOff, Lock, Mail, AlertCircle, CheckCircle2 } from 'lucide-react'
import { login } from '../api/auth'
import { useAuthStore } from '../stores/authStore'

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
      // One field, one request.
      //
      // The old version, when the input had no @, queried the profiles table
      // from the BROWSER to turn an employee code into an email — which meant
      // the sign-in page could read the staff directory before anyone had
      // proved who they were. The server resolves it now, behind the password
      // check, and an unknown code is indistinguishable from a wrong password.
      const session = await login(email.trim(), password)
      setSession(session)
    } catch (err) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  function handleForgotPassword() {
    // There is no email in v1, so there is nothing to send. What does exist is
    // a reset link an administrator can issue from Settings → Users — so say
    // that, rather than show a button that looks like it sent something.
    setError('Ask your administrator for a password reset link. They can create one from Settings → Users.')
  }

  return (
    <div className="min-h-screen flex" style={{ fontFamily: 'Inter, sans-serif' }}>

      {/* Left Panel — Branding (Logo removed) */}
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-between p-12"
        style={{ background: 'linear-gradient(135deg, #1E40AF 0%, #2563EB 60%, #3B82F6 100%)' }}>

        {/* Empty top slot since logo is moved */}
        <div />

        {/* Center Content */}
        <div className="space-y-6">
          <div className="w-16 h-1 bg-blue-300 rounded-full" />
          <h1 className="text-4xl font-bold text-white leading-tight">
            HR & Payroll<br />Management<br />System
          </h1>
          <p className="text-blue-200 text-base leading-relaxed max-w-sm">
            Manage your workforce, attendance, leave, and payroll — all in one place.
          </p>

          {/* Feature pills */}
          <div className="flex flex-wrap gap-2 pt-2">
            {['Employee Management', 'Attendance', 'Leave', 'Payroll', 'Reports'].map((f) => (
              <span key={f}
                className="px-3 py-1 rounded-full text-xs font-medium text-white border border-blue-400"
                style={{ background: 'rgba(255,255,255,0.12)' }}>
                {f}
              </span>
            ))}
          </div>
        </div>

        {/* Bottom */}
        <p className="text-blue-300 text-xs">
          © {new Date().getFullYear()} CareerMap Solutions. Internal platform.
        </p>
      </div>

      {/* Right Panel — Login Form & Centered Logo */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-6 bg-[#F8FAFC]">
        <div className="w-full max-w-md">

          {/* Centered Logo */}
          <div className="flex justify-center mb-8">
            <img src="/logo.png" alt="CareerMap Solutions" className="w-[50%] max-w-80 object-contain" />
          </div>

          {/* Form Card */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
            <div className="mb-8 text-center lg:text-left">
              <h2 className="text-2xl font-bold text-gray-900">Welcome back</h2>
              <p className="text-sm text-gray-500 mt-1">Sign in to your account to continue</p>
            </div>

            <form onSubmit={handleSignIn} className="space-y-5">

              {passwordSetFor && !error && (
                <div className="flex items-start gap-3 p-3 rounded-lg bg-green-50 border border-green-200">
                  <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                  <p className="text-sm text-green-700">Password saved. Sign in with it now.</p>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="flex items-start gap-3 p-3 rounded-lg bg-red-50 border border-red-200">
                  <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                  <p className="text-sm text-red-600">{error}</p>
                </div>
              )}

              {/* Email or Employee ID */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-gray-600">
                  Work Email or Employee ID
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@careermap.in or EMP001"
                    className="w-full border border-gray-300 rounded-lg pl-10 pr-3 py-2.5 text-sm
                      focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                      placeholder:text-gray-400 text-gray-900"
                  />
                </div>
              </div>

              {/* Password */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-gray-600">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full border border-gray-300 rounded-lg pl-10 pr-10 py-2.5 text-sm
                      focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                      placeholder:text-gray-400 text-gray-900"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={submitting}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white
                  px-4 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center
                  justify-center gap-2 mt-2"
              >
                {submitting ? (
                  <>
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    Signing in…
                  </>
                ) : 'Sign In'}
              </button>
            </form>

            {/* Footer note */}
            <p className="text-xs text-gray-400 text-center mt-6 leading-relaxed">
              Access is restricted to CareerMap Solutions employees.<br />
              Contact HR if you need assistance.
            </p>
          </div>

        </div>
      </div>
    </div>
  )
}
