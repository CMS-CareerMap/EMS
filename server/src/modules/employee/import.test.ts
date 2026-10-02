import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { hashInviteToken } from '../../platform/auth/tokenHash'
import { fromDateColumn } from '../../domain/shared/dates'

/**
 * CSV roster import.
 *
 * The requirement the guide sets is unusually precise: "you import the client's
 * real roster and NONE OF THEM CAN LOG IN until they set a password." That is
 * the test that matters — importing fifty people who all share a default
 * password would be worse than not importing them at all, and it is exactly
 * what happens when somebody adds a `password` column to make onboarding easier.
 */

const PREFIX = 'imptest'
const PASSWORD = 'CorrectHorseBattery1'

const app = createApp()

let orgId = ''
const tokens: Record<string, string> = {}

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.employeeStatutoryIdentity.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.passwordResetToken.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } })
  await prisma.refreshToken.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.department.deleteMany({ where: org })
  await prisma.designation.deleteMany({ where: org })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function makeUser(key: string, role: 'super_admin' | 'hr' | 'manager') {
  const email = `${PREFIX}-${key}@example.com`
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD) },
  })
  await prisma.membership.create({
    data: { userId: user.id, organizationId: orgId, role, status: 'active' },
  })
  const res = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })
  tokens[key] = res.body.data.accessToken
}

function upload(csv: string, dryRun = true, key = 'hr') {
  return request(app)
    .post('/api/employees/import')
    .set('Authorization', `Bearer ${tokens[key]}`)
    .send({ csv, dryRun })
}

const HEADER = 'employee_code,full_name,email,phone,date_of_joining,department,designation,pan'

beforeAll(async () => {
  await cleanup()
  const org = await prisma.organization.create({ data: { name: `${PREFIX}-org` } })
  orgId = org.id

  await prisma.department.create({ data: { organizationId: orgId, name: 'Sales' } })
  await prisma.designation.create({ data: { organizationId: orgId, name: 'Executive' } })

  await makeUser('hr', 'hr')
  await makeUser('mgr', 'manager')
})

