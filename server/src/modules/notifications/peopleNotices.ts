import type { TxDb } from '../../platform/db/transaction'
import { dayLabel, type CalendarDate } from '../../domain/shared/dates'
import { notify, type NoticeActor, type Recipients } from './notify.service'
import * as repo from './notification.repository'

/**
 * Somebody joining or leaving (client §45: "Employee created", "Employee
 * deactivated"), told to the person they report to and to HR who keep their
 * record — inside the transaction that adds or removes them.
 */

function around(employeeId: string, managerId: string | null): Recipients {
  return {
    all: [
      ...(managerId ? [{ employee: managerId } as const] : []),
      { reaching: { permission: 'employee:update', resource: 'employee', employeeId } },
    ],
  }
}

export async function tellJoined(ctx: NoticeActor, tx: TxDb, employeeId: string, joining: CalendarDate | null): Promise<void> {
  const person = await repo.personBrief(tx, employeeId)
  if (!person) return
  await notify(ctx, tx, {
    event: 'employment.joined',
    to: around(employeeId, person.reportingManagerId),
    title: 'New employee added',
    message: `${person.fullName} (${person.employeeCode}) has been added${joining ? `, joining on ${dayLabel(joining)}` : ''}.`,
    link: `/employees?open=${employeeId}`,
    entity: { type: 'employee', id: employeeId },
    notAbout: employeeId,
  })
}

export async function tellLeft(ctx: NoticeActor, tx: TxDb, employeeId: string, lastDay: CalendarDate | null, how: 'exit' | 'access_removed'): Promise<void> {
  const person = await repo.personBrief(tx, employeeId)
  if (!person) return
  const when = lastDay ? ` Last working day: ${dayLabel(lastDay)}.` : ''
  await notify(ctx, tx, {
    event: 'employment.left',
    to: around(employeeId, person.reportingManagerId),
    title: how === 'exit' ? 'Employee has left' : 'Employee deactivated',
    message: how === 'exit'
      ? `${person.fullName} (${person.employeeCode})’s exit is complete, and their sign-in is closed.${when}`
      : `${person.fullName} (${person.employeeCode}) can no longer sign in, and is marked as having left.${when}`,
    link: null,
    entity: { type: 'employee', id: employeeId },
    notAbout: employeeId,
  })
}
