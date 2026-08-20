// Durable session log parser: zstd multi-frame decoding + usage event extraction.
// Ported from a validated personal implementation; READ-ONLY against $DSH_HOME —
// this module never writes to the sessions tree, only to the ledger db.
//
// The caller passes the sessions root explicitly:
//   parseAllLogs(db, join(resolveDshHome(), 'sessions'))
//
// Three known data pitfalls (do not "fix" them away):
//   1. For the same (turn, step), the assistant/chunk usage and the final
//      assistant/message usage are a REPLACEMENT relationship — only the final
//      assistant/message value ($.data.usage) is authoritative. Chunk-level
//      usage ($.data.chunk.usage) is always skipped, eliminating double-counting
//      at the root.
//   2. reasoningTokens is already INCLUDED in outputTokens — it is stored in its
//      own column and must never be added on top when aggregating cost.
//   3. projcache has no provider dimension — this module only parses durable
//      logs and never reads projcache.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { upsertSession, insertEvent, getIngest, updateIngest } from './ledger.mjs'

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

// zstd multi-frame concatenation: the runtime appends one independent frame per
// batch. Scan for magic bytes to split frames, then decompress each frame.
export function decodeZstdFrames(buf) {
  const idx = [];
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0x28 && buf[i+1] === 0xB5 && buf[i+2] === 0x2F && buf[i+3] === 0xFD) idx.push(i);
  }
  const out = [];
  for (let i = 0; i < idx.length; i++) {
    const s = idx[i], e = i + 1 < idx.length ? idx[i + 1] : buf.length;
    try {
      out.push(zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'));
    } catch { /* the tail frame may be incomplete (still being written) — skip it */ }
  }
  return out.join('');
}

function* walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (ent.name === 'session.jsonl.zstd') yield p;
  }
}

export function parseFile(db, filePath) {
  const stat = fs.statSync(filePath);
  const prev = getIngest(db, filePath);
  if (prev && prev.size === stat.size && prev.mtime === Math.floor(stat.mtimeMs)) {
    return { skipped: true, events: 0, sessions: 0, badLines: 0 };
  }
  const text = decodeZstdFrames(fs.readFileSync(filePath));
  const dirSessionId = path.basename(path.dirname(filePath));
  let headerId = null, events = 0, sessions = 0, badLines = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { badLines++; continue; }

    if (j.type === 'session') {
      const d = j;
      headerId = d.id ?? headerId;
      upsertSession(db, {
        session_id: d.id ?? dirSessionId,
        parent_session_id: d.parentSession ?? null,
        origin: d.origin ?? null,
        delegation_depth: d.delegationDepth ?? null,
        agent_preset: d.agentPreset ?? null,
        cwd: d.cwd ?? null,
        created_at: d.createdAt ?? null,
      });
      sessions++;
    } else if (j.type === 'assistant/message' && j.data && j.data.usage) {
      const u = j.data.usage;
      const src = j.data.message?.source ?? j.data.source ?? {};
      const inserted = insertEvent(db, {
        session_id: headerId ?? dirSessionId,
        seq: j.seq,
        ts: j.time ?? null,
        provider: src.provider ?? null,
        model: src.model ?? null,
        input_tokens: u.inputTokens ?? 0,
        output_tokens: u.outputTokens ?? 0,
        cache_read_tokens: u.cacheReadTokens ?? 0,
        cache_write_tokens: u.cacheWriteTokens ?? 0,
        reasoning_tokens: u.reasoningTokens ?? 0,
      });
      if (inserted) events++;
    }
  }
  updateIngest(db, {
    path: filePath, size: stat.size, mtime: Math.floor(stat.mtimeMs),
    event_count: events, last_parsed_at: Date.now(),
  });
  return { skipped: false, events, sessions, badLines };
}

export function parseAllLogs(db, sessionsRoot) {
  const r = { filesSeen: 0, filesParsed: 0, filesSkipped: 0, eventsInserted: 0, sessionsUpserted: 0, badLines: 0 };
  if (!sessionsRoot || !fs.existsSync(sessionsRoot)) return r;
  for (const f of walk(sessionsRoot)) {
    r.filesSeen++;
    try {
      const pr = parseFile(db, f);
      if (pr.skipped) r.filesSkipped++;
      else { r.filesParsed++; r.eventsInserted += pr.events; r.sessionsUpserted += pr.sessions; r.badLines += pr.badLines; }
    } catch (e) {
      console.warn(`WARN parse failed: ${f}: ${e.message}`);
    }
  }
  return r;
}
