// Role knowledge base + startup probing + role resolution.
//
// The router (src/router-core.mjs) only ever references four ROLES:
// main / worker / long-context / reviewer. This module resolves each role to a
// concrete {provider, model, reasoningEffort} triple, in strict priority:
//
//   1. cfg.roles.<role> explicit user mapping — the ONLY way an unknown model
//      enters routing (anti-burn guardrail: knowledge base unknown models
//      never participate otherwise).
//   2. Knowledge base: the provider shows up in ctx.llm.listProviders() AND
//      the model shows up in `await ctx.llm.listModels(provider)`. A throwing
//      or timing-out listModels marks the whole provider unavailable — caught,
//      never crashes.
//   3. `main` fallback: the deployment default model via
//      ctx.agentDefaultModel.currentSelection() (may be undefined — tolerated).
//
// If the `llm` service does not exist at all (e.g. a plain CLI profile),
// knowledge-base probing is skipped wholesale and only user overrides plus the
// default-model fallback apply; a note says so.
//
// Unresolvable roles stay null and are honestly marked 'unavailable' — the
// router drops candidates whose role is null, it never invents a route.

export const ROLE_NAMES = ['main', 'worker', 'long-context', 'reviewer']

// Built-in model knowledge base. Only models listed here may enter routing
// automatically; anything else requires an explicit cfg.roles mapping.
// NOTE: this shape (per-role {model, reasoningEffort}) supersedes the plain
// string map in docs/DESIGN.md §2.1.
export const KNOWLEDGE_BASE = {
  'deepseek-official': {
    main: { model: 'deepseek-v4-pro', reasoningEffort: 'high' },
    worker: { model: 'deepseek-v4-flash', reasoningEffort: 'low' },
    reviewer: { model: 'deepseek-v4-pro', reasoningEffort: 'xhigh' },
  },
  'kimi-coding': {
    'long-context': { model: 'k3', reasoningEffort: null },
  },
}

const PROBE_TIMEOUT_MS = 10000

function withTimeout(promise, ms) {
  let t
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    if (typeof t.unref === 'function') t.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}

// resolveRoles(ctx, cfg) -> { roles, sources, probed, notes }
//   roles:   { main|worker|long-context|reviewer: {provider, model, reasoningEffort} | null }
//   sources: { role: 'user-override' | 'knowledge-base' | 'deployment-default' | 'unavailable' }
//   probed:  [{ provider, ok, models?|reason? }]  — startup probing record
//   notes:   human-readable English explanations for skips/failures
export async function resolveRoles(ctx, cfg) {
  const roles = { main: null, worker: null, 'long-context': null, reviewer: null }
  const sources = {}
  const probed = []
  const notes = []

  // Priority 1: explicit user mapping. Any model is allowed here — including
  // models the knowledge base does not know. This is the only exception to
  // the anti-burn guardrail.
  const userRoles = (cfg && typeof cfg.roles === 'object' && cfg.roles) || {}
  for (const role of ROLE_NAMES) {
    const u = userRoles[role]
    if (u && typeof u === 'object' && typeof u.provider === 'string' && typeof u.model === 'string') {
      roles[role] = { provider: u.provider, model: u.model, reasoningEffort: u.reasoningEffort ?? null }
      sources[role] = 'user-override'
    }
  }

  // Priority 2: knowledge base gated by startup probing.
  const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (!llm) {
    notes.push('llm service not available (e.g. a plain CLI profile): knowledge-base probing skipped; only user overrides and the deployment default model are used')
  } else {
    let providerIds = new Set()
    try {
      const providers = llm.listProviders() ?? []
      providerIds = new Set(providers.map((p) => p && p.id).filter(Boolean))
    } catch (e) {
      notes.push(`llm.listProviders() failed (${e.message}): knowledge-base probing skipped`)
    }
    for (const [providerId, roleMap] of Object.entries(KNOWLEDGE_BASE)) {
      if (!providerIds.has(providerId)) {
        probed.push({ provider: providerId, ok: false, reason: 'provider not registered' })
        continue
      }
      let modelIds
      try {
        const models = await withTimeout(Promise.resolve(llm.listModels(providerId)), PROBE_TIMEOUT_MS)
        modelIds = new Set((models ?? []).map((m) => m && m.id).filter(Boolean))
        probed.push({ provider: providerId, ok: true, models: modelIds.size })
      } catch (e) {
        probed.push({ provider: providerId, ok: false, reason: `listModels failed: ${e.message}` })
        notes.push(`provider "${providerId}" treated as unavailable: listModels failed (${e.message})`)
        continue
      }
      for (const [role, kb] of Object.entries(roleMap)) {
        if (roles[role]) continue // user override wins
        if (modelIds.has(kb.model)) {
          roles[role] = { provider: providerId, model: kb.model, reasoningEffort: kb.reasoningEffort ?? null }
          sources[role] = 'knowledge-base'
        } else {
          notes.push(`knowledge-base model "${kb.model}" not available on provider "${providerId}": role "${role}" left unresolved`)
        }
      }
    }
  }

  // Priority 3: main fallback — the deployment default model. Tolerates the
  // service or the selection being undefined.
  if (!roles.main) {
    let sel
    try {
      sel = (ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined)?.currentSelection?.()
    } catch {
      sel = undefined
    }
    if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
      roles.main = { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoning ?? sel.reasoningEffort ?? null }
      sources.main = 'deployment-default'
    }
  }

  for (const role of ROLE_NAMES) {
    if (!roles[role]) {
      if (!sources[role]) sources[role] = 'unavailable'
      notes.push(`role "${role}" unavailable: no user override, no knowledge-base match, no fallback`)
    }
  }

  return { roles, sources, probed, notes }
}
