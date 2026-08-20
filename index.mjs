// dsh-quota-autopilot — host plugin entry (cordis plugin export).
//
// One row in the profile's cordis.patch.yml:
//   - insert:
//       - id: autopilot
//         name: 'dsh-quota-autopilot'
//
// What it does:
//   - polls Kimi/DeepSeek account quotas on an interval into a local ledger
//     (node:sqlite) under the plugin data directory;
//   - parses durable session logs (read-only against $DSH_HOME) into the ledger;
//   - auto-calibrates the point<->token ratio and persists calibration.json;
//   - resolves the four routing roles (user override > knowledge base probing
//     > deployment default) and caches them for 60s;
//   - provides the `autopilot` service: status() / advise() / roles() /
//     calibration() / dataDir.
//
// Advisory only — this plugin NEVER calls any API that changes routing.
// Everything user-visible is English; any API key output goes through
// redactKey(). All cordis services are read optionally via ctx.get().

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

import { mergeConfig, DEFAULT_CONFIG } from './src/config.mjs'
import { resolveDshHome, readCredentials, redactKey } from './src/paths.mjs'
import { openLedger } from './src/ledger.mjs'
import { pollAll } from './src/poll.mjs'
import { parseAllLogs } from './src/parse-logs.mjs'
import { calibrate, loadCalibration, saveCalibration } from './src/calibrate.mjs'
import { resolveRoles } from './src/roles.mjs'
import { route } from './src/router-core.mjs'
import { evalState } from './src/state.mjs'
import { appendShadow } from './src/shadow.mjs'

export const name = 'autopilot'
// Everything is optional: the plugin degrades gracefully without llm /
// agentDefaultModel / timer / settings / launchEnvironment / credentials.
export const inject = []

// Runtime schema for the plugin row's config (dsh-persona convention).
// schemastery preserves undeclared keys (verified against v3.18.1), so user
// overrides of rules / modifiers / stateMachine survive validation;
// mergeConfig() then deep-merges the result over DEFAULT_CONFIG.
export const Config = z.object({
  credentials: z.object({
    kimiKeyName: z.string().default(DEFAULT_CONFIG.credentials.kimiKeyName),
    deepseekKeyName: z.string().default(DEFAULT_CONFIG.credentials.deepseekKeyName),
  }).default({}),
  poll: z.object({
    intervalMin: z.number().min(1).default(DEFAULT_CONFIG.poll.intervalMin),
    kimiUsageUrl: z.string().default(DEFAULT_CONFIG.poll.kimiUsageUrl),
    deepseekBalanceUrl: z.string().default(DEFAULT_CONFIG.poll.deepseekBalanceUrl),
    timeoutMs: z.number().default(DEFAULT_CONFIG.poll.timeoutMs),
  }).default({}),
  dailyBudgetUsd: z.number().default(DEFAULT_CONFIG.dailyBudgetUsd),
  calibration: z.object({
    minSpanHours: z.number().default(DEFAULT_CONFIG.calibration.minSpanHours),
    minPointDelta: z.number().default(DEFAULT_CONFIG.calibration.minPointDelta),
    driftRelearnPct: z.number().default(DEFAULT_CONFIG.calibration.driftRelearnPct),
  }).default({}),
  roles: z.object({}).default({}),
  rules: z.array(z.object({})),
  fallback: z.object({}),
  modifiers: z.array(z.object({})),
  stateMachine: z.object({}),
  stateActions: z.object({}),
  dshHome: z.string(),
  dataDir: z.string(),
})

// Schema for the optional `autopilot` settings namespace.
const SettingsSchema = z.object({
  dailyBudgetUsd: z.number().default(DEFAULT_CONFIG.dailyBudgetUsd)
    .description('DeepSeek daily budget in USD'),
  poll: z.object({
    intervalMin: z.number().min(1).default(DEFAULT_CONFIG.poll.intervalMin)
      .description('Quota poll interval in minutes'),
  }).default({}),
  roles: z.object({}).default({})
    .description('Explicit role -> {provider, model, reasoningEffort?} mapping (user override)'),
})

const ROLES_CACHE_MS = 60e3

