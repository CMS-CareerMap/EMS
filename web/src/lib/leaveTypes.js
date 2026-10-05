/**
 * A leave type's badge colour, kept steady per type. Types are the company's
 * own (Settings → Leave), named and coded as it likes, so the colour follows
 * the code rather than a list of names written here.
 */
const TYPE_COLOURS = ['bg-brand-100 text-brand-700', 'bg-red-100 text-red-700', 'bg-purple-100 text-purple-700', 'bg-teal-100 text-teal-700', 'bg-pink-100 text-pink-700', 'bg-indigo-100 text-indigo-700', 'bg-orange-100 text-orange-700']
export function typeColourOf(code) {
  let h = 0
  for (const ch of String(code ?? '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return TYPE_COLOURS[h % TYPE_COLOURS.length]
}
