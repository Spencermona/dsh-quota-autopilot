// Optional v0.3 request-time safety routing.
// This module never discovers models: callers pass the already resolved role map,
// so an unknown/unprobed provider-model pair can never enter enforcement.

export const AUTOMATION_MODES = new Set(['off', 'shadow', 'enforce'])

export function normalizeAutomationMode(value) {
  return AUTOMATION_MODES.has(value) ? value : 'off'
}

function destinationHealthy(target, quota, cfg) {
  if (target.provider === 'deepseek-official') {
    const bal = quota?.deepseekBalanceUsd
    return typeof bal === 'number' && bal >= cfg.stateMachine.reserve.deepseekBalanceLt
  }
  if (target.provider === 'kimi-coding') {
    const w = quota?.kimiWeeklyRemaining
    const r5 = quota?.kimiRolling5hRemaining
    return typeof w === 'number' && typeof r5 === 'number' &&
      w > cfg.stateMachine.reserve.kimiWeeklyRemainingLte &&
      r5 > cfg.stateMachine.reserve.kimiRolling5hRemainingLte
  }
  // No quota health signal exists for third-party providers: fail closed.
  return false
}

export function decideAutomation(original, roles, safeQuota, _quotaState, cfg) {
  if (!original?.provider || !original?.model) return null

  // Move Kimi work only when a Kimi window itself is low. The aggregate state
  // can also be RESERVE/EMERGENCY because DeepSeek balance is low; that must not
  // send healthy Kimi traffic toward the depleted provider.
  const w = safeQuota?.kimiWeeklyRemaining
  const r5 = safeQuota?.kimiRolling5hRemaining
  const sm = cfg.stateMachine
  const kimiEmergency = (typeof w === 'number' && w <= sm.emergency.kimiWeeklyRemainingLte) ||
    (typeof r5 === 'number' && r5 <= sm.emergency.kimiRolling5hRemainingLte)
  const kimiReserve = (typeof w === 'number' && w <= sm.reserve.kimiWeeklyRemainingLte) ||
    (typeof r5 === 'number' && r5 <= sm.reserve.kimiRolling5hRemainingLte)
  if (original.provider === 'kimi-coding' && (kimiEmergency || kimiReserve)) {
    const target = roles?.worker
    if (target?.provider && target?.model && target.provider !== original.provider &&
        destinationHealthy(target, safeQuota, cfg)) {
      return { target, reason: kimiEmergency ? 'kimi-emergency' : 'kimi-reserve' }
    }
  }

  // Budget protection is eligible only when stripStale() retained a complete
  // numeric cost. Incomplete/lower-bound cost is nulled before this function.
  const today = safeQuota?.deepseekTodayUsd
  if (original.provider === 'deepseek-official' && typeof today === 'number' &&
      today > cfg.dailyBudgetUsd) {
    const target = [roles?.['long-context'], roles?.main]
      .find((r) => r?.provider === 'kimi-coding' && r?.model)
    if (target && destinationHealthy(target, safeQuota, cfg)) {
      return { target, reason: 'deepseek-daily-budget' }
    }
  }
  return null
}

export function applyAutomationTarget(original, target) {
  const { reasoningEffort: _oldEffort, ...base } = original
  return {
    ...base,
    provider: target.provider,
    model: target.model,
    ...(target.reasoningEffort == null ? {} : { reasoningEffort: target.reasoningEffort }),
  }
}
