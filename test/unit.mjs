// Unit tests for dsh-quota-autopilot pure Node modules.
// Run directly (from the dsh-quota-autopilot directory; do NOT use `node --test` —
// the directory runner spawns child processes, which hits EPERM in some sandboxes):
//   node test/unit.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { resolveDshHome, readCredentials, redactKey } from '../src/paths.mjs'
import { openLedger, insertEvent, insertSnapshot, getIngest, updateIngest, seedRates, RATE_SEED } from '../src/ledger.mjs'
import { decodeZstdFrames, parseAllLogs } from '../src/parse-logs.mjs'
import { calibrate, loadCalibration, saveCalibration } from '../src/calibrate.mjs'
import { appendShadow, readShadow } from '../src/shadow.mjs'
import { pollAll } from '../src/poll.mjs'
import { mergeConfig, DEFAULT_CONFIG } from '../src/config.mjs'
import { quotaSnapshot, deepseekTodayUsd, stripStale } from '../src/quota.mjs'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quota-autopilot-test-'))
}

// ---------- paths.mjs ----------

test('redactKey: all branches', () => {
  assert.equal(redactKey(null), '(missing)')
  assert.equal(redactKey(undefined), '(missing)')
  assert.equal(redactKey(12345), '(invalid)')
  assert.equal(redactKey('short'), '(invalid)')
  assert.equal(redactKey('12345678901'), '(invalid)') // length 11 < 12
  assert.equal(redactKey('abcdefghijkl'), 'abcd****ijkl')
  assert.equal(redactKey('sk-abcdefghijklmnop'), 'sk-a****mnop')
})

test('readCredentials: parses quotes, comments, = form; skips nested/comment lines', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, '.credentials.yaml'), [
    '# a full-line comment',
    '',
    'KIMI_CODING_API_KEY: "kimi-key-aaaa1111"  # trailing comment',
    "DEEPSEEK_API_KEY = 'ds-key-bbbb2222'",
    'UNQUOTED_KEY: plain-value-3333 # note',
    'nested:',
    '  KIMI_CODING_API_KEY: nested-must-not-win',
    'not a key line at all ::',
  ].join('\n'), 'utf8')
  const c = readCredentials(dir, { kimiKeyName: 'KIMI_CODING_API_KEY', deepseekKeyName: 'DEEPSEEK_API_KEY' })
  assert.equal(c.kimi, 'kimi-key-aaaa1111')
  assert.equal(c.deepseek, 'ds-key-bbbb2222')
})

test('readCredentials: missing file and missing keys -> null, never throws', () => {
  const dir = tmpdir()
  const c = readCredentials(dir, { kimiKeyName: 'KIMI_CODING_API_KEY', deepseekKeyName: 'DEEPSEEK_API_KEY' })
  assert.deepEqual(c, { kimi: null, deepseek: null })
  fs.writeFileSync(path.join(dir, '.credentials.yaml'), 'OTHER_KEY: x\n', 'utf8')
  const c2 = readCredentials(dir, { kimiKeyName: 'KIMI_CODING_API_KEY', deepseekKeyName: 'DEEPSEEK_API_KEY' })
  assert.deepEqual(c2, { kimi: null, deepseek: null })
})

