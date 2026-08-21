// dsh-quota-autopilot — GUI panel half (optional, web profile only).
// Serves one JSON document for the browser pill (client.js) at
// GET /autopilot/api/status, shaped from the host `autopilot` service's own
// status() — this plugin NEVER reads an external quota-status.json.
//
// Kept from the original standalone dsh-quota-panel:
//   - Codex (ChatGPT subscription): polled every 5 min from
//     https://chatgpt.com/backend-api/wham/usage with the local OAuth token
//     (~/.dsh/codex-oauth.json preferred, ~/.codex/auth.json fallback).
//   - Local runtimes (Ollama / LM Studio): probed every 60 s; shown as ∞.
//
// Mounted from index.mjs through optional ctx.inject(['webServer']); non-web
// profiles or test contexts without webServer simply skip this half.
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_POLL_MS = 5 * 60 * 1000
const LOCAL_POLL_MS = 60 * 1000

function readCodexCredential(managedPath, cliPath) {
  // Managed store (pi-ai refreshed) wins; fall back to the Codex CLI login.
  try {
    const m = JSON.parse(readFileSync(managedPath, 'utf8'))
    if (m?.type === 'oauth' && m.access) return { access: m.access, accountId: m.accountId ?? null }
  } catch {}
  try {
    const c = JSON.parse(readFileSync(cliPath, 'utf8'))
    const t = c?.tokens
    if (t?.access_token) return { access: t.access_token, accountId: t.account_id ?? null }
  } catch {}
  return null
}

function slimWindow(w) {
  if (!w || typeof w !== 'object') return null
  return {
    usedPercent: typeof w.used_percent === 'number' ? w.used_percent : null,
    windowSeconds: typeof w.limit_window_seconds === 'number' ? w.limit_window_seconds : null,
    resetAt: typeof w.reset_at === 'number' ? w.reset_at * 1000 : null,
  }
}

