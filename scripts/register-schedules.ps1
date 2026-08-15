# S8 稳定性 定时任务注册脚本（2026-08-13）
# 作用：注册 3 个 Windows 定时任务，让探活/备份/监控自动跑
#   用 Register-ScheduledTask（对象化传参，避免 schtasks /TR 引号转义问题）
# 用法（需管理员权限）：powershell -ExecutionPolicy Bypass -File scripts\register-schedules.ps1
# 卸载：scripts\unregister-schedules.ps1
$Root = Split-Path -Parent $PSScriptRoot
# Node 路径自动探测（开源通用）：优先环境变量覆盖，否则从 PATH 探测
$Node = if ($env:POLICYBOT_NODE) { $env:POLICYBOT_NODE } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $Node) { Write-Host "错误：未找到 node，请安装 Node.js ≥22 或设置 POLICYBOT_NODE 环境变量"; exit 1 }
# SYSTEM 账户 + 隐藏窗口（避免每次触发弹黑窗口；无需用户登录；与 NSSM LocalSystem 一致）
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -Hidden

function Reg-NodeTask($name, $script, $trigger, $desc) {
  $action = New-ScheduledTaskAction -Execute $Node -Argument "`"$script`""
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $desc -Force | Out-Null
  Write-Host "  ✅ $name"
}

Write-Host "== 注册定时任务 =="

# ① 探活：每 1 分钟（服务假死/宕机检测）
$t1 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
Reg-NodeTask "policybot-health-check" "$Root\scripts\health-check.mjs" $t1 "探活：检测 backend/python 存活与假死，失败分级告警"

# ② 备份：每天凌晨 03:00
$t2 = New-ScheduledTaskTrigger -Daily -At 3:00am
Reg-NodeTask "policybot-backup" "$Root\scripts\backup.mjs" $t2 "全量备份：SQLite 热备份 + 向量/上传/会话，保留 14 份"

# ③ 监控：每 5 分钟（资源阈值告警）
$t3 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
Reg-NodeTask "policybot-monitor" "$Root\scripts\monitor.mjs" $t3 "资源监控：磁盘/内存/服务状态，超阈值告警"

Write-Host ""
Write-Host "== 注册完成，当前任务 =="
Get-ScheduledTask -TaskName "policybot-*" | Select-Object TaskName, State | Format-Table -AutoSize
Write-Host ""
Write-Host "手动触发测试：Start-ScheduledTask -TaskName policybot-health-check"
