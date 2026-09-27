import { describe, it, expect } from 'vitest'
import { indianNumberInWords, rupeesInWords } from './words'

describe('numbers in words, the Indian way', () => {
  const cases: [number, string][] = [
    [0, 'Zero'],
    [7, 'Seven'],
    [15, 'Fifteen'],
    [20, 'Twenty'],
    [21, 'Twenty One'],
    [99, 'Ninety Nine'],
    [100, 'One Hundred'],
    [101, 'One Hundred One'],
    [999, 'Nine Hundred Ninety Nine'],
    [1_000, 'One Thousand'],
    [1_001, 'One Thousand One'],
    [12_345, 'Twelve Thousand Three Hundred Forty Five'],
    [1_00_000, 'One Lakh'],
    [12_34_567, 'Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven'],
    [1_00_00_000, 'One Crore'],
    [12_34_56_789, 'Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine'],
    [120_00_00_000, 'One Hundred Twenty Crore'],
  ]

  for (const [n, words] of cases) {
    it(`${n.toLocaleString('en-IN')} is "${words}"`, () => {
      expect(indianNumberInWords(n)).toBe(words)
    })
  }

  it('refuses what is not a whole number', () => {
    expect(() => indianNumberInWords(1.5)).toThrow()
    expect(() => indianNumberInWords(-1)).toThrow()
  })
})

describe('a net pay in words', () => {
  it('writes rupees, and says Only', () => {
    expect(rupeesInWords(28_500)).toBe('Rupees Twenty Eight Thousand Five Hundred Only')
  })

  it('writes the paise too — every one of them', () => {
    expect(rupeesInWords(26_903.23)).toBe('Rupees Twenty Six Thousand Nine Hundred Three and Paise Twenty Three Only')
    expect(rupeesInWords(0.5)).toBe('Rupees Zero and Paise Fifty Only')
  })

  it('is not thrown by floating point', () => {
    expect(rupeesInWords(0.1 + 0.2)).toBe('Rupees Zero and Paise Thirty Only')
  })

  it('says so when the net pay is below zero', () => {
    expect(rupeesInWords(-1_200)).toBe('Minus Rupees One Thousand Two Hundred Only')
    expect(rupeesInWords(0)).toBe('Rupees Zero Only')
  })
})
