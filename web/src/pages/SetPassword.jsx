import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Eye, EyeOff, Lock, AlertCircle, Loader2, KeyRound } from 'lucide-react'
import { inspectPasswordLink, redeemPasswordLink } from '../api/auth'
import AuthShell from '../components/AuthShell'
import { btn } from '../components/ui/styles'

/**
 * Where an invitation or reset link lands.
 *
 * Until this page existed, an invited person had nowhere to go: the link was
 * issued, the account sat at "invited", and sign-in refused it for ever.
 *
 * The token is read from the URL FRAGMENT (`#token=…`), not the query string.
 * Browsers never send the fragment to a server, so it stays out of every access
 * log and every Referer header between here and the API — the only place it is
 * sent is the request body that redeems it.
 */

/**
 * The server's rule, repeated only as a hint — the company's own length when
 * the link says it (Settings → Passwords). The server decides.
 */
const MIN_LENGTH = 10

const inputCls = 'w-full h-11 border border-gray-200 rounded-[10px] pl-10 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500'

function tokenFromFragment() {
  return new URLSearchParams(window.location.hash.slice(1)).get('token') ?? ''
}

export default function SetPassword() {
  const navigate = useNavigate()
  // Read once, on arrival. Nothing on this page changes the fragment.
  const [token] = useState(tokenFromFragment)

  const [link, setLink] = useState(null)
  const [linkError, setLinkError] = useState(token ? '' : 'This link is incomplete. Open it again from the message you were sent, or ask your administrator for a new one.')
  const [checking, setChecking] = useState(Boolean(token))

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Asked before anybody types a password, so a dead link says so up front
  // instead of after the person has chosen one.
  useEffect(() => {
    if (!token) return
    let cancelled = false

    inspectPasswordLink(token)
      .then((data) => { if (!cancelled) setLink(data) })
      .catch((err) => { if (!cancelled) setLinkError(err.message) })
      .finally(() => { if (!cancelled) setChecking(false) })

    return () => { cancelled = true }
  }, [token])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    const minLength = link?.min_length ?? MIN_LENGTH
    if (password.length < minLength) {
      setError(`Use at least ${minLength} characters.`)
      return
    }
    if (password !== confirm) {
      setError('The two passwords do not match.')
      return
    }

    setSubmitting(true)
    try {
      const result = await redeemPasswordLink(token, password)
      // Not signed in automatically. Typing the new password once, straight
      // away, is how somebody finds out they chose what they meant to.
      // What they sign in with: the email, or — a login with none — the Employee ID.
      navigate('/signin', { replace: true, state: { passwordSetFor: result.email ?? link?.employee_code ?? null } })
    } catch (err) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  const isReset = link?.purpose === 'reset'

  return (
    <AuthShell>
      {checking && (
        <div className="flex items-center gap-2 py-10 text-sm text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Checking your link…
        </div>
      )}

      {!checking && linkError && (
        <div className="space-y-6">
          <div role="alert" className="flex items-start gap-3 p-3 rounded-[10px] bg-red-50 border border-red-200">
            <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
            <p className="text-sm text-red-600">{linkError}</p>
          </div>
          <Link to="/signin" className={`${btn.secondary} w-full`}>
            Go to sign in
          </Link>
        </div>
      )}

      {!checking && link && (
        <>
          <div className="mb-7">
            <div className="w-10 h-10 rounded-xl bg-brand-50 flex items-center justify-center mb-4">
              <KeyRound className="w-5 h-5 text-brand-600" />
            </div>
            <h2 className="text-2xl font-extrabold tracking-tight text-gray-900">
              {isReset ? 'Choose a new password' : 'Set your password'}
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              For <span className="font-semibold text-gray-700">{link.email ?? `Employee ID ${link.employee_code}`}</span>
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div role="alert" className="flex items-start gap-3 p-3 rounded-[10px] bg-red-50 border border-red-200">
                <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}

            <label className="block space-y-1.5">
              <span className="text-[13px] font-semibold text-gray-700">New password</span>
              <span className="relative block">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
                <input type={showPassword ? 'text' : 'password'} required autoComplete="new-password" value={password}
                  onChange={(e) => setPassword(e.target.value)} placeholder={`At least ${link?.min_length ?? MIN_LENGTH} characters`} className={`${inputCls} pr-10`} />
                <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </span>
            </label>

            <label className="block space-y-1.5">
              <span className="text-[13px] font-semibold text-gray-700">Type it again</span>
              <span className="relative block">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
                <input type={showPassword ? 'text' : 'password'} required autoComplete="new-password" value={confirm}
                  onChange={(e) => setConfirm(e.target.value)} placeholder="The same password" className={inputCls} />
              </span>
            </label>

            <button type="submit" disabled={submitting} className={`${btn.gradient} w-full h-11! text-sm! mt-2`}>
              {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : 'Save password'}
            </button>
          </form>

          <p className="text-xs text-gray-400 text-center mt-7 leading-relaxed">
            This link works once. After saving, sign in with the password you chose.
          </p>
        </>
      )}
    </AuthShell>
  )
}
