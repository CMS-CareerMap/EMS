/** One-line summaries of a shift's and a leave type's rules (client §34, §36), under their names in Settings. */

/** "Grace 10m · late >2h → half day · overtime after 30m" — under the shift's name. */
export function rulesSummary(s) {
  const mins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`)
  return [
    s.grace_minutes ? `grace ${mins(s.grace_minutes)}` : null,
    s.late_threshold_minutes != null ? `late over ${mins(s.late_threshold_minutes)} → half day` : null,
    s.early_leaving_minutes != null ? `early over ${mins(s.early_leaving_minutes)} → half day` : null,
    s.min_full_day_hours != null ? `full day ${s.min_full_day_hours}h` : null,
    `overtime after ${mins(s.overtime_after_minutes ?? 0)}`,
  ].filter(Boolean).join(' · ')
}

/** "Monthly · 3 days’ notice · encashable up to 5 a year" — under the type's name. */
export function leaveRulesSummary(t) {
  return [
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
