# Update the locally installed dsh-pec plugin from a released tag, then reload
# the gateway. Run AFTER pushing a release:
#
#   pwsh ./scripts/sync-local.ps1 [-ProfileDir <dir>] [-Version v2.0.3]
#
# What it does:
#   1. Pins the profile dependency to the given tag (profile package.json).
#   2. Runs pnpm update so node_modules picks up the released tarball.
#   3. Reloads the plugin without restarting DSH:
#        toggle OFF (gateway writes "disabled: true" and stops)
#        -> clear that flag (a semantic patch change)
#        -> DSH hot-reloads the plugin with the new files.
#   4. Waits for the gateway and verifies /api/health.
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

# 3) Reload cycle: disable via the running gateway, then clear the flag.
$patch = Join-Path $ProfileDir 'cordis.patch.yml'

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/plugins/include%3Adsh-pec/toggle" -Method Post -Body '{"enabled":false}' -ContentType 'application/json' -TimeoutSec 3 | Out-Null
} catch { Write-Host 'gateway closing (expected)' }
Start-Sleep -Seconds 2

$lines = [System.IO.File]::ReadAllLines($patch)
$out = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
  $isFlag = $lines[$i] -match '^\s*disabled:\s*true\s*$' -and $i -gt 0 -and $lines[$i - 1] -match 'id: dsh-pec'
  if (-not $isFlag) { $out += $lines[$i] }
}
[System.IO.File]::WriteAllLines($patch, $out)
Write-Host 'cleared disabled flag - DSH will hot-reload the plugin'

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