/**
 * Amounts in words, the Indian way: lakh and crore, not million.
 *
 * An Indian payslip states the net pay in figures AND in words (guide, Day 17).
 * The words are what a bank clerk reads when the figures are smudged, so they
 * are written out exactly — every rupee and every paisa — and never rounded.
 */

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
] as const

const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'] as const

function belowHundred(n: number): string {
  if (n < 20) return ONES[n] ?? ''
  const tens = TENS[Math.floor(n / 10)] ?? ''
  const ones = n % 10
  return ones ? `${tens} ${ONES[ones]}` : tens
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ')
}

/**
 * A whole number in the Indian system: 1,23,45,678 is "One Crore Twenty Three
 * Lakh Forty Five Thousand Six Hundred Seventy Eight". Above 99 crore the crore
 * count is itself written out — "One Hundred Twenty Crore".
 */
export function indianNumberInWords(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`Not a whole number: ${n}`)
  if (n === 0) return 'Zero'

  const crore = Math.floor(n / 10_000_000)
  const lakh = Math.floor((n % 10_000_000) / 100_000)
  const thousand = Math.floor((n % 100_000) / 1_000)
  const rest = n % 1_000

  return [
    crore ? `${indianNumberInWords(crore)} Crore` : '',
    lakh ? `${belowHundred(lakh)} Lakh` : '',
    thousand ? `${belowHundred(thousand)} Thousand` : '',
    rest ? belowThousand(rest) : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * "Rupees Twenty Eight Thousand Five Hundred and Paise Twenty Three Only".
 *
 * Negative amounts say so. A net pay below zero is a real state a payslip can
 * be in (deductions above a heavily reduced gross), and words that dropped the
 * sign would state a payment that is not being made.
 */
export function rupeesInWords(amount: number): string {
  const inPaise = Math.round(Math.abs(amount) * 100)
  const rupees = Math.floor(inPaise / 100)
  const paise = inPaise % 100

  const words = `Rupees ${indianNumberInWords(rupees)}${paise ? ` and Paise ${belowHundred(paise)}` : ''} Only`
  return amount < 0 && inPaise > 0 ? `Minus ${words}` : words
}
