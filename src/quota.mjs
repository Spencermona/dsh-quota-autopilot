// Quota snapshot reading, per-source freshness, and DeepSeek daily cost.
// Read-only over the ledger db; no writes, no network. Every function degrades
// to a partial result on a missing/unreadable table instead of throwing.
//
// Data-reliability contract (v0.2):
//   - latestSnapshot() reads collected_at so callers can age each source.
//   - quotaSnapshot() attaches a per-source `freshness` record
//     { collectedAt, ageMs, stale } and NEVER hides a stale value by itself —
//     staleness is surfaced, and stripStale() is what removes stale fields from
//     the routing/state input.
//   - deepseekTodayUsd() returns { todayUsd, incomplete, unknownModels } so a
//     real zero ("no spend today") is distinguishable from "some models have no
//     known rate" (incomplete) and from "ledger unreadable" (todayUsd null).

// Latest snapshot row for (provider, window_type), newest-first, with its
// collected_at so the caller can compute age.
export function latestSnapshot(db, provider, windowType) {
  return db.prepare(`SELECT "limit", used, remaining, reset_time, unit, collected_at FROM account_snapshots
    WHERE provider=? AND window_type=? ORDER BY collected_at DESC LIMIT 1`).get(provider, windowType)
}

// Freshness record for a snapshot row. null when there is no row.
export function freshnessOf(row, staleAfterMin, now = Date.now()) {
  if (!row) return null
  const collectedAt = typeof row.collected_at === 'number' ? row.collected_at : null
  const ageMs = collectedAt === null ? null : Math.max(0, now - collectedAt)
  const stale = ageMs !== null && ageMs > staleAfterMin * 60e3
  return { collectedAt, ageMs, stale }
}

// Full quota snapshot: the polled values plus a `freshness` map. All fields are
// optional — a missing provider/table only weakens the result, never throws.
export function quotaSnapshot(db, cfg, now = Date.now()) {
  const staleAfterMin = (cfg?.poll && typeof cfg.poll.staleAfterMin === 'number')
    ? cfg.poll.staleAfterMin
    : 15
  const q = {}
  const freshness = {}
  try {
    const w = latestSnapshot(db, 'kimi-coding', 'weekly')
    if (w) {
      q.kimiWeeklyRemaining = w.remaining ?? null
      q.kimiWeeklyLimit = w.limit ?? null
      q.kimiWeeklyResetTime = w.reset_time ?? null
      freshness.kimiWeekly = freshnessOf(w, staleAfterMin, now)
    }
    const r5 = latestSnapshot(db, 'kimi-coding', 'rolling_5h')
    if (r5) {
      q.kimiRolling5hRemaining = r5.remaining ?? null
      q.kimiRolling5hLimit = r5.limit ?? null
      freshness.kimiRolling5h = freshnessOf(r5, staleAfterMin, now)
    }
    const bal = latestSnapshot(db, 'deepseek-official', 'balance')
    if (bal) {
      q.deepseekBalanceUsd = bal.remaining ?? null
      freshness.deepseekBalance = freshnessOf(bal, staleAfterMin, now)
    }
  } catch { /* ledger unreadable -> partial snapshot, never crash */ }
  q.freshness = freshness
  return q
}

// DeepSeek cost of the local-timezone current day, computed from attributed
// usage events x the peak/off-peak rates table (ported from the validated
// personal route script). reasoning_tokens is already included in
// output_tokens and must NOT be added on top.
//
// Returns { todayUsd, incomplete, unknownModels }:
//   - todayUsd     number = sum over events whose model has a known rate;
//                   null only when the ledger could not be read at all.
//   - incomplete   true when at least one token bucket had no known rate (the
//                   number above is then a lower bound, never silently padded
//                   with a 0 rate).
//   - unknownModels the models (or '(unattributed)') whose rate was missing.
export function deepseekTodayUsd(db, now = new Date()) {
  try {
    const rates = {}
    for (const r of db.prepare(`SELECT model, bucket, usd_per_mtoken FROM rates WHERE provider='deepseek-official'`).all()) {
      rates[r.model + '|' + r.bucket] = r.usd_per_mtoken
    }
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    const buckets = ['input', 'cache_read', 'cache_write', 'output']
    let total = 0
    let incomplete = false
    const unknownModels = new Set()
    const rows = db.prepare(`SELECT ts, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
      FROM usage_events WHERE provider='deepseek-official' AND ts>=?`).all(midnight.getTime())
    for (const e of rows) {
      const h = new Date(Number(e.ts)).getUTCHours()
      const pp = (h >= 1 && h < 4) || (h >= 6 && h < 10) ? 'peak' : 'offpeak'
      const model = e.model || '(unattributed)'
      for (const b of buckets) {
        const tok = e[b + '_tokens']
        if (!tok) continue
        const rate = rates[e.model + '|' + b + '_' + pp]
        if (typeof rate === 'number') {
          total += tok * rate / 1e6
        } else {
          incomplete = true
          unknownModels.add(model)
        }
      }
    }
    return { todayUsd: Number(total.toFixed(4)), incomplete, unknownModels: [...unknownModels] }
  } catch {
    return { todayUsd: null, incomplete: true, unknownModels: [] }
  }
}

// Split a full quota snapshot into (a) a routing/state-safe copy with stale
// polled fields and incomplete cost nulled, and (b) human-readable stale notes.
// Unsafe fields must not drive evalState()/route(); nulling makes those pure
// functions treat them exactly like "no data".
export function stripStale(quota) {
  const fresh = { ...(quota || {}) }
  const notes = []
  const f = quota && quota.freshness ? quota.freshness : {}
  const map = {
    kimiWeekly: ['kimiWeeklyRemaining', 'kimiWeeklyLimit', 'kimiWeeklyResetTime'],
    kimiRolling5h: ['kimiRolling5hRemaining', 'kimiRolling5hLimit'],
    deepseekBalance: ['deepseekBalanceUsd'],
  }
  for (const [key, fields] of Object.entries(map)) {
    const fr = f[key]
    if (fr && fr.stale) {
      for (const field of fields) fresh[field] = null
      const ageMin = typeof fr.ageMs === 'number' ? Math.round(fr.ageMs / 60000) : '?'
      notes.push(`${key} quota is stale (age ${ageMin} min): excluded from state and routing`)
    }
  }
  // An incomplete cost is only a lower bound. It remains in the full snapshot
  // for display, but must not trigger budget modifiers or quota-state changes.
  if (quota?.deepseekToday?.incomplete) fresh.deepseekTodayUsd = null
  return { quota: fresh, staleNotes: notes }
}
