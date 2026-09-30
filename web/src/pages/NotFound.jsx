import { Link, useLocation } from 'react-router-dom'
import { Compass } from 'lucide-react'

/**
 * An address that is not a page. Signed in, it is said plainly with a way back;
 * the old app sent every unknown address to the sign-in screen, which read as
 * "you have been signed out" to somebody who had only mistyped.
 */
export default function NotFound() {
  const { pathname } = useLocation()
  return (
    <div className="flex items-center justify-center py-16 px-4">
      <div className="max-w-md w-full bg-white border border-gray-200 rounded-2xl shadow-sm p-6 text-center space-y-3">
        <Compass className="w-8 h-8 text-blue-500 mx-auto" aria-hidden="true" />
        <h2 className="text-base font-semibold text-gray-900">There is no page here</h2>
        <p className="text-sm text-gray-600 break-words">
          Nothing in EMS lives at <span className="font-mono text-gray-800">{pathname}</span>. The link may be old, or mistyped.
        </p>
        <Link to="/dashboard" className="inline-block px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
          Go to the dashboard
        </Link>
      </div>
    </div>
  )
}
