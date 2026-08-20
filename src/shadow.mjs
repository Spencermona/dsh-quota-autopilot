// Shadow log: advice vs. actual consumption, one JSON object per line (JSONL).
// Advisory only — the plugin never calls any API that changes routing; this log
// is the observation record that lets users compare what was suggested against
// what actually happened (reconciled later by the ledger via sessionId).
//
// Entry shape (see docs/DESIGN.md section 5.2):
//   { ts, kind: 'advice', task, type, estTokens,
//     recommendation: { role, provider, model },
//     quotaState, calibration: 'learning'|'calibrated', sessionId }
//
// The shadow log lives in the plugin data directory, never under $DSH_HOME.

import fs from 'node:fs'
import path from 'node:path'

// Append one JSONL entry, creating the parent directory as needed.
export function appendShadow(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
}

// Read the last `limit` entries, newest-last. Tolerates corrupt lines (skipped).
// Missing file -> [].
export function readShadow(file, limit = 50) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return out.slice(-limit);
}
