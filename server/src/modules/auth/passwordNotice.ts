import { forOrg } from '../../platform/db/scoped'
import { withTransaction } from '../../platform/db/transaction'
import { logger } from '../../platform/logger'
import { notify } from '../notifications/notify.service'

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
    await withTransaction(forOrg(organizationId), (tx) =>
      notify({ organizationId, userId }, tx, {
        event: 'account.password_changed',
        to: { users: [userId] },
        includeActor: true,
        title: 'Your password was changed',
        message:
          how === 'reset'
            ? 'Your password was reset with a link from your administrator, and every other device was signed out. If this was not you, tell your administrator at once.'
            : 'Your password was changed and every other device was signed out. If this was not you, ask your administrator to reset it at once.',
        link: null,
      }),
    )
  } catch (err) {
    logger.error('Password-change notice could not be written', { userId, error: err instanceof Error ? err.message : String(err) })
  }
}
