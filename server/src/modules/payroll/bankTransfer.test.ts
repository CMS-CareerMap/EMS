import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { isoInstant } from '../../domain/shared/dates'

/**
 * Day 18's server half: bank accounts for salary, the bank file's layout, and
 * the bank transfer file itself — from an approved run, paying exactly the
 * payslips' net, and saying who it leaves out.
 */

const PREFIX = 'banktest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()
const day = (d: string) => new Date(`${d}T00:00:00Z`)
const AUGUST = { year: 2026, month: 8 }

type Role = 'super_admin' | 'accounts' | 'hr' | 'employee'

let orgId = ''
const token = {} as Record<Role, string>
const membership = {} as Record<Role, string>
const component: Record<string, string> = {}
let seq = 0

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.payslipLine.deleteMany({ where: org })
  await prisma.payslip.deleteMany({ where: org })
  await prisma.payrollRun.deleteMany({ where: org })
  await prisma.bankFileTemplate.deleteMany({ where: org })
  await prisma.employeeBankAccount.deleteMany({ where: org })
  await prisma.esiCoverage.deleteMany({ where: org })
  await prisma.employeeSalaryComponent.deleteMany({ where: org })
  await prisma.employeeFinancial.deleteMany({ where: org })
  await prisma.employeeStatutoryIdentity.deleteMany({ where: org })
  await prisma.salaryComponent.deleteMany({ where: org })
  await prisma.ptSlab.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

const api = (role: Role) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token[role]}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('Authorization', `Bearer ${token[role]}`).send(body),
  put: (url: string, body: object) => request(app).put(url).set('Authorization', `Bearer ${token[role]}`).send(body),
})

/** The version of somebody's account a checker has in front of them. */
const seen = async (employeeId: string) =>
  isoInstant((await prisma.employeeBankAccount.findFirstOrThrow({ where: { employeeId } })).updatedAt)

const download = (role: Role, url: string) =>
  request(app)
    .get(url)
    .set('Authorization', `Bearer ${token[role]}`)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => callback(null, Buffer.concat(chunks)))
    })

async function hire(name: string, basic: number, membershipId: string | null = null): Promise<string> {
  seq += 1
  const employee = await prisma.employee.create({
    data: {
      organizationId: orgId,
      employeeCode: `BT${seq}`,
      fullName: name,
      dateOfJoining: day('2021-01-01'),
      gender: 'male',
      membershipId,
    },
  })
  await prisma.employeeStatutoryIdentity.create({
    data: { organizationId: orgId, employeeId: employee.id, ptState: 'Maharashtra', pfApplicable: true, hasPriorPfMembership: true },
  })
  await prisma.employeeFinancial.create({
    data: {
      organizationId: orgId,
      employeeId: employee.id,
      ctc: basic * 12,
      effectiveFrom: day('2021-01-01'),
      components: { create: [{ organizationId: orgId, salaryComponentId: component.BASIC!, amount: basic }] },
    },
  })
  return employee.id
}

const account = (overrides: object = {}) => ({
  bankName: 'HDFC Bank',
  accountHolderName: 'ACCOUNT HOLDER',
  accountNumber: '000123456789',
  ifsc: 'HDFC0001234',
  accountType: 'Savings',
  ...overrides,
})

const who: Record<string, string> = {}

