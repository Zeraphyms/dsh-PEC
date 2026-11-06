# Build the cc-dsh phone shell APK with the Android build tools directly:
# no Gradle, no Flutter, no network.
#
# Requirements (any recent versions work):
#   * Android SDK with build-tools (aapt2, d8, zipalign, apksigner) and a platform jar
#   * A JDK 17+ on PATH or in JAVA_HOME (javac, keytool)
#
# Usage:
#   pwsh ./build-apk.ps1
#   pwsh ./build-apk.ps1 -AndroidSdk C:\Android\sdk -JavaHome "C:\Program Files\Java\jdk-21"
#
# The signing key is created next to the build output on first run; keep it out
# of version control (it is git-ignored) and reuse it for later releases.

param(
  [string]$AndroidSdk = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { "$env:LOCALAPPDATA\Android\Sdk" }),
  [string]$JavaHome = $env:JAVA_HOME,
  [string]$BuildTools = '36.0.0',
  [string]$Platform = 'android-36',
  [string]$Out = '',
  [string]$Keystore = '',
  [string]$KeystorePass = 'ccdsh-local'
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$project = Join-Path $PSScriptRoot 'app\src\main'
$work = Join-Path $PSScriptRoot 'build'

if (-not $Out) { $Out = Join-Path $repo 'dist\cc-dsh.apk' }
# Keep the signing key outside the build directory: it is deleted on every run,
# and a stable key is required to upgrade an installed APK in place.
if (-not $Keystore) { $Keystore = Join-Path $repo 'build-keys\ccdsh.keystore' }

if (-not $JavaHome) {
  $javac = Get-Command javac.exe -ErrorAction SilentlyContinue
  if (-not $javac) { throw 'Set JAVA_HOME or pass -JavaHome (a JDK 17+ is required).' }
  $JavaHome = Split-Path -Parent (Split-Path -Parent $javac.Source)
}

$bt = Join-Path $AndroidSdk "build-tools\$BuildTools"
$platformJar = Join-Path $AndroidSdk "platforms\$Platform\android.jar"
$java = Join-Path $JavaHome 'bin\java.exe'

foreach ($tool in @('aapt2.exe', 'd8.bat', 'zipalign.exe', 'apksigner.bat')) {
  if (-not (Test-Path (Join-Path $bt $tool))) {
    throw "missing $tool under $bt — install build-tools $BuildTools with sdkmanager."
  }
}
if (-not (Test-Path $platformJar)) {
  throw "missing $platformJar — install platforms;$Platform with sdkmanager."
}

$env:JAVA_HOME = $JavaHome
$env:PATH = "$(Join-Path $JavaHome 'bin');$env:PATH"

if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force -Path $work, "$work\gen", "$work\classes", "$work\dex" | Out-Null

Write-Host '1/6 aapt2 compile'
& "$bt\aapt2.exe" compile --dir "$project\res" -o "$work\res.flata"
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

Write-Host '2/6 aapt2 link'
& "$bt\aapt2.exe" link `
  -o "$work\base.apk" `
  -I $platformJar `
  --manifest "$project\AndroidManifest.xml" `
  --java "$work\gen" `
  --min-sdk-version 26 `
  --target-sdk-version 36 `
  "$work\res.flata"
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

Write-Host '3/6 javac'
$sources = Get-ChildItem -Path "$project\java", "$work\gen" -Recurse -Filter *.java | ForEach-Object { $_.FullName }
& "$JavaHome\bin\javac.exe" -encoding UTF-8 -source 11 -target 11 -nowarn `
  -classpath $platformJar -d "$work\classes" $sources
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

Write-Host '4/6 d8'
$classes = Get-ChildItem -Path "$work\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& "$bt\d8.bat" --lib $platformJar --min-api 26 --output "$work\dex" $classes
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }

Write-Host '5/6 package + align'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$work\base.apk", 'Update')
try {
  $existing = $zip.GetEntry('classes.dex')
  if ($existing) { $existing.Delete() }
  $entry = $zip.CreateEntry('classes.dex', [System.IO.Compression.CompressionLevel]::Optimal)
  $stream = $entry.Open()
  try {
    $bytes = [System.IO.File]::ReadAllBytes("$work\dex\classes.dex")
    $stream.Write($bytes, 0, $bytes.Length)
  } finally { $stream.Dispose() }
} finally { $zip.Dispose() }

& "$bt\zipalign.exe" -f -p 4 "$work\base.apk" "$work\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

Write-Host '6/6 sign'
if (-not (Test-Path $Keystore)) {
  Write-Host "  generating a signing key at $Keystore"
  New-Item -ItemType Directory -Force -Path (Split-Path $Keystore) | Out-Null
  & "$JavaHome\bin\keytool.exe" -genkeypair -v -keystore $Keystore -storepass $KeystorePass -keypass $KeystorePass `
    -alias ccdsh -keyalg RSA -keysize 2048 -validity 10000 `
    -dname 'CN=cc-dsh, OU=personal, O=cc-dsh, L=local, C=CN' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
}

New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
& "$bt\apksigner.bat" sign --ks $Keystore --ks-pass "pass:$KeystorePass" --key-pass "pass:$KeystorePass" `
  --out $Out "$work\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'apksigner sign failed' }

& "$bt\apksigner.bat" verify --print-certs $Out | Select-Object -First 4
$size = [math]::Round((Get-Item $Out).Length / 1KB, 1)
Write-Host "APK: $Out ($size KiB)"
