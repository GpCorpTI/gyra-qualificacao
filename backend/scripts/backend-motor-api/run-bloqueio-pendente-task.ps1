$ErrorActionPreference = 'Stop'

$NodeExe = 'C:\Program Files\nodejs\node.exe'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Resolve-Path (Join-Path $ScriptDir '..\..')
$ScriptPath = Join-Path $ScriptDir 'run-motor-from-bloqueio-pendente.mjs'
$LogDir = Join-Path $BackendDir 'logs\scheduled-tasks'
$LogFile = Join-Path $LogDir ("bloqueio-pendente-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Test-Path -LiteralPath $NodeExe)) {
  throw "Node.js nao encontrado em $NodeExe"
}

if (-not (Test-Path -LiteralPath $ScriptPath)) {
  throw "Script nao encontrado em $ScriptPath"
}

Push-Location $BackendDir
try {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Inicio da execucao" | Tee-Object -FilePath $LogFile
  "BackendDir: $BackendDir" | Tee-Object -FilePath $LogFile -Append
  "Script: $ScriptPath" | Tee-Object -FilePath $LogFile -Append

  & $NodeExe $ScriptPath *>&1 | Tee-Object -FilePath $LogFile -Append
  $exitCode = $LASTEXITCODE

  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Fim da execucao. ExitCode=$exitCode" | Tee-Object -FilePath $LogFile -Append
  exit $exitCode
}
finally {
  Pop-Location
}
