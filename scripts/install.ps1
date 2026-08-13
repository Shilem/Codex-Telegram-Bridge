[CmdletBinding()]
param(
  [string]$PackageDir = (Split-Path -Parent (Split-Path -Parent $PSCommandPath)),
  [string]$InstallRoot = "$env:LOCALAPPDATA\CodexTelegramBridge\app",
  [string]$ConfigDir = "$env:APPDATA\CodexTelegramBridge",
  [string]$StateDir = "$env:LOCALAPPDATA\CodexTelegramBridge",
  [string]$NodePath = "node.exe",
  [string]$CodexPath = "codex.exe",
  [string]$Version,
  [switch]$SkipService,
  [switch]$SkipBuild,
  [switch]$SkipDependencies
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string]$Message) { throw "Codex Telegram Bridge：$Message" }
function WriteUtf8NoBom([string]$Path,[string]$Value) { [IO.File]::WriteAllText($Path,$Value,(New-Object Text.UTF8Encoding($false))) }
function QuotePs([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
if ([string]::IsNullOrWhiteSpace($InstallRoot) -or $InstallRoot -eq (Split-Path -Qualifier $InstallRoot)) { Fail "安装目录不安全" }
$nodeVersion = & $NodePath --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.') { Fail "需要 Node.js 24 LTS，当前为 $nodeVersion" }
& $CodexPath app-server --help *> $null
if ($LASTEXITCODE -ne 0) { Fail "当前 Codex CLI 不支持 app-server" }
if (-not $Version) { $Version = (& $NodePath -e "process.stdout.write(require(process.argv[1]+'/package.json').version)" $PackageDir) }
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') { Fail "版本号无效：$Version" }

$versionRoot = Join-Path $InstallRoot "versions"
$versionDir = Join-Path $versionRoot $Version
$stage = Join-Path $versionRoot ".staging-$Version-$PID"
New-Item -ItemType Directory -Force -Path $versionRoot,$ConfigDir,(Join-Path $StateDir "artifacts") | Out-Null
$updatePublicKey = Join-Path $ConfigDir "update-public-key.pem"
if (-not (Test-Path $updatePublicKey)) { Copy-Item (Join-Path $PackageDir "deploy\update-public-key.pem") $updatePublicKey }
if (Test-Path $versionDir) { Fail "版本目录已存在，拒绝覆盖：$versionDir" }
try {
  if (-not (Test-Path (Join-Path $PackageDir "dist"))) {
    if ($SkipBuild) { Fail "SkipBuild 已启用但 dist 不存在" }
    Push-Location $PackageDir
    try { & npm.cmd ci; if ($LASTEXITCODE) { Fail "npm ci 失败" }; & npm.cmd run build; if ($LASTEXITCODE) { Fail "构建失败" } } finally { Pop-Location }
  }
  New-Item -ItemType Directory -Path $stage | Out-Null
  Copy-Item -Recurse (Join-Path $PackageDir "dist") $stage
  Copy-Item -Recurse (Join-Path $PackageDir "scripts") $stage
  Copy-Item (Join-Path $PackageDir "package.json") $stage
  $lock=Join-Path $PackageDir "npm-shrinkwrap.json"
  if (-not (Test-Path $lock)) { $lock=Join-Path $PackageDir "package-lock.json" }
  if (-not (Test-Path $lock)) { Fail "发布包缺少 npm-shrinkwrap.json 或 package-lock.json" }
  Copy-Item $lock $stage
  [IO.File]::WriteAllText((Join-Path $stage "NODE_BIN"),$NodePath,(New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $stage "CODEX_BIN"),$CodexPath,(New-Object Text.UTF8Encoding($false)))
  if (-not $SkipDependencies) {
    Push-Location $stage
    try { & npm.cmd ci --omit=dev; if ($LASTEXITCODE) { Fail "生产依赖安装失败" } } finally { Pop-Location }
  } else { New-Item -ItemType Directory -Path (Join-Path $stage "node_modules") | Out-Null }
  Set-Content -NoNewline -Encoding ascii -Path (Join-Path $stage "VERSION") -Value $Version
  Move-Item $stage $versionDir
} finally { if (Test-Path $stage) { Remove-Item -Recurse -Force $stage } }

$pointerTmp = Join-Path $InstallRoot ".current.$PID.tmp"
WriteUtf8NoBom $pointerTmp $versionDir
$pointer = Join-Path $InstallRoot "current"
if (Test-Path $pointer) { [IO.File]::Replace($pointerTmp,$pointer,$null) } else { [IO.File]::Move($pointerTmp,$pointer) }

$configFile = Join-Path $ConfigDir "config.json"
$tokenFile = Join-Path $ConfigDir "bot-token"
if (-not (Test-Path $configFile)) {
  $config = [ordered]@{ botTokenFile="bot-token"; stateDirectory=$StateDir; artifactDirectory=(Join-Path $StateDir "artifacts"); codexExecutable=$CodexPath; allowDangerFullAccess=$false; inboundFileLimitBytes=20971520; outboundFileLimitBytes=52428800; maxUpdateAgeMinutes=10; attachmentRetentionHours=24; taskRetentionDays=7; auditRetentionDays=30; logLevel="info"; updateManifestUrl="https://github.com/Shilem/Codex-Telegram-Bridge/releases/latest/download/release-manifest.json"; updateSignatureUrl="https://github.com/Shilem/Codex-Telegram-Bridge/releases/latest/download/release-manifest.sig"; updateArchiveUrl="https://github.com/Shilem/Codex-Telegram-Bridge/releases/latest/download/codex-telegram-bridge.tgz"; updatePublicKeyFile="update-public-key.pem" }
  WriteUtf8NoBom $configFile ($config | ConvertTo-Json)
}
if (-not (Test-Path $tokenFile)) { WriteUtf8NoBom $tokenFile ""; Write-Host "请将 Bot Token 写入 $tokenFile" }

$runner = Join-Path $InstallRoot "run-service.ps1"
$installRootLiteral = QuotePs $InstallRoot
$configFileLiteral = QuotePs $configFile
$nodePathLiteral = QuotePs $NodePath
@"
`$ErrorActionPreference = "Stop"
`$versionDir = (Get-Content -Raw (Join-Path $installRootLiteral 'current')).Trim()
`$env:CTB_CONFIG_FILE = $configFileLiteral
& $nodePathLiteral (Join-Path `$versionDir 'dist\service.js')
exit `$LASTEXITCODE
"@ | Set-Content -Encoding utf8 $runner
$cli = Join-Path $InstallRoot "ctb.ps1"
@"
`$ErrorActionPreference = "Stop"
`$versionDir = (Get-Content -Raw (Join-Path $installRootLiteral 'current')).Trim()
& $nodePathLiteral (Join-Path `$versionDir 'dist\cli.js') @args
exit `$LASTEXITCODE
"@ | Set-Content -Encoding utf8 $cli

if (-not $SkipService) {
  $template = Get-Content -Raw (Join-Path $PackageDir "deploy\windows-task.xml.template")
  $xml = $template.Replace("__USER_ID__", [Security.SecurityElement]::Escape([Security.Principal.WindowsIdentity]::GetCurrent().Name)).Replace("__RUNNER__", [Security.SecurityElement]::Escape($runner))
  $taskXml = Join-Path $InstallRoot "CodexTelegramBridge.xml"
  Set-Content -Encoding Unicode $taskXml $xml
  & schtasks.exe /Create /TN CodexTelegramBridge /XML $taskXml /F | Out-Null
  if ((Get-Item $tokenFile).Length -gt 0) {
    & schtasks.exe /Run /TN CodexTelegramBridge | Out-Null
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cli doctor
    if ($LASTEXITCODE) { Fail "ctb doctor 失败" }
  } else { Write-Host "Token 尚未配置。写入后执行：schtasks.exe /Run /TN CodexTelegramBridge" }
}
Write-Host "安装完成：$versionDir"
