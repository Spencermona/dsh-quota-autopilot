// Path resolution, credentials reading, and key redaction.
// Pure functions, no side effects. Everything under $DSH_HOME is read-only here.
//
// DSH_HOME resolution order: explicit override > $DSH_HOME env > ~/.dsh
// API keys are read BY NAME from <dshHome>/.credentials.yaml; key values never
// appear in logs or output — anything user-visible must go through redactKey().

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

export function resolveDshHome(override) {
  return override ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

// Redact a secret for display: first 4 + '****' + last 4.
// null/undefined -> '(missing)'; non-string or shorter than 12 chars -> '(invalid)'.
export function redactKey(key) {
  if (key === null || key === undefined) return '(missing)'
  if (typeof key !== 'string' || key.length < 12) return '(invalid)'
  return key.slice(0, 4) + '****' + key.slice(-4)
}

// Minimal YAML-subset reader for <dshHome>/.credentials.yaml (zero dependencies,
// deliberately more robust than a single regex):
//   - top-level `KEY: value` or `KEY=value` lines only (indented lines are
//     treated as nested and skipped)
//   - optional single/double quotes around the value
//   - trailing comments after unquoted values (`value # note`)
//   - full-line comments and blank lines are ignored
// Missing file / unreadable file / missing keys -> null fields. Never throws.
export function readCredentials(dshHome, { kimiKeyName, deepseekKeyName } = {}) {
  const out = { kimi: null, deepseek: null }
  try {
    const text = fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8')
    const values = new Map()
    for (const rawLine of text.split(/\r?\n/)) {
      if (rawLine === '' || /^\s/.test(rawLine)) continue // top-level keys only
      const line = rawLine.trimEnd()
      if (line.startsWith('#')) continue
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.*)$/)
      if (!m) continue
      let v = m[2].trim()
      if (v === '') continue
      const q = v[0]
      if (q === '"' || q === "'") {
        const end = v.indexOf(q, 1)
        v = end > 0 ? v.slice(1, end) : v.slice(1)
      } else {
        const ci = v.indexOf('#')
        if (ci >= 0) v = v.slice(0, ci).trimEnd()
      }
      if (v !== '') values.set(m[1], v)
    }
    out.kimi = (kimiKeyName && values.get(kimiKeyName)) ?? null
    out.deepseek = (deepseekKeyName && values.get(deepseekKeyName)) ?? null
  } catch {
    // unreadable/missing credentials file -> all null, never throw
  }
  return out
}
