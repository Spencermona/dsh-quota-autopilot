// Quota state machine — pure function, no IO.
// Ported from a validated personal implementation; semantics unchanged.
// evalState(quota, cfg) -> 'AGGRESSIVE' | 'NORMAL' | 'CONSERVE' | 'RESERVE' | 'EMERGENCY'
//
// quota shape (all fields optional — missing data never crashes, only weakens the verdict):
//   kimiWeeklyRemaining, kimiWeeklyLimit, kimiRolling5hRemaining,
//   deepseekBalanceUsd, deepseekTodayUsd

export function evalState(quota, cfg) {
  const sm = cfg.stateMachine
  const w = quota.kimiWeeklyRemaining, wl = quota.kimiWeeklyLimit
  const r5 = quota.kimiRolling5hRemaining
  const bal = quota.deepseekBalanceUsd
  const today = quota.deepseekTodayUsd ?? 0
  const wPct = (typeof w === 'number' && wl > 0) ? (w / wl) * 100 : null

  if ((typeof w === 'number' && w <= sm.emergency.kimiWeeklyRemainingLte) ||
      (typeof r5 === 'number' && r5 <= sm.emergency.kimiRolling5hRemainingLte) ||
      (typeof bal === 'number' && bal < sm.emergency.deepseekBalanceLt)) return 'EMERGENCY'
  if ((typeof w === 'number' && w <= sm.reserve.kimiWeeklyRemainingLte) ||
      (typeof r5 === 'number' && r5 <= sm.reserve.kimiRolling5hRemainingLte) ||
      (typeof bal === 'number' && bal < sm.reserve.deepseekBalanceLt)) return 'RESERVE'
  if ((wPct !== null && wPct <= sm.conserve.kimiWeeklyRemainingPctLte) ||
      (typeof r5 === 'number' && r5 <= sm.conserve.kimiRolling5hRemainingLte) ||
      today > cfg.dailyBudgetUsd * sm.conserve.deepseekTodayUsdGtPct / 100) return 'CONSERVE'
  if (wPct !== null && wPct > sm.aggressive.kimiWeeklyRemainingPctGt &&
      typeof r5 === 'number' && r5 > sm.aggressive.kimiRolling5hRemainingGt &&
      today < cfg.dailyBudgetUsd * sm.aggressive.deepseekTodayUsdLtPct / 100) return 'AGGRESSIVE'
  return 'NORMAL'
}
