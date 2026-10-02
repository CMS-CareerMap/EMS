import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { isoInstant } from '../../domain/shared/dates'

/**
 * Day 19's half of bank accounts: the employee sends in their own, with a
 * photo or PDF of a cancelled cheque or passbook page, and Accounts checks it
 * against that proof.
 */

const PREFIX = 'proofkest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()
const day = (d: string) => new Date(`${d}T00:00:00Z`)

type Who = 'super_admin' | 'accounts' | 'esha'
let orgId = ''
const token = {} as Record<Who, string>
const userId = {} as Record<Who, string>
const employee = {} as Record<'esha' | 'anil', string>

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)])
const PDF = Buffer.from('%PDF-1.4\n% passbook\n%%EOF\n')
const BIG = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1_600_000, 0x20)])

const details = { bankName: 'HDFC Bank', accountHolderName: 'ESHA IYER', accountNumber: '000123456789', ifsc: 'HDFC0001234', accountType: 'Savings' }

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.notification.deleteMany({ where: org })
  await prisma.employeeBankAccount.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

function send(who: Who, url: string, fields: Record<string, string>, proof?: { bytes: Buffer; name: string; type: string }) {
  let req = request(app).put(url).set('Authorization', `Bearer ${token[who]}`)
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v)
  if (proof) req = req.attach('proof', proof.bytes, { filename: proof.name, contentType: proof.type })
  return req
}
const own = (fields: Record<string, string>, proof?: { bytes: Buffer; name: string; type: string }) => send('esha', '/api/payslips/me/bank-account', fields, proof)
const cheque = { bytes: PNG, name: 'cheque.png', type: 'image/png' }

const noticesOf = (who: Who, event: string) => prisma.notification.findMany({ where: { organizationId: orgId, userId: userId[who], event }, orderBy: { createdAt: 'desc' } })

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata', maxUploadMb: 1 } })).id
  for (const [who, role] of [['super_admin', 'super_admin'], ['accounts', 'accounts'], ['esha', 'employee']] as const) {
    const email = `${PREFIX}-${who}@example.com`
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
    const m = await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status: 'active' } })
    userId[who] = user.id
    if (who !== 'super_admin') {
      const e = await prisma.employee.create({ data: { organizationId: orgId, employeeCode: `PK-${who}`, fullName: who === 'esha' ? 'Esha Iyer' : 'Anil Accountant', dateOfJoining: day('2025-01-01'), memberships: { connect: { id: m.id } } } })
      employee[who === 'esha' ? 'esha' : 'anil'] = e.id
    }
    token[who] = (await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })).body.data.accessToken
  }
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('an employee sending in their bank account', () => {
  it('must attach a cheque or passbook page', async () => {
    const res = await own(details)
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/cancelled cheque or a passbook page/)
  })

  it('refuses a proof that is not a photo or PDF, or is over the company cap', async () => {
    expect((await own(details, { bytes: Buffer.from('<html>'), name: 'cheque.png', type: 'image/png' })).status).toBe(400)
    expect((await own(details, { bytes: BIG, name: 'cheque.pdf', type: 'application/pdf' })).status).toBe(413)
  })

  it('waits for Accounts, who are told — and the audit keeps only the last four digits', async () => {
    const res = await own(details, cheque)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ account_ending: '6789', verification_status: 'pending', has_proof: true })

    for (const who of ['accounts', 'super_admin'] as const) {
      const [notice] = await noticesOf(who, 'bank.submitted')
      expect(notice?.message).toBe('Esha Iyer sent in bank details (account ending 6789). Check them against the proof attached.')
      expect(notice?.link).toBe('/payroll?tab=bank')
    }
    expect(await noticesOf('esha', 'bank.submitted')).toHaveLength(0)

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'bank_account.submitted' } })
    expect(JSON.stringify(audit.details)).not.toContain('000123456789')
    expect(audit.details).toMatchObject({ accountEnding: '6789', proofAttached: true })
  })

  it('shows Accounts the proof, and that the employee sent it', async () => {
    const list = await request(app).get('/api/payroll/bank-accounts').set('Authorization', `Bearer ${token.accounts}`)
    const esha = list.body.data.find((r: { employee_id: string }) => r.employee_id === employee.esha)
    expect(esha.bank_account).toMatchObject({ submitted_by_employee: true, proof: { file_name: 'cheque.png', content_type: 'image/png' } })

    const file = await request(app).get(`/api/payroll/employees/${employee.esha}/bank-account/proof`).set('Authorization', `Bearer ${token.accounts}`)
    expect(file.status).toBe(200)
    expect(file.headers['content-type']).toBe('image/png')
    expect(file.headers['content-disposition']).toBe('attachment; filename="PK-esha-bank-proof.png"')
    expect(file.headers['x-content-type-options']).toBe('nosniff')
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, action: 'bank_account.proof_downloaded' } })).toBe(1)

    expect((await request(app).get(`/api/payroll/employees/${employee.esha}/bank-account/proof`).set('Authorization', `Bearer ${token.esha}`)).status).toBe(403)
  })

  it('tells the employee what Accounts decided', async () => {
    const res = await request(app).post(`/api/payroll/employees/${employee.esha}/bank-account/verify`).set('Authorization', `Bearer ${token.accounts}`).send({ decision: 'verified', accountUpdatedAt: isoInstant((await prisma.employeeBankAccount.findFirstOrThrow({ where: { employeeId: employee.esha } })).updatedAt) })
    expect(res.status).toBe(200)
    expect((await noticesOf('esha', 'bank.decided'))[0]).toMatchObject({ title: 'Bank account verified', message: 'Your salary account ending 6789 was verified.' })
  })

  it('goes back to waiting whenever the employee changes anything — and a new number needs a new proof', async () => {
    const branch = await own({ ...details, branch: 'Baner' })
    expect(branch.status).toBe(200)
    expect(branch.body.data.verification_status).toBe('pending')

    const newNumber = await own({ ...details, accountNumber: '999988887777' })
    expect(newNumber.status).toBe(400)
    const withProof = await own({ ...details, accountNumber: '999988887777' }, { bytes: PDF, name: 'passbook.pdf', type: 'application/pdf' })
    expect(withProof.body.data).toMatchObject({ account_ending: '7777', verification_status: 'pending', has_proof: true })
  })
})

describe('Accounts entering an account', () => {
  it('may attach the proof, and a changed account without one keeps no old proof', async () => {
    const entered = await send('accounts', `/api/payroll/employees/${employee.esha}/bank-account`, { ...details, accountNumber: '111122223333', markVerified: 'true' }, cheque)
    expect(entered.status).toBe(200)
    expect(entered.body.data.bank_account).toMatchObject({ verification_status: 'verified', proof: { content_type: 'image/png' } })

    const changed = await request(app)
      .put(`/api/payroll/employees/${employee.esha}/bank-account`)
      .set('Authorization', `Bearer ${token.accounts}`)
      .send({ ...details, accountNumber: '444455556666' })
    expect(changed.status).toBe(200)
    expect(changed.body.data.bank_account).toMatchObject({ verification_status: 'pending', proof: null })
  })
})
