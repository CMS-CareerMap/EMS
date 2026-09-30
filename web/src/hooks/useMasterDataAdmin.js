import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'

/**
 * Changing the company's departments, designations and shifts.
 *
 * Reading them is `useMasterData` in useEmployees.js; these are the writes,
 * held by Super Admin (the client's matrix gives Settings to nobody else).
 * Nothing is deleted — "remove" archives, so records that already point at a
 * department keep it.
 */

function useMasterDataMutation(fn) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    // Returned, so the confirm dialog closes only once the list shows the change.
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ['master-data'] }),
      // A rename shows up in the directory and the attendance roster too.
      queryClient.invalidateQueries({ queryKey: ['employees'] }),
      queryClient.invalidateQueries({ queryKey: ['attendance'] }),
    ]),
  })
}

/** `kind` is 'departments' or 'designations'. */
export function useAddNamed(kind) {
  return useMasterDataMutation(async ({ name }) => {
    const payload = await api.post(`/master-data/${kind}`, { name })
    return { row: payload.data, restored: Boolean(payload.meta?.restored) }
  })
}

export function useRenameNamed(kind) {
  return useMasterDataMutation(async ({ id, name }) => (await api.patch(`/master-data/${kind}/${id}`, { name })).data)
}

export function useArchiveNamed(kind) {
  return useMasterDataMutation(async ({ id }) => (await api.del(`/master-data/${kind}/${id}`)).data)
}

export function useAddShift() {
  return useMasterDataMutation(async (body) => {
    const payload = await api.post('/master-data/shifts', body)
    return { row: payload.data, restored: Boolean(payload.meta?.restored) }
  })
}

export function useEditShift() {
  return useMasterDataMutation(async ({ id, ...body }) => (await api.patch(`/master-data/shifts/${id}`, body)).data)
}

export function useArchiveShift() {
  return useMasterDataMutation(async ({ id }) => (await api.del(`/master-data/shifts/${id}`)).data)
}
