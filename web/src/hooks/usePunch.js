import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'
import { LOCATION_UNREAD, readLocationBurst } from '../lib/location'
import { deviceKey } from '../lib/deviceKey'

/**
 * The employee's own punch in and punch out.
 *
 * No employee id anywhere. The server keys the row off whoever is
 * authenticated, so there is nothing here that could be pointed at somebody
 * else — and nothing the browser can change to make it.
 */

const KEY = ['attendance', 'me', 'today']

/**
 * Where today is worked from — the office, home or on duty by an approved
 * request, or remote (client §32–33) — and whether check-in will need a
 * location reading. The browser is asked for one only then.
 */
export function useMyWorkplace({ enabled = true } = {}) {
  return useQuery({
    queryKey: [...KEY, 'workplace'],
    queryFn: async () => (await api.get('/attendance/me/workplace')).data,
    enabled,
  })
}

export function useMyToday() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => (await api.get('/attendance/me/today')).data,
  })
}

/**
 * One punch, as the server wants it (client, 11 Oct 2026): started first — the
 * server says now if anything would refuse it, and whether and how precisely
 * the location is needed — then the location read as a burst, then the punch
 * with its start token and every reading. The server decides; this app has no
 * say in whether a location passes, which is the entire point of the check
 * being on the server.
 */
async function punch(action, takePhoto) {
  // The touch points tell an iPad, which describes itself as a Mac, from a computer ("phones only");
  // the key tells this phone from another ("one phone per employee").
  const touchPoints = Math.min(64, Math.max(0, Math.round(navigator.maxTouchPoints ?? 0)))
  const device = { touchPoints, deviceKey: deviceKey() }
  const begin = async () => ({ at: Date.now(), ...(await api.post('/attendance/punch-start', { action, ...device })).data })
  let start = await begin()
  // The location first (client, 14 Oct 2026): no location — permission refused, or nothing
  // read — and the camera never opens, so no photo is taken for a punch that cannot be made.
  const readings = start.location_needed ? await readLocationBurst({ target: start.accuracy_meters ?? 20 }) : []
  const photo = start.photo_needed ? await takePhoto() : null
  // A slow camera, or a long look at the browser's questions, can outlast the start:
  // begun again, so the punch is not refused for the time it took — the photo and readings kept.
  if (Date.now() - start.at > (start.expires_in_seconds - 15) * 1000) start = await begin()
  return (await api.post(`/attendance/punch-${action}`, { token: start.token, ...device, ...(readings.length ? { readings } : {}), ...(photo ? { photo } : {}) })).data
}

/** No camera in this page: a punch the company wants a photo with cannot be made here. */
const noCamera = () => Promise.reject(new Error('A photo is needed to punch. Open the Check In card to take it.'))

export function usePunchIn() {
  const queryClient = useQueryClient()

  return useMutation({
    // Started fresh each time: a request approved since the page opened counts.
    // `takePhoto`: the card's camera dialog, when the company asks for a selfie with every punch.
    mutationFn: ({ takePhoto = noCamera } = {}) => punch('in', takePhoto),
    // Returned: the button stays busy until today's row shows the punch, so
    // it cannot be pressed a second time in between.
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: KEY }),
      // The client asked for the dashboard to update the moment somebody
      // punches, so the figures it draws are refreshed too.
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      // …and the Attendance page's log and calendar, as checking out does.
      queryClient.invalidateQueries({ queryKey: ['attendance'] }),
    ]),
  })
}

export function usePunchOut() {
  const queryClient = useQueryClient()

  return useMutation({
    // On an office day the way out is checked too, when the company says so
    // (client, 11 Oct 2026); refused outside, the card offers to ask HR to
    // record the check-out instead.
    mutationFn: ({ takePhoto = noCamera } = {}) => punch('out', takePhoto),
    // Said on the card, with the way to ask HR — not as a toast that goes away:
    // refused at the office fence, or the location not read at all.
    meta: { quietCodes: ['LOCATION_REFUSED', LOCATION_UNREAD] },
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: KEY }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      // The month's rows too: a day's overtime is there to claim at once.
      queryClient.invalidateQueries({ queryKey: ['attendance'] }),
    ]),
  })
}
