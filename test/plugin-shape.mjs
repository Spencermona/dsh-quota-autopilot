// Offline smoke test for the dsh-coupled plugin files (index.mjs / advisor.mjs /
// src/roles.mjs) against a mock cordis ctx. No network, no real $DSH_HOME:
// every filesystem side effect lands in a fresh os.tmpdir() directory passed
// via config {dshHome, dataDir}.
//
// Run directly (do NOT use `node --test <dir>` — the directory runner spawns
// child processes, which hits EPERM in some sandboxes):
//   node test/plugin-shape.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as hostPlugin from '../index.mjs'
import * as advisor from '../advisor.mjs'
import { openLedger } from '../src/ledger.mjs'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quota-autopilot-shape-'))
}

// Minimal cordis ctx mock. services: map for ctx.get(); captures provided
// services, registered tools, and effect cleanups.
function mockCtx(services = {}) {
  const provided = {}
  const tools = []
  const cleanups = []
  const ctx = {
    get: (n) => services[n],
    on: () => () => {},
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') cleanups.push(d)
      return () => {}
    },
    provide: (n, v) => { provided[n] = v },
    inject: (deps, cb) => {
      // cordis runs the callback once all deps are available; emulate that
      // synchronously — and not at all when a dep is missing.
      if (deps.every((d) => services[d] !== undefined)) cb(ctx)
      return () => {}
    },
    tools: { register: (def) => { tools.push(def); return () => {} } },
  }
  return { ctx, provided, tools, cleanups }
}

const fullLlm = {
  listProviders: () => [
    { id: 'deepseek-official', name: 'DeepSeek Official' },
    { id: 'kimi-coding', name: 'Kimi Coding' },
  ],
  listModels: async (p) => (p === 'deepseek-official'
    ? [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }]
    : [{ id: 'k3' }]),
}

async function waitFor(cond, ms = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

test('host plugin: provides autopilot service; status/advise/roles work; shadow log written', async () => {
  const dir = tmpdir()
  const dshHome = path.join(dir, 'dsh-home')
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dshHome, { recursive: true })
  const { ctx, provided, cleanups } = mockCtx({ llm: fullLlm })

  assert.equal(hostPlugin.name, 'autopilot')
  assert.deepEqual(hostPlugin.inject, [])
  await hostPlugin.apply(ctx, { dshHome, dataDir })

  const svc = provided.autopilot
  assert.ok(svc, 'service "autopilot" must be provided')
  assert.equal(svc.dataDir, dataDir)

  // boot tick (poll with no credentials -> fast warn path) must complete
  assert.ok(await waitFor(() => svc.status().poll !== null), 'first poll round should finish')

  const st = svc.status()
  assert.equal(st.ok, true)
  assert.equal(typeof st.state, 'string')
  assert.ok(st.quota && typeof st.quota === 'object')
  assert.equal(st.keyHints.kimi, '(missing)') // redactKey over absent keys
  assert.equal(st.keyHints.deepseek, '(missing)')
  assert.equal(st.calibration.status, 'learning')

  const adv = await svc.advise({ task: 'fix the flaky test', type: 'coding', estTokens: 30000 })
  assert.ok(adv.recommended, 'coding task should resolve a recommendation')
  assert.equal(adv.recommended.role, 'main')
  assert.equal(adv.recommended.provider, 'deepseek-official')
  assert.equal(adv.recommended.model, 'deepseek-v4-pro')
  assert.equal(adv.calibration.status, 'learning')
  assert.equal(adv.learning, true)
  assert.ok(adv.notes.some((n) => n.includes('learning: true')), 'learning note must be present')
  assert.equal(typeof adv.quotaState, 'string')
  assert.ok(Array.isArray(adv.candidates))

  const rr = await svc.roles()
  assert.equal(rr.roles.worker.model, 'deepseek-v4-flash')
  assert.equal(rr.roles['long-context'].model, 'k3')
  assert.equal(rr.sources.worker, 'knowledge-base')
  assert.ok(Array.isArray(rr.probed) && rr.probed.length >= 2)

  const shadowFile = path.join(dataDir, 'shadow-log.jsonl')
  assert.ok(fs.existsSync(shadowFile), 'shadow log must be written into dataDir')
  const lines = fs.readFileSync(shadowFile, 'utf8').trim().split('\n')
  const entry = JSON.parse(lines[lines.length - 1])
  assert.equal(entry.kind, 'advice')
  assert.equal(entry.type, 'coding')
  assert.equal(entry.recommendation.model, 'deepseek-v4-pro')

  // calibration.json persisted
  assert.ok(fs.existsSync(path.join(dataDir, 'calibration.json')))

  for (const c of cleanups) c()
})

