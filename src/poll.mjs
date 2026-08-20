// Account quota polling: Kimi /v1/usages + DeepSeek /user/balance.
// Ported from a validated personal implementation; endpoints, timeouts and
// credential key NAMES all come from the merged config (src/config.mjs) — no
// environment variables, no hardcoded personal paths.
//
// Defensive parsing contract (both providers):
//   - string numbers are coerced with Number(); NaN -> null, never crashes
//   - schema drift -> a `parse_error` snapshot row + console.warn, never throws
//   - network/HTTP errors -> a `fetch_error` snapshot row, never throws
// Key values never leave this module unredacted: the returned keyHints are
// produced by redactKey().

import { insertSnapshot, seedRates } from './ledger.mjs'
import { readCredentials, redactKey } from './paths.mjs'

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

async function fetchRaw(url, headers, timeoutMs) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  return { status: r.status, raw: await r.text() };
}

async function pollKimi(db, key, now, cfg) {
  const url = cfg.poll.kimiUsageUrl;
  const timeoutMs = cfg.poll.timeoutMs;
  let raw, status;
  try {
    ({ status, raw } = await fetchRaw(url, { 'x-api-key': key }, timeoutMs));
  } catch (e) {
    insertSnapshot(db, { collected_at: now, provider: 'kimi-coding', window_type: 'fetch_error', raw_json: JSON.stringify({ error: e.message }) });
    console.warn(`WARN kimi fetch failed: ${e.message}`);
    return 'error';
  }
  if (status !== 200) {
    insertSnapshot(db, { collected_at: now, provider: 'kimi-coding', window_type: 'fetch_error', raw_json: JSON.stringify({ status, body: raw.slice(0, 500) }) });
    console.warn(`WARN kimi status ${status}`);
    return 'error';
  }
  let j;
  try { j = JSON.parse(raw); } catch (e) {
    insertSnapshot(db, { collected_at: now, provider: 'kimi-coding', window_type: 'parse_error', raw_json: raw.slice(0, 2000) });
    console.warn(`WARN kimi parse_error: ${e.message}`);
    return 'error';
  }
  let rows = 0;
  const snap = (window_type, o) => { insertSnapshot(db, { collected_at: now, provider: 'kimi-coding', raw_json: raw, ...o }); rows++; };
  // Defensive parsing: fields may be string numbers; missing/drifted fields ->
  // parse_error row + WARN, never a crash. Four snapshot kinds when healthy:
  // weekly / rolling_5h / booster_wallet / parallel_limit.
  if (j.usage && typeof j.usage === 'object') {
    snap('weekly', { window_type: 'weekly', limit: num(j.usage.limit), used: num(j.usage.used), remaining: num(j.usage.remaining), reset_time: j.usage.resetTime ?? null, unit: 'quota_points' });
  } else {
    console.warn('WARN kimi schema drift: missing usage');
    snap('parse_error', { window_type: 'parse_error' });
  }
  const l0 = Array.isArray(j.limits) ? j.limits[0]?.detail : null;
  if (l0) {
    snap('rolling_5h', { window_type: 'rolling_5h', limit: num(l0.limit), used: num(l0.used), remaining: num(l0.remaining), reset_time: l0.resetTime ?? null, unit: 'quota_points' });
  } else {
    console.warn('WARN kimi schema drift: missing limits[0].detail');
    snap('parse_error', { window_type: 'parse_error' });
  }
  const bal = j.boosterWallet?.balance;
  if (bal) {
    snap('booster_wallet', { window_type: 'booster_wallet', limit: num(bal.amount), remaining: num(bal.amountLeft), unit: bal.unit ?? 'UNIT_CURRENCY' });
  }
  if (j.parallel) {
    snap('parallel_limit', { window_type: 'parallel_limit', limit: num(j.parallel.limit), used: Array.isArray(j.parallel.details) ? j.parallel.details.length : null, unit: 'sessions' });
  }
  return rows > 0 ? 'ok' : 'error';
}

async function pollDeepSeek(db, key, now, cfg) {
  const url = cfg.poll.deepseekBalanceUrl;
  const timeoutMs = cfg.poll.timeoutMs;
  let raw, status;
  try {
    ({ status, raw } = await fetchRaw(url, { Authorization: 'Bearer ' + key }, timeoutMs));
  } catch (e) {
    insertSnapshot(db, { collected_at: now, provider: 'deepseek-official', window_type: 'fetch_error', raw_json: JSON.stringify({ error: e.message }) });
    console.warn(`WARN deepseek fetch failed: ${e.message}`);
    return 'error';
  }
  if (status !== 200) {
    insertSnapshot(db, { collected_at: now, provider: 'deepseek-official', window_type: 'fetch_error', raw_json: JSON.stringify({ status, body: raw.slice(0, 500) }) });
    console.warn(`WARN deepseek status ${status}`);
    return 'error';
  }
  let j;
  try { j = JSON.parse(raw); } catch (e) {
    insertSnapshot(db, { collected_at: now, provider: 'deepseek-official', window_type: 'parse_error', raw_json: raw.slice(0, 2000) });
    console.warn(`WARN deepseek parse_error: ${e.message}`);
    return 'error';
  }
  const bi = Array.isArray(j.balance_infos) ? j.balance_infos[0] : null;
  if (!bi) {
    console.warn('WARN deepseek schema drift: missing balance_infos[0]');
    insertSnapshot(db, { collected_at: now, provider: 'deepseek-official', window_type: 'parse_error', raw_json: raw });
    return 'error';
  }
  const cur = bi.currency ?? 'USD';
  insertSnapshot(db, { collected_at: now, provider: 'deepseek-official', window_type: 'balance', remaining: num(bi.total_balance), unit: cur, raw_json: raw });
  insertSnapshot(db, { collected_at: now, provider: 'deepseek-official', window_type: 'balance_granted', remaining: num(bi.granted_balance), unit: cur, raw_json: raw });
  insertSnapshot(db, { collected_at: now, provider: 'deepseek-official', window_type: 'balance_topped_up', remaining: num(bi.topped_up_balance), unit: cur, raw_json: raw });
  return 'ok';
}

// Poll both providers and persist snapshots. cfg is the MERGED config
// (cfg.poll.* endpoints/timeout, cfg.credentials.*KeyName). dshHome is where
// .credentials.yaml lives (resolved by the caller via paths.resolveDshHome).
// `keys` is an optional pre-resolved {kimi, deepseek} pair: the host plugin
// resolves keys service-first (ctx.credentials) and passes them here; when
// omitted, keys fall back to readCredentials(dshHome).
export async function pollAll(db, cfg, dshHome, keys) {
  const seeded = seedRates(db);
  if (seeded) console.log(`rates seeded: ${seeded} rows`);
  const resolved = keys ?? readCredentials(dshHome, cfg.credentials);
  const now = Date.now();
  const kimi = resolved.kimi
    ? await pollKimi(db, resolved.kimi, now, cfg)
    : (console.warn(`WARN ${cfg.credentials.kimiKeyName} not found in credentials`), 'error');
  const deepseek = resolved.deepseek
    ? await pollDeepSeek(db, resolved.deepseek, now, cfg)
    : (console.warn(`WARN ${cfg.credentials.deepseekKeyName} not found in credentials`), 'error');
  return { kimi, deepseek, keyHints: { kimi: redactKey(resolved.kimi), deepseek: redactKey(resolved.deepseek) } };
}
