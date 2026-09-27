import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createHash } from 'node:crypto'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { storage } from '../../platform/storage'

/**
 * Day 17, end to end: a draft is approved, paid, and becomes payslips that the
 * people they belong to can download — and the month behind it closes.
 *
 * August 2026 again: Saturday the 1st, Sundays on the 2nd, 9th, 16th, 23rd and
 * 30th, 26 working days with Sunday off.
 */

const PREFIX = 'slipflow'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()

type Role = 'super_admin' | 'accounts' | 'hr' | 'employee' | 'manager'

interface Org {
  id: string
  token: Record<Role, string>
  userId: Record<Role, string>
  membershipId: Record<Role, string>
  component: Record<string, string>
}

let seq = 0
const day = (date: string) => new Date(`${date}T00:00:00Z`)
const AUGUST = { year: 2026, month: 8 }

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.payslipLine.deleteMany({ where: org })
  await prisma.payslip.deleteMany({ where: org })
  await prisma.payrollRun.deleteMany({ where: org })
  await prisma.employeeMonthlyEntry.deleteMany({ where: org })
  await prisma.employeeTdsDirective.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.holiday.deleteMany({ where: org })
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

async function makeOrg(label: string, policy: { payslipLockDay?: number | null } = {}): Promise<Org> {
  const organization = await prisma.organization.create({
    data: {
      name: `${PREFIX}-${label}`,
      legalName: `${label} Private Limited`,
      addressLine: '1st Floor, MG Road',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
      timezone: 'Asia/Kolkata',
    },
  })
  const id = organization.id

  await prisma.organizationPolicy.create({
    data: { organizationId: id, effectiveFrom: day('2020-04-01'), pfWageCeiling: 15_000, ...policy },
  })

  const component: Record<string, string> = {}
  for (const c of [
    { code: 'BASIC', label: 'Basic', countsForPf: true, displayOrder: 1 },
    { code: 'HRA', label: 'House Rent Allowance', countsForPf: false, displayOrder: 3 },
    { code: 'INCENTIVE', label: 'Incentive', countsForPf: false, displayOrder: 6, entry: 'monthly' as const },
  ]) {
    component[c.code] = (await prisma.salaryComponent.create({ data: { organizationId: id, ...c } })).id
  }

  for (const slab of [
    { gender: 'male', minGross: 0, maxGross: 7500, amount: 0, februaryAmount: null },
    { gender: 'male', minGross: 7500.01, maxGross: 10000, amount: 175, februaryAmount: null },
    { gender: 'male', minGross: 10000.01, maxGross: null, amount: 200, februaryAmount: 300 },
  ] as const) {
    await prisma.ptSlab.create({ data: { organizationId: id, state: 'Maharashtra', effectiveFrom: day('2020-04-01'), ...slab } })
  }

  const token = {} as Record<Role, string>
  const userId = {} as Record<Role, string>
  const membershipId = {} as Record<Role, string>
  for (const role of ['super_admin', 'accounts', 'hr', 'employee', 'manager'] as const) {
    const email = `${PREFIX}-${label}-${role}@example.com`
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
    const membership = await prisma.membership.create({
      data: { userId: user.id, organizationId: id, role, status: 'active' },
    })
    const res = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })
    token[role] = res.body.data.accessToken
    userId[role] = user.id
    membershipId[role] = membership.id
  }

  return { id, token, userId, membershipId, component }
}

