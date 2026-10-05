import { useAuthStore } from '../stores/authStore'
import { ROUTE_PERMISSIONS } from '../config/navigation'
import { useTeamLeave } from './useLeave'
import { useWaitingRequests } from './useRequests'

/**
 * The small numbers on the menu: leave asked of this login, and requests it
 * decides.
 *
 * The same answers the Leave and Requests pages and the home page read, so the
 * three always agree, and a decision anywhere updates the badge. Asked only
 * when the menu shows the item; a count that could not be fetched shows
 * nothing rather than a wrong number.
 */
export function useNavCounts() {
  const canAny = useAuthStore((state) => state.canAny)
  const team = useTeamLeave({ enabled: canAny(ROUTE_PERMISSIONS['/leave']) })
  const waiting = useWaitingRequests({ enabled: canAny(ROUTE_PERMISSIONS['/requests']) })
  return {
    '/leave': team.isError ? 0 : (team.data?.requests ?? []).filter((r) => r.status === 'pending').length,
    '/requests': waiting.isError ? 0 : (waiting.data?.length ?? 0),
  }
}
