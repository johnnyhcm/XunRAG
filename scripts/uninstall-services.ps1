# S8 稳定性① 进程守护卸载脚本（2026-08-13）
# 用法（需管理员权限）：powershell -ExecutionPolicy Bypass -File scripts\uninstall-services.ps1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Nssm = Join-Path $Root "tools\nssm\nssm.exe"

foreach ($svc in "policybot-backend", "policybot-python") {
  Write-Host "== 停止并移除 $svc =="
  & $Nssm stop $svc 2>$null | Out-Null
  Start-Sleep -Seconds 1
  & $Nssm remove $svc confirm | Out-Null
  Write-Host "  ✅ $svc 已移除"
}
Write-Host ""
Write-Host "提示：卸载后如需恢复手动开发模式，手动启动："
Write-Host "  backend：cd app/backend && npx tsx watch src/main.ts（或 npm run dev）"
Write-Host "  python：python app/python/server.py"