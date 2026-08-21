// Role-based routing engine — pure functions, no IO.
// Ported from a validated personal rule engine; the route table of hardcoded
// provider/model pairs is replaced by four ROLES (main / worker /
// long-context / reviewer) resolved elsewhere (src/roles.mjs).
//
// route(task, quota, cfg, roles) -> recommendation (advisory only, never executes).
// roles: { [roleName]: { provider, model, reasoningEffort } | null }
//   null = role unavailable (unknown model, unconfigured provider) — the
//   guardrail: candidates whose role is unavailable are dropped, never guessed.

export const ROLES = ['main', 'worker', 'long-context', 'reviewer']

function matchWhen(when, task, quota, cfg) {
  if (when.type && !when.type.includes(task.type)) return false
  if (when.minEstTokens && !(task.estTokens >= when.minEstTokens)) return false
  if (when.kimiWeeklyRemainingPctGt !== undefined) {
    const pct = quota.kimiWeeklyLimit > 0 ? quota.kimiWeeklyRemaining / quota.kimiWeeklyLimit * 100 : null
    if (pct === null || pct <= when.kimiWeeklyRemainingPctGt) return false
  }
  if (when.kimiWeeklyResetWithinH !== undefined) {
    if (!quota.kimiWeeklyResetTime) return false
    const h = (Date.parse(quota.kimiWeeklyResetTime) - Date.now()) / 3600e3
    if (h > when.kimiWeeklyResetWithinH) return false
  }
  if (when.deepseekTodayUsdGt !== undefined && !((quota.deepseekTodayUsd ?? 0) > when.deepseekTodayUsdGt)) return false
  if (when.deepseekTodayUsdGtPct !== undefined) {
    const threshold = cfg.dailyBudgetUsd * when.deepseekTodayUsdGtPct / 100
    if (!((quota.deepseekTodayUsd ?? 0) > threshold)) return false
  }
  return true
}

export function route(task, quota, cfg, roles) {
  const candidates = []
  for (const rule of cfg.rules) {
    if (matchWhen(rule.when, task, quota, cfg)) {
      candidates.push({ ruleId: rule.id, role: rule.role, score: rule.score, why: rule.why })
    }
  }
  if (!candidates.length) {
    candidates.push({ ruleId: 'fallback', role: cfg.fallback.role, score: cfg.fallback.score, why: cfg.fallback.why })
  }
  // Modifiers adjust the score of matched candidates.
  for (const mod of cfg.modifiers) {
    if (!matchWhen(mod.when, task, quota, cfg)) continue
    for (const c of candidates) {
      const hit = (mod.role && c.role === mod.role) ||
        (mod.roles && mod.roles.includes(c.role))
      if (hit) {
        c.score += mod.addScore
        c.notes = (c.notes || []).concat(mod.why)
        if (mod.downgradeTo) c.role = mod.downgradeTo
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score)

  // Guardrail: walk candidates in score order, skip roles that did not
  // resolve (unknown model / unconfigured provider). Never invent a route.
  const dropped = []
  for (const c of candidates) {
    const resolved = roles[c.role]
    if (resolved) {
      return {
        recommended: { role: c.role, provider: resolved.provider, model: resolved.model, reasoningEffort: resolved.reasoningEffort ?? null },
        ruleId: c.ruleId, score: c.score, why: c.why,
        notes: (c.notes ?? []).concat(dropped.map(d => `role "${d.role}" unavailable (not in knowledge base / not configured), skipped`)),
        candidates,
        unavailableRoles: ROLES.filter(r => !roles[r]),
      }
    }
    dropped.push(c)
  }
  return {
    recommended: null,
    ruleId: null, score: 0,
    why: 'no candidate role could be resolved — every matched role is unavailable',
    notes: dropped.map(d => `role "${d.role}" unavailable`),
    candidates,
    unavailableRoles: ROLES.filter(r => !roles[r]),
  }
}
