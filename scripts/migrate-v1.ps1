[CmdletBinding()]
param(
  [string]$LegacyEnv = "$env:USERPROFILE\.config\telegram-agent-bridge.env",
  [string]$InstallRoot = "$env:LOCALAPPDATA\CodexTelegramBridge\app",
  [string]$ConfigDir = "$env:APPDATA\CodexTelegramBridge",
  [string]$StateDir = "$env:LOCALAPPDATA\CodexTelegramBridge",
  [string]$LegacyTaskName = "TelegramAgentBridge"
)
$ErrorActionPreference="Stop"
Set-StrictMode -Version Latest
if (-not (Test-Path $LegacyEnv)) { throw "旧配置不存在：$LegacyEnv" }
$cli=Join-Path $InstallRoot "ctb.ps1"
if (-not (Test-Path $cli)) { throw "请先安装 1.0，再运行迁移" }
$values=@{}
foreach ($line in Get-Content $LegacyEnv) {
  if ($line -match '^([A-Z0-9_]+)=(.*)$') {
    $value=$Matches[2].Trim()
    if (($value.StartsWith("'") -and $value.EndsWith("'")) -or ($value.StartsWith('"') -and $value.EndsWith('"'))) { $value=$value.Substring(1,$value.Length-2) }
    $values[$Matches[1]]=$value
  }
}
$token=""
if ($values.ContainsKey("TAB_BOT_TOKEN")) { $token=[string]$values["TAB_BOT_TOKEN"] }
if (-not $token -and $values.ContainsKey("CRB_BOT_TOKEN")) { $token=[string]$values["CRB_BOT_TOKEN"] }
$chat=""; $workdir=""
if ($values.ContainsKey("TAB_CHAT_ID")) { $chat=[string]$values["TAB_CHAT_ID"] }
if ($values.ContainsKey("TAB_WORKDIR")) { $workdir=[string]$values["TAB_WORKDIR"] }
if (-not $token -or -not $chat -or -not (Test-Path $workdir -PathType Container)) { throw "旧 Token、Chat ID 或工作目录无效" }
$stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$backup=Join-Path $StateDir "migration-backups\$stamp"
New-Item -ItemType Directory -Force $backup,$ConfigDir | Out-Null
Copy-Item $LegacyEnv (Join-Path $backup "telegram-agent-bridge.env")
$legacyState="$env:USERPROFILE\.local\state\telegram-agent-bridge"
if ($values.ContainsKey("TAB_STATE_DIR")) { $legacyState=[Environment]::ExpandEnvironmentVariables(([string]$values["TAB_STATE_DIR"]).Replace('~',$env:USERPROFILE)) }
if (Test-Path $legacyState) { Copy-Item -Recurse $legacyState (Join-Path $backup "legacy-state") }
$offsetFiles=@(Get-ChildItem $legacyState -Filter 'codex-repl-bridge-*.offset' -File -ErrorAction SilentlyContinue)
if ($offsetFiles.Count -gt 1) { throw "发现多个旧 offset 文件，无法唯一迁移" }
$offsetValue=0
if ($offsetFiles.Count -eq 1) {
  $offsetValue=[long](Get-Content -Raw $offsetFiles[0].FullName).Trim()
  [IO.File]::WriteAllText((Join-Path $backup "legacy-offset-path"),$offsetFiles[0].FullName,(New-Object Text.UTF8Encoding($false)))
}
& schtasks.exe /Query /TN $LegacyTaskName /XML > (Join-Path $backup "legacy-task.xml") 2>$null
& schtasks.exe /End /TN $LegacyTaskName 2>$null
Start-Sleep -Seconds 1
$legacyTask=Get-ScheduledTask -TaskName $LegacyTaskName -ErrorAction SilentlyContinue
if ($legacyTask -and $legacyTask.State -eq 'Running') { throw "旧服务仍在运行，拒绝启动第二个 getUpdates 消费者" }
[IO.File]::WriteAllText((Join-Path $ConfigDir "bot-token"),$token,(New-Object Text.UTF8Encoding($false)))
$report=Join-Path $backup "migration-report.json"
$reportJson=[ordered]@{schemaVersion=1;legacy=[ordered]@{chatId=$chat;workdir=(Resolve-Path $workdir).Path;telegramOffset=$offsetValue};requiresLocalPairing=$true;legacySessionImported=$false;notes=@("旧会话只有在线程 ID 与工作目录均可唯一验证时才可导入")} | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($report,$reportJson,(New-Object Text.UTF8Encoding($false)))
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cli migrate legacy --report $report
if ($LASTEXITCODE) {
  if (Test-Path (Join-Path $backup "legacy-task.xml")) { & schtasks.exe /Create /TN $LegacyTaskName /XML (Join-Path $backup "legacy-task.xml") /F | Out-Null; & schtasks.exe /Run /TN $LegacyTaskName | Out-Null }
  throw "迁移失败；旧服务已恢复。备份：$backup"
}
& schtasks.exe /Run /TN CodexTelegramBridge | Out-Null
Start-Sleep -Seconds 2
$newTask=Get-ScheduledTask -TaskName CodexTelegramBridge -ErrorAction Stop
if ($newTask.State -ne 'Running') { throw "新服务未运行，停止迁移" }
Write-Host "迁移数据已导入。请向 Bot 发送 /start，再在本机执行 ctb pair <配对码>。"
Write-Host "备份与只读报告：$backup"
