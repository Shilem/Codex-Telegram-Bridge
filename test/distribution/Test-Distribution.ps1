$ErrorActionPreference="Stop"
Set-StrictMode -Version Latest
$root=(Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$tmp=Join-Path ([IO.Path]::GetTempPath()) "ctb-distribution-$([guid]::NewGuid())"
try {
  $package=Join-Path $tmp "package"; New-Item -ItemType Directory -Force (Join-Path $package "dist") | Out-Null
  [IO.File]::WriteAllText((Join-Path $package "package.json"),'{"name":"ctb-test","version":"1.0.0","type":"module"}',(New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $package "package-lock.json"),'{"name":"ctb-test","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"ctb-test","version":"1.0.0"}}}',(New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $package "dist\cli.js"),'process.exit(0)',(New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $package "dist\service.js"),'process.exit(0)',(New-Object Text.UTF8Encoding($false)))
  Copy-Item -Recurse (Join-Path $root "scripts") (Join-Path $package "scripts")
  Copy-Item -Recurse (Join-Path $root "deploy") (Join-Path $package "deploy")
  $fakeCodex=Join-Path $tmp "codex.cmd"
  Set-Content -Encoding ascii $fakeCodex '@exit /b 0'
  $install=Join-Path $root "scripts\install.ps1"
  & $install -PackageDir $package -InstallRoot (Join-Path $tmp "app") -ConfigDir (Join-Path $tmp "config") -StateDir (Join-Path $tmp "state") -NodePath (Get-Command node.exe).Source -CodexPath $fakeCodex -SkipDependencies -SkipService
  if ((Get-Content -Raw (Join-Path $tmp "app\current")).Trim() -notmatch 'versions\\1\.0\.0$') { throw "current 指针错误" }
  $config=Get-Content -Raw (Join-Path $tmp "config\config.json") | ConvertFrom-Json
  if ($config.allowDangerFullAccess -ne $false) { throw "危险权限默认值错误" }
  if ($config.updatePublicKeyFile -ne "update-public-key.pem") { throw "更新公钥配置错误" }
  if (-not (Test-Path (Join-Path $tmp "config\update-public-key.pem"))) { throw "安装器未复制更新公钥" }
  $runner=Get-Content -Raw (Join-Path $tmp "app\run-service.ps1")
  if ($runner -notmatch 'CTB_NODE_BIN') { throw "服务启动器缺少 Node 更新环境" }
  if ($runner -notmatch 'CTB_CODEX_BIN') { throw "服务启动器缺少 Codex 更新环境" }
  if ($runner -notmatch 'CTB_INSTALL_ROOT') { throw "服务启动器缺少安装根目录环境" }
  if ($runner -notmatch 'CTB_STATE_DIR') { throw "服务启动器缺少状态目录环境" }
  if ((Get-Content -Raw (Join-Path $root "scripts\update.ps1")) -notmatch 'CodexPath') { throw "Windows 更新器未传递 Codex 路径" }
  if (-not ((Get-Content -Raw (Join-Path $root "deploy\windows-task.xml.template")) -match '<RunLevel>LeastPrivilege</RunLevel>')) { throw "任务计划未使用最低权限" }
  Write-Host "windows distribution tests passed"
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
