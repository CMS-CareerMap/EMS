/** One-line summaries of a shift's and a leave type's rules (client §34, §36), under their names in Settings. */

/** "Grace 10m · late >2h → half day · overtime after 30m" — under the shift's name. */
export function rulesSummary(s) {
  const mins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`)
  return [
    s.grace_minutes ? `grace ${mins(s.grace_minutes)}` : null,
    s.late_threshold_minutes != null ? `late over ${mins(s.late_threshold_minutes)} → half day` : null,
    s.early_leaving_minutes != null ? `early over ${mins(s.early_leaving_minutes)} → half day` : null,
    `overtime after ${mins(s.overtime_after_minutes ?? 0)}`,
  ].filter(Boolean).join(' · ')
}

/** A year's days as a month's, for a type earned monthly: 12 → "1 day", 18 → "1.5 days", 15 → "1.25 days". */
export function perMonth(days) {
  const n = Math.round((days / 12) * 100) / 100
  return `${n} day${n === 1 ? '' : 's'}`
}

/** "Monthly · 3 days’ notice · encashable up to 5 a year" — under the type's name. */
export function leaveRulesSummary(t) {
  return [
    t.joiner_grant === 'months_after_joining' ? 'joiners: whole months only' : t.joiner_grant === 'full_year' ? 'joiners: the full year' : null,
    t.usable_after_confirmation ? 'after confirmation' : null,
    t.accrual === 'monthly' ? 'earned monthly' : null,
    t.min_notice_days ? `${t.min_notice_days} days’ notice` : null,
    t.max_days_per_request != null ? `at most ${t.max_days_per_request} at a time` : null,
    t.eligible_after_days ? `after ${t.eligible_after_days} days’ service` : null,
    t.eligible_gender === 'female' ? 'women only' : t.eligible_gender === 'male' ? 'men only' : null,
    t.half_day_allowed === false ? 'whole days only' : null,
    t.counts_non_working_days ? 'calendar days' : null,
    t.encashable ? `encashable${t.encash_max_days_per_year != null ? ` up to ${t.encash_max_days_per_year} a year` : ''}` : null,
  ].filter(Boolean).join(' · ')
}
