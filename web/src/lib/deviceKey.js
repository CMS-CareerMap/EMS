/**
 * The phone's key (client, 11 Oct 2026: one phone per employee): a random
 * string this browser keeps, sent with every punch. The server keeps only its
 * hash. Clearing the browser's data — or a private window, where nothing is
 * kept — makes a new key, which the server sees as a new phone.
 */

const STORE = 'ems.punchDevice'

let memory = null

function fresh() {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function deviceKey() {
  try {
    const kept = localStorage.getItem(STORE)
    if (kept && /^[A-Za-z0-9_-]{16,128}$/.test(kept)) return kept
    const made = fresh()
    localStorage.setItem(STORE, made)
    return made
  } catch {
    // Storage blocked (a private window): a key for this page only.
    memory ??= fresh()
    return memory
  }
}
