import { forOrg } from '../../platform/db/scoped'
import { withTransaction } from '../../platform/db/transaction'
import { logger } from '../../platform/logger'
import { notify } from '../notifications/notify.service'
import { otherLoginsOfPerson } from '../notifications/notification.repository'

/**
 * The security notice in the bell: this account's password changed.
 *
 * Sent however it changed — by the person while signed in, or through a reset
 * link their administrator issued — because either one is what somebody who
 * took over the account would do. It used to be sent from the BROWSER after a
 * change, so any page could send one and a reset never produced one.
 *
 * Best effort: the password has already changed by now, and a notice that
 * cannot be written must not undo that.
 */
export async function tellPasswordChanged(organizationId: string, userId: string, how: 'changed' | 'reset'): Promise<void> {
  try {
    await withTransaction(forOrg(organizationId), async (tx) => {
      await notify({ organizationId, userId }, tx, {
        event: 'account.password_changed',
        to: { users: [userId] },
        includeActor: true,
        title: 'Your password was changed',
        message:
          how === 'reset'
            ? 'Your password was reset with a link from your administrator, and every other device was signed out. If this was not you, tell your administrator at once.'
            : 'Your password was changed and every other device was signed out. If this was not you, ask your administrator to reset it at once.',
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
          message: `The password of ${email} was ${how === 'reset' ? 'reset with a link from your administrator' : 'changed'}. If this was not you, tell your administrator at once.`,
          link: null,
        })
      }
    })
  } catch (err) {
    logger.error('Password-change notice could not be written', { userId, error: err instanceof Error ? err.message : String(err) })
  }
}
