import { useState } from 'react'
import { toast } from 'sonner'
import { ApiError } from '../../api/http'

/**
 * A file download with its own busy flag and its own error message.
 *
 * Downloads are plain requests, not React Query mutations, so the app-wide
 * error handler in main.jsx never sees them — without this a failed PDF or bank
 * file would simply do nothing when clicked.
 *
 *   const { busy, start } = useDownload()
 *   start(slip.id, () => downloadRunPayslip(run.id, slip.id))
 */
export function useDownload() {
  const [busy, setBusy] = useState(null)

  async function start(key, download) {
    setBusy(key)
    try {
      return await download()
    } catch (error) {
      // The session ended: App.jsx is already on its way to the sign-in page.
      if (error instanceof ApiError && error.isAuthError) return undefined
      toast.error(error?.message ?? 'The download failed.', {
        description: error instanceof ApiError && error.requestId ? `Reference: ${error.requestId}` : undefined,
      })
      return undefined
    } finally {
      setBusy(null)
    }
  }

  return { busy, start }
}
