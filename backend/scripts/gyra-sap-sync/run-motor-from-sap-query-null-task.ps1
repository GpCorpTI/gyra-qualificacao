$ErrorActionPreference = "Stop"

$backendDir = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$logDir = Join-Path $backendDir "logs"
$logFile = Join-Path $logDir "gyra-sap-sync-null.log"

New-Item -ItemType Directory -Force $logDir | Out-Null
Set-Location $backendDir

$env:NODE_ENV = "production"

$startedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $logFile -Value ""
Add-Content -Path $logFile -Value "===== START $startedAt run-motor-from-sap-query-null ====="

cmd.exe /d /c "node ""scripts\gyra-sap-sync\run-motor-from-sap-query-null.mjs"" >> ""$logFile"" 2>&1"
$exitCode = $LASTEXITCODE

$finishedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $logFile -Value "===== END $finishedAt exit=$exitCode ====="

exit $exitCode
