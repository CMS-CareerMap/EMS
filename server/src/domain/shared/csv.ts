/**
 * CSV, written once and written safely (guide, Day 19: "one shared csv()
 * helper").
 *
 * The exporters this replaces shared three bugs:
 *
 *   · A comma, quote or line break inside a value broke the row. Every field
 *     that needs it is quoted here, with quotes doubled inside it.
 *   · No byte-order mark, so Excel opened UTF-8 as Latin-1 and "₹" or a name
 *     in Devanagari came out as rubbish. The BOM is on by default.
 *   · Formula injection. A cell that starts with = + - @ is run by a
 *     spreadsheet as a formula — an employee named "=HYPERLINK(…)" becomes a
 *     link in the accountant's copy of the payroll. Such cells are prefixed
 *     with an apostrophe, which spreadsheets show as plain text.
 *
 * Pure: rows in, one string out.
 */

const FORMULA_START = /^[=+\-@\t\r]/
const NEEDS_QUOTES = /[",\r\n]/
/** A plain decimal — "-350.00" — which no spreadsheet runs as a formula. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

export type CsvCell = string | number | null | undefined

/**
 * One cell, made safe. A number is written as it is — a negative amount is a
 * number, not a formula — and so is text that is only a number, such as money
 * written to two places ("-350.00"): an apostrophe there would turn it into
 * text, and the column's SUM would quietly skip it. Everything else is guarded.
 */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (PLAIN_NUMBER.test(value)) return value

  const guarded = FORMULA_START.test(value) ? `'${value}` : value
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

export function toCsv(
  rows: readonly (readonly CsvCell[])[],
  options: { bom?: boolean; lineEnding?: '\r\n' | '\n' } = {},
): string {
  const eol = options.lineEnding ?? '\r\n'
  const body = rows.map((row) => row.map(csvCell).join(',')).join(eol)
  return `${options.bom === false ? '' : '﻿'}${body}${rows.length > 0 ? eol : ''}`
}
