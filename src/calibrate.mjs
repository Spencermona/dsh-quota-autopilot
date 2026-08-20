// Auto-calibration: learns the Kimi quota-point <-> token exchange rate from
// the ledger, never guesses it. Ported from a validated personal calibration
// script, functionized with explicit gating thresholds.
//
// Algorithm (window pairing over adjacent `weekly` snapshots):
//   - dP = used(b) - used(a) for each adjacent snapshot pair
//   - only windows with dP > 0 count (resets / flat windows carry no signal)
//   - tokens = SUM(input_tokens + output_tokens) of kimi usage_events whose ts
//     falls inside the same window
//   - macro ratio = Σ(in+out) / ΣdP across all qualifying windows
//
// Explicit gate (design contract): status = 'calibrated' ONLY when
//   spanHours >= cfg.calibration.minSpanHours (default 24) AND
//   pointDelta >= cfg.calibration.minPointDelta (default 3)
// otherwise status = 'learning' and tokPerPoint = null. While learning, any
// output needing the ratio must be marked `learning: true` — never estimate.
//
// Persistence (calibration.json): saveCalibration applies drift-based sliding
// correction — once calibrated, a new ratio only replaces the stored one (and
// is appended to history) when it drifts by more than driftRelearnPct percent.

import fs from 'node:fs'
import path from 'node:path'

export function calibrate(db, cfg) {
  const snaps = db.prepare(`SELECT collected_at, used FROM account_snapshots
    WHERE provider='kimi-coding' AND window_type='weekly' ORDER BY collected_at`).all();

  const tokStmt = db.prepare(`SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o
    FROM usage_events WHERE provider='kimi-coding' AND ts>=? AND ts<?`);

  let sumTok = 0, sumDP = 0, sampleWindows = 0;
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1], b = snaps[i];
    const dP = b.used - a.used;
    if (dP <= 0) continue; // only net-consumption windows carry signal
    const tok = tokStmt.get(a.collected_at, b.collected_at);
    sumTok += tok.i + tok.o;
    sumDP += dP;
    sampleWindows++;
  }

  const spanHours = snaps.length >= 2
    ? (snaps[snaps.length - 1].collected_at - snaps[0].collected_at) / 3600e3
    : 0;

  const calibrated =
    spanHours >= cfg.calibration.minSpanHours &&
    sumDP >= cfg.calibration.minPointDelta &&
    sampleWindows > 0;

  return {
    status: calibrated ? 'calibrated' : 'learning',
    tokPerPoint: calibrated ? sumTok / sumDP : null,
    sampleWindows,
    spanHours,
    pointDelta: sumDP,
    updatedAt: Date.now(),
  };
}

// Load persisted calibration state. Missing/corrupt file -> null, never throws.
export function loadCalibration(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object') return null;
    return {
      status: j.status === 'calibrated' ? 'calibrated' : 'learning',
      tokPerPoint: typeof j.tokPerPoint === 'number' ? j.tokPerPoint : null,
      sampleWindows: j.sampleWindows ?? 0,
      spanHours: j.spanHours ?? 0,
      updatedAt: j.updatedAt ?? null,
      history: Array.isArray(j.history) ? j.history : [],
    };
  } catch {
    return null;
  }
}

// Persist calibration state with drift-based sliding correction:
//   - first time calibrated -> store ratio, seed history
//   - already calibrated -> replace the stored ratio (and push history) only
//     when the new ratio drifts by more than driftRelearnPct percent;
//     otherwise keep the previous ratio
//   - still learning -> store status/progress, keep any previous ratio+history
// Returns the state actually written.
export function saveCalibration(file, state, { driftRelearnPct = 30 } = {}) {
  const prev = loadCalibration(file);
  const out = {
    status: state.status,
    tokPerPoint: state.tokPerPoint ?? null,
    sampleWindows: state.sampleWindows ?? 0,
    spanHours: state.spanHours ?? 0,
    updatedAt: state.updatedAt ?? Date.now(),
    history: prev?.history ? [...prev.history] : [],
  };

  if (state.status === 'calibrated' && typeof state.tokPerPoint === 'number') {
    if (prev?.status === 'calibrated' && typeof prev.tokPerPoint === 'number' && prev.tokPerPoint > 0) {
      const driftPct = Math.abs(state.tokPerPoint - prev.tokPerPoint) / prev.tokPerPoint * 100;
      if (driftPct > driftRelearnPct) {
        out.history.push({ ts: out.updatedAt, tokPerPoint: state.tokPerPoint });
      } else {
        out.tokPerPoint = prev.tokPerPoint; // drift within tolerance: keep the stable value
      }
    } else {
      out.history.push({ ts: out.updatedAt, tokPerPoint: state.tokPerPoint });
    }
  } else if (prev?.status === 'calibrated' && typeof prev.tokPerPoint === 'number') {
    out.tokPerPoint = prev.tokPerPoint; // never lose a learned ratio while re-learning
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return out;
}