beforeAll(async () => {
  await cleanup()
  const org = await prisma.organization.create({ data: { name: `${PREFIX}-org`, legalName: 'Bank Test Pvt Ltd', timezone: 'Asia/Kolkata' } })
  orgId = org.id
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: day('2020-04-01') } })
  component.BASIC = (await prisma.salaryComponent.create({ data: { organizationId: orgId, code: 'BASIC', label: 'Basic', countsForPf: true } })).id
  await prisma.salaryComponent.create({
    data: { organizationId: orgId, code: 'INCENTIVE', label: 'Incentive', entry: 'monthly', displayOrder: 6 },
  })

  for (const role of ['super_admin', 'accounts', 'hr', 'employee'] as const) {
    const email = `${PREFIX}-${role}@example.com`
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
    const m = await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status: 'active' } })
    membership[role] = m.id
    const res = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })
    token[role] = res.body.data.accessToken
  }

  who.asha = await hire('Asha Kulkarni', 30_000)
  who.ravi = await hire('Ravi Patil', 25_000)
  who.nobank = await hire('No Bank Yet', 20_000)
  // The accountant is on the payroll too — the case self-verification is about.
  who.accountant = await hire('Anil Accountant', 40_000, membership.accounts)
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('bank accounts', () => {
  it('are for the people who pay: not HR, not an employee', async () => {
    for (const role of ['hr', 'employee'] as const) {
      expect((await api(role).get('/api/payroll/bank-accounts')).status).toBe(403)
      expect((await api(role).put(`/api/payroll/employees/${who.asha}/bank-account`, account())).status).toBe(403)
    }
  })

  it('refuses an IFSC or account number that cannot be one', async () => {
    expect((await api('accounts').put(`/api/payroll/employees/${who.asha}/bank-account`, account({ ifsc: 'HDFC1234' }))).status).toBe(422)
    expect((await api('accounts').put(`/api/payroll/employees/${who.asha}/bank-account`, account({ accountNumber: '12AB' }))).status).toBe(422)
  })

  it('records an account checked against the cheque — and keeps only its last four digits in the audit', async () => {
    const res = await api('accounts').put(`/api/payroll/employees/${who.asha}/bank-account`, account({ accountHolderName: 'ASHA KULKARNI', markVerified: true }))
    expect(res.status).toBe(200)
    expect(res.body.data.bank_account).toMatchObject({ account_number: '000123456789', ifsc: 'HDFC0001234', verification_status: 'verified' })

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'bank_account.saved', entityId: who.asha } })
    expect(JSON.stringify(audit.details)).not.toContain('000123456789')
    expect(audit.details).toMatchObject({ accountEnding: '6789', status: 'verified' })
  })

  it('un-verifies an account whose number changes — it is no longer the one that was checked', async () => {
    await api('accounts').put(`/api/payroll/employees/${who.ravi}/bank-account`, account({ accountHolderName: 'RAVI PATIL', accountNumber: '111122223333', markVerified: true }))
    const changed = await api('accounts').put(`/api/payroll/employees/${who.ravi}/bank-account`, account({ accountHolderName: 'RAVI PATIL', accountNumber: '999988887777' }))
    expect(changed.body.data.bank_account.verification_status).toBe('pending')
  })

  it('keeps a verified account verified when only its details around it change', async () => {
    const res = await api('accounts').put(`/api/payroll/employees/${who.asha}/bank-account`, account({ accountHolderName: 'ASHA KULKARNI', branch: 'Baner' }))
    expect(res.body.data.bank_account).toMatchObject({ verification_status: 'verified', branch: 'Baner' })
  })

  it('will not let anybody verify their own account', async () => {
    const self = `/api/payroll/employees/${who.accountant}/bank-account`
    const marked = await api('accounts').put(self, account({ accountHolderName: 'ANIL', accountNumber: '555566667777', markVerified: true }))
    // Your own work goes up the company tree (Day 22): nobody above the
    // accountant here, so to the Super Admin.
    expect(marked.status).toBe(403)
    expect(marked.body.error.message).toBe('You cannot check your own bank account. It goes to the person above you: the Super Admin.')

    expect((await api('accounts').put(self, account({ accountHolderName: 'ANIL', accountNumber: '555566667777' }))).status).toBe(200)
    expect((await api('accounts').post(`${self}/verify`, { decision: 'verified', accountUpdatedAt: await seen(who.accountant!) })).status).toBe(403)

    // Somebody else can.
    const other = await api('super_admin').post(`${self}/verify`, { decision: 'verified', accountUpdatedAt: await seen(who.accountant!) })
    expect(other.status).toBe(200)
    expect(other.body.data.bank_account.verification_status).toBe('verified')
  })

  it('shows a person their own account — its last four digits — and nobody else’s', async () => {
    const mine = await api('accounts').get('/api/payslips/me/bank-account')
    expect(mine.status).toBe(200)
    expect(mine.body.data).toMatchObject({ bank_name: 'HDFC Bank', account_ending: '7777', ifsc: 'HDFC0001234', verification_status: 'verified' })
    expect(JSON.stringify(mine.body.data)).not.toContain('555566667777')

    // A login with no employee record has no account to show.
    const none = await api('employee').get('/api/payslips/me/bank-account')
    expect(none.status).toBe(200)
    expect(none.body.data).toBeNull()
  })

  it('refuses a decision on a version of the account that is no longer there — and a save from a stale form', async () => {
    const url = `/api/payroll/employees/${who.ravi}/bank-account`
    const looked = await seen(who.ravi!)
    // Meanwhile the details change (in real life: Ravi sends in a new account).
    await new Promise((r) => setTimeout(r, 5))
    expect((await api('accounts').put(url, account({ accountHolderName: 'RAVI PATIL', accountNumber: '998877665544' }))).status).toBe(200)

    const late = await api('accounts').post(`${url}/verify`, { decision: 'verified', accountUpdatedAt: looked })
    expect(late.status).toBe(409)
    expect(late.body.error.message).toMatch(/changed while you were checking it — it now ends 5544/)
    expect((await prisma.employeeBankAccount.findFirstOrThrow({ where: { employeeId: who.ravi } })).verificationStatus).toBe('pending')

    const stale = await api('accounts').put(url, account({ accountHolderName: 'RAVI P', accountNumber: '998877665544', accountUpdatedAt: looked }))
    expect(stale.status).toBe(409)
    expect(stale.body.error.message).toMatch(/changed since you opened it/)
    // The current version goes through.
    expect((await api('accounts').put(url, account({ accountHolderName: 'RAVI P', accountNumber: '998877665544', accountUpdatedAt: await seen(who.ravi!) }))).status).toBe(200)
  })

  it('needs a reason to reject an account', async () => {
    const url = `/api/payroll/employees/${who.ravi}/bank-account/verify`
    expect((await api('accounts').post(url, { decision: 'rejected', accountUpdatedAt: await seen(who.ravi!) })).status).toBe(400)
    // A decision has to say which version of the account it is about.
    expect((await api('accounts').post(url, { decision: 'rejected', remarks: 'x' })).status).toBe(422)
    const res = await api('accounts').post(url, { decision: 'rejected', remarks: 'Name does not match the cheque', accountUpdatedAt: await seen(who.ravi!) })
    expect(res.body.data.bank_account).toMatchObject({ verification_status: 'rejected', verification_remarks: 'Name does not match the cheque' })
  })

  it('lists everybody, with or without an account', async () => {
    const res = await api('accounts').get('/api/payroll/bank-accounts')
    const byId = new Map(res.body.data.map((r: { employee_id: string }) => [r.employee_id, r]))
    expect((byId.get(who.nobank) as { bank_account: unknown }).bank_account).toBeNull()
    expect((byId.get(who.asha) as { bank_account: { verification_status: string } }).bank_account.verification_status).toBe('verified')
  })
})

