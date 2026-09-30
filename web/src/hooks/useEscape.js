import { useEffect, useRef } from 'react'

/**
 * Escape closes a dialog — the TOPMOST one only.
 *
 * Dialogs open on top of each other: the proof preview over the bank-account
 * check, a report over the page. With a listener each, one Escape closed them
 * all, and the remarks typed into the dialog underneath were lost. The open
 * dialogs are kept in the order they opened, and Escape goes to the last.
 */
const open = []

function onKey(event) {
  if (event.key !== 'Escape' || open.length === 0) return
  open[open.length - 1].current()
}

export function useEscape(onClose) {
  const latest = useRef(onClose)
  useEffect(() => {
    latest.current = onClose
  })

  useEffect(() => {
    const entry = latest
    open.push(entry)
    if (open.length === 1) window.addEventListener('keydown', onKey)
    return () => {
      open.splice(open.indexOf(entry), 1)
      if (open.length === 0) window.removeEventListener('keydown', onKey)
    }
  }, [])
}
