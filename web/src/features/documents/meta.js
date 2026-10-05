import { CheckCircle2, Clock, XCircle, CircleDashed } from 'lucide-react'
import { formatDayOf } from '../../lib/dates'
import { useAuthStore } from '../../stores/authStore'

/** How each document status reads on screen. */
export const STATUS = {
  verified: { label: 'Verified', cls: 'bg-green-50 text-green-700 border-green-200', icon: CheckCircle2 },
  pending: { label: 'Waiting for a check', cls: 'bg-amber-50 text-amber-700 border-amber-200', icon: Clock },
  rejected: { label: 'Rejected', cls: 'bg-red-50 text-red-700 border-red-200', icon: XCircle },
  missing: { label: 'Not uploaded', cls: 'bg-gray-50 text-gray-500 border-gray-200', icon: CircleDashed },
}

export const CATEGORIES = [
  { value: 'policy', label: 'Policy' },
  { value: 'handbook', label: 'Handbook' },
  { value: 'template', label: 'Form or template' },
  { value: 'announcement', label: 'Announcement' },
  { value: 'other', label: 'Other' },
]

export const categoryLabel = (value) => CATEGORIES.find((c) => c.value === value)?.label ?? value

/** A moment's day, on the company's clock — as every other screen reads an instant. */
export function when(iso) {
  return formatDayOf(iso, useAuthStore.getState().organization?.timezone)
}
