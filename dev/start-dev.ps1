<#
  Starts the local development Foundry instance (PLAN 0.3, A8).
  Never point this at the live server's data. The instance listens on all interfaces (Foundry
  default); keep it private by leaving UPnP off and not forwarding the port.

  Usage:  .\dev\start-dev.ps1 [-FoundryRoot <install dir>] [-DataPath <data dir>] [-Port 30001]
#>
param(
  [string]$FoundryRoot = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [string]$DataPath = "$HOME\FoundryDev",
  [int]$Port = 30001
)

if (-not (Test-Path "$FoundryRoot\main.js")) { throw "Foundry main.js not found in $FoundryRoot" }
if (-not (Test-Path "$DataPath\Data")) { throw "Dev data path $DataPath\Data does not exist" }

Write-Host "Foundry dev instance: http://localhost:$Port  (data: $DataPath)"
node "$FoundryRoot\main.js" --dataPath="$DataPath" --port=$Port --noupnp
