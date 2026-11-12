# Update the locally installed dsh-pec plugin from a released tag.
#
#   pwsh ./scripts/sync-local.ps1 [-ProfileDir <dir>] [-Version v2.0.3] [-Reload]
#
# What it does:
#   1. Pins the profile dependency to the given tag (profile package.json).
#   2. Runs pnpm update so node_modules picks up the released tarball.
#   3. WITHOUT -Reload: prints which layers changed and how to activate them.
#      WITH -Reload: attempts a plugin hot-reload by toggling the row twice
#      through the gateway API. WARNING: if the gateway stops mid-cycle the
#      toggle can leave the plugin fiber stuck; restarting DSH always fixes it.
#
# Safe usage pattern:
#   - web/* changes:   no reload needed at all (gateway serves from disk).
#   - lib/* changes:   run with -Reload, or toggle the plugin in DSH settings.
#
param(
  [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop",
  [string]$Version = 'v2.0.3',
  [int]$Port = 7317,
  [switch]$Reload
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

# 3) Activation guidance (and the risky reload only on explicit request).
if (-not $Reload) {
  Write-Host ''
  Write-Host 'activation guide:'
  Write-Host '  - web/* changes:        live already, just refresh the phone page.'
  Write-Host '  - lib/* changes:        toggle dsh-pec in DSH plugin settings'
  Write-Host '                           (or rerun this script with -Reload).'
  exit 0
}

Write-Host 'attempting hot reload (toggle off -> on)...'
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/plugins/include%3Adsh-pec/toggle" -Method Post -Body '{"enabled":false}' -ContentType 'application/json' -TimeoutSec 3 | Out-Null
} catch { Write-Host 'gateway closing (expected during disable)' }
Start-Sleep -Seconds 3

# The disable stops the gateway, so "on" must go through the patch file:
# removing the disabled flag is a semantic change that makes DSH remount the
# plugin with the new files.
$patch = Join-Path $ProfileDir 'cordis.patch.yml'
$lines = [System.IO.File]::ReadAllLines($patch)
$out = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
  $isFlag = $lines[$i] -match '^\s*disabled:\s*true\s*$' -and $i -gt 0 -and $lines[$i - 1] -match 'id: dsh-pec'
  if (-not $isFlag) { $out += $lines[$i] }
}
[System.IO.File]::WriteAllLines($patch, $out)
Write-Host 'cleared disabled flag - DSH will hot-reload the plugin'

# 4) Wait for the gateway and verify.
for ($attempt = 1; $attempt -le 15; $attempt++) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
    Write-Host ("health: ok=" + $health.ok + " port=" + $health.port)
    if ($health.ok) { Write-Host 'local DSH plugin updated.'; exit 0 }
  } catch { Start-Sleep -Seconds 2 }
}
Write-Warning 'gateway did not come back within 30s. Restart DSH - that always fixes a stuck plugin fiber.'
exit 1