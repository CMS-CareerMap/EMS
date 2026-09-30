import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Eye, EyeOff, Lock, AlertCircle, Loader2, KeyRound } from 'lucide-react'
import { inspectPasswordLink, redeemPasswordLink } from '../api/auth'

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

/** The server's rule, repeated only as a hint. The server decides. */
const MIN_LENGTH = 10

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

    if (password.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters.`)
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
      navigate('/signin', { replace: true, state: { passwordSetFor: result.email } })
    } catch (err) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  const isReset = link?.purpose === 'reset'

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[#F8FAFC]" style={{ fontFamily: 'Inter, sans-serif' }}>
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-8">
          <img src="/logo.png" alt="CareerMap Solutions" className="w-[50%] max-w-80 object-contain" />
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
          {checking && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Checking your link…
            </div>
          )}

          {!checking && linkError && (
            <div className="space-y-6">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-red-50 border border-red-200">
                <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                <p className="text-sm text-red-600">{linkError}</p>
              </div>
              <Link to="/signin" className="block text-center text-sm font-medium text-blue-600 hover:text-blue-800">
                Go to sign in
              </Link>
            </div>
          )}

          {!checking && link && (
            <>
              <div className="mb-8 text-center lg:text-left">
                <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center mb-4 mx-auto lg:mx-0">
                  <KeyRound className="w-5 h-5 text-blue-600" />
                </div>
                <h2 className="text-2xl font-bold text-gray-900">
                  {isReset ? 'Choose a new password' : 'Set your password'}
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  For <span className="font-medium text-gray-700">{link.email}</span>
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-5">
                {error && (
                  <div className="flex items-start gap-3 p-3 rounded-lg bg-red-50 border border-red-200">
                    <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                    <p className="text-sm text-red-600">{error}</p>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-gray-600">New password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={`At least ${MIN_LENGTH} characters`}
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

                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-gray-600">Type it again</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      autoComplete="new-password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      placeholder="The same password"
                      className="w-full border border-gray-300 rounded-lg pl-10 pr-3 py-2.5 text-sm
                        focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                        placeholder:text-gray-400 text-gray-900"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white
                    px-4 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center
                    justify-center gap-2 mt-2"
                >
                  {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : 'Save password'}
                </button>
              </form>

              <p className="text-xs text-gray-400 text-center mt-6 leading-relaxed">
                This link works once. After saving, sign in with the password you chose.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