test('advisor row: registers route_consult and execute returns a recommendation', async () => {
  const dir = tmpdir()
  const dshHome = path.join(dir, 'dsh-home')
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dshHome, { recursive: true })
  const host = mockCtx({ llm: fullLlm })
  await hostPlugin.apply(host.ctx, { dshHome, dataDir })
  assert.ok(await waitFor(() => host.provided.autopilot.status().poll !== null))

  assert.equal(advisor.name, 'autopilot-advisor')
  assert.deepEqual(advisor.inject, ['autopilot', 'tools'])
  const adv = mockCtx()
  adv.ctx.autopilot = host.provided.autopilot // emulate inject: ['autopilot']
  advisor.apply(adv.ctx)

  assert.equal(adv.tools.length, 1)
  const tool = adv.tools[0]
  assert.equal(tool.name, 'route_consult')
  assert.ok(tool.description.includes('Advisory only'))
  // dsh-tools value-schema DSL: parameters is a map of name -> schema
  assert.equal(tool.parameters.task?.required, true)
  assert.ok(Array.isArray(tool.parameters.type?.enum))

  const out = await tool.execute({ task: 'review the diff', type: 'review' }, {})
  assert.ok(out.recommended, 'review task should resolve')
  assert.equal(out.recommended.role, 'reviewer')
  assert.equal(out.recommended.model, 'deepseek-v4-pro')

  // render returns [{type:'text', text}] with JSON text
  const rendered = tool.output.render({}, out)
  assert.equal(rendered[0].type, 'text')
  const parsed = JSON.parse(rendered[0].text)
  assert.ok(parsed.recommended)

  // sessionId from exec context lands in the shadow entry when present
  await tool.execute({ task: 'summarize this', type: 'summary' }, { sessionId: 'sess-123' })
  const lines = fs.readFileSync(path.join(dataDir, 'shadow-log.jsonl'), 'utf8').trim().split('\n')
  const last = JSON.parse(lines[lines.length - 1])
  assert.equal(last.sessionId, 'sess-123')

  for (const c of host.cleanups) c()
})

test('degraded mode: no llm / no agentDefaultModel -> roles unavailable, advise still works', async () => {
  const dir = tmpdir()
  const dshHome = path.join(dir, 'dsh-home')
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dshHome, { recursive: true })
  const { ctx, provided, cleanups } = mockCtx({}) // nothing at all

  await hostPlugin.apply(ctx, { dshHome, dataDir })
  const svc = provided.autopilot
  assert.ok(await waitFor(() => svc.status().poll !== null))

  const rr = await svc.roles()
  assert.equal(rr.roles.main, null)
  assert.equal(rr.sources.main, 'unavailable')
  assert.ok(rr.notes.some((n) => n.includes('llm service not available')))

  const adv = await svc.advise({ task: 'do something', type: 'coding' })
  assert.equal(adv.recommended, null) // guardrail: never invent a route
  assert.ok(adv.why.includes('unavailable'))
  assert.equal(svc.status().ok, true)

  for (const c of cleanups) c()
})

test('user override is the only way an unknown model enters routing', async () => {
  const dir = tmpdir()
  const dshHome = path.join(dir, 'dsh-home')
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dshHome, { recursive: true })
  const { ctx, provided, cleanups } = mockCtx({ llm: fullLlm })

  await hostPlugin.apply(ctx, {
    dshHome,
    dataDir,
    roles: { worker: { provider: 'acme', model: 'acme-mystery-1', reasoningEffort: 'low' } },
  })
  const svc = provided.autopilot

  const rr = await svc.roles()
  assert.equal(rr.roles.worker.model, 'acme-mystery-1')
  assert.equal(rr.sources.worker, 'user-override')

  const adv = await svc.advise({ task: 'batch job', type: 'batch' })
  assert.equal(adv.recommended.role, 'worker')
  assert.equal(adv.recommended.model, 'acme-mystery-1')

  for (const c of cleanups) c()
})

