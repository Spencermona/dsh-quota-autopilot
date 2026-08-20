#!/usr/bin/env node
// dsh-quota-autopilot uninstaller — removes the Auto agent preset copy from
// <dshHome>/.agent-presets/auto (only with --yes) and prints the remaining
// manual steps. Zero dependencies. Touches nothing else under $DSH_HOME.
//
// Usage:
//   node scripts/uninstall.mjs --yes

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const yes = args.includes('--yes')

function resolveDshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

const dshHome = resolveDshHome()
const presetDir = path.join(dshHome, '.agent-presets', 'auto')

console.log('dsh-quota-autopilot uninstaller')
console.log(`  DSH_HOME    : ${dshHome}`)
console.log(`  preset copy : ${presetDir}`)

if (!yes) {
  console.log('Refusing to act without --yes. Nothing was changed.')
  process.exit(1)
}

if (fs.existsSync(presetDir)) {
  fs.rmSync(presetDir, { recursive: true, force: true })
  console.log('OK: Auto preset copy removed.')
} else {
  console.log('Auto preset copy not found — nothing to remove.')
}

console.log(`
Manual steps remaining:

1. Remove the autopilot row from ${path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')}
   (the "- insert:" entry with id: autopilot / name: 'dsh-quota-autopilot').

2. Remove the plugin package from the profile:

     dsh plugin --profile web remove dsh-quota-autopilot

3. Optional: delete the plugin data directory (ledger, calibration, shadow
   log). It lives at ONE of:

     <profile directory>/data/dsh-quota-autopilot        (profile install)
     ${path.join(dshHome, 'plugin-data', 'dsh-quota-autopilot')}   (fallback)

4. Restart dsh.
`)
