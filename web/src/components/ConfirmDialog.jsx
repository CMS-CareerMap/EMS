import { useState } from 'react'
import Dialog from './Dialog'

/**
 * "Are you sure?" in the app's own dialog — replacing window.confirm.
 *
 * The browser's box could not say what was about to happen in more than one
 * line, looked like a pop-up from somewhere else, and closed the instant it was
 * answered, before the change had even been sent. This one:
 *
 *   - says what will happen and what will not, in as many words as it takes;
 *   - waits for the change to finish, and stays open if it fails, so the
 *     person sees the error (the global toast) and can try again or cancel;
 *   - cannot be answered twice: the buttons are held while it works;
 *   - on a destructive action, starts with the focus on Cancel, so a stray
 *     Enter does nothing harmful.
 *
 * `onConfirm` returns a promise — usually a mutation's mutateAsync.
 * `disabled` holds the confirm button — while what it confirms is still
 * loading, or when there is nothing to do.
 */
export default function ConfirmDialog({ title, children, confirmLabel = 'Confirm', danger = false, disabled = false, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false)

  const confirm = async () => {
    setBusy(true)
    try {
      await onConfirm()
      onClose()
    } catch {
      // Already shown: every failed mutation raises the global toast. The
      // dialog stays so the person can decide again.
      setBusy(false)
    }
  }

  // While it works, Escape and the close button wait too.
  const close = busy ? () => {} : onClose

  return (
    <Dialog title={title} onClose={close}>
      <div className="text-sm text-gray-600 space-y-2">{children}</div>
      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
        <button type="button" onClick={close} disabled={busy} autoFocus={danger}
          className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60">
          Cancel
        </button>
        <button type="button" onClick={confirm} disabled={busy || disabled} autoFocus={!danger}
          className={`px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-60 ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  )
}
