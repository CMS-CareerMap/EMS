/** Tones shared by chips, tiles and icons. */
export const TONES = {
  ok: { soft: 'bg-emerald-50 text-emerald-700', icon: 'bg-emerald-50 text-emerald-600' },
  warn: { soft: 'bg-amber-50 text-amber-700', icon: 'bg-amber-50 text-amber-600' },
  bad: { soft: 'bg-red-50 text-red-600', icon: 'bg-red-50 text-red-500' },
  info: { soft: 'bg-sky-50 text-sky-700', icon: 'bg-sky-50 text-sky-600' },
  leave: { soft: 'bg-pink-50 text-pink-700', icon: 'bg-pink-50 text-pink-600' },
  brand: { soft: 'bg-brand-50 text-brand-700', icon: 'bg-brand-50 text-brand-600' },
  gray: { soft: 'bg-gray-100 text-gray-600', icon: 'bg-gray-100 text-gray-500' },
}

/** "Rahul Mehta" → "RM". */
export const initialsOf = (name) => String(name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
