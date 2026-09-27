import type { PayslipTemplate } from './template'
import { INDIA } from './in'
import { UNITED_KINGDOM } from './gb'
import { UNITED_STATES } from './us'

export type { PayslipTemplate, IdentifierKey } from './template'

/** Every layout, by country. A new country is a new file and a line here. */
const TEMPLATES: Record<string, PayslipTemplate> = {
  IN: INDIA,
  GB: UNITED_KINGDOM,
  // "UK" is what people type; ISO calls it GB. Both find the same layout.
  UK: UNITED_KINGDOM,
  US: UNITED_STATES,
}

/**
 * The layout for an employee's country. Anything unknown gets India's — the
 * one layout that prints every statutory field — rather than a guess.
 */
export function templateFor(country: string | null | undefined): PayslipTemplate {
  return TEMPLATES[(country ?? '').trim().toUpperCase()] ?? INDIA
}

export const PAYSLIP_COUNTRIES = ['IN', 'GB', 'US'] as const
