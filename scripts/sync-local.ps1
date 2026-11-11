# Update the locally installed dsh-pec plugin from a released tag, then reload
# the gateway. Run AFTER pushing a release:
#
#   pwsh ./scripts/sync-local.ps1 [-ProfileDir <dir>] [-Version v2.0.2]
#
# What it does:
#   1. Pins the profile dependency to the given tag (profile package.json).
#   2. Runs pnpm update so node_modules picks up the released tarball.
#   3. Clears a leftover "disabled: true" flag on the plugin row if present.
#   4. Waits for the gateway to come back and verifies /api/health.
#
# NOTE: do NOT run this while developing - changes in the repo only reach the
# installed plugin when you explicitly release and run this script.
param(
  [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop",
  [string]$Version = 'v2.0.2',
  [int]$Port = 7317
)
$ErrorActionPreference = 'Stop'

# 1) Pin the dependency to the released tag.
$pkg = Join-Path $ProfileDir 'package.json'
$manifest = Get-Content $pkg -Raw | ConvertFrom-Json
$specifier = "github:huajikano/dsh-PEC#$Version"
if ($manifest.dependencies.'dsh-pec' -ne $specifier) {
  $manifest.dependencies.'dsh-pec' = $specifier
  $manifest | ConvertTo-Json -Depth 10 | Set-Content $pkg -Encoding UTF8
  Write-Host "pinned dsh-pec to $specifier"
} else {
  Write-Host "dsh-pec already pinned to $specifier"
}

# 2) Let pnpm fetch the released tarball into node_modules.
Push-Location $ProfileDir
try { pnpm update dsh-pec 2>&1 | Select-Object -Last 3 } finally { Pop-Location }

# 3) Clear a leftover disabled flag so the gateway remounts.
$patch = Join-Path $ProfileDir 'cordis.patch.yml'
$lines = Get-Content $patch
for ($i = 1; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^\s*disabled:\s*true\s*$' -and $lines[$i - 1] -match 'id: dsh-pec') {
    $next = $lines[0..($i - 1)] + $lines[($i + 1)..($lines.Count - 1)]
    Set-Content $patch $next -Encoding UTF8
    Write-Host 'cleared disabled flag on the dsh-pec row'
    break
  }
}

# 4) Wait for the gateway and verify.
for ($attempt = 1; $attempt -le 10; $attempt++) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
    Write-Host ("health: ok=" + $health.ok + " port=" + $health.port)
    if ($health.ok) { Write-Host 'local DSH plugin updated.'; exit 0 }
  } catch { Start-Sleep -Seconds 2 }
}
Write-Warning 'gateway did not come back within 20s; check the DSH log.'
exit 1