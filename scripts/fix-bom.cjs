#!/usr/bin/env node
/**
 * Scan the profile root for JSON/YAML files starting with a UTF-8 BOM and
 * remove it. A BOM on profile package.json crashes DSH at readProfileManifest
 * before any plugin loads - typically written by PowerShell 5's
 * Set-Content/ConvertTo-Json with -Encoding UTF8.
 *
 * Usage: node scripts/fix-bom.js [profileDir]
 *   profileDir defaults to %DSH_HOME%\profiles\desktop or ~/.dsh/profiles/desktop
 */
const fs = require('node:fs')
const path = require('node:path')

const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const profile = process.argv[2] || path.join(home, 'profiles', 'desktop')

if (!fs.existsSync(profile)) {
  console.error('profile dir not found:', profile)
  process.exit(2)
}

const targets = []
for (const name of fs.readdirSync(profile)) {
  if (!/\.(json|ya?ml)$/i.test(name)) continue
  const full = path.join(profile, name)
  if (fs.statSync(full).isFile()) targets.push(full)
}

let fixed = 0
for (const file of targets) {
  const buf = fs.readFileSync(file)
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    const backup = file + '.bak-bom-' + new Date().toISOString().replace(/[:T-]/g, '').slice(0, 14)
    fs.writeFileSync(backup, buf)
    fs.writeFileSync(file, buf.subarray(3))
    console.log('BOM removed:', file, '(backup:', backup + ')')
    fixed++
  }
}

console.log(fixed ? fixed + ' file(s) fixed.' : 'No BOM found - profile is clean.')
