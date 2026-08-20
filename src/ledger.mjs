// Quota ledger: account snapshots + attributed usage events in node:sqlite.
// Ported from a validated personal implementation; the schema below is FROZEN —
// any change must ship with a migration and stay in sync with the README.
//
// Idempotency is the core guarantee:
//   - usage_events: PK(session_id, seq) + INSERT OR IGNORE -> re-runs and
//     duplicate files never double-count.
//   - ingest_state: size+mtime short-circuit in the parser (src/parse-logs.mjs)
//     skips unchanged log files entirely.
//
// Requires Node >= 22.15 (native node:sqlite). Zero npm dependencies.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Frozen schema — five tables, field-for-field identical to the validated
// personal ledger. Do not edit casually.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions(
  session_id TEXT PRIMARY KEY, parent_session_id TEXT, origin TEXT,
  delegation_depth INTEGER, agent_preset TEXT, cwd TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS usage_events(
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER,
  provider TEXT, model TEXT,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  PRIMARY KEY(session_id, seq));
CREATE TABLE IF NOT EXISTS account_snapshots(
  id INTEGER PRIMARY KEY AUTOINCREMENT, collected_at INTEGER NOT NULL,
  provider TEXT NOT NULL, window_type TEXT NOT NULL,
  "limit" REAL, used REAL, remaining REAL, reset_time TEXT, unit TEXT, raw_json TEXT);
CREATE TABLE IF NOT EXISTS ingest_state(
  path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER,
  event_count INTEGER, last_parsed_at INTEGER);
CREATE TABLE IF NOT EXISTS rates(
  provider TEXT, model TEXT, bucket TEXT, usd_per_mtoken REAL, source TEXT,
  PRIMARY KEY(provider, model, bucket));
`;

export function openLedger(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }
  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA)
  return db
}

export function upsertSession(db, s) {
  db.prepare(`INSERT INTO sessions(session_id,parent_session_id,origin,delegation_depth,agent_preset,cwd,created_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET
      parent_session_id=excluded.parent_session_id, origin=excluded.origin,
      delegation_depth=excluded.delegation_depth, agent_preset=excluded.agent_preset,
      cwd=excluded.cwd, created_at=excluded.created_at`)
    .run(s.session_id, s.parent_session_id ?? null, s.origin ?? null,
         s.delegation_depth ?? null, s.agent_preset ?? null, s.cwd ?? null, s.created_at ?? null);
}

// Idempotency core: PK(session_id, seq) + INSERT OR IGNORE -> re-runs and
// duplicate files never double-count. Returns true when a row was inserted.
export function insertEvent(db, e) {
  const r = db.prepare(`INSERT OR IGNORE INTO usage_events
    (session_id,seq,ts,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(e.session_id, e.seq, e.ts ?? null, e.provider ?? null, e.model ?? null,
         e.input_tokens ?? 0, e.output_tokens ?? 0, e.cache_read_tokens ?? 0,
         e.cache_write_tokens ?? 0, e.reasoning_tokens ?? 0);
  return r.changes > 0;
}

export function insertSnapshot(db, snap) {
  db.prepare(`INSERT INTO account_snapshots(collected_at,provider,window_type,"limit",used,remaining,reset_time,unit,raw_json)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(snap.collected_at, snap.provider, snap.window_type,
         snap.limit ?? null, snap.used ?? null, snap.remaining ?? null,
         snap.reset_time ?? null, snap.unit ?? null, snap.raw_json ?? null);
}

export function getIngest(db, path) {
  return db.prepare('SELECT * FROM ingest_state WHERE path=?').get(path);
}

export function updateIngest(db, st) {
  db.prepare(`INSERT INTO ingest_state(path,size,mtime,event_count,last_parsed_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime,
      event_count=excluded.event_count, last_parsed_at=excluded.last_parsed_at`)
    .run(st.path, st.size, st.mtime, st.event_count, st.last_parsed_at);
}

// Rate seed: DeepSeek V4 official peak/off-peak pricing + Kimi subscription
// (flat, not billed per token). peak = UTC 01:00-04:00 & 06:00-10:00.
const PRICE_SRC = 'https://api-docs.deepseek.com/quick_start/pricing/';
export const RATE_SEED = [
  ['deepseek-official', 'deepseek-v4-flash', 'input_offpeak', 0.22],  // cache miss
  ['deepseek-official', 'deepseek-v4-flash', 'input_peak', 0.44],
  ['deepseek-official', 'deepseek-v4-flash', 'cache_read_offpeak', 0.007],
  ['deepseek-official', 'deepseek-v4-flash', 'cache_read_peak', 0.014],
  ['deepseek-official', 'deepseek-v4-flash', 'cache_write_offpeak', 0.22], // billed as cache miss
  ['deepseek-official', 'deepseek-v4-flash', 'cache_write_peak', 0.44],
  ['deepseek-official', 'deepseek-v4-flash', 'output_offpeak', 0.66],
  ['deepseek-official', 'deepseek-v4-flash', 'output_peak', 1.32],
  ['deepseek-official', 'deepseek-v4-pro', 'input_offpeak', 0.66],
  ['deepseek-official', 'deepseek-v4-pro', 'input_peak', 1.32],
  ['deepseek-official', 'deepseek-v4-pro', 'cache_read_offpeak', 0.022],
  ['deepseek-official', 'deepseek-v4-pro', 'cache_read_peak', 0.044],
  ['deepseek-official', 'deepseek-v4-pro', 'cache_write_offpeak', 0.66],
  ['deepseek-official', 'deepseek-v4-pro', 'cache_write_peak', 1.32],
  ['deepseek-official', 'deepseek-v4-pro', 'output_offpeak', 1.98],
  ['deepseek-official', 'deepseek-v4-pro', 'output_peak', 3.96],
  ['kimi-coding', 'k3', 'subscription', 0], // flat subscription, not billed per token
];

// Insert the seed only into an EMPTY rates table; never overwrites user rates.
export function seedRates(db) {
  const c = db.prepare('SELECT COUNT(*) c FROM rates').get().c;
  if (c > 0) return 0;
  const stmt = db.prepare('INSERT OR IGNORE INTO rates(provider,model,bucket,usd_per_mtoken,source) VALUES(?,?,?,?,?)');
  for (const [p, m, b, v] of RATE_SEED) {
    stmt.run(p, m, b, v, b === 'subscription' ? 'flat subscription' : PRICE_SRC);
  }
  return RATE_SEED.length;
}