beforeEach(async () => {
  await prisma.employeeStatutoryIdentity.deleteMany({
    where: { employee: { employeeCode: { startsWith: `${PREFIX}-E` } } },
  })
  await prisma.employee.deleteMany({ where: { employeeCode: { startsWith: `${PREFIX}-E` } } })
  await prisma.passwordResetToken.deleteMany({
    where: { user: { email: { startsWith: `${PREFIX}-staff` } } },
  })
  await prisma.membership.deleteMany({ where: { user: { email: { startsWith: `${PREFIX}-staff` } } } })
  await prisma.user.deleteMany({ where: { email: { startsWith: `${PREFIX}-staff` } } })
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('the preview', () => {
  it('reports what would happen and writes nothing', async () => {
    const csv = [
      HEADER,
      `${PREFIX}-E1,Asha Menon,${PREFIX}-staff1@example.com,9876543210,01/04/2026,Sales,Executive,ABCDE1234F`,
      `${PREFIX}-E2,Rahul Nair,${PREFIX}-staff2@example.com,9876543211,15/04/2026,Sales,Executive,`,
    ].join('\n')

    const res = await upload(csv)

    expect(res.status).toBe(200)
    expect(res.body.data.dry_run).toBe(true)
    expect(res.body.data.summary.total_rows).toBe(2)
    expect(res.body.data.summary.valid).toBe(2)
    expect(res.body.data.summary.imported).toBe(0)

    // The whole point of a preview.
    expect(await prisma.employee.count({ where: { employeeCode: { startsWith: `${PREFIX}-E` } } })).toBe(0)
  })

  it('previews by default, so a forgotten flag cannot import 500 people', async () => {
    const csv = [HEADER, `${PREFIX}-E1,Asha Menon,,,,,,`].join('\n')

    const res = await request(app)
      .post('/api/employees/import')
      .set('Authorization', `Bearer ${tokens.hr}`)
      .send({ csv })

    expect(res.body.data.dry_run).toBe(true)
    expect(await prisma.employee.count({ where: { employeeCode: `${PREFIX}-E1` } })).toBe(0)
  })

  it('names the line number the spreadsheet shows', async () => {
    const csv = [
      HEADER,
      `${PREFIX}-E1,Asha Menon,,,,,,`,
      `,Missing Code,,,,,,`,
    ].join('\n')

    const res = await upload(csv)
    const bad = res.body.data.rows.find((r: { line: number }) => r.line === 3)

    // Line 3, not row 2 or index 1 — what HR sees when they open the file.
    expect(bad.issues.length).toBeGreaterThan(0)
    expect(JSON.stringify(bad.issues)).toMatch(/employee code/i)
  })
})

describe('what the preview catches', () => {
  it('a date it cannot read', async () => {
    const csv = [HEADER, `${PREFIX}-E1,Asha Menon,,,not-a-date,,,`].join('\n')
    const res = await upload(csv)
    expect(JSON.stringify(res.body.data.rows[0].issues)).toMatch(/DD\/MM\/YYYY/)
  })

  it('a malformed PAN', async () => {
    const csv = [HEADER, `${PREFIX}-E1,Asha Menon,,,,,,NOTAPAN`].join('\n')
    const res = await upload(csv)
    expect(JSON.stringify(res.body.data.rows[0].issues)).toMatch(/ABCDE1234F/)
  })

  it('a department that does not exist, rather than creating it', async () => {
    const csv = [HEADER, `${PREFIX}-E1,Asha Menon,,,,Marketing,,`].join('\n')
    const res = await upload(csv)

    // Creating it silently is how a company ends up with "Sales", "sales " and
    // "Salse" as three departments.
    expect(JSON.stringify(res.body.data.rows[0].issues)).toMatch(/no department called/)
    expect(await prisma.department.count({ where: { organizationId: orgId } })).toBe(1)
  })

  it('a code that already exists in the system', async () => {
    await prisma.employee.create({
      data: { organizationId: orgId, employeeCode: `${PREFIX}-E9`, fullName: 'Already Here' },
    })

    const csv = [HEADER, `${PREFIX}-E9,Someone Else,,,,,,`].join('\n')
    const res = await upload(csv)

    expect(JSON.stringify(res.body.data.rows[0].issues)).toMatch(/already exists/)
    await prisma.employee.deleteMany({ where: { employeeCode: `${PREFIX}-E9` } })
  })

  it('a code repeated inside the file itself', async () => {
    const csv = [
      HEADER,
      `${PREFIX}-E1,Asha Menon,,,,,,`,
      `${PREFIX}-E1,Rahul Nair,,,,,,`,
    ].join('\n')

    const res = await upload(csv)

    // Without this the import would fail halfway through on a constraint
    // violation, with no useful message about which lines collided.
    expect(JSON.stringify(res.body.data.rows[1].issues)).toMatch(/also appears on line 2/)
  })

  it('an email repeated inside the file', async () => {
    const csv = [
      HEADER,
      `${PREFIX}-E1,Asha Menon,${PREFIX}-staff1@example.com,,,,,`,
      `${PREFIX}-E2,Rahul Nair,${PREFIX}-staff1@example.com,,,,,`,
    ].join('\n')

    const res = await upload(csv)
    expect(JSON.stringify(res.body.data.rows[1].issues)).toMatch(/also appears on line 2/)
  })
})

describe('reading real spreadsheets', () => {
  it('accepts the header names other systems export', async () => {
    const csv = [
      'Employee ID,Name,Work Email,Mobile,DOJ,Dept,Job Title',
      `${PREFIX}-E1,Asha Menon,${PREFIX}-staff1@example.com,9876543210,01/04/2026,Sales,Executive`,
    ].join('\n')

    const res = await upload(csv)
    expect(res.body.data.summary.valid).toBe(1)
  })

  it('reads 05/11/2026 as 5 November, not 11 May', async () => {
    const csv = [HEADER, `${PREFIX}-E1,Asha Menon,,,05/11/2026,,,`].join('\n')

    await upload(csv, false)

    const employee = await prisma.employee.findFirst({ where: { employeeCode: `${PREFIX}-E1` } })
    // A roster exported in India is day-first. Reading it month-first gives a
    // plausible, silent, wrong answer — the worst kind.
    expect(fromDateColumn(employee?.dateOfJoining)).toBe('2026-11-05')
  })

  it('handles a comma inside a quoted name', async () => {
    const csv = [HEADER, `${PREFIX}-E1,"Menon, Asha",,,,,,`].join('\n')

    const res = await upload(csv)
    expect(res.body.data.summary.valid).toBe(1)
    expect(res.body.data.rows[0].full_name).toBe('Menon, Asha')
  })

  it('ignores columns it does not know', async () => {
    const csv = [
      `${HEADER},blood_group,t_shirt_size`,
      `${PREFIX}-E1,Asha Menon,,,,,,,O+,M`,
    ].join('\n')

    const res = await upload(csv)
    // Refusing a whole roster over a Blood Group column would be obstructive.
    expect(res.body.data.summary.valid).toBe(1)
  })
})

describe('the real import', () => {
  const twoGoodRows = [
    HEADER,
    `${PREFIX}-E1,Asha Menon,${PREFIX}-staff1@example.com,9876543210,01/04/2026,Sales,Executive,ABCDE1234F`,
    `${PREFIX}-E2,Rahul Nair,${PREFIX}-staff2@example.com,9876543211,15/04/2026,Sales,Executive,`,
  ].join('\n')

  it('writes the employees, their departments and their PANs', async () => {
    const res = await upload(twoGoodRows, false)

    expect(res.status).toBe(201)
    expect(res.body.data.summary.imported).toBe(2)

    const asha = await prisma.employee.findFirst({
      where: { employeeCode: `${PREFIX}-E1` },
      include: { department: true, designation: true, statutoryIdentity: true },
    })

    expect(asha?.fullName).toBe('Asha Menon')
    expect(asha?.department?.name).toBe('Sales')
    expect(asha?.designation?.name).toBe('Executive')
    expect(asha?.statutoryIdentity?.pan).toBe('ABCDE1234F')
    expect(fromDateColumn(asha?.dateOfJoining)).toBe('2026-04-01')
  })

  it('refuses the whole file when any row is bad, leaving nothing behind', async () => {
    const csv = [
      HEADER,
      `${PREFIX}-E1,Asha Menon,,,,,,`,
      `${PREFIX}-E2,Rahul Nair,,,,Marketing,,`,
    ].join('\n')

    const res = await upload(csv, false)

    expect(res.status).toBe(400)
    // "47 of 50 imported" leaves somebody working out which three.
    expect(await prisma.employee.count({ where: { employeeCode: { startsWith: `${PREFIX}-E` } } })).toBe(0)
  })

  it('refuses a manager, who may read the directory but not fill it', async () => {
    const res = await upload(twoGoodRows, false, 'mgr')
    expect(res.status).toBe(403)
  })
})

describe('gender, which professional tax depends on', () => {
  const GENDER_HEADER = 'employee_code,full_name,gender'

  it('reads the spellings an old system exports', async () => {
    const csv = [
      GENDER_HEADER,
      `${PREFIX}-E1,Asha Menon,F`,
      `${PREFIX}-E2,Rahul Nair,Male`,
      `${PREFIX}-E3,Sam Iyer,`,
    ].join('\n')

    const res = await upload(csv, false)
    expect(res.status).toBe(201)

    const genders = await prisma.employee.findMany({
      where: { employeeCode: { startsWith: `${PREFIX}-E` } },
      orderBy: { employeeCode: 'asc' },
      select: { gender: true },
    })

    // Blank is left unrecorded — not guessed from a name, which is exactly the
    // kind of inference that is wrong often enough to matter.
    expect(genders.map((g) => g.gender)).toEqual(['female', 'male', null])
  })

  it('names a value it cannot read, rather than dropping it', async () => {
    const csv = [GENDER_HEADER, `${PREFIX}-E1,Asha Menon,femail`].join('\n')
    const res = await upload(csv)

    expect(JSON.stringify(res.body.data.rows[0].issues)).toMatch(/male, female, other/)
  })
})

describe('NONE of them can log in until they set a password', () => {
  const csv = [
    HEADER,
    `${PREFIX}-E1,Asha Menon,${PREFIX}-staff1@example.com,,,,,`,
    `${PREFIX}-E2,Rahul Nair,${PREFIX}-staff2@example.com,,,,,`,
  ].join('\n')

  it('creates them with NO password hash at all', async () => {
    await upload(csv, false)

    const users = await prisma.user.findMany({
      where: { email: { startsWith: `${PREFIX}-staff` } },
    })

    expect(users).toHaveLength(2)
    for (const user of users) {
      // Null, not a default, not a shared welcome password. Null cannot match
      // any input, so there is nothing to guess and nothing to circulate.
      expect(user.passwordHash, `${user.email} must have no password`).toBeNull()
    }
  })

  it('leaves every one of them unable to sign in', async () => {
    await upload(csv, false)

    for (const email of [`${PREFIX}-staff1@example.com`, `${PREFIX}-staff2@example.com`]) {
      for (const attempt of [PASSWORD, 'EMS@2026', 'password123', '']) {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ identifier: email, password: attempt })

        expect(res.status, `${email} must not sign in with "${attempt}"`).not.toBe(200)
      }
    }
  })

  it('marks them invited, not active', async () => {
    await upload(csv, false)

    const memberships = await prisma.membership.findMany({
      where: { user: { email: { startsWith: `${PREFIX}-staff` } } },
    })

    for (const membership of memberships) {
      expect(membership.status).toBe('invited')
      // Always the narrowest role. A spreadsheet must not be able to create an
      // administrator, which is why there is no role column to read.
      expect(membership.role).toBe('employee')
    }
  })

  it('returns one invitation token each, stored only as a hash', async () => {
    const res = await upload(csv, false)

    expect(res.body.data.invites).toHaveLength(2)

    for (const invite of res.body.data.invites) {
      const stored = await prisma.passwordResetToken.findUnique({
        where: { tokenHash: hashInviteToken(invite.token) },
      })

      // The row exists and holds the hash — so the token in this response is
      // the only copy anybody will ever see.
      expect(stored, 'the token must match a stored hash').not.toBeNull()
      expect(stored?.usedAt).toBeNull()
      expect(stored?.purpose).toBe('invite')
    }
  })

  it('lets each of them in once they set a password with their own link', async () => {
    // The other half of the rule, and the half that was missing: "until they
    // set a password" used to mean "for ever", because nothing accepted the
    // link. Each imported person redeems their own and can then sign in.
    const res = await upload(csv, false)
    const chosen = 'MyOwnFirstPassword1'

    for (const invite of res.body.data.invites) {
      const accepted = await request(app)
        .post('/api/auth/password-link/redeem')
        .send({ token: invite.token, password: chosen })
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)

      const signedIn = await request(app)
        .post('/api/auth/login')
        .send({ identifier: invite.email, password: chosen })
      expect(signedIn.status, `${invite.email} should sign in after accepting`).toBe(200)
    }
  })

  it('imports an employee with no email at all, and gives them no login', async () => {
    const noEmail = [HEADER, `${PREFIX}-E3,Site Worker,,,,,,`].join('\n')
    await upload(noEmail, false)

    const employee = await prisma.employee.findFirst({ where: { employeeCode: `${PREFIX}-E3` }, include: { memberships: true } })

    // A record for someone who does not use the system is a legitimate thing
    // to have — attendance can still be marked for them by HR.
    expect(employee).not.toBeNull()
    expect(employee?.memberships).toEqual([])
  })
})