test('resolveDshHome: override > env > homedir', () => {
  assert.equal(resolveDshHome('/x/y'), '/x/y')
  const prev = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/env/home'
    assert.equal(resolveDshHome(), '/env/home')
    delete process.env.DSH_HOME
    assert.equal(resolveDshHome(), path.join(os.homedir(), '.dsh'))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

// ---------- config.mjs ----------

test('mergeConfig: deep merge, arrays replaced, defaults intact', () => {
  const d = mergeConfig()
  assert.deepEqual(d, DEFAULT_CONFIG)
  assert.notEqual(d, DEFAULT_CONFIG) // cloned

  const m = mergeConfig({
    dailyBudgetUsd: 9,
    calibration: { minSpanHours: 48 },
    rules: [{ id: 'only', when: {}, role: 'main', score: 1, why: 'x' }],
  })
  assert.equal(m.dailyBudgetUsd, 9)
  assert.equal(m.calibration.minSpanHours, 48)
  assert.equal(m.calibration.minPointDelta, DEFAULT_CONFIG.calibration.minPointDelta) // preserved
  assert.equal(m.rules.length, 1) // arrays replaced wholesale
  assert.equal(m.poll.timeoutMs, DEFAULT_CONFIG.poll.timeoutMs) // untouched subtree
  // user config must not mutate defaults
  assert.equal(DEFAULT_CONFIG.calibration.minSpanHours, 24)
  assert.ok(DEFAULT_CONFIG.rules.length > 1)
})

// ---------- ledger.mjs ----------

test('ledger: idempotent event insert (PK + INSERT OR IGNORE)', () => {
  const db = openLedger(':memory:')
  const e = { session_id: 's1', seq: 1, ts: 1000, provider: 'p', model: 'm', input_tokens: 10, output_tokens: 5 }
  assert.equal(insertEvent(db, e), true)
  assert.equal(insertEvent(db, e), false) // duplicate ignored
  assert.equal(insertEvent(db, { ...e, input_tokens: 999 }), false) // even with different payload
  const c = db.prepare('SELECT COUNT(*) c, SUM(input_tokens) s FROM usage_events').get()
  assert.equal(c.c, 1)
  assert.equal(c.s, 10)
  db.close()
})

test('ledger: seedRates only seeds an empty table', () => {
  const db = openLedger(':memory:')
  assert.equal(seedRates(db), RATE_SEED.length)
  assert.equal(seedRates(db), 0) // second call is a no-op
  const c = db.prepare('SELECT COUNT(*) c FROM rates').get().c
  assert.equal(c, RATE_SEED.length)
  db.close()
})

test('ledger: openLedger creates the parent directory', () => {
  const dir = path.join(tmpdir(), 'nested', 'data')
  const db = openLedger(path.join(dir, 'ledger.db'))
  db.close()
  assert.ok(fs.existsSync(path.join(dir, 'ledger.db')))
})

// ---------- parse-logs.mjs ----------

function makeSessionsTree(root) {
  const sdir = path.join(root, 'sess-A')
  fs.mkdirSync(sdir, { recursive: true })
  const frame1 = zlib.zstdCompressSync(Buffer.from([
    JSON.stringify({ type: 'session', id: 'sess-A', origin: 'user', createdAt: 100 }),
    JSON.stringify({ type: 'assistant/message', seq: 1, time: 1000, data: { usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 10 }, message: { source: { provider: 'kimi-coding', model: 'k3' } } } }),
    '',
  ].join('\n')))
  const frame2 = zlib.zstdCompressSync(Buffer.from([
    'this is not json',
    JSON.stringify({ type: 'assistant/chunk', seq: 2, time: 1100, data: { chunk: { usage: { inputTokens: 999, outputTokens: 999 } } } }), // chunk usage must be skipped
    JSON.stringify({ type: 'assistant/message', seq: 3, time: 1200, data: { usage: { inputTokens: 200, outputTokens: 80 }, source: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } }),
    '',
  ].join('\n')))
  fs.writeFileSync(path.join(sdir, 'session.jsonl.zstd'), Buffer.concat([frame1, frame2]))
}

test('parse-logs: multi-frame decode, event extraction, ingest short-circuit', () => {
  const root = tmpdir()
  makeSessionsTree(root)
  const db = openLedger(':memory:')

  const r1 = parseAllLogs(db, root)
  assert.equal(r1.filesSeen, 1)
  assert.equal(r1.filesParsed, 1)
  assert.equal(r1.eventsInserted, 2)   // chunk-level usage skipped (pitfall 1)
  assert.equal(r1.sessionsUpserted, 1)
  assert.equal(r1.badLines, 1)

  const sess = db.prepare('SELECT * FROM sessions WHERE session_id=?').get('sess-A')
  assert.equal(sess.origin, 'user')
  const toks = db.prepare(`SELECT SUM(input_tokens) i, SUM(output_tokens) o, SUM(reasoning_tokens) r FROM usage_events WHERE session_id='sess-A'`).get()
  assert.equal(toks.i, 300)
  assert.equal(toks.o, 130)
  assert.equal(toks.r, 10) // reasoning stored separately, never added to output

  // Second run: size+mtime short-circuit, nothing re-inserted
  const r2 = parseAllLogs(db, root)
  assert.equal(r2.filesSkipped, 1)
  assert.equal(r2.eventsInserted, 0)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM usage_events').get().c, 2)

  const st = getIngest(db, path.join(root, 'sess-A', 'session.jsonl.zstd'))
  assert.ok(st && st.event_count === 2)
  db.close()
})

test('parse-logs: missing sessions root -> empty result, never throws', () => {
  const db = openLedger(':memory:')
  const r = parseAllLogs(db, path.join(tmpdir(), 'does-not-exist'))
  assert.deepEqual(r, { filesSeen: 0, filesParsed: 0, filesSkipped: 0, eventsInserted: 0, sessionsUpserted: 0, badLines: 0 })
  db.close()
})

test('parse-logs: decodeZstdFrames skips an incomplete tail frame', () => {
  const good = zlib.zstdCompressSync(Buffer.from('hello\n'))
  const truncated = good.subarray(0, 5) // magic + 1 byte: undecodable
  const buf = Buffer.concat([good, truncated])
  assert.equal(decodeZstdFrames(buf), 'hello\n')
})

// ---------- calibrate.mjs ----------

const H = 3600e3
const T0 = 1_700_000_000_000

function seedCalibrateDb(db) {
  // weekly snapshots: t0 (used 0), t0+10h (used 2), t0+25h (used 5)
  for (const [ts, used] of [[T0, 0], [T0 + 10 * H, 2], [T0 + 25 * H, 5]]) {
    insertSnapshot(db, { collected_at: ts, provider: 'kimi-coding', window_type: 'weekly', used })
  }
  // events inside the windows (provider kimi-coding)
  insertEvent(db, { session_id: 'c1', seq: 1, ts: T0 + 5 * H, provider: 'kimi-coding', model: 'k3', input_tokens: 1000, output_tokens: 500 })
  insertEvent(db, { session_id: 'c1', seq: 2, ts: T0 + 15 * H, provider: 'kimi-coding', model: 'k3', input_tokens: 2000, output_tokens: 1000 })
}

test('calibrate: learning -> calibrated with explicit gates', () => {
  const cfg = mergeConfig()
  const db = openLedger(':memory:')
  seedCalibrateDb(db)

  // learning: not enough span/points -> truncate to first two snapshots
  db.prepare(`DELETE FROM account_snapshots WHERE collected_at=?`).run(T0 + 25 * H)
  const learning = calibrate(db, cfg)
  assert.equal(learning.status, 'learning')
  assert.equal(learning.tokPerPoint, null)
  assert.equal(learning.pointDelta, 2)
  assert.equal(learning.sampleWindows, 1)
  assert.ok(learning.spanHours < 24)

  // calibrated: add the third snapshot -> span 25h, pointDelta 5
  insertSnapshot(db, { collected_at: T0 + 25 * H, provider: 'kimi-coding', window_type: 'weekly', used: 5 })
  const done = calibrate(db, cfg)
  assert.equal(done.status, 'calibrated')
  assert.equal(done.pointDelta, 5)
  assert.equal(done.sampleWindows, 2)
  assert.equal(done.spanHours, 25)
  assert.equal(done.tokPerPoint, 4500 / 5) // Σ(in+out) / ΣdP = 4500/5 = 900
  db.close()
})

test('calibrate: point-delta gate (span ok but delta < 3 stays learning)', () => {
  const cfg = mergeConfig()
  const db = openLedger(':memory:')
  insertSnapshot(db, { collected_at: T0, provider: 'kimi-coding', window_type: 'weekly', used: 0 })
  insertSnapshot(db, { collected_at: T0 + 48 * H, provider: 'kimi-coding', window_type: 'weekly', used: 2 })
  const r = calibrate(db, cfg)
  assert.equal(r.status, 'learning')
  assert.equal(r.tokPerPoint, null)
  assert.equal(r.spanHours, 48)
  assert.equal(r.pointDelta, 2)
  db.close()
})

test('calibrate: empty ledger -> learning, never throws', () => {
  const db = openLedger(':memory:')
  const r = calibrate(db, mergeConfig())
  assert.equal(r.status, 'learning')
  assert.equal(r.tokPerPoint, null)
  assert.equal(r.sampleWindows, 0)
  assert.equal(r.spanHours, 0)
  db.close()
})

test('calibrate: persistence round-trip + drift-based sliding correction', () => {
  const file = path.join(tmpdir(), 'sub', 'calibration.json')
  assert.equal(loadCalibration(file), null) // missing file -> null

  // first calibration: stored + history seeded
  const s1 = saveCalibration(file, { status: 'calibrated', tokPerPoint: 1000, sampleWindows: 2, spanHours: 25, updatedAt: 1 }, { driftRelearnPct: 30 })
  assert.equal(s1.tokPerPoint, 1000)
  assert.equal(s1.history.length, 1)
  assert.deepEqual(loadCalibration(file), s1)

  // drift 10% (< 30%): keep the stable value, no history push
  const s2 = saveCalibration(file, { status: 'calibrated', tokPerPoint: 1100, sampleWindows: 3, spanHours: 49, updatedAt: 2 }, { driftRelearnPct: 30 })
  assert.equal(s2.tokPerPoint, 1000)
  assert.equal(s2.history.length, 1)
  assert.equal(s2.sampleWindows, 3) // progress still updates

  // drift 40% (> 30%): sliding correction, history push
  const s3 = saveCalibration(file, { status: 'calibrated', tokPerPoint: 600, sampleWindows: 4, spanHours: 73, updatedAt: 3 }, { driftRelearnPct: 30 })
  assert.equal(s3.tokPerPoint, 600)
  assert.equal(s3.history.length, 2)
  assert.equal(s3.history[1].tokPerPoint, 600)
})

// ---------- shadow.mjs ----------

test('shadow: append/read round-trip, bad lines tolerated, limit honored', () => {
  const file = path.join(tmpdir(), 'data', 'shadow-log.jsonl')
  assert.deepEqual(readShadow(file), []) // missing file -> []

  const e1 = { ts: 1, kind: 'advice', task: 't1', type: 'coding', estTokens: 1000, recommendation: { role: 'main', provider: 'p', model: 'm' }, quotaState: 'NORMAL', calibration: 'learning', sessionId: 's1' }
  const e2 = { ...e1, ts: 2, task: 't2' }
  const e3 = { ...e1, ts: 3, task: 't3' }
  appendShadow(file, e1)
  appendShadow(file, e2)
  fs.appendFileSync(file, '{corrupt line\n', 'utf8')
  appendShadow(file, e3)

  assert.deepEqual(readShadow(file), [e1, e2, e3])
  assert.deepEqual(readShadow(file, 2), [e2, e3])
})

// ---------- poll.mjs (stubbed fetch) ----------

function withFetchStub(fn, body, status = 200) {
  const prev = globalThis.fetch
  globalThis.fetch = async () => ({ status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) })
  return fn().finally(() => { globalThis.fetch = prev })
}

