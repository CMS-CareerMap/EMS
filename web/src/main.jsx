import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import {
  QueryClient,
  QueryClientProvider,
  QueryCache,
  MutationCache,
} from '@tanstack/react-query'
import { Toaster, toast } from 'sonner'
import './index.css'
import App from './App.jsx'
import { ApiError } from './api/http'

/**
 * The default error handler for every query and mutation in the app.
 *
 * The audit's finding was that this codebase had ZERO onError handlers — not
 * too few, none. A failed save looked exactly like a successful one: the modal
 * closed, the toast never came, and the user found out a week later that the
 * employee they added was not there.
 *
 * Registering it on the CACHE rather than per-hook is what makes that
 * impossible to repeat. A new hook written next month is covered without anyone
 * remembering to cover it, and a page that wants special handling adds its own
 * on top rather than being the only thing standing between an error and silence.
 */
function reportError(error) {
  // A 401 is not an error to complain about — the session simply ended, and
  // App.jsx is already sending this person to the sign-in page. A toast here
  // would just be noise on top of a redirect.
  if (error instanceof ApiError && error.isAuthError) return

  toast.error(error?.message ?? 'Something went wrong.', {
    // The request id is in every server response. When someone reports a
    // problem, this is the string that finds it in the logs.
    description: error instanceof ApiError && error.requestId
      ? `Reference: ${error.requestId}`
      : undefined,
  })
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: reportError }),
  mutationCache: new MutationCache({
    // A mutation may answer some errors itself — approving a payroll turns the
    // "confirm these days" reply into a dialog — by naming their codes in
    // meta.quietCodes. Every other error still gets the toast.
    onError: (error, _variables, _context, mutation) => {
      if (error instanceof ApiError && mutation?.options?.meta?.quietCodes?.includes(error.code)) return
      reportError(error)
    },
  }),
  defaultOptions: {
    queries: {
      /**
       * Never retry a 4xx. A 403 will not become a 200 by asking again — it
       * just delays the error by two seconds and sends three requests where
       * one would do. Server errors are worth one more try.
       */
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false
        return failureCount < 2
      },
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      // A write that failed must never be repeated automatically. Retrying a
      // payroll run or a leave approval could apply it twice.
      retry: false,
    },
  },
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <App />
        <Toaster position="top-right" richColors closeButton />
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
)
