[CmdletBinding()]
param(
  [string]$Version,
  [string]$InstallRoot = "$env:LOCALAPPDATA\CodexTelegramBridge\app",
  [switch]$SkipService
)
$ErrorActionPreference="Stop"
Set-StrictMode -Version Latest
$currentFile=Join-Path $InstallRoot "current"
if (-not (Test-Path $currentFile)) { throw "current 指针不存在" }
$old=(Get-Content -Raw $currentFile).Trim()
if ($Version) { $target=Join-Path $InstallRoot "versions\$Version" }
else {
  $target=Get-ChildItem (Join-Path $InstallRoot "versions") -Directory | Where-Object { $_.FullName -ne $old -and (Test-Path (Join-Path $_.FullName "VERSION")) } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $target -or -not (Test-Path $target)) { throw "没有可回滚版本" }
$tmp=Join-Path $InstallRoot ".current.rollback.tmp"
[IO.File]::WriteAllText($tmp,$target,(New-Object Text.UTF8Encoding($false)))
[IO.File]::Replace($tmp,$currentFile,$null)
if (-not $SkipService) {
  & schtasks.exe /End /TN CodexTelegramBridge 2>$null
  & schtasks.exe /Run /TN CodexTelegramBridge | Out-Null
  $cli=Join-Path $InstallRoot "ctb.ps1"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cli doctor
  if ($LASTEXITCODE) {
    [IO.File]::WriteAllText($tmp,$old,(New-Object Text.UTF8Encoding($false))); [IO.File]::Replace($tmp,$currentFile,$null)
    & schtasks.exe /End /TN CodexTelegramBridge 2>$null; & schtasks.exe /Run /TN CodexTelegramBridge | Out-Null
    throw "目标版本健康检查失败，已恢复原版本"
  }
}
Write-Host "已回滚到 $target"