// --- config validation (hand-written) --------------------------------------
// Second line of defense behind the exported Config schema (schemastery):
// invalid values fall back to defaults and produce a note instead of a crash.
function validateConfig(cfg, notes) {
  if (!(typeof cfg.dailyBudgetUsd === 'number' && Number.isFinite(cfg.dailyBudgetUsd) && cfg.dailyBudgetUsd > 0)) {
    notes.push(`config dailyBudgetUsd invalid (${String(cfg.dailyBudgetUsd)}): reset to default ${DEFAULT_CONFIG.dailyBudgetUsd}`)
    cfg.dailyBudgetUsd = DEFAULT_CONFIG.dailyBudgetUsd
  }
  if (!(typeof cfg.poll?.intervalMin === 'number' && Number.isFinite(cfg.poll.intervalMin) && cfg.poll.intervalMin >= 1)) {
    notes.push(`config poll.intervalMin invalid (${String(cfg.poll?.intervalMin)}): reset to default ${DEFAULT_CONFIG.poll.intervalMin}`)
    cfg.poll.intervalMin = DEFAULT_CONFIG.poll.intervalMin
  }
  if (cfg.roles !== undefined && (typeof cfg.roles !== 'object' || cfg.roles === null || Array.isArray(cfg.roles))) {
    notes.push('config roles invalid (not an object): reset to default {}')
    cfg.roles = {}
  }
}

// --- dshHome / dataDir resolution -------------------------------------------

function resolveDshHomeForCtx(ctx, cfg) {
  if (cfg.dshHome) return cfg.dshHome
  try {
    const v = ctx?.get?.('launchEnvironment')?.get?.('DSH_HOME')?.value
    if (typeof v === 'string' && v) return v
  } catch { /* fall through to env/home resolution */ }
  return resolveDshHome(undefined)
}

// Self-location convention (docs/DESIGN.md §9.3): installed as
//   <dshHome>/profiles/<profile>/node_modules/dsh-quota-autopilot/
// the data directory is <profile>/data/dsh-quota-autopilot. Anything else (global
// install, tests) falls back to <dshHome>/plugin-data/dsh-quota-autopilot.
// cfg.dataDir overrides both.
function resolveDataDir(cfg, dshHome) {
  if (cfg.dataDir) return cfg.dataDir
  try {
    const pkgDir = path.dirname(fileURLToPath(import.meta.url))
    const parent = path.dirname(pkgDir) // node_modules?
    const profileDir = path.dirname(parent) // <profile name>?
    if (path.basename(pkgDir) === 'dsh-quota-autopilot' &&
        path.basename(parent) === 'node_modules' &&
        path.basename(path.dirname(profileDir)) === 'profiles') {
      return path.join(profileDir, 'data', 'dsh-quota-autopilot')
    }
  } catch { /* fall through */ }
  return path.join(dshHome, 'plugin-data', 'dsh-quota-autopilot')
}

// --- quota snapshot -----------------------------------------------------------
// pollAll() persists snapshots into the ledger; the latest snapshot rows ARE
// the most recent poll values (and survive restarts, unlike process memory).

function latestSnapshot(db, provider, windowType) {
  return db.prepare(`SELECT "limit", used, remaining, reset_time, unit FROM account_snapshots
    WHERE provider=? AND window_type=? ORDER BY collected_at DESC LIMIT 1`).get(provider, windowType)
}

function quotaSnapshot(db) {
  const q = {}
  try {
    const w = latestSnapshot(db, 'kimi-coding', 'weekly')
    if (w) {
      q.kimiWeeklyRemaining = w.remaining ?? null
      q.kimiWeeklyLimit = w.limit ?? null
      q.kimiWeeklyResetTime = w.reset_time ?? null
    }
    const r5 = latestSnapshot(db, 'kimi-coding', 'rolling_5h')
    if (r5) q.kimiRolling5hRemaining = r5.remaining ?? null
    const bal = latestSnapshot(db, 'deepseek-official', 'balance')
    if (bal) q.deepseekBalanceUsd = bal.remaining ?? null
  } catch { /* ledger unreadable -> partial snapshot, never crash */ }
  return q
}

