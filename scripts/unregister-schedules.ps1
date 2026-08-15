# S8 稳定性 定时任务卸载脚本（2026-08-13）
# 用法（需管理员权限）：powershell -ExecutionPolicy Bypass -File scripts\unregister-schedules.ps1
foreach ($name in "policybot-health-check", "policybot-backup", "policybot-monitor") {
  Write-Host "== 删除任务 $name =="
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "  ✅ $name 已删除"
}
# 清理测试残留任务
Unregister-ScheduledTask -TaskName "policybot-test*" -Confirm:$false -ErrorAction SilentlyContinue