async function hire(
  org: Org,
  options: {
    salary: Record<string, number>
    name: string
    membershipId?: string
    identity?: { uan?: string; pfAccountNumber?: string; esiNumber?: string; pan?: string }
    country?: string
    currency?: string
  },
): Promise<string> {
  seq += 1
  const employee = await prisma.employee.create({
    data: {
      organizationId: org.id,
      employeeCode: `${PREFIX}-${seq}`,
      fullName: options.name,
      dateOfJoining: day('2021-01-01'),
      gender: 'male',
      membershipId: options.membershipId ?? null,
      ...(options.country ? { country: options.country } : {}),
      ...(options.currency ? { currency: options.currency } : {}),
    },
  })
  await prisma.employeeStatutoryIdentity.create({
    data: {
      organizationId: org.id,
      employeeId: employee.id,
      ptState: 'Maharashtra',
      pfApplicable: true,
      hasPriorPfMembership: true,
      ...options.identity,
    },
  })
  await prisma.employeeFinancial.create({
    data: {
      organizationId: org.id,
      employeeId: employee.id,
      ctc: Object.values(options.salary).reduce((a, b) => a + b, 0) * 12,
      effectiveFrom: day('2021-01-01'),
      components: {
        create: Object.entries(options.salary).map(([code, amount]) => ({
          organizationId: org.id,
          salaryComponentId: org.component[code]!,
          amount,
        })),
      },
    },
  })
  // No TDS directive: these companies are on the client's own setting, TDS
  // off, so a run asks for none.
  return employee.id
}

/** Present on every working day of August 2026. */
async function presentAllAugust(org: Org, employeeId: string) {
  const rows = []
  for (let d = 1; d <= 31; d++) {
    const date = `2026-08-${String(d).padStart(2, '0')}`
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue
    rows.push({ organizationId: org.id, employeeId, date: day(date), status: 'present' as const, source: 'manual' as const })
  }
  await prisma.attendance.createMany({ data: rows })
}

const api = (org: Org, role: Role = 'accounts') => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${org.token[role]}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('Authorization', `Bearer ${org.token[role]}`).send(body),
  put: (url: string, body: object) => request(app).put(url).set('Authorization', `Bearer ${org.token[role]}`).send(body),
  patch: (url: string, body: object) => request(app).patch(url).set('Authorization', `Bearer ${org.token[role]}`).send(body),
  delete: (url: string) => request(app).delete(url).set('Authorization', `Bearer ${org.token[role]}`),
})

/** A binary body, for PDF downloads. */
const download = (org: Org, role: Role, url: string) =>
  request(app)
    .get(url)
    .set('Authorization', `Bearer ${org.token[role]}`)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => callback(null, Buffer.concat(chunks)))
    })

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

