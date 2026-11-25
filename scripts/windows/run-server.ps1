# Runs the 2nd Brain web app in the background (http://localhost:4321).
# Started at login by the "2ndBrain" scheduled task that scripts/install.ps1 creates.
param([Parameter(Mandatory = $true)][string]$Node)
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$data = Join-Path $env:LOCALAPPDATA '2ndBrain'
New-Item -ItemType Directory -Force -Path $data | Out-Null
# There is no terminal here, so the server writes its log to a file.
$env:SECONDBRAIN_LOG = Join-Path $data '2ndBrain.log'
Set-Location $dir
& $Node --disable-warning=ExperimentalWarning (Join-Path $dir 'src\server.mjs')
exit $LASTEXITCODE