const KIMI_PAYLOAD = {
  usage: { limit: '100', used: '32', remaining: '68', resetTime: '2026-08-23T21:07:41Z' },
  limits: [{ detail: { limit: '100', used: '16', remaining: '84', resetTime: null } }],
  boosterWallet: { balance: { amount: '10', amountLeft: '7.5', unit: 'UNIT_CURRENCY' } },
  parallel: { limit: '3', details: [{}] },
}
const DS_PAYLOAD = { balance_infos: [{ currency: 'USD', total_balance: '22.39', granted_balance: '2.00', topped_up_balance: '20.39' }] }

function pollTestCfg() {
  const cfg = mergeConfig()
  cfg.poll.kimiUsageUrl = 'https://example.invalid/kimi'
  cfg.poll.deepseekBalanceUrl = 'https://example.invalid/ds'
  return cfg
}

function pollTestHome() {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, '.credentials.yaml'),
    'KIMI_CODING_API_KEY: kimi-fake-key-0001\nDEEPSEEK_API_KEY: ds-fake-key-0002\n', 'utf8')
  return dir
}

test('poll: happy path persists all snapshot kinds and redacts key hints', async () => {
  const db = openLedger(':memory:')
  const home = pollTestHome()
  const cfg = pollTestCfg()
  const r = await withFetchStub(async () => {
    const first = await withFetchStub(() => pollAll(db, cfg, home), KIMI_PAYLOAD)
    return first
  }, KIMI_PAYLOAD)

  // pollAll polls both providers against the same stubbed body; assert on rows.
  assert.equal(r.keyHints.kimi, 'kimi****0001')
  assert.equal(r.keyHints.deepseek, 'ds-f****0002')

  const kinds = db.prepare(`SELECT DISTINCT window_type FROM account_snapshots WHERE provider='kimi-coding' ORDER BY window_type`).all().map(x => x.window_type)
  assert.deepEqual(kinds, ['booster_wallet', 'parallel_limit', 'rolling_5h', 'weekly'])
  const weekly = db.prepare(`SELECT * FROM account_snapshots WHERE provider='kimi-coding' AND window_type='weekly'`).get()
  assert.equal(weekly.limit, 100)   // string numbers coerced
  assert.equal(weekly.remaining, 68)
  assert.equal(weekly.reset_time, '2026-08-23T21:07:41Z')
  assert.ok(db.prepare('SELECT COUNT(*) c FROM rates').get().c > 0) // rates seeded
  db.close()
})

