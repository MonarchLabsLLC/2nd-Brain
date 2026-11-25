# One-step install for 2nd Brain on Windows 10 or 11.
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1           install everything
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -NoApp    skip the Start menu app
# Safe to run again: it updates what is already installed. No administrator rights needed.
param([switch]$NoApp)
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $PSScriptRoot
Set-Location $dir
$port = if ($env:SECONDBRAIN_PORT) { [int]$env:SECONDBRAIN_PORT } else { 4321 }
$data = Join-Path $env:LOCALAPPDATA '2ndBrain'
$taskName = '2ndBrain'

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!  $m" -ForegroundColor Yellow }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# 1. Node.js 22.13 or later
if (-not (Has 'node')) {
  Write-Host 'Node.js is not installed. Install it with:  winget install OpenJS.NodeJS.LTS   (or from https://nodejs.org)'
  Write-Host 'Then open a new PowerShell window and run this script again.'
  exit 1
}
$node = (Get-Command node).Source
$nodeOk = & $node -e "const [a,b]=process.versions.node.split('.').map(Number);console.log(a>22||(a===22&&b>=13)?1:0)"
if ($nodeOk -ne '1') {
  Write-Host "2nd Brain needs Node.js 22.13 or later. You have $(& $node -v). Update with:  winget upgrade OpenJS.NodeJS.LTS"
  exit 1
}
Say "Node.js $(& $node -v)"

# 2. Dependencies
Say 'Installing dependencies'
& npm install --no-fund --no-audit --loglevel=error
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

# 3. Stop a running copy, so the new code is used
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

# 4. First index
Say 'Indexing your Downloads folder (the first run can take a minute)'
& npm run --silent index
if ($LASTEXITCODE -ne 0) { Warn 'The first index did not finish. The app will try again when it starts.' }

# 5. Start at login: a scheduled task that runs the server in a hidden window and restarts it if it stops
Say 'Starting 2nd Brain at login'
$runner = Join-Path $dir 'scripts\windows\run-server.ps1'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$psArgs = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Node `"$node`""
$me = "$env:USERDOMAIN\$env:USERNAME"
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) '2nd Brain.lnk'
try {
  $action = New-ScheduledTaskAction -Execute $ps -Argument $psArgs -WorkingDirectory $dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Runs the 2nd Brain web app at http://localhost:4321' -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  if (Test-Path $startup) { Remove-Item $startup -Force }
} catch {
  # Some managed PCs do not allow scheduled tasks. A Startup-folder shortcut works everywhere (no automatic restart).
  Warn "Could not create a scheduled task ($($_.Exception.Message)). Using the Startup folder instead."
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($startup)
  $lnk.TargetPath = $ps; $lnk.Arguments = $psArgs; $lnk.WorkingDirectory = $dir; $lnk.WindowStyle = 7
  $lnk.Save()
  Start-Process -FilePath $ps -ArgumentList $psArgs -WorkingDirectory $dir -WindowStyle Hidden
}
$up = $false
for ($i = 0; $i -lt 40 -and -not $up; $i++) {
  Start-Sleep -Milliseconds 500
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://localhost:$port/api/status" | Out-Null; $up = $true } catch { }
}
if ($up) { Write-Host "   Running at http://localhost:$port" } else { Warn "2nd Brain did not answer yet. See the log: $data\2ndBrain.log" }

# 6. MCP server for AI agents
$mcp = @($node, '--disable-warning=ExperimentalWarning', (Join-Path $dir 'src\mcp.mjs'))
if (Has 'claude') {
  Say 'Connecting to Claude Code'
  & claude mcp remove --scope user 2ndbrain 2>&1 | Out-Null
  & claude mcp add --scope user 2ndbrain '--' @mcp 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "   Added MCP server '2ndbrain' to Claude Code." }
  else { Warn "Could not add the MCP server to Claude Code. See README, section 'From Claude Code or Codex'." }
} else {
  Warn 'Claude Code (claude) not found. Search, Organize and the app still work. AI naming and the Claude Code tools need it.'
}
if (Has 'codex') {
  Say 'Connecting to Codex'
  & codex mcp remove 2ndbrain 2>&1 | Out-Null
  & codex mcp add 2ndbrain '--' @mcp 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "   Added MCP server '2ndbrain' to Codex." } else { Warn 'Could not add the MCP server to Codex. See README.' }
}

# 7. Optional helpers
if (-not (Has 'pdftotext')) { Warn 'Optional: winget install oschwartz10612.Poppler   (lets 2nd Brain search the text inside PDFs)' }

# 8. Start menu app: Microsoft Edge in app mode, so 2nd Brain gets its own window and taskbar button
if (-not $NoApp) {
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
    Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($edge) {
    Say 'Adding 2nd Brain to the Start menu'
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    $ico = Join-Path $data '2ndBrain.ico'
    try {
      # The app icon: the dark square with the yellow bar, as in the web app.
      Add-Type -AssemblyName System.Drawing
      $bmp = New-Object System.Drawing.Bitmap 256, 256
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.SmoothingMode = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)
      function RoundRect($x, $y, $w, $h, $r) {
        $p = New-Object System.Drawing.Drawing2D.GraphicsPath
        $p.AddArc($x, $y, $r, $r, 180, 90); $p.AddArc($x + $w - $r, $y, $r, $r, 270, 90)
        $p.AddArc($x + $w - $r, $y + $h - $r, $r, $r, 0, 90); $p.AddArc($x, $y + $h - $r, $r, $r, 90, 90); $p.CloseFigure(); $p
      }
      $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#1D2633'))), (RoundRect 0 0 256 256 112))
      $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#F6DA4A'))), (RoundRect 56 104 144 56 32))
      $g.Dispose()
      $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $png = $ms.ToArray()
      $fs = [System.IO.File]::Create($ico); $w = New-Object System.IO.BinaryWriter $fs
      # ICO header with one 256x256 PNG image
      $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)
      $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0)
      $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$png.Length); $w.Write([UInt32]22); $w.Write($png)
      $w.Close(); $bmp.Dispose()
    } catch { $ico = $null }
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) '2nd Brain.lnk'))
    $lnk.TargetPath = $edge
    $lnk.Arguments = "--app=http://localhost:$port"
    $lnk.Description = 'Find anything you downloaded'
    if ($ico) { $lnk.IconLocation = "$ico,0" }
    $lnk.Save()
    Write-Host '   Open "2nd Brain" from the Start menu. Right-click its taskbar button to pin it.'
  } else {
    Warn "Microsoft Edge not found, so no Start menu app. Open http://localhost:$port in your browser."
  }
}

Write-Host ''
Say "Done. Open http://localhost:$port"