beforeAll(async () => {
  await cleanup()
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('from draft to paid payslips', () => {
  let org: Org
  let asha = ''
  let ravi = ''
  let runId = ''
  const slipOf: Record<string, string> = {}

  beforeAll(async () => {
    org = await makeOrg('flow')
    // Asha has a login, and every statutory number on record.
    asha = await hire(org, {
      name: 'Asha Kulkarni',
      salary: { BASIC: 20_000, HRA: 10_000 },
      membershipId: org.membershipId.employee,
      identity: { uan: '100123456789', pfAccountNumber: 'MHBAN0012345000', esiNumber: '3100123456', pan: 'ABCDE1234F' },
    })
    // Ravi has none, and nobody marked his attendance.
    ravi = await hire(org, { name: 'Ravi Patil', salary: { BASIC: 30_000 } })
    await presentAllAugust(org, asha)

    const res = await api(org).post('/api/payroll-runs', AUGUST)
    expect(res.status).toBe(201)
    runId = res.body.data.id
    for (const slip of res.body.data.payslips) slipOf[slip.employee_id] = slip.id
  })

  it('is signed off by the approver, not by whoever prepared it', async () => {
    expect((await api(org, 'accounts').post(`/api/payroll-runs/${runId}/approve`, { confirmAssumedDays: true })).status).toBe(403)
    expect((await api(org, 'hr').post(`/api/payroll-runs/${runId}/approve`)).status).toBe(403)
  })

  it('asks about the days paid for on no record before it approves', async () => {
    const res = await api(org, 'super_admin').post(`/api/payroll-runs/${runId}/approve`)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('BUSINESS_RULE')
    expect(res.body.error.message).toMatch(/26 days in August 2026 were counted as paid/)
    expect(res.body.error.details.assumed_days).toBe(26)
    expect(res.body.error.details.employees).toEqual([
      expect.objectContaining({ employee_id: ravi, full_name: 'Ravi Patil' }),
    ])
    expect(res.body.error.details.employees[0].unmarked_days).toHaveLength(26)
  })

  it('refuses to approve figures the records no longer support', async () => {
    // HR corrects a day after the draft was worked out.
    const row = await prisma.attendance.findFirstOrThrow({ where: { employeeId: asha, date: day('2026-08-10') } })
    expect((await api(org, 'hr').patch(`/api/attendance/${row.id}`, { status: 'absent' })).status).toBe(200)

    const res = await api(org, 'super_admin').post(`/api/payroll-runs/${runId}/approve`, { confirmAssumedDays: true })
    expect(res.status).toBe(422)
    expect(res.body.error.message).toMatch(/have changed since it was calculated/)
    expect(res.body.error.details.changed).toEqual([
      expect.objectContaining({ employee_id: asha, change: 'changed', fields: expect.arrayContaining(['netPayable', 'lopDays']) }),
    ])
  })

  it('approves once recalculated and confirmed — copying the employer and the statutory numbers', async () => {
    const recalc = await api(org).post(`/api/payroll-runs/${runId}/recalculate`)
    expect(recalc.status).toBe(200)
    for (const slip of recalc.body.data.payslips) slipOf[slip.employee_id] = slip.id

    const res = await api(org, 'super_admin').post(`/api/payroll-runs/${runId}/approve`, { confirmAssumedDays: true })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      status: 'approved',
      approved_by_user_id: org.userId.super_admin,
      assumed_days: 26,
      employer_name: 'flow Private Limited',
      employer_address: '1st Floor, MG Road, Pune, Maharashtra 411001',
    })

    const slip = (await api(org).get(`/api/payroll-runs/${runId}/payslips/${slipOf[asha]}`)).body.data
    expect(slip).toMatchObject({ uan: '100123456789', pf_member_id: 'MHBAN0012345000', esic_number: '3100123456', pan: 'ABCDE1234F', pdf: null })
    const none = (await api(org).get(`/api/payroll-runs/${runId}/payslips/${slipOf[ravi]}`)).body.data
    expect(none).toMatchObject({ uan: null, pan: null })

    const audit = await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'payroll.run_approved', entityId: runId } })
    expect(audit?.details).toMatchObject({ assumedDays: 26, confirmedAssumedDays: true })
  })

  it('closes August to every change that would have altered it', async () => {
    // Attendance, marked by hand.
    const mark = await api(org, 'hr').post('/api/attendance/mark', { employeeId: asha, date: '2026-08-11', status: 'absent' })
    expect(mark.status).toBe(409)
    expect(mark.body.error.message).toMatch(/Payroll for August 2026 is approved/)

    // Attendance, imported: the August line is refused, the rest of the file is not.
    const imported = await api(org, 'hr').post('/api/attendance/import', {
      csv: `employee_code,date,check_in,check_out\n${PREFIX}-1,2026-08-12,09:30,18:30`,
      dryRun: true,
    })
    expect(imported.status).toBe(200)
    expect(JSON.stringify(imported.body.data)).toMatch(/Payroll for that month is already approved/)

    // A holiday on an August day.
    expect((await api(org, 'hr').post('/api/holidays', { name: 'Late holiday', date: '2026-08-14' })).status).toBe(409)

    // Leave that would change August's loss of pay.
    const lwp = await prisma.leaveType.create({ data: { organizationId: org.id, name: 'Leave Without Pay', code: 'LWP', isPaid: false } })
    const pending = await prisma.leaveRequest.create({
      data: {
        organizationId: org.id, employeeId: ravi, leaveTypeId: lwp.id, fromDate: day('2026-08-20'), toDate: day('2026-08-20'),
        days: 1, leaveYear: 2026, reason: 'Late request', status: 'pending',
      },
    })
    expect((await api(org, 'hr').post(`/api/leave-requests/${pending.id}/approve`)).status).toBe(409)

    // A salary from inside August — but one from September is fine.
    const salary = (effectiveFrom: string) =>
      api(org).put(`/api/payroll/employees/${ravi}/salary`, { effectiveFrom, ctc: 400_000, components: [{ code: 'BASIC', amount: 32_000 }] })
    expect((await salary('2026-08-15')).status).toBe(409)
    expect((await salary('2026-09-01')).status).toBe(200)

    // A PT table from inside August.
    const pt = await api(org, 'super_admin').put('/api/settings/pt-slabs', {
      state: 'Maharashtra',
      effectiveFrom: '2026-08-01',
      slabs: [{ gender: 'any', from: 0, amount: 0 }],
    })
    expect(pt.status).toBe(409)

    // ESI for the period August sits in.
    expect((await api(org).post('/api/payroll/esi-coverage/redecide', { employeeId: ravi, ...AUGUST })).status).toBe(409)

    // And the run itself.
    expect((await api(org).post(`/api/payroll-runs/${runId}/recalculate`)).status).toBe(409)
    expect((await api(org).delete(`/api/payroll-runs/${runId}`)).status).toBe(409)
  })

  it('shows payroll staff a preview, stamped, and stores nothing', async () => {
    const res = await download(org, 'accounts', `/api/payroll-runs/${runId}/payslips/${slipOf[asha]}/pdf`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect((res.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(await prisma.payslip.count({ where: { payrollRunId: runId, pdfKey: { not: null } } })).toBe(0)
  })

  it('does not show an employee a payslip that has not been paid', async () => {
    const mine = await api(org, 'employee').get('/api/payslips/me')
    expect(mine.status).toBe(200)
    expect(mine.body.data).toEqual([])
    expect((await download(org, 'employee', `/api/payslips/${slipOf[asha]}/pdf`)).status).toBe(404)
  })

  it('can be reopened by the approver, forgetting what approval copied', async () => {
    expect((await api(org, 'accounts').post(`/api/payroll-runs/${runId}/reopen`)).status).toBe(403)

    const res = await api(org, 'super_admin').post(`/api/payroll-runs/${runId}/reopen`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'draft', approved_at: null, employer_name: null, assumed_days: null })
    const slip = (await api(org).get(`/api/payroll-runs/${runId}/payslips/${slipOf[asha]}`)).body.data
    expect(slip.uan).toBeNull()

    // Open again: HR's correction goes in now.
    expect((await api(org, 'hr').post('/api/attendance/mark', { employeeId: asha, date: '2026-08-11', status: 'present' })).status).toBe(201)

    const again = await api(org, 'super_admin').post(`/api/payroll-runs/${runId}/approve`, { confirmAssumedDays: true })
    expect(again.status).toBe(200)
  })

  it('records the payment only on a real day — not before the month, not in the future', async () => {
    expect((await api(org).post(`/api/payroll-runs/${runId}/mark-paid`, { paidOn: '2026-07-31' })).status).toBe(400)
    expect((await api(org).post(`/api/payroll-runs/${runId}/mark-paid`, { paidOn: '2099-01-01' })).status).toBe(400)
    expect((await api(org, 'hr').post(`/api/payroll-runs/${runId}/mark-paid`, { paidOn: '2026-09-01' })).status).toBe(403)
  })

  it('pays: every payslip written once, hashed, and the run locked for good', async () => {
    const res = await api(org).post(`/api/payroll-runs/${runId}/mark-paid`, { paidOn: '2026-09-01' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'paid', paid_on: '2026-09-01', paid_by_user_id: org.userId.accounts })

    const stored = await prisma.payslip.findMany({ where: { payrollRunId: runId } })
    expect(stored).toHaveLength(2)
    for (const slip of stored) {
      expect(slip.pdfKey).toMatch(new RegExp(`^org/${org.id}/payslip/${slip.employeeId}/${slip.id}-[0-9a-f]{16}\\.pdf$`))
      const bytes = await storage().get(slip.pdfKey!)
      expect(sha(bytes)).toBe(slip.pdfSha256)
      expect(bytes.length).toBe(slip.pdfBytes)
    }

    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: 'payroll.run_paid', entityId: runId } })).toBe(1)

    for (const action of ['approve', 'reopen', 'recalculate']) {
      const moved = await api(org, 'super_admin').post(`/api/payroll-runs/${runId}/${action}`, { confirmAssumedDays: true })
      expect(moved.status, action).toBe(409)
      expect(moved.body.error.message).toMatch(/It is paid/)
    }
    expect((await api(org).post(`/api/payroll-runs/${runId}/mark-paid`, { paidOn: '2026-09-01' })).status).toBe(409)
  })

  it('lets the employee see and download their own payslip — exactly the stored file', async () => {
    const mine = await api(org, 'employee').get('/api/payslips/me')
    expect(mine.body.data).toEqual([
      expect.objectContaining({ id: slipOf[asha], year: 2026, month: 8, paid_on: '2026-09-01', pdf_url: `/api/payslips/${slipOf[asha]}/pdf` }),
    ])

    const res = await download(org, 'employee', `/api/payslips/${slipOf[asha]}/pdf`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="payslip-2026-08-slipflow-\d+\.pdf"$/)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['cache-control']).toBe('private, no-store')

    const stored = await prisma.payslip.findUniqueOrThrow({ where: { id: slipOf[asha]! } })
    expect(sha(res.body as Buffer)).toBe(stored.pdfSha256)

    expect(
      await prisma.auditLog.count({ where: { organizationId: org.id, action: 'payslip.downloaded', entityId: slipOf[asha] } }),
    ).toBeGreaterThan(0)
  })

  it('keeps everybody else’s payslip out of an employee’s reach — and a manager’s, and HR’s', async () => {
    for (const role of ['employee', 'manager', 'hr'] as const) {
      expect((await download(org, role, `/api/payslips/${slipOf[ravi]}/pdf`)).status, role).toBe(404)
    }
    // Their own list is simply empty: none of them has a payslip here.
    expect((await api(org, 'manager').get('/api/payslips/me')).body.data).toEqual([])
    // Payroll staff reach the whole company.
    expect((await download(org, 'accounts', `/api/payslips/${slipOf[ravi]}/pdf`)).status).toBe(200)
  })

  it('serves the stored file from the run as well, not a new drawing of it', async () => {
    const stored = await prisma.payslip.findUniqueOrThrow({ where: { id: slipOf[ravi]! } })
    const res = await download(org, 'accounts', `/api/payroll-runs/${runId}/payslips/${slipOf[ravi]}/pdf`)
    expect(sha(res.body as Buffer)).toBe(stored.pdfSha256)
  })

  it('refuses a stored file that is not the one that was written', async () => {
    const stored = await prisma.payslip.findUniqueOrThrow({ where: { id: slipOf[asha]! } })
    const original = await storage().get(stored.pdfKey!)
    await storage().put(stored.pdfKey!, Buffer.concat([original, Buffer.from('tampered')]), 'application/pdf')
    try {
      expect((await download(org, 'employee', `/api/payslips/${slipOf[asha]}/pdf`)).status).toBe(500)
    } finally {
      await storage().put(stored.pdfKey!, original, 'application/pdf')
    }
    expect((await download(org, 'employee', `/api/payslips/${slipOf[asha]}/pdf`)).status).toBe(200)
  })

  it('is not reachable from another company', async () => {
    const other = await makeOrg('other')
    expect((await download(other, 'accounts', `/api/payslips/${slipOf[asha]}/pdf`)).status).toBe(404)
    expect((await api(other, 'super_admin').post(`/api/payroll-runs/${runId}/approve`)).status).toBe(404)
  })
})

