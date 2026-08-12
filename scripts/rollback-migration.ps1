[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Backup,
  [Parameter(Mandatory=$true)][long]$LatestOffset,
  [string]$LegacyEnv="$env:USERPROFILE\.config\telegram-agent-bridge.env"
)
$ErrorActionPreference="Stop"
if ($LatestOffset -lt 0) { throw "offset 必须是非负整数" }
$source=Join-Path $Backup "telegram-agent-bridge.env"
if (-not (Test-Path $source)) { throw "备份缺少旧配置" }
New-Item -ItemType Directory -Force (Split-Path -Parent $LegacyEnv) | Out-Null
Copy-Item -Force $source $LegacyEnv
$stateBackup=Join-Path $Backup "legacy-state"
if (Test-Path $stateBackup) {
  $state="$env:USERPROFILE\.local\state\telegram-agent-bridge"
  New-Item -ItemType Directory -Force $state | Out-Null
  Copy-Item -Recurse -Force "$stateBackup\*" $state
  $offsetPathFile=Join-Path $Backup "legacy-offset-path"
  if (-not (Test-Path $offsetPathFile)) { throw "备份缺少精确 offset 路径，拒绝谎报成功" }
  $offsetPath=(Get-Content -Raw $offsetPathFile).Trim()
  if (-not $offsetPath) { throw "旧 offset 路径为空" }
  New-Item -ItemType Directory -Force (Split-Path -Parent $offsetPath) | Out-Null
  [IO.File]::WriteAllText($offsetPath,[string]$LatestOffset,(New-Object Text.UTF8Encoding($false)))
} else { throw "备份缺少旧状态，无法回写 offset" }
$taskXml=Join-Path $Backup "legacy-task.xml"
if (-not (Test-Path $taskXml)) { throw "备份缺少旧 Task Scheduler 定义" }
& schtasks.exe /End /TN CodexTelegramBridge 2>$null
& schtasks.exe /Create /TN TelegramAgentBridge /XML $taskXml /F | Out-Null
& schtasks.exe /Run /TN TelegramAgentBridge | Out-Null
Write-Host "旧配置、任务和 offset 已恢复为 $LatestOffset。"
