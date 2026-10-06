import { forOrg } from '../../platform/db/scoped'
import { withTransaction } from '../../platform/db/transaction'
import { logger } from '../../platform/logger'
import { notify } from '../notifications/notify.service'
import { otherLoginsOfPerson } from '../notifications/notification.repository'

/**
 * The security notice in the bell: this account's password changed.
 *
 * Sent however it changed — by the person while signed in, through a reset
 * link their administrator issued, or set for them by HR or the Super Admin —
 * because each is what somebody who took over the account would do. It used to
 * be sent from the BROWSER after a change, so any page could send one and a
 * reset never produced one.
 *
 * Best effort: the password has already changed by now, and a notice that
 * cannot be written must not undo that.
 */
export type PasswordChange =
  | { how: 'changed' }
  | { how: 'reset' }
  /** Set for them; `by` is who, as the notice names them ("HR", "the Super Admin"). */
  | { how: 'set'; by: string }

function told(change: PasswordChange): { title: string; message: string; done: string } {
  switch (change.how) {
    case 'reset':
      return {
        title: 'Your password was changed',
        message: 'Your password was reset with a link from your administrator, and every other device was signed out. If this was not you, tell your administrator at once.',
        done: 'reset with a link from your administrator',
      }
    case 'set':
      return {
        title: 'A new password was set for you',
        message: `${change.by.charAt(0).toUpperCase()}${change.by.slice(1)} set a new password for you, and every device signed in with the old one was signed out. If you did not ask for it, tell the Super Admin at once.`,
        done: `set by ${change.by}`,
      }
    default:
      return {
        title: 'Your password was changed',
        message: 'Your password was changed and every other device was signed out. If this was not you, ask your administrator to reset it at once.',
        done: 'changed',
      }
  }
}

export async function tellPasswordChanged(organizationId: string, userId: string, change: PasswordChange): Promise<void> {
  const { title, message, done } = told(change)
  try {
    await withTransaction(forOrg(organizationId), async (tx) => {
      await notify({ organizationId, userId }, tx, {
        event: 'account.password_changed',
        to: { users: [userId] },
        includeActor: true,
        title,
        message,
        link: null,
      })
      // Somebody with two logins (Day 23) is told on the other one too: a
      // reset taken over by somebody else is read where they still get in.
      const { email, others } = await otherLoginsOfPerson(tx, userId)
      if (others.length > 0) {
        await notify({ organizationId, userId }, tx, {
          event: 'account.password_changed',
          to: { users: others },
          includeActor: true,
          title: 'The password of your other login was changed',
          message: `The password of ${email ?? 'your employee login'} was ${done}. If this was not you, tell your administrator at once.`,
          link: null,
        })
      }
    })
  } catch (err) {
    logger.error('Password-change notice could not be written', { userId, error: err instanceof Error ? err.message : String(err) })
  }
}