// DeepSeek cost of the local-timezone current day, computed from attributed
// usage events x the peak/off-peak rates table (ported from the validated
// personal route script). reasoning_tokens is already included in
// output_tokens and must NOT be added on top.
function deepseekTodayUsd(db) {
  try {
    const rates = {}
    for (const r of db.prepare(`SELECT model, bucket, usd_per_mtoken FROM rates WHERE provider='deepseek-official'`).all()) {
      rates[r.model + '|' + r.bucket] = r.usd_per_mtoken
    }
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
    let total = 0
    const rows = db.prepare(`SELECT ts, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
      FROM usage_events WHERE provider='deepseek-official' AND ts>=?`).all(midnight.getTime())
    for (const e of rows) {
      const h = new Date(Number(e.ts)).getUTCHours()
      const pp = (h >= 1 && h < 4) || (h >= 6 && h < 10) ? 'peak' : 'offpeak'
      const r = (b) => rates[e.model + '|' + b + '_' + pp] ?? 0
      total += e.input_tokens * r('input') / 1e6
             + e.cache_read_tokens * r('cache_read') / 1e6
             + e.cache_write_tokens * r('cache_write') / 1e6
             + e.output_tokens * r('output') / 1e6
    }
    return Number(total.toFixed(4))
  } catch {
    return null
  }
}

function redactedKeyHints(dshHome, cfg) {
  const keys = readCredentials(dshHome, cfg.credentials)
  return { kimi: redactKey(keys.kimi), deepseek: redactKey(keys.deepseek) }
}

// Credential resolution: the official credentials service first (its local
// provider reads $DSH_HOME/.credentials.yaml), the read-only file parser as
// fallback when the service is absent. Key NAMES come from cfg.credentials;
// values are only ever passed to the pollers, never logged.
async function resolveKeys(ctx, cfg, dshHome) {
  try {
    const creds = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
    if (creds && typeof creds.resolve === 'function') {
      const [k, d] = await Promise.all([
        creds.resolve(cfg.credentials.kimiKeyName).catch(() => undefined),
        creds.resolve(cfg.credentials.deepseekKeyName).catch(() => undefined),
      ])
      const kimi = k?.value ?? null
      const deepseek = d?.value ?? null
      if (kimi || deepseek) return { kimi, deepseek }
    }
  } catch { /* fall through to the file fallback */ }
  return readCredentials(dshHome, cfg.credentials)
}

// --- plugin entry ---------------------------------------------------------------