async function pollCodex(managedPath, cliPath) {
  const cred = readCodexCredential(managedPath, cliPath)
  if (!cred) return { available: false }
  try {
    const r = await fetch(CODEX_USAGE_URL, {
      headers: {
        Authorization: 'Bearer ' + cred.access,
        'ChatGPT-Account-Id': cred.accountId ?? '',
        'User-Agent': 'codex-cli/0.148',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (r.status === 401 || r.status === 403) {
      return { available: true, error: 'auth ' + r.status + '（token 可能已过期，用一次 Codex 触发刷新）' }
    }
    if (!r.ok) return { available: true, error: 'http ' + r.status }
    const j = await r.json()
    const rl = j.rate_limit ?? null
    const spark = Array.isArray(j.additional_rate_limits)
      ? j.additional_rate_limits.find((x) => /spark/i.test(String(x?.limit_name ?? '')))
      : null
    return {
      available: true,
      plan: typeof j.plan_type === 'string' ? j.plan_type : null,
      limitReached: Boolean(rl?.limit_reached),
      primary: slimWindow(rl?.primary_window),
      secondary: slimWindow(rl?.secondary_window),
      spark: spark ? {
        primary: slimWindow(spark.rate_limit?.primary_window),
        secondary: slimWindow(spark.rate_limit?.secondary_window),
      } : null,
      credits: j.credits ? { balance: j.credits.balance ?? null, unlimited: Boolean(j.credits.unlimited) } : null,
      polledAt: Date.now(),
    }
  } catch (e) {
    return { available: true, error: 'network: ' + String(e?.message ?? e).slice(0, 120) + '（chatgpt.com 需要代理）' }
  }
}

async function probeJson(url, timeoutMs) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

async function pollLocal(ollamaUrl, lmstudioUrl) {
  const [ollama, lmstudio] = await Promise.all([
    probeJson(ollamaUrl + '/api/tags', 1500).then((j) => (j && Array.isArray(j.models) ? j.models.length : null)),
    probeJson(lmstudioUrl + '/v1/models', 1500).then((j) => (j && Array.isArray(j.data) ? j.data.length : null)),
  ])
  return { ollama, lmstudio, polledAt: Date.now() }
}

function freshestCollectedAt(freshness) {
  let ts = null
  for (const key of ['kimiWeekly', 'kimiRolling5h', 'deepseekBalance']) {
    const c = freshness?.[key]?.collectedAt
    if (typeof c === 'number' && (ts === null || c > ts)) ts = c
  }
  return ts
}

// Mount the panel on an optional webServer. Returns true when the route was
// registered, false when webServer is absent (non-web profile / test).
export function mountPanel(ctx, autopilot, cfg = {}) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (!webServer || typeof webServer.register !== 'function') return false

  const p = (cfg && typeof cfg.panel === 'object' && cfg.panel) || {}
  const codexEnabled = p.codex !== false
  const localEnabled = p.local !== false
  const managedPath = p.codexManagedPath ?? path.join(os.homedir(), '.dsh', 'codex-oauth.json')
  const cliPath = p.codexCliPath ?? path.join(os.homedir(), '.codex', 'auth.json')
  const ollamaUrl = p.ollamaUrl ?? 'http://127.0.0.1:11434'
  const lmstudioUrl = p.lmstudioUrl ?? 'http://127.0.0.1:1234'
  // Display thresholds, forwarded to the client so coloring matches the panel.
  // staleMs tracks poll.staleAfterMin unless overridden.
  const panel = {
    dailyCapUsd: p.dailyCapUsd ?? 2.0,
    lowPoints: p.lowPoints ?? 10,
    warnPoints: p.warnPoints ?? 25,
    warnBalanceUsd: p.warnBalanceUsd ?? 5,
    lowBalanceUsd: p.lowBalanceUsd ?? 1,
    staleMs: p.staleMs ?? (cfg.poll?.staleAfterMin ?? 15) * 60 * 1000,
  }

  const extras = { codex: null, local: null }
  const tickCodex = () => { pollCodex(managedPath, cliPath).then((c) => { extras.codex = c }).catch(() => {}) }
  const tickLocal = () => { pollLocal(ollamaUrl, lmstudioUrl).then((l) => { extras.local = l }).catch(() => {}) }
  if (codexEnabled) tickCodex()
  if (localEnabled) tickLocal()
  const t1 = codexEnabled ? setInterval(tickCodex, CODEX_POLL_MS) : null
  const t2 = localEnabled ? setInterval(tickLocal, LOCAL_POLL_MS) : null

  function shapeStatus() {
    const st = autopilot.status()
    const q = st.quota || {}
    const f = q.freshness || {}
    return {
      panel,
      kimi: {
        weekly: {
          limit: q.kimiWeeklyLimit ?? null,
          remaining: q.kimiWeeklyRemaining ?? null,
          resetTime: q.kimiWeeklyResetTime ?? null,
          collectedAt: f.kimiWeekly?.collectedAt ?? null,
          ageMs: f.kimiWeekly?.ageMs ?? null,
          stale: Boolean(f.kimiWeekly?.stale),
        },
        rolling5h: {
          limit: q.kimiRolling5hLimit ?? null,
          remaining: q.kimiRolling5hRemaining ?? null,
          collectedAt: f.kimiRolling5h?.collectedAt ?? null,
          ageMs: f.kimiRolling5h?.ageMs ?? null,
          stale: Boolean(f.kimiRolling5h?.stale),
        },
      },
      deepseek: {
        balanceUsd: q.deepseekBalanceUsd ?? null,
        collectedAt: f.deepseekBalance?.collectedAt ?? null,
        ageMs: f.deepseekBalance?.ageMs ?? null,
        stale: Boolean(f.deepseekBalance?.stale),
      },
      cost: {
        todayUsd: q.deepseekTodayUsd ?? null,
        incomplete: Boolean(q.deepseekToday?.incomplete),
        unknownModels: q.deepseekToday?.unknownModels ?? [],
      },
      codex: extras.codex,
      local: extras.local,
      updatedAt: freshestCollectedAt(f),
      notes: st.notes ?? [],
    }
  }

  const disposer = webServer.register({
    kind: 'exact',
    path: '/autopilot/api/status',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(JSON.stringify(shapeStatus()))
    },
  })

  ctx.effect(() => {
    return () => {
      try { disposer() } catch { /* ignore */ }
      if (t1) clearInterval(t1)
      if (t2) clearInterval(t2)
    }
  }, 'autopilot: panel status route + pollers')

  return true
}