describe('the bank file’s layout', () => {
  it('starts as the built-in one', async () => {
    const res = await api('accounts').get('/api/payroll/bank-file-template')
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ saved: false, include_header: true, only_verified: true })
    expect(res.body.data.columns.map((c: { field: string }) => c.field)).toContain('account_number')
    expect(res.body.data.fields.length).toBeGreaterThan(5)
  })

  it('refuses a layout that pays nobody, and HR cannot set one', async () => {
    const bad = await api('accounts').put('/api/payroll/bank-file-template', {
      columns: [{ header: 'Name', field: 'employee_name' }],
      includeHeader: true,
      dateFormat: 'DD/MM/YYYY',
      narration: 'Salary {month}',
      onlyVerified: true,
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error.message).toMatch(/needs an account number column/)
    expect((await api('hr').put('/api/payroll/bank-file-template', {})).status).toBe(403)
  })
})

describe('the bank transfer file', () => {
  let runId = ''

  beforeAll(async () => {
    const run = await api('accounts').post('/api/payroll-runs', AUGUST)
    expect(run.status).toBe(201)
    runId = run.body.data.id
  })

  it('is not made from a draft', async () => {
    const res = await api('accounts').get(`/api/payroll-runs/${runId}/bank-file/preview`)
    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/Approve the payroll first/)
  })

  it('pays the checked accounts and names who is left out, and why', async () => {
    expect((await api('super_admin').post(`/api/payroll-runs/${runId}/approve`, { confirmAssumedDays: true })).status).toBe(200)

    const res = await api('accounts').get(`/api/payroll-runs/${runId}/bank-file/preview?payDate=2026-09-01`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.pay_date).toBe('2026-09-01')
    expect(d.payments.map((p: { employee_id: string }) => p.employee_id).sort()).toEqual([who.accountant, who.asha].sort())
    // Last four only on screen.
    expect(d.payments.find((p: { employee_id: string }) => p.employee_id === who.asha).account_ending).toBe('6789')
    expect(new Map(d.excluded.map((x: { employee_id: string; reason: string }) => [x.employee_id, x.reason]))).toEqual(
      new Map([
        [who.ravi, 'rejected'],
        [who.nobank, 'no_bank_account'],
      ]),
    )

    // The total is the payslips' net, to the paisa.
    const slips = await prisma.payslip.findMany({ where: { payrollRunId: runId, employeeId: { in: [who.asha!, who.accountant!] } } })
    const net = Math.round(slips.reduce((s, x) => s + Number(x.netPayable) * 100, 0)) / 100
    expect(d.total).toBe(net)
  })

  it('downloads as a CSV the bank can read: marked UTF-8, one line each, the amounts exact', async () => {
    const res = await download('accounts', `/api/payroll-runs/${runId}/bank-file?payDate=2026-09-01`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="bank-transfer-2026-08.csv"')
    expect(res.headers['x-content-type-options']).toBe('nosniff')

    const text = (res.body as Buffer).toString('utf8')
    expect(text.charCodeAt(0)).toBe(0xfeff)
    const lines = text.slice(1).trim().split('\r\n')
    expect(lines[0]).toBe('Beneficiary Name,Account Number,IFSC,Amount,Payment Mode,Narration,Employee Code')
    expect(lines).toHaveLength(3)
    const asha = await prisma.payslip.findFirstOrThrow({ where: { payrollRunId: runId, employeeId: who.asha! } })
    expect(lines).toContain(`ASHA KULKARNI,000123456789,HDFC0001234,${Number(asha.netPayable).toFixed(2)},NEFT,Salary August 2026,${asha.employeeCode}`)

    expect(
      await prisma.auditLog.count({ where: { organizationId: orgId, action: 'payroll.bank_file_downloaded', entityId: runId } }),
    ).toBe(1)
  })

  it('follows the layout Accounts sets up for their bank', async () => {
    // An account nobody has checked yet, for the company that pays those too.
    await api('accounts').put(`/api/payroll/employees/${who.nobank}/bank-account`, account({ accountHolderName: 'NO BANK YET', accountNumber: '444455556666' }))

    const saved = await api('accounts').put('/api/payroll/bank-file-template', {
      columns: [
        { header: 'TXN', field: 'fixed', text: 'N' },
        { header: 'AMT', field: 'amount' },
        { header: 'DATE', field: 'pay_date' },
        { header: 'ACCT', field: 'account_number' },
        { header: 'REMARK', field: 'narration' },
      ],
      includeHeader: false,
      dateFormat: 'DD-MM-YYYY',
      narration: 'SAL {code}',
      // Pending accounts too, this company decides.
      onlyVerified: false,
    })
    expect(saved.status).toBe(200)
    expect(saved.body.data.saved).toBe(true)

    const res = await download('accounts', `/api/payroll-runs/${runId}/bank-file?payDate=2026-09-01`)
    const lines = (res.body as Buffer).toString('utf8').slice(1).trim().split('\r\n')
    // No heading row; the pending account is in, as this company chose; Ravi's
    // rejected account is still out — checked and wrong is never paid.
    expect(lines[0]!.startsWith('N,')).toBe(true)
    expect(lines.every((line) => line.split(',')[2] === '01-09-2026')).toBe(true)
    expect(lines).toHaveLength(3)
    expect(lines.some((line) => line.includes('444455556666'))).toBe(true)
    expect(lines.some((line) => line.includes('999988887777'))).toBe(false)
  })

  it('lets HR, who enters incentives, read the component list — and nothing else of payroll', async () => {
    expect((await api('hr').get('/api/payroll/components')).status).toBe(200)
    expect((await api('hr').get(`/api/payroll-runs/${runId}/bank-file/preview`)).status).toBe(403)
    expect((await api('employee').get('/api/payroll/components')).status).toBe(403)
  })
})
