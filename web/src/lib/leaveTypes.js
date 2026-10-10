/**
 * A leave type's badge colour, kept steady per type. Types are the company's
 * own (Settings → Leave), named and coded as it likes, so the colour follows
 * the code rather than a list of names written here.
 *
 * Unpaid leave — Loss of Pay — has a colour of its own, the same everywhere,
 * so a day cut from pay is seen as one wherever it is listed (client, 9 Oct 2026).
 */
const TYPE_COLOURS = ['bg-brand-100 text-brand-700', 'bg-red-100 text-red-700', 'bg-purple-100 text-purple-700', 'bg-teal-100 text-teal-700', 'bg-pink-100 text-pink-700', 'bg-indigo-100 text-indigo-700', 'bg-orange-100 text-orange-700']
export const UNPAID_COLOUR = 'bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-300'

export function typeColourOf(code, isPaid = true) {
  if (isPaid === false) return UNPAID_COLOUR
  let h = 0
  for (const ch of String(code ?? '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return TYPE_COLOURS[h % TYPE_COLOURS.length]
}

const dayWord = (n) => `${n} day${n === 1 ? '' : 's'}`

/**
 * What a request is, in words: its type — or, for an application in parts
 * (the days a paid balance covers, and the rest unpaid), each part with its
 * days: "1 day Casual Leave + 2 days Loss of Pay".
 */
export function leaveLabel(request) {
  if (request.parts?.length > 1) return request.parts.map((p) => `${dayWord(p.days)} ${p.leave_type_name}`).join(' + ')
  return request.leave_type_name
}

/**
 * Own days a year as typed on Add Employee (type id → text), as the server
 * takes them: only the boxes filled in. Null when one is not a whole or half
 * number of days from 0 to 365.
 */
export function leaveDaysOf(value) {
  const list = []
  for (const [leaveTypeId, typed] of Object.entries(value)) {
    if (typed === '') continue
    const days = Number(typed)
    if (!(days >= 0 && days <= 365 && Number.isInteger(days * 2))) return null
    list.push({ leaveTypeId, days })
  }
  return list
}

/** The types of a request — every part's, for one in parts — as the filters match them. */
export function leaveCodesOf(request) {
  return request.parts?.length > 1 ? request.parts.map((p) => p.leave_type) : [request.leave_type]
}
