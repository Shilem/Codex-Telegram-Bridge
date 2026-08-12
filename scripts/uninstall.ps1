[CmdletBinding()]
param(
  [string]$InstallRoot = "$env:LOCALAPPDATA\CodexTelegramBridge\app",
  [string]$ConfigDir = "$env:APPDATA\CodexTelegramBridge",
  [string]$StateDir = "$env:LOCALAPPDATA\CodexTelegramBridge",
  [switch]$PurgeData
)
$ErrorActionPreference="Stop"
& schtasks.exe /End /TN CodexTelegramBridge 2>$null
& schtasks.exe /Delete /TN CodexTelegramBridge /F 2>$null
if ($InstallRoot.Length -lt 8 -or $InstallRoot -eq (Split-Path -Qualifier $InstallRoot)) { throw "拒绝删除不安全路径" }
Remove-Item -Recurse -Force $InstallRoot -ErrorAction SilentlyContinue
if ($PurgeData) {
  Remove-Item -Recurse -Force $ConfigDir,$StateDir -ErrorAction SilentlyContinue
  Write-Host "已卸载并删除本地配置和数据（不可恢复）。"
} else { Write-Host "已卸载程序；配置和数据已保留。" }