test('poll: deepseek balance snapshots persist three kinds', async () => {
  const db = openLedger(':memory:')
  const home = pollTestHome()
  const cfg = pollTestCfg()
  await withFetchStub(() => pollAll(db, cfg, home), DS_PAYLOAD)
  const kinds = db.prepare(`SELECT DISTINCT window_type FROM account_snapshots WHERE provider='deepseek-official' ORDER BY window_type`).all().map(x => x.window_type)
  assert.deepEqual(kinds, ['balance', 'balance_granted', 'balance_topped_up'])
  const bal = db.prepare(`SELECT * FROM account_snapshots WHERE provider='deepseek-official' AND window_type='balance'`).get()
  assert.equal(bal.remaining, 22.39)
  assert.equal(bal.unit, 'USD')
  db.close()
})

test('poll: fetch failure -> fetch_error snapshot row, status error, never throws', async () => {
  const db = openLedger(':memory:')
  const home = pollTestHome()
  const cfg = pollTestCfg()
  const prev = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('network down') }
  try {
    const r = await pollAll(db, cfg, home)
    assert.equal(r.kimi, 'error')
    assert.equal(r.deepseek, 'error')
  } finally {
    globalThis.fetch = prev
  }
  const errs = db.prepare(`SELECT COUNT(*) c FROM account_snapshots WHERE window_type='fetch_error'`).get().c
  assert.equal(errs, 2)
  db.close()
})