export async function apply(ctx, config) {
  const cfg = mergeConfig(config)
  const bootNotes = []
  validateConfig(cfg, bootNotes)

  const dshHome = resolveDshHomeForCtx(ctx, cfg)
  const dataDir = resolveDataDir(cfg, dshHome)
  fs.mkdirSync(dataDir, { recursive: true })

  const db = openLedger(path.join(dataDir, 'ledger.db'))
  const calibrationFile = path.join(dataDir, 'calibration.json')
  const shadowFile = path.join(dataDir, 'shadow-log.jsonl')
  const sessionsRoot = path.join(dshHome, 'sessions')

  let lastPoll = null // { kimi, deepseek, keyHints } from the most recent pollAll
  let calibrationState = loadCalibration(calibrationFile)
    ?? { status: 'learning', tokPerPoint: null, sampleWindows: 0, spanHours: 0, updatedAt: null, history: [] }
  let rolesCache = { at: 0, value: null }

  async function tick() {
    try {
      const keys = await resolveKeys(ctx, cfg, dshHome)
      lastPoll = await pollAll(db, cfg, dshHome, keys)
    } catch (e) {
      console.warn(`WARN autopilot poll failed: ${e.message}`)
    }
    try {
      parseAllLogs(db, sessionsRoot)
    } catch (e) {
      console.warn(`WARN autopilot log parse failed: ${e.message}`)
    }
    try {
      const result = calibrate(db, cfg)
      calibrationState = saveCalibration(calibrationFile, result, { driftRelearnPct: cfg.calibration.driftRelearnPct })
    } catch (e) {
      console.warn(`WARN autopilot calibrate failed: ${e.message}`)
    }
  }

  // First round immediately (async — never blocks plugin mount on network),
  // then on the configured interval. Prefer the ctx.setInterval mixin
  // (cordis-plugin-timer is guaranteed by the boot fallback and its timers are
  // disposed with the fiber automatically); fall back to a native interval
  // owned by ctx.effect, mirroring the quota-mgr effect pattern.
  tick().catch(() => {})
  const intervalMs = cfg.poll.intervalMin * 60e3
  let disposeTimer = null
  try {
    if (typeof ctx.setInterval === 'function') {
      ctx.setInterval(() => { tick().catch(() => {}) }, intervalMs)
      disposeTimer = () => {} // fiber-owned; nothing to clean up manually
    }
  } catch {
    disposeTimer = null
  }
  if (!disposeTimer) {
    const timerSvc = typeof ctx.get === 'function' ? ctx.get('timer') : undefined
    if (timerSvc && typeof timerSvc.interval === 'function') {
      try {
        disposeTimer = timerSvc.interval(() => { tick().catch(() => {}) }, intervalMs)
      } catch {
        disposeTimer = null
      }
    }
  }
  if (!disposeTimer) {
    const t = setInterval(() => { tick().catch(() => {}) }, intervalMs)
    if (typeof t.unref === 'function') t.unref()
    disposeTimer = () => clearInterval(t)
  }
  ctx.effect(() => () => {
    try { disposeTimer?.() } catch { /* ignore */ }
    try { db.close() } catch { /* ignore */ }
  })

  async function getRoles(force = false) {
    if (!force && rolesCache.value && Date.now() - rolesCache.at < ROLES_CACHE_MS) return rolesCache.value
    const value = await resolveRoles(ctx, cfg)
    rolesCache = { at: Date.now(), value }
    return value
  }

  function snapshotWithCost() {
    const quota = quotaSnapshot(db)
    quota.deepseekTodayUsd = deepseekTodayUsd(db)
    return quota
  }

  async function advise(args = {}) {
    const input = typeof args === 'string' ? { task: args } : (args ?? {})
    const type = typeof input.type === 'string' ? input.type : 'coding'
    const text = String(input.task ?? '')
    const estTokens = Number(input.estTokens) || Math.max(1000, Math.round(text.length / 3) + 20000)

    const quota = snapshotWithCost()
    const quotaState = evalState(quota, cfg)
    const rolesResult = await getRoles()
    const result = route({ type, estTokens, text }, quota, cfg, rolesResult.roles)

    const learning = calibrationState?.status !== 'calibrated'
    const notes = [...(result.notes ?? []), ...rolesResult.notes]
    if (learning) notes.push('learning: true — point/token ratio still calibrating')

    const out = {
      recommended: result.recommended,
      ruleId: result.ruleId,
      score: result.score,
      why: result.why,
      notes,
      candidates: result.candidates,
      quotaState,
      advisoryAction: cfg.stateActions[quotaState] ?? null,
      calibration: {
        status: calibrationState?.status ?? 'learning',
        tokPerPoint: calibrationState?.tokPerPoint ?? null,
      },
      quotaSnapshot: quota,
      ts: Date.now(),
    }
    if (learning) out.learning = true

    try {
      appendShadow(shadowFile, {
        ts: out.ts,
        kind: 'advice',
        task: text.slice(0, 500),
        type,
        estTokens,
        recommendation: result.recommended
          ? { role: result.recommended.role, provider: result.recommended.provider, model: result.recommended.model }
          : null,
        quotaState,
        calibration: out.calibration.status,
        ...(typeof input.sessionId === 'string' && input.sessionId ? { sessionId: input.sessionId } : {}),
      })
    } catch (e) {
      console.warn(`WARN autopilot shadow log failed: ${e.message}`)
    }
    return out
  }

  const service = {
    status() {
      if (!rolesCache.value) getRoles().catch(() => {}) // warm the cache in the background
      const quota = snapshotWithCost()
      return {
        ok: true,
        quota,
        state: evalState(quota, cfg),
        roles: rolesCache.value
          ? { roles: rolesCache.value.roles, sources: rolesCache.value.sources }
          : null,
        calibration: calibrationState,
        poll: lastPoll ? { kimi: lastPoll.kimi, deepseek: lastPoll.deepseek } : null,
        keyHints: lastPoll?.keyHints ?? redactedKeyHints(dshHome, cfg),
        dataDir,
        notes: [...bootNotes],
      }
    },
    advise,
    roles: () => getRoles(),
    calibration: () => calibrationState,
    dataDir,
  }
  ctx.provide('autopilot', service)

  // Optional settings namespace via the cordis optional-injection pattern.
  // If the settings service is absent, the row config alone remains the
  // configuration source and validateConfig() above guards the
  // settings-facing fields.
  try {
    ctx.inject(['settings'], (sctx) => {
      try {
        sctx.settings.register('autopilot', SettingsSchema)
      } catch (e) {
        console.warn(`WARN autopilot settings namespace skipped: ${e.message}`)
      }
    })
  } catch { /* settings service unavailable — row config only */ }

  console.log(`[autopilot] mounted, dataDir=${dataDir}`)
}