test('default-model fallback fills main when knowledge base cannot', async () => {
  const dir = tmpdir()
  const dshHome = path.join(dir, 'dsh-home')
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dshHome, { recursive: true })
  const { ctx, provided, cleanups } = mockCtx({
    // llm absent -> probing skipped; only the default model can fill main
    agentDefaultModel: { currentSelection: () => ({ provider: 'kimi-coding', model: 'k3' }) },
  })

  await hostPlugin.apply(ctx, { dshHome, dataDir })
  const rr = await provided.autopilot.roles()
  assert.equal(rr.roles.main.model, 'k3')
  assert.equal(rr.sources.main, 'deployment-default')
  assert.equal(rr.roles.worker, null)

  for (const c of cleanups) c()
})

test('stale quota fields are excluded from state, surfaced in notes', async () => {
  const dir = tmpdir()
  const dshHome = path.join(dir, 'dsh-home')
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dshHome, { recursive: true })
  const { ctx, provided, cleanups } = mockCtx({ llm: fullLlm })

  await hostPlugin.apply(ctx, { dshHome, dataDir, poll: { staleAfterMin: 15 } })
  const svc = provided.autopilot
  assert.ok(await waitFor(() => svc.status().poll !== null))

  // Write a stale weekly snapshot (remaining 1 would normally trigger
  // EMERGENCY) directly into the plugin's ledger via a second handle.
  const db = openLedger(path.join(dataDir, 'ledger.db'))
  const now = Date.now()
  db.prepare(`INSERT INTO account_snapshots(collected_at,provider,window_type,"limit",remaining) VALUES(?,?,?,?,?)`)
    .run(now - 20 * 60e3, 'kimi-coding', 'weekly', 100, 1)
  db.close()

  const st = svc.status()
  assert.equal(st.quota.kimiWeeklyRemaining, 1)          // value still visible
  assert.equal(st.quota.freshness.kimiWeekly.stale, true) // ...but marked stale
  assert.equal(st.state, 'NORMAL')                        // stale excluded -> no EMERGENCY
  assert.ok(st.notes.some((n) => n.includes('kimiWeekly') && n.includes('stale')))

  // advise must not let the stale low-remaining value force a downgrade either
  const adv = await svc.advise({ task: 'fix a test', type: 'coding', estTokens: 30000 })
  assert.equal(adv.quotaState, 'NORMAL')
  assert.ok(adv.notes.some((n) => n.includes('kimiWeekly') && n.includes('stale')))

  for (const c of cleanups) c()
})

test('panel: mounts /autopilot/api/status only when webServer is present', async () => {
  const dir = tmpdir()
  const dshHome = path.join(dir, 'dsh-home')
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dshHome, { recursive: true })
  const routes = []
  const ws = { register: (def) => { routes.push(def); return () => {} } }
  const { ctx, provided, cleanups } = mockCtx({ llm: fullLlm, webServer: ws })

  await hostPlugin.apply(ctx, { dshHome, dataDir, panel: { codex: false, local: false } })
  const svc = provided.autopilot
  assert.ok(await waitFor(() => svc.status().poll !== null))

  const route = routes.find((r) => r.path === '/autopilot/api/status')
  assert.ok(route, 'panel route must be registered when webServer exists')

  let body = null
  await route.handler({ method: 'GET' }, { writeHead: () => {}, end: (s) => { body = s } })
  const j = JSON.parse(body)
  assert.ok(j.panel && typeof j.panel.staleMs === 'number')
  assert.ok(j.kimi && 'weekly' in j.kimi && 'rolling5h' in j.kimi)
  assert.ok('balanceUsd' in j.deepseek)
  assert.ok('todayUsd' in j.cost && 'incomplete' in j.cost)
  assert.ok('codex' in j && 'local' in j)
  assert.equal(j.updatedAt === null || typeof j.updatedAt === 'number', true)
  // codex/local probing disabled in this test -> null, not absent
  assert.equal(j.codex, null)
  assert.equal(j.local, null)

  let status405 = null
  await route.handler({ method: 'POST' }, { writeHead: (c) => { status405 = c }, end: () => {} })
  assert.equal(status405, 405)

  for (const c of cleanups) c()
})

test('panel: absent webServer -> no route, plugin still mounts', async () => {
  const dir = tmpdir()
  const dshHome = path.join(dir, 'dsh-home')
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dshHome, { recursive: true })
  const { ctx, provided, cleanups } = mockCtx({ llm: fullLlm }) // no webServer

  await hostPlugin.apply(ctx, { dshHome, dataDir })
  const svc = provided.autopilot
  assert.ok(await waitFor(() => svc.status().poll !== null))
  assert.equal(svc.status().ok, true) // mounts and serves status without webServer

  for (const c of cleanups) c()
})