test('poll: schema drift -> parse_error row, never crashes', async () => {
  const db = openLedger(':memory:')
  const home = pollTestHome()
  const cfg = pollTestCfg()
  const r = await withFetchStub(() => pollAll(db, cfg, home), { unexpected: true })
  // Ported semantics: parse_error snapshot rows still count as written rows,
  // so kimi reports 'ok' even though every section drifted; deepseek has no
  // salvageable section at all and reports 'error'. The signal lives in the
  // parse_error rows + warnings, never in a crash.
  assert.equal(r.kimi, 'ok')
  assert.equal(r.deepseek, 'error')
  const pe = db.prepare(`SELECT COUNT(*) c FROM account_snapshots WHERE provider='kimi-coding' AND window_type='parse_error'`).get().c
  assert.ok(pe >= 2) // missing usage + missing limits[0].detail
  db.close()
})

test('poll: missing credentials -> error status, (missing) hints, no fetch', async () => {
  const db = openLedger(':memory:')
  const dir = tmpdir() // no .credentials.yaml
  const cfg = pollTestCfg()
  let fetched = false
  const prev = globalThis.fetch
  globalThis.fetch = async () => { fetched = true; throw new Error('should not be called') }
  try {
    const r = await pollAll(db, cfg, dir)
    assert.equal(r.kimi, 'error')
    assert.equal(r.deepseek, 'error')
    assert.equal(r.keyHints.kimi, '(missing)')
    assert.equal(r.keyHints.deepseek, '(missing)')
  } finally {
    globalThis.fetch = prev
  }
  assert.equal(fetched, false)
  db.close()
})