describe('limits', () => {
  it('refuses a file over 1 MB', async () => {
    // Under 500 rows on purpose, so the SIZE limit is what refuses this and
    // not the row count.
    const padding = 'x'.repeat(3000)
    const rows = Array.from(
      { length: 400 },
      (_, i) => `${PREFIX}-E${i},Name ${padding},,,,,,`,
    )
    const res = await upload([HEADER, ...rows].join('\n'), true)

    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/1 MB/)
  })

  it('refuses more than 500 rows', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => `${PREFIX}-E${i},Name ${i},,,,,,`)
    const res = await upload([HEADER, ...rows].join('\n'), true)

    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/500/)
  })

  it('refuses a file with only a header', async () => {
    const res = await upload(HEADER, true)
    expect(res.status).toBe(400)
  })
})

describe('an upload that is too large for the request itself', () => {
  it('answers 413, not 500', async () => {
    // Past the 2 MB the import route parses, so body-parser refuses it before
    // any of our code runs. That used to surface as a 500 — "the system broke"
    // for what is really "that file is too big", and it would be investigated
    // as an outage.
    const huge = 'x'.repeat(3_000_000)

    const res = await request(app)
      .post('/api/employees/import')
      .set('Authorization', `Bearer ${tokens.hr}`)
      .send({ csv: huge })

    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE')
    expect(res.body.error.requestId).toEqual(expect.any(String))
  })
})
