// Shape test for the hand-written browser bundle (client.js) — no build step,
// no React runtime needed. Loads the lazy-CJS module in a sandbox and asserts
// the module contract: it registers via window.__ModuleLoader__.load, exports
// {apply, inject:['slots']}, registers the composer-dock slot under a stable id,
// and requests the NEW /autopilot/api/status path (not the legacy quota-panel
// path). Run directly:
//   node test/client.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const clientPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

// Minimal React surface the bundle touches at module-definition time.
function loadClientModule() {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: () => [null, () => {}],
    useEffect: () => {},
    useSyncExternalStore: (_sub, get) => get(),
  }
  let def = null
  const win = {
    __ModuleLoader__: { load: (d) => { def = d } },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const requireFn = (name) => {
    if (name === 'react') return React
    throw new Error('require of unknown module: ' + name)
  }
  const code = fs.readFileSync(clientPath, 'utf8')
  // The bundle runs `window.__ModuleLoader__.load({...})` at top level.
  new Function('window', 'require', code)(win, requireFn)
  assert.ok(def, 'client must register via window.__ModuleLoader__.load')
  return def.factory(requireFn)
}

test('client: lazy-CJS module exports apply + inject:[slots]', () => {
  const mod = loadClientModule()
  assert.ok(mod && typeof mod.apply === 'function')
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('slots'))
})

test('client: apply registers the composer-dock slot with a stable id', () => {
  const mod = loadClientModule()
  const captured = {}
  const ctx = {
    get: () => undefined,
    slots: {
      inject: (slot, gen) => {
        captured.slot = slot
        captured.register = gen().next().value
      },
      register: (descriptor, component) => ({ descriptor, component }),
    },
  }
  mod.apply(ctx)
  assert.equal(captured.slot, 'conversation.composer.dock')
  assert.equal(captured.register.descriptor.name, 'conversation.composer.dock')
  assert.equal(captured.register.descriptor.id, 'quota-autopilot')
  assert.equal(typeof captured.register.component, 'function')
})

test('client: requests /autopilot/api/status, not the legacy path', () => {
  const src = fs.readFileSync(clientPath, 'utf8')
  assert.ok(src.includes('/autopilot/api/status'), 'must poll the new autopilot status route')
  assert.ok(!src.includes('/quota-panel/api/status'), 'must not poll the legacy quota-panel route')
  assert.ok(src.includes('sourceStale'), 'per-source stale data must produce a visible stale marker')
})