// ---------- quota.mjs ----------

test('config: poll.staleAfterMin default + deep-merge override', () => {
  assert.equal(DEFAULT_CONFIG.poll.staleAfterMin, 15)
  assert.equal(mergeConfig().poll.staleAfterMin, 15)
  assert.equal(mergeConfig({ poll: { staleAfterMin: 30 } }).poll.staleAfterMin, 30)
  // unrelated poll fields preserved
  assert.equal(mergeConfig({ poll: { staleAfterMin: 30 } }).poll.timeoutMs, DEFAULT_CONFIG.poll.timeoutMs)
})

test('quota: quotaSnapshot attaches per-source freshness (collectedAt/ageMs/stale)', () => {
  const db = openLedger(':memory:')
  const now = 1_700_000_000_000
  insertSnapshot(db, { collected_at: now - 20 * 60e3, provider: 'kimi-coding', window_type: 'weekly', limit: 100, remaining: 50 })
  insertSnapshot(db, { collected_at: now - 2 * 60e3, provider: 'kimi-coding', window_type: 'rolling_5h', limit: 100, remaining: 80 })
  insertSnapshot(db, { collected_at: now - 1 * 60e3, provider: 'deepseek-official', window_type: 'balance', remaining: 12.5 })
  const q = quotaSnapshot(db, { poll: { staleAfterMin: 15 } }, now)
  assert.equal(q.kimiWeeklyRemaining, 50)
  assert.equal(q.kimiWeeklyLimit, 100)
  assert.equal(q.kimiRolling5hRemaining, 80)
  assert.equal(q.kimiRolling5hLimit, 100)
  assert.equal(q.deepseekBalanceUsd, 12.5)
  // per-source freshness
  assert.equal(q.freshness.kimiWeekly.stale, true)      // 20 min > 15 min
  assert.equal(q.freshness.kimiRolling5h.stale, false)  // 2 min
  assert.equal(q.freshness.deepseekBalance.stale, false) // 1 min
  assert.equal(q.freshness.kimiWeekly.collectedAt, now - 20 * 60e3)
  assert.equal(q.freshness.kimiWeekly.ageMs, 20 * 60e3)
  db.close()
})

test('quota: stripStale nulls stale polled fields, preserves computed fields', () => {
  const quota = {
    kimiWeeklyRemaining: 50, kimiWeeklyLimit: 100, kimiWeeklyResetTime: '2026-08-23T21:07:41Z',
    kimiRolling5hRemaining: 80, kimiRolling5hLimit: 100,
    deepseekBalanceUsd: 12.5,
    deepseekTodayUsd: 0.1,
    freshness: {
      kimiWeekly: { collectedAt: 1, ageMs: 20 * 60e3, stale: true },
      kimiRolling5h: { collectedAt: 2, ageMs: 2 * 60e3, stale: false },
      deepseekBalance: { collectedAt: 3, ageMs: 1 * 60e3, stale: false },
    },
  }
  const { quota: fresh, staleNotes } = stripStale(quota)
  assert.equal(fresh.kimiWeeklyRemaining, null)
  assert.equal(fresh.kimiWeeklyLimit, null)
  assert.equal(fresh.kimiWeeklyResetTime, null)
  assert.equal(fresh.kimiRolling5hRemaining, 80)   // fresh -> kept
  assert.equal(fresh.deepseekBalanceUsd, 12.5)     // fresh -> kept
  assert.equal(fresh.deepseekTodayUsd, 0.1)        // computed -> never stale
  assert.equal(staleNotes.length, 1)
  assert.ok(staleNotes[0].includes('kimiWeekly'))
  assert.ok(staleNotes[0].includes('stale'))
})

