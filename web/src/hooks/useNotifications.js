import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { isoInstant } from '../lib/dates'

export function useNotifications(userId) {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['notifications', userId],
    queryFn: async () => {
      if (!userId) return []
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })

      if (error) throw error
      return data || []
    },
    enabled: !!userId,
    staleTime: 5000,
  })

  // Set up Real-Time listener and fallback event listeners
  useEffect(() => {
    if (!userId) return

    // 1. Supabase Postgres Realtime Subscription (for real DB)
    const channel = supabase
      .channel(`notifications-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['notifications', userId] })
        }
      )
      .subscribe()

    // 2. Custom Window Event listener for Mock DB real-time updates
    const handleMockDbEvent = () => {
      queryClient.invalidateQueries({ queryKey: ['notifications', userId] })
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('ems_mock_db_changed', handleMockDbEvent)
      window.addEventListener('storage', handleMockDbEvent)
    }

    return () => {
      supabase.removeChannel?.(channel) || channel.unsubscribe?.()
      if (typeof window !== 'undefined') {
        window.removeEventListener('ems_mock_db_changed', handleMockDbEvent)
        window.removeEventListener('storage', handleMockDbEvent)
      }
    }
  }, [userId, queryClient])

  const notifications = query.data || []
  const unreadCount = notifications.filter((n) => !n.read).length

  return {
    ...query,
    notifications,
    unreadCount,
  }
}

export function useMarkNotificationAsRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id }) => {
      const { error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('id', id)

      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}

export function useMarkAllNotificationsAsRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId }) => {
      const { error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('user_id', userId)

      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}

export function useClearAllNotifications() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId }) => {
      const { error } = await supabase
        .from('notifications')
        .delete()
        .eq('user_id', userId)

      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}

export function useCreateNotification() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (notificationData) => {
      const records = Array.isArray(notificationData) ? notificationData : [notificationData]
      const { data, error } = await supabase.from('notifications').insert(records)
      if (error) throw error
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}

/**
 * Utility helper to dispatch a notification directly (handles array of recipient IDs or single ID)
 */
export async function sendNotification({ userIds, userId, title, message, type = 'system', link = '/dashboard', relatedEntityId = null }) {
  const targets = userIds || (userId ? [userId] : [])
  if (!targets.length) return

  const records = targets.map((id) => ({
    user_id: id,
    title,
    message,
    type,
    link,
    related_entity_id: relatedEntityId,
    read: false,
    created_at: isoInstant(),
  }))

  const { error } = await supabase.from('notifications').insert(records)
  if (error) console.error('Failed to send notification:', error)
}
