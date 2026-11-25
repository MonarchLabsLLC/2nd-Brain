# Remove 2nd Brain's login task, MCP registrations and Start menu app on Windows.
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1          keeps your index and settings
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -Data    also deletes the index, thumbnails and settings
# Your files are never touched.
param([switch]$Data)
$port = if ($env:SECONDBRAIN_PORT) { [int]$env:SECONDBRAIN_PORT } else { 4321 }

if (Get-ScheduledTask -TaskName '2ndBrain' -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName '2ndBrain' -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName '2ndBrain' -Confirm:$false
  Write-Host 'Removed the login task.'
}
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
foreach ($lnk in @((Join-Path ([Environment]::GetFolderPath('Startup')) '2nd Brain.lnk'),
                   (Join-Path ([Environment]::GetFolderPath('Programs')) '2nd Brain.lnk'))) {
  if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "Removed $lnk" }
}
if (Get-Command claude -ErrorAction SilentlyContinue) {
  & claude mcp remove --scope user 2ndbrain 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host 'Removed the MCP server from Claude Code.' }
}
if (Get-Command codex -ErrorAction SilentlyContinue) {
  & codex mcp remove 2ndbrain 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host 'Removed the MCP server from Codex.' }
}
if ($Data) {
  $dir = Join-Path $env:LOCALAPPDATA '2ndBrain'
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force; Write-Host 'Deleted the index, thumbnails and settings.' }
}
Write-Host '2nd Brain is uninstalled. You can delete this folder.'
