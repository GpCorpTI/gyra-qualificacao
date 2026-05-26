$ErrorActionPreference = "Stop"

$backendDir = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$logDir = Join-Path $backendDir "logs"
$logFile = Join-Path $logDir "gyra-sap-sync-stale.log"

New-Item -ItemType Directory -Force $logDir | Out-Null
Set-Location $backendDir

$env:NODE_ENV = "production"

node "scripts\gyra-sap-sync\run-motor-from-sap-query.mjs" *>> $logFile
