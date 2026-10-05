import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'

/**
 * Every CSV through the one writer: the BOM Excel needs, CRLF, quoting that
 * survives a comma or a quote, and a cell beginning "=" disarmed. The six old
 * exporters had none of those. Field access holds in a file as on screen.
 */

const PREFIX = 'exptest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()
const day = (d: string) => new Date(`${d}T00:00:00Z`)

let orgId = ''
const token = {} as Record<'admin' | 'hr', string>

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.attendance.deleteMany({ where: org })
  await prisma.employeeFinancial.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.department.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

const csv = (who: 'admin' | 'hr', url: string) =>
  request(app)
    .get(url)
    .set('Authorization', `Bearer ${token[who]}`)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => callback(null, Buffer.concat(chunks)))
    })

const linesOf = (body: Buffer) => {
  const text = body.toString('utf8')
  expect(text.startsWith('﻿')).toBe(true)
  expect(text).toContain('\r\n')
  return text.slice(1).split('\r\n').filter(Boolean)
}

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })).id
  const sales = await prisma.department.create({ data: { organizationId: orgId, name: 'Sales' } })
  const plain = await prisma.employee.create({ data: { organizationId: orgId, employeeCode: 'EX-1', fullName: 'Rao, "Ravi"', personalEmail: 'zzfind@example.com', departmentId: sales.id, dateOfJoining: day('2025-04-01') } })
  const trap = await prisma.employee.create({ data: { organizationId: orgId, employeeCode: 'EX-2', fullName: '=HYPERLINK("http://evil.example")', dateOfJoining: day('2025-04-01') } })
  await prisma.employeeFinancial.create({ data: { organizationId: orgId, employeeId: plain.id, ctc: 480000, effectiveFrom: day('2025-04-01') } })
  // 09:30 and 18:45 in Kolkata.
  await prisma.attendance.create({
    data: { organizationId: orgId, employeeId: plain.id, date: day('2026-09-25'), status: 'present', source: 'manual', checkIn: new Date('2026-09-25T04:00:00Z'), checkOut: new Date('2026-09-25T13:15:00Z'), hoursWorked: 9.25 },
  })
  void trap

  for (const [key, role] of [['admin', 'super_admin'], ['hr', 'hr']] as const) {
    const email = `${PREFIX}-${key}@example.com`
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
    await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status: 'active' } })
    token[key] = (await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })).body.data.accessToken
  }
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('the employee export', () => {
  it('quotes what needs quoting and disarms a formula', async () => {
    const res = await csv('admin', '/api/employees/export')
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="employees-\d{4}-\d{2}-\d{2}\.csv"$/)
    const lines = linesOf(res.body as Buffer)
    expect(lines[0]).toBe('Full Name,Employee Code,Department,Designation,Phone,Employment Type,Date of Joining,Last Working Day,Stage,Status,CTC')
    expect(lines).toContain('"Rao, ""Ravi""",EX-1,Sales,,,Full time,2025-04-01,,Onboarding,active,480000')
    // The leading apostrophe keeps Excel from running it.
    expect(lines.find((l) => l.includes('EX-2'))).toMatch(/^"'=HYPERLINK\(""http:\/\/evil\.example""\)",EX-2/)
  })

  it('shows HR every salary but the seniors’ — for a login with no place in the tree, all but the Super Admins’', async () => {
    // HR sees salaries except their seniors' (Day 22). The owner and the Super
    // Admins are always seniors, so an HR login with no employee record sees
    // everybody else's, and theirs never.
    const lines = linesOf((await csv('hr', '/api/employees/export')).body as Buffer)
    expect(lines[0]!.endsWith(',CTC')).toBe(true)
    expect(lines.find((l) => l.includes('EX-1'))).toMatch(/,480000$/)
  })

  it('follows the page’s filters, and is recorded', async () => {
    const lines = linesOf((await csv('admin', '/api/employees/export?search=EX-2')).body as Buffer)
    expect(lines).toHaveLength(2)
    const event = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: 'employee.exported' }, orderBy: { createdAt: 'desc' } })
    expect(event?.details).toMatchObject({ rows: 1, withCompensation: true })
  })

  it('searches the name and the code only, as the page does — not a personal email', async () => {
    const lines = linesOf((await csv('admin', '/api/employees/export?search=zzfind')).body as Buffer)
    expect(lines).toHaveLength(1)
  })
})

describe('the attendance export', () => {
  it('is the day’s roster, times in the company’s zone, and the unmarked said as such', async () => {
    const res = await csv('hr', '/api/attendance/export?date=2026-09-25')
    expect(res.headers['content-disposition']).toBe('attachment; filename="attendance-2026-09-25.csv"')
    const lines = linesOf(res.body as Buffer)
    expect(lines[0]).toBe('Employee Name,Employee Code,Department,Designation,Status,Check In,Check Out,Hours Worked,Work Mode,Note')
    expect(lines).toContain('"Rao, ""Ravi""",EX-1,Sales,,Present,09:30,18:45,9.25,,')
    expect(lines.find((l) => l.includes('EX-2'))).toContain(',Not marked,')
  })

  it('follows the page’s tab, department and search, so the file is what was on screen', async () => {
    const unmarked = linesOf((await csv('hr', '/api/attendance/export?date=2026-09-25&status=unmarked')).body as Buffer)
    expect(unmarked.slice(1).map((l) => l.includes('EX-2'))).toEqual([true])
    const present = linesOf((await csv('hr', '/api/attendance/export?date=2026-09-25&status=present&department=Sales')).body as Buffer)
    expect(present).toHaveLength(2)
    const searched = linesOf((await csv('hr', '/api/attendance/export?date=2026-09-25&search=ex-2')).body as Buffer)
    expect(searched).toHaveLength(2)
    expect(searched[1]).toContain('EX-2')
  })
})

describe('the import template', () => {
  it('has the columns the importer reads', async () => {
    const lines = linesOf((await csv('hr', '/api/employees/import/template')).body as Buffer)
    expect(lines[0]).toBe('employee_code,full_name,email,personal_email,phone,date_of_joining,employment_type,department,designation,shift,pan,gender,confirmed_on,date_of_birth')
    // A new joiner, and somebody already working here (confirmed_on filled); each with a date of birth.
    expect(lines).toHaveLength(3)
    expect(lines[2]).toMatch(/,06\/07\/2025,22\/11\/1990$/)
  })
})
