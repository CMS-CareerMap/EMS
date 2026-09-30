import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'
import { useAuthStore } from '../stores/authStore'

/**
 * The bell, from the server.
 *
 * The server writes every notice, inside the change it reports; this file
 * only reads a person's own and marks them. The version it replaces let any
 * page insert a notification for anybody — and addressed approvers as the
 * literal string "demo-hr-admin-id", so nobody ever received one.
 *
 * Delivery is polling: once a minute, and when the tab comes back into view.
 * Cheap, and nothing a small company would notice the difference from a push.
 *
 * They come 30 at a time. Older pages are fetched only when somebody asks for
 * them, and each continues from the last notice seen — its time and its id.
 */

const KEY = ['notifications']
const POLL_MS = 60 * 1000

export function useNotifications() {
  const enabled = useAuthStore((s) => s.can('notification:read'))
  const query = useInfiniteQuery({
    queryKey: KEY,
    queryFn: async ({ pageParam }) => {
      const cursor = pageParam ? `?before=${encodeURIComponent(pageParam.before)}&beforeId=${pageParam.beforeId}` : ''
      const payload = await api.get(`/notifications${cursor}`)
      return { items: payload.data, unread: payload.meta.unread, more: payload.meta.more }
    },
    initialPageParam: null,
    getNextPageParam: (last) => {
      const end = last.items[last.items.length - 1]
      return last.more && end ? { before: end.created_at, beforeId: end.id } : undefined
    },
    enabled,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: 15 * 1000,
  })

  const pages = query.data?.pages ?? []
  return {
    isLoading: query.isLoading,
    // Enough of the query for DataState: the panel shows why the list is
    // missing, not "No notifications".
    isError: query.isError,
    error: query.error,
    isFetching: query.isFetching,
    refetch: query.refetch,
    notifications: pages.flatMap((p) => p.items),
    // The first page's count is the whole count, not just what is loaded.
    unreadCount: pages[0]?.unread ?? 0,
    hasOlder: Boolean(query.hasNextPage),
    loadingOlder: query.isFetchingNextPage,
    loadOlder: () => query.fetchNextPage(),
  }
}

function useNoticeMutation(mutationFn) {
  const qc = useQueryClient()
  return useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) })
}

export function useMarkNotificationAsRead() {
  return useNoticeMutation(async ({ id }) => api.post(`/notifications/${id}/read`))
}

export function useMarkAllNotificationsAsRead() {
  return useNoticeMutation(async () => api.post('/notifications/read-all'))
}

export function useClearAllNotifications() {
  return useNoticeMutation(async () => api.del('/notifications'))
}

// ── Settings → Notifications ────────────────────────────────────────────────

export function useNotificationSettings({ enabled = true } = {}) {
  return useQuery({ queryKey: ['notifications', 'settings'], queryFn: async () => (await api.get('/notifications/settings')).data, enabled })
}

export function useSaveNotificationSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (changes) => (await api.put('/notifications/settings', { changes })).data,
    onSuccess: (saved) => qc.setQueryData(['notifications', 'settings'], saved),
  })
}