describe('the payslip lock day', () => {
  it('stops an approved run being reopened once it has passed', async () => {
    // Day 1 of the following month — long gone by the time this runs.
    const org = await makeOrg('lockday', { payslipLockDay: 1 })
    await hire(org, { name: 'Meera Joshi', salary: { BASIC: 20_000 } })
    const run = (await api(org).post('/api/payroll-runs', AUGUST)).body.data
    expect((await api(org, 'super_admin').post(`/api/payroll-runs/${run.id}/approve`, { confirmAssumedDays: true })).status).toBe(200)

    const res = await api(org, 'super_admin').post(`/api/payroll-runs/${run.id}/reopen`)
    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/locked on day 1 of the following month/)
  })
})

describe('a payslip in another country’s layout', () => {
  it('keeps the employee’s country and currency on the payslip, and prints it', async () => {
    const org = await makeOrg('london')
    const id = await hire(org, { name: 'Oliver Smith', salary: { BASIC: 4_000 }, country: 'GB', currency: 'GBP' })
    const run = (await api(org).post('/api/payroll-runs', AUGUST)).body.data
    const slipId = run.payslips.find((s: { employee_id: string }) => s.employee_id === id).id

    const slip = (await api(org).get(`/api/payroll-runs/${run.id}/payslips/${slipId}`)).body.data
    expect(slip).toMatchObject({ country: 'GB', currency: 'GBP' })

    const pdf = await download(org, 'accounts', `/api/payroll-runs/${run.id}/payslips/${slipId}/pdf`)
    expect(pdf.status).toBe(200)
  })
})

