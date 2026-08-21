// Package-shape test: asserts the published manifest (package.json) and the
// files it references are consistent for v0.3.0 — version, exports (./client),
// files list, the dsh.client inject/platform block, and the lockfile version.
// Run directly:
//   node test/package-shape.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('package: version 0.3.0 and lockfile in sync', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package-lock.json'), 'utf8'))
  assert.equal(pkg.version, '0.3.0')
  assert.equal(lock.version, '0.3.0')
  assert.equal(lock.packages[''].version, '0.3.0')
  assert.equal(pkg.name, lock.name)
})

test('package: exports ./client and ./package.json, files include client.js', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.main, 'index.mjs')
  assert.equal(pkg.exports['.'], './index.mjs')
  assert.equal(pkg.exports['./advisor'], './advisor.mjs')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./package.json'], './package.json')
  assert.ok(pkg.files.includes('client.js'), 'files must ship the browser bundle')
  assert.ok(pkg.files.includes('src/'), 'files must ship src/ (incl. panel.mjs)')
})

test('package: dsh.client block declares inject + platform web', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
  assert.ok(pkg.dsh && pkg.dsh.client, 'dsh.client block required')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject))
  assert.ok(pkg.dsh.client.inject.length > 0)
})

test('package: referenced files exist on disk', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
  assert.ok(fs.existsSync(path.join(pkgRoot, 'client.js')))
  assert.ok(fs.existsSync(path.join(pkgRoot, 'src', 'panel.mjs')))
  assert.ok(fs.existsSync(path.join(pkgRoot, pkg.exports['./client'])))
})
