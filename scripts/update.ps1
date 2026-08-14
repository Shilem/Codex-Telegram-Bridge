[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Manifest,
  [Parameter(Mandatory=$true)][string]$Signature,
  [Parameter(Mandatory=$true)][string]$Archive,
  [Parameter(Mandatory=$true)][string]$PublicKey,
  [string]$InstallRoot = "$env:LOCALAPPDATA\CodexTelegramBridge\app",
  [string]$ConfigDir = "$env:APPDATA\CodexTelegramBridge",
  [string]$StateDir = "$env:LOCALAPPDATA\CodexTelegramBridge",
  [string]$NodePath = "node.exe",
  [string]$CodexPath = "codex.exe",
  [switch]$SkipService
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$tmp = Join-Path ([IO.Path]::GetTempPath()) "ctb-update-$([guid]::NewGuid())"
New-Item -ItemType Directory $tmp | Out-Null
function Fetch([string]$Source,[string]$Target) {
  if ($Source -match '^https://') { Invoke-WebRequest -UseBasicParsing -Uri $Source -OutFile $Target }
  elseif ($Source -match '^http://') { throw "拒绝通过明文 HTTP 下载更新" }
  else { Copy-Item $Source $Target }
}
try {
  $manifestFile=Join-Path $tmp "manifest.json"; $signatureFile=Join-Path $tmp "manifest.sig"; $archiveFile=Join-Path $tmp "release.tgz"
  Fetch $Manifest $manifestFile; Fetch $Signature $signatureFile; Fetch $Archive $archiveFile
  $rsa=[Security.Cryptography.RSA]::Create()
  try {
    $rsa.ImportFromPem((Get-Content -Raw $PublicKey))
    $ok=$rsa.VerifyData([IO.File]::ReadAllBytes($manifestFile),[IO.File]::ReadAllBytes($signatureFile),[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
  } finally { $rsa.Dispose() }
  if (-not $ok) { throw "release manifest 签名校验失败" }
  $m=Get-Content -Raw $manifestFile | ConvertFrom-Json
  if ($m.archive -ne [IO.Path]::GetFileName($Archive)) { throw "release 包名与 manifest 不匹配" }
  $hash=(Get-FileHash -Algorithm SHA256 $archiveFile).Hash.ToLowerInvariant()
  if ($hash -ne ([string]$m.sha256).ToLowerInvariant()) { throw "release 包 SHA-256 校验失败" }
  $old=(Get-Content -Raw (Join-Path $InstallRoot "current")).Trim()
  $currentVersion=(Get-Content -Raw (Join-Path $old "VERSION")).Trim()
  & $NodePath -e 'const [a,b]=process.argv.slice(1);const p=s=>s.split(/[.-]/).map(x=>/^\d+$/.test(x)?Number(x):x);const A=p(a),B=p(b);for(let i=0;i<Math.max(A.length,B.length);i++){const x=A[i]??0,y=B[i]??0;if(x===y)continue;if(typeof x===typeof y)process.exit(x>y?0:1);process.exit(typeof x==="number"?0:1)}process.exit(1)' ([string]$m.version) $currentVersion
  if ($LASTEXITCODE) { throw "拒绝安装非升级版本：当前 $currentVersion，目标 $($m.version)" }
  $package=Join-Path $tmp "package"; New-Item -ItemType Directory $package | Out-Null
  tar.exe -xzf $archiveFile -C $package
  $packageJson=Get-ChildItem -Recurse -Filter package.json $package | Select-Object -First 1
  if (-not $packageJson) { throw "release 包缺少 package.json" }
  & (Join-Path $PSScriptRoot "install.ps1") -PackageDir $packageJson.DirectoryName -InstallRoot $InstallRoot -ConfigDir $ConfigDir -StateDir $StateDir -NodePath $NodePath -CodexPath $CodexPath -Version $m.version -SkipService
  if (-not $SkipService) {
    & schtasks.exe /End /TN CodexTelegramBridge 2>$null
    & schtasks.exe /Run /TN CodexTelegramBridge | Out-Null
    $cli=Join-Path $InstallRoot "ctb.ps1"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cli doctor
    if ($LASTEXITCODE) {
      $p=Join-Path $InstallRoot ".current.rollback.tmp"; [IO.File]::WriteAllText($p,$old,(New-Object Text.UTF8Encoding($false))); [IO.File]::Replace($p,(Join-Path $InstallRoot "current"),$null)
      & schtasks.exe /End /TN CodexTelegramBridge 2>$null; & schtasks.exe /Run /TN CodexTelegramBridge | Out-Null
      throw "健康检查失败，已回滚"
    }
  }
  Write-Host "更新成功：$($m.version)"
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
