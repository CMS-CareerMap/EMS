import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'

/**
 * The employee's own punch in and punch out.
 *
 * No employee id anywhere. The server keys the row off whoever is
 * authenticated, so there is nothing here that could be pointed at somebody
 * else — and nothing the browser can change to make it.
 */

const KEY = ['attendance', 'me', 'today']

export function useMyToday() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => (await api.get('/attendance/me/today')).data,
  })
}

/**
 * Asks the browser where we are, INCLUDING how sure it is.
 *
 * `coords.accuracy` is the number everybody drops, and dropping it is what
 * makes a 30 m geofence unusable — the server cannot tell a reading taken at
 * the desk from one taken in the car park without it.
 *
 * `enableHighAccuracy` asks for GPS rather than the wifi/cell estimate, which
 * is the difference between ±15 m and ±2 km indoors. It costs battery and a few
 * seconds, which is the right trade for something done twice a day.
 */
export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser cannot report your location. Ask HR to mark your attendance.'))
      return
    }

    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: Math.round(position.coords.accuracy),
        }),
      (error) => {
        // The refusal case is worth its own wording. "Position unavailable"
        // tells somebody nothing about what to do next.
        reject(
          new Error(
            error.code === error.PERMISSION_DENIED
              ? 'Location access was blocked. Allow it for this site and try again.'
              : 'Your location could not be read. Move near a window and try again.',
          ),
        )
      },
      { enableHighAccuracy: true, timeout: 15 * 1000, maximumAge: 0 },
    )
  })
}

export function usePunchIn() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      // The reading is taken HERE and sent. The server decides — this app has
      // no say in whether the location passes, which is the entire point of
      // moving the check off the client.
      const position = await getPosition()
      return (await api.post('/attendance/punch-in', position)).data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEY })
      // The client asked for the dashboard to update the moment somebody
      // punches, so the figures it draws are refreshed too.
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function usePunchOut() {
  const queryClient = useQueryClient()

  return useMutation({
    // No location on the way out. Somebody who has finished and walked to the
    // bus stop must still be able to close their day — refusing them leaves a
    // row with no check-out, which looks like they never left.
    mutationFn: async () => (await api.post('/attendance/punch-out', {})).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEY })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}
