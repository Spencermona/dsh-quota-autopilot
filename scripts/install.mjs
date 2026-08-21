#!/usr/bin/env node
// dsh-quota-autopilot installer — copies the bundled Auto agent preset into
// <dshHome>/.agent-presets/auto and prints the remaining manual steps.
// Zero dependencies. Never modifies cordis.patch.yml on its own: the patch
// snippet is printed for the user to apply.
//
// Usage:
//   node scripts/install.mjs [--force] [--dry-run]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const force = args.includes('--force')
const dryRun = args.includes('--dry-run')

function resolveDshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name)
    const d = path.join(dst, ent.name)
    if (ent.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(pkgRoot, 'presets', 'auto')
const dshHome = resolveDshHome()
const dest = path.join(dshHome, '.agent-presets', 'auto')

console.log('dsh-quota-autopilot installer')
console.log(`  DSH_HOME      : ${dshHome}`)
console.log(`  preset source : ${src}`)
console.log(`  preset target : ${dest}`)

if (!fs.existsSync(src)) {
  console.error('ERROR: bundled presets/auto not found — reinstall the dsh-quota-autopilot package.')
  process.exit(1)
}
if (fs.existsSync(dest) && !force && !dryRun) {
  console.error('ERROR: target already exists. Re-run with --force to overwrite.')
  process.exit(1)
}

if (dryRun) {
  console.log('dry run: no files written. The plan above is what would happen.')
} else {
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
  copyDir(src, dest)
  console.log('OK: Auto preset copied.')
}

console.log(`
Manual steps remaining:

1. Install the host plugin into your profile (example profile: web; requires pnpm):

     dsh plugin --profile web add "github:Spencermona/dsh-quota-autopilot#v0.2.0"

2. Add the plugin row to ${path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')}
   (root-level insert; create the file if missing):

     - insert:
         - id: autopilot
           name: 'dsh-quota-autopilot'

3. Restart dsh. The "Auto" preset appears in the preset picker, the autopilot
   service starts polling quotas into its data directory, and the web composer
   dock shows the quota pill (served by this package at /autopilot/api/status).

Upgrading from v0.1.0: re-run step 1 with the v0.2.0 tag above, then step 3.

Migrating from the standalone dsh-quota-panel: run
   dsh plugin --profile web remove dsh-quota-panel
and delete its insert row (id: quota-panel, incl. the obsolete statusPath) from
cordis.patch.yml — v0.2.0 serves the same pill itself and no longer reads
quota-status.json.
`)