describe('two approvers at the same moment', () => {
  it('approves once', async () => {
    const org = await makeOrg('race')
    await hire(org, { name: 'Kiran Rao', salary: { BASIC: 20_000 } })
    const run = (await api(org).post('/api/payroll-runs', AUGUST)).body.data

    const [a, b] = await Promise.all([
      api(org, 'super_admin').post(`/api/payroll-runs/${run.id}/approve`, { confirmAssumedDays: true }),
      api(org, 'super_admin').post(`/api/payroll-runs/${run.id}/approve`, { confirmAssumedDays: true }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: 'payroll.run_approved' } })).toBe(1)
  })
})

describe('what else a closed month refuses', () => {
  it('will not move or remove its holidays, or reverse its leave', async () => {
    const org = await makeOrg('closed')
    const id = await hire(org, { name: 'Sunita Rao', salary: { BASIC: 20_000 } })

    // Before the run: a holiday, and a day of approved leave.
    const holiday = await api(org, 'hr').post('/api/holidays', { name: 'Founders Day', date: '2026-08-14' })
    expect(holiday.status).toBe(201)
    const cl = await prisma.leaveType.create({ data: { organizationId: org.id, name: 'Casual Leave', code: 'CL', annualQuota: 12 } })
    await prisma.leaveLedgerEntry.create({
      data: { organizationId: org.id, employeeId: id, leaveTypeId: cl.id, leaveYear: 2026, days: 12, reason: 'opening_grant' },
    })
    const leave = await prisma.leaveRequest.create({
      data: {
        organizationId: org.id, employeeId: id, leaveTypeId: cl.id, fromDate: day('2026-08-18'), toDate: day('2026-08-18'),
        days: 1, leaveYear: 2026, reason: 'Family', status: 'pending',
      },
    })
    expect((await api(org, 'hr').post(`/api/leave-requests/${leave.id}/approve`)).status).toBe(200)

    const run = (await api(org).post('/api/payroll-runs', AUGUST)).body.data
    expect((await api(org, 'super_admin').post(`/api/payroll-runs/${run.id}/approve`, { confirmAssumedDays: true })).status).toBe(200)

    const holidayId = holiday.body.data.id
    expect((await api(org, 'hr').patch(`/api/holidays/${holidayId}`, { date: '2026-09-14' })).status).toBe(409)
    expect((await api(org, 'hr').delete(`/api/holidays/${holidayId}`)).status).toBe(409)
    expect((await api(org, 'hr').post(`/api/leave-requests/${leave.id}/reverse`)).status).toBe(409)

    // A holiday in September is nobody's business yet.
    expect((await api(org, 'hr').post('/api/holidays', { name: 'Later Day', date: '2026-09-21' })).status).toBe(201)
  })
})