test('quota: incomplete DeepSeek cost is display-only and excluded from decisions', () => {
  const full = {
    deepseekTodayUsd: 0.25,
    deepseekToday: { todayUsd: 0.25, incomplete: true, unknownModels: ['mystery-model'] },
    freshness: {},
  }
  const { quota: safe } = stripStale(full)
  assert.equal(full.deepseekTodayUsd, 0.25) // lower bound remains visible
  assert.equal(safe.deepseekTodayUsd, null) // but cannot drive state/router
  assert.equal(safe.deepseekToday.incomplete, true)
})

test('quota: deepseekTodayUsd known rate -> exact cost, not incomplete', () => {
  const db = openLedger(':memory:')
  seedRates(db)
  const now = new Date(2026, 7, 20, 12, 0, 0) // local noon, Aug 20 2026
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0)
  const ts = midnight.getTime() + 3600e3 // 1h after local midnight -> today
  insertEvent(db, { session_id: 'q1', seq: 1, ts, provider: 'deepseek-official', model: 'deepseek-v4-pro', input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 })
  const r = deepseekTodayUsd(db, now)
  assert.ok(r && typeof r === 'object')
  assert.equal(r.incomplete, false)
  assert.deepEqual(r.unknownModels, [])
  const h = new Date(ts).getUTCHours()
  const pp = (h >= 1 && h < 4) || (h >= 6 && h < 10) ? 'peak' : 'offpeak'
  const rate = RATE_SEED.find(([p, m, b]) => p === 'deepseek-official' && m === 'deepseek-v4-pro' && b === 'input_' + pp)[3]
  assert.equal(r.todayUsd, Number((1_000_000 * rate / 1e6).toFixed(4)))
  db.close()
})

test('quota: deepseekTodayUsd unknown rate -> incomplete + unknownModels, never silent-zero', () => {
  const db = openLedger(':memory:')
  seedRates(db)
  const now = new Date(2026, 7, 20, 12, 0, 0)
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0)
  const ts = midnight.getTime() + 3600e3
  insertEvent(db, { session_id: 'q2', seq: 1, ts, provider: 'deepseek-official', model: 'deepseek-v4-pro', input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 })
  insertEvent(db, { session_id: 'q2', seq: 2, ts, provider: 'deepseek-official', model: 'mystery-model', input_tokens: 500_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 })
  const r = deepseekTodayUsd(db, now)
  assert.equal(r.incomplete, true)
  assert.deepEqual(r.unknownModels, ['mystery-model'])
  // only the known model is counted; the unknown rate is NOT padded with 0
  const h = new Date(ts).getUTCHours()
  const pp = (h >= 1 && h < 4) || (h >= 6 && h < 10) ? 'peak' : 'offpeak'
  const rate = RATE_SEED.find(([p, m, b]) => p === 'deepseek-official' && m === 'deepseek-v4-pro' && b === 'input_' + pp)[3]
  assert.equal(r.todayUsd, Number((1_000_000 * rate / 1e6).toFixed(4)))
  db.close()
})

test('quota: deepseekTodayUsd no events -> todayUsd 0, incomplete false (real zero)', () => {
  const db = openLedger(':memory:')
  seedRates(db)
  const r = deepseekTodayUsd(db, new Date(2026, 7, 20, 12, 0, 0))
  assert.deepEqual(r, { todayUsd: 0, incomplete: false, unknownModels: [] })
  db.close()
})

test('quota: deepseekTodayUsd unreadable ledger -> todayUsd null, incomplete true', () => {
  const db = openLedger(':memory:')
  db.close()
  const r = deepseekTodayUsd(db, new Date())
  assert.equal(r.todayUsd, null)
  assert.equal(r.incomplete, true)
  assert.deepEqual(r.unknownModels, [])
})
