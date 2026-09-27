import { describe, it, expect } from 'vitest'
import {
  bankFileRows,
  DEFAULT_BANK_FILE_TEMPLATE,
  exclusionOf,
  formatAmount,
  formatDate,
  narrationFor,
  templateProblems,
  type BankFileTemplate,
  type BankPayment,
} from './bankFile'

const PAYMENT: BankPayment = {
  employeeName: 'Asha Kulkarni',
  employeeCode: 'EMP001',
  beneficiaryName: 'ASHA KULKARNI',
  accountNumber: '000123456789',
  ifsc: 'HDFC0001234',
  bankName: 'HDFC Bank',
  amount: 27400,
}
const AUGUST = { year: 2026, month: 8, payDate: '2026-09-01' }

describe('the default bank file', () => {
  it('has a heading row, then one line per person', () => {
    const rows = bankFileRows(DEFAULT_BANK_FILE_TEMPLATE, [PAYMENT], AUGUST)
    expect(rows).toEqual([
      ['Beneficiary Name', 'Account Number', 'IFSC', 'Amount', 'Payment Mode', 'Narration', 'Employee Code'],
      ['ASHA KULKARNI', '000123456789', 'HDFC0001234', '27400.00', 'NEFT', 'Salary August 2026', 'EMP001'],
    ])
  })

  it('is a template a company can save as it is', () => {
    expect(templateProblems(DEFAULT_BANK_FILE_TEMPLATE)).toEqual([])
  })
})

describe('a bank’s own layout', () => {
  const template: BankFileTemplate = {
    columns: [
      { header: 'TXN_TYPE', field: 'fixed', text: 'N' },
      { header: 'AMOUNT', field: 'amount' },
      { header: 'VALUE_DATE', field: 'pay_date' },
      { header: 'BENE_ACCT', field: 'account_number' },
      { header: 'BENE_NAME', field: 'employee_name' },
      { header: 'IFSC', field: 'ifsc' },
      { header: 'REMARK', field: 'narration' },
    ],
    includeHeader: false,
    dateFormat: 'DD-MM-YYYY',
    narration: 'SAL {code} {month}',
    onlyVerified: true,
  }

  it('follows its columns, its date style and its remark — and no heading when it wants none', () => {
    expect(bankFileRows(template, [PAYMENT], AUGUST)).toEqual([
      ['N', '27400.00', '01-09-2026', '000123456789', 'Asha Kulkarni', 'HDFC0001234', 'SAL EMP001 August'],
    ])
  })
})

describe('the pieces', () => {
  it('writes amounts the way bank portals read them', () => {
    expect(formatAmount(27400)).toBe('27400.00')
    expect(formatAmount(1234.5)).toBe('1234.50')
    expect(formatAmount(0.1 + 0.2)).toBe('0.30')
  })

  it('writes the date in any of the four styles', () => {
    expect(formatDate('2026-09-01', 'DD/MM/YYYY')).toBe('01/09/2026')
    expect(formatDate('2026-09-01', 'YYYY-MM-DD')).toBe('2026-09-01')
    expect(formatDate('2026-09-01', 'DD-MM-YYYY')).toBe('01-09-2026')
    expect(formatDate('2026-09-01', 'MM/DD/YYYY')).toBe('09/01/2026')
  })

  it('fills the narration in, and leaves anything else as typed', () => {
    expect(narrationFor('Salary {month} {year}', { year: 2026, month: 8, code: 'E1' })).toBe('Salary August 2026')
  })
})

describe('what a template may not be', () => {
  const base = DEFAULT_BANK_FILE_TEMPLATE

  it('must pay somebody: an account number and an amount', () => {
    const problems = templateProblems({ ...base, columns: [{ header: 'Name', field: 'employee_name' }] })
    expect(problems).toContain('The file needs an account number column.')
    expect(problems).toContain('The file needs an amount column.')
  })

  it('needs headings when it has a heading row, and text in a fixed column', () => {
    const problems = templateProblems({
      ...base,
      columns: [...base.columns, { header: '', field: 'fixed', text: '' }],
    })
    expect(problems.some((p) => /needs a heading/.test(p))).toBe(true)
    expect(problems.some((p) => /enter the text/.test(p))).toBe(true)
  })

  it('knows only three placeholders', () => {
    expect(templateProblems({ ...base, narration: 'Salary {salary}' })).toEqual([
      'The narration uses {salary}, which is not {month}, {year} or {code}.',
    ])
  })
})

describe('who is left out of the file', () => {
  const verified = { verificationStatus: 'verified' }
  it('pays a checked account', () => {
    expect(exclusionOf({ netPayable: 100, account: verified, onlyVerified: true })).toBeNull()
  })
  it('leaves out somebody with no account, or an unchecked one when only checked ones are paid', () => {
    expect(exclusionOf({ netPayable: 100, account: null, onlyVerified: true })).toBe('no_bank_account')
    expect(exclusionOf({ netPayable: 100, account: { verificationStatus: 'pending' }, onlyVerified: true })).toBe('not_verified')
    expect(exclusionOf({ netPayable: 100, account: { verificationStatus: 'pending' }, onlyVerified: false })).toBeNull()
  })
  it('never pays an account that was checked and rejected, even when unchecked ones are allowed', () => {
    expect(exclusionOf({ netPayable: 100, account: { verificationStatus: 'rejected' }, onlyVerified: false })).toBe('rejected')
    expect(exclusionOf({ netPayable: 100, account: { verificationStatus: 'rejected' }, onlyVerified: true })).toBe('rejected')
  })
  it('leaves out a net pay of nothing or less — there is nothing to send', () => {
    expect(exclusionOf({ netPayable: 0, account: verified, onlyVerified: true })).toBe('nothing_to_pay')
    expect(exclusionOf({ netPayable: -50, account: verified, onlyVerified: true })).toBe('nothing_to_pay')
  })
})
