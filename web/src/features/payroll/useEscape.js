import { useEffect } from 'react'

/** Escape closes the payroll dialogs, as it does every other dialog people use. */
export function useEscape(onClose) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}
