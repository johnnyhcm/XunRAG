# S8 稳定性① 进程守护安装脚本（2026-08-13）
# 作用：把 backend + python 两进程注册为 Windows 服务（NSSM 托管），崩溃自动重启 + 开机自启 + 日志重定向
# 用法（需管理员权限，PowerShell）：powershell -ExecutionPolicy Bypass -File scripts\install-services.ps1
# 卸载：scripts\uninstall-services.ps1
# 说明：环境变量不设——backend config.ts 默认 AUTH_MODE=production / HTTPS_ENABLED=0 / BIND_HOST=127.0.0.1，即生产配置
#       执行时会【停止】当前手动起的 tsx/python 进程（避免端口冲突 ISSUE #58）
$Root      = Split-Path -Parent $PSScriptRoot                          # 项目根目录
$Nssm      = Join-Path $Root "tools\nssm\nssm.exe"
# Python/Node 路径自动探测（开源通用）：优先环境变量覆盖，否则从 PATH 探测
$Python    = if ($env:POLICYBOT_PYTHON) { $env:POLICYBOT_PYTHON } else { (Get-Command python -ErrorAction SilentlyContinue).Source }
if (-not $Python) { Write-Host "错误：未找到 python，请安装 Python ≥3.12 或设置 POLICYBOT_PYTHON 环境变量"; exit 1 }
$Node      = if ($env:POLICYBOT_NODE) { $env:POLICYBOT_NODE } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $Node) { Write-Host "错误：未找到 node，请安装 Node.js ≥22 或设置 POLICYBOT_NODE 环境变量"; exit 1 }
$LogDir    = Join-Path $Root "data\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Run([string]$label, [scriptblock]$block) {
  Write-Host "  → $label"
  & $block 2>&1 | Out-Null
  Write-Host "    ✅ 完成（退出码 $LASTEXITCODE）"
}

Write-Host "== 幂等清理：卸载可能存在的旧服务 =="
foreach ($svc in "policybot-backend", "policybot-python") {
  & $Nssm stop $svc 2>&1 | Out-Null
  & $Nssm remove $svc confirm 2>&1 | Out-Null
  Write-Host "  已尝试卸载 $svc"
}

Write-Host "== 停止当前手动进程（避免端口冲突）=="
foreach ($port in 3000, 8001) {
  $procId = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)
  if ($procId) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue; Write-Host "  已停止端口 ${port} 进程 PID ${procId}" }
}

Write-Host "== 注册 python 检索引擎服务 policybot-python =="
Run "install policybot-python" { & $Nssm install policybot-python $Python }
Run "set AppDirectory" { & $Nssm set policybot-python AppDirectory $Root }
Run "set AppParameters" { & $Nssm set policybot-python AppParameters "app\python\server.py" }
Run "set AppExit restart" { & $Nssm set policybot-python AppExit Default Restart }
Run "set AppRestartDelay" { & $Nssm set policybot-python AppRestartDelay 5000 }
Run "set AppStdout" { & $Nssm set policybot-python AppStdout "$LogDir\nssm-python.log" }
Run "set AppStderr" { & $Nssm set policybot-python AppStderr "$LogDir\nssm-python-err.log" }
Run "set auto start" { & $Nssm set policybot-python Start SERVICE_AUTO_START }

Write-Host "== 注册 backend 服务 policybot-backend =="
Run "install policybot-backend" { & $Nssm install policybot-backend $Node }
Run "set AppDirectory" { & $Nssm set policybot-backend AppDirectory (Join-Path $Root "app\backend") }
Run "set AppParameters" { & $Nssm set policybot-backend AppParameters "dist\main.js" }
Run "set AppExit restart" { & $Nssm set policybot-backend AppExit Default Restart }
Run "set AppRestartDelay" { & $Nssm set policybot-backend AppRestartDelay 5000 }
Run "set AppStdout" { & $Nssm set policybot-backend AppStdout "$LogDir\nssm-backend.log" }
Run "set AppStderr" { & $Nssm set policybot-backend AppStderr "$LogDir\nssm-backend-err.log" }
Run "set auto start" { & $Nssm set policybot-backend Start SERVICE_AUTO_START }
Run "set depend on python" { & $Nssm set policybot-backend DependOnService policybot-python }

Write-Host ""
Write-Host "== 启动服务 =="
& $Nssm start policybot-python 2>&1 | Out-Null
Start-Sleep -Seconds 5
& $Nssm start policybot-backend 2>&1 | Out-Null
Start-Sleep -Seconds 5

Write-Host ""
Write-Host "== 验证 =="
Write-Host "服务状态："
& $Nssm status policybot-python
& $Nssm status policybot-backend
Write-Host "健康检查："
try { (Invoke-RestMethod -Uri "http://localhost:3000/api/health" -TimeoutSec 5) | ConvertTo-Json -Compress } catch { Write-Host "  backend 未就绪：$($_.Exception.Message)" }
try { (Invoke-RestMethod -Uri "http://localhost:8001/health" -TimeoutSec 5) | ConvertTo-Json -Compress } catch { Write-Host "  python 未就绪：$($_.Exception.Message)" }
Write-Host ""
Write-Host "管理命令："
Write-Host "  重启后端：& `"$Nssm`" restart policybot-backend"
Write-Host "  查看日志：Get-Content `"$LogDir\nssm-backend.log`" -Tail 50"