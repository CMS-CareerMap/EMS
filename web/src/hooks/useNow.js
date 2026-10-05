import { useEffect, useState } from 'react'

/** The time now, refreshed every `everyMs` — for a clock on screen. */
export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}
