import { describe, it, expect } from 'vitest'
import { csvCell, toCsv } from './csv'

describe('one CSV cell', () => {
  it('leaves plain text and numbers alone', () => {
    expect(csvCell('HDFC0001234')).toBe('HDFC0001234')
    expect(csvCell(27400.5)).toBe('27400.5')
    expect(csvCell(-120)).toBe('-120')
  })

  it('keeps an account number exactly as written, leading zeros and all', () => {
    expect(csvCell('000123456789')).toBe('000123456789')
  })

  it('quotes a comma, a quote or a line break, doubling the quotes', () => {
    expect(csvCell('Kulkarni, Asha')).toBe('"Kulkarni, Asha"')
    expect(csvCell('The "boss"')).toBe('"The ""boss"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
  })

  it('stops a spreadsheet running a cell as a formula', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`)
    expect(csvCell('+91 98765')).toBe("'+91 98765")
    expect(csvCell('-SUM(A1)')).toBe("'-SUM(A1)")
    expect(csvCell('@cmd')).toBe("'@cmd")
    expect(csvCell('-1+2')).toBe("'-1+2")
    expect(csvCell('-2.5e3')).toBe("'-2.5e3")
  })

  it('writes a negative amount as a number, so the column still adds up', () => {
    // Money arrives as text to two places; net pay can be below zero.
    expect(csvCell('-350.00')).toBe('-350.00')
    expect(csvCell('-7')).toBe('-7')
    expect(csvCell(-350)).toBe('-350')
  })

  it('writes nothing for nothing', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
    expect(csvCell(Number.NaN)).toBe('')
  })
})

describe('a CSV file', () => {
  it('starts with a byte-order mark, so Excel reads ₹ as ₹', () => {
    const csv = toCsv([['Name', 'Amount'], ['Asha', '₹100']])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv.slice(1)).toBe('Name,Amount\r\nAsha,₹100\r\n')
  })

  it('can leave the mark out and use plain line feeds', () => {
    expect(toCsv([['a', 'b']], { bom: false, lineEnding: '\n' })).toBe('a,b\n')
  })

  it('is just the mark when there are no rows', () => {
    expect(toCsv([])).toBe('﻿')
  })
})
