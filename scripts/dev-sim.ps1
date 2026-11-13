<#
.SYNOPSIS
Start MedHop in simulator mode on Windows. No drone is involved.

.DESCRIPTION
Default: the Python backend (simulator) on http://127.0.0.1:8010 and the site on http://localhost:5180.
With -Browser: only the site, with the simulator running inside the page. That needs Node and nothing else.
Press Ctrl-C to stop.

Environment:
  MEDHOP_PYTHON   Python 3.11+ with backend\requirements.txt installed
                  (default: .venv\Scripts\python.exe if it exists, otherwise python)

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\dev-sim.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\dev-sim.ps1 -Browser
#>
param([switch]$Browser)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$BackendPort = 8010
$FrontendPort = 5180

function Fail($message) {
    Write-Host "dev-sim: $message"
    exit 1
}

function Test-PortBusy($port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect("localhost", $port)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Test-Answers($url) {
    try {
        Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

# ---------------------------------------------------------------- checks
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "node not found. Install Node.js 22.12 or newer." }
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)"
if ($LASTEXITCODE -ne 0) { Fail "node $(node --version) is too old for Vite 8. Install Node.js 22.12 or newer." }
$ViteJs = Join-Path $Root "frontend\node_modules\vite\bin\vite.js"
if (-not (Test-Path $ViteJs)) { Fail "frontend dependencies missing. Run: cd frontend; npm install" }

if (-not $Browser) {
    $Py = $env:MEDHOP_PYTHON
    if (-not $Py) {
        $Venv = Join-Path $Root ".venv\Scripts\python.exe"
        if (Test-Path $Venv) { $Py = $Venv } else { $Py = "python" }
    }
    if (-not (Get-Command $Py -ErrorAction SilentlyContinue)) {
        Fail "Python not found: '$Py'. Set MEDHOP_PYTHON to a Python 3.11+ interpreter, or use -Browser."
    }
    & $Py -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"
    if ($LASTEXITCODE -ne 0) { Fail "$Py is too old. MedHop needs Python 3.11+. Set MEDHOP_PYTHON." }
    & $Py -c "import fastapi, uvicorn, numpy, cv2; cv2.aruco" 2>$null
    if ($LASTEXITCODE -ne 0) { Fail "backend packages missing for $Py. Run: $Py -m pip install -r backend\requirements.txt" }
    if (Test-PortBusy $BackendPort) { Fail "port $BackendPort is already in use (another MedHop backend?). Stop it first." }
}
if (Test-PortBusy $FrontendPort) { Fail "port $FrontendPort is already in use (another frontend dev server?). Stop it first." }

# ---------------------------------------------------------------- start
$Backend = $null
$Frontend = $null
try {
    if (-not $Browser) {
        Write-Host "dev-sim: starting backend (simulator) on http://127.0.0.1:$BackendPort"
        $env:MEDHOP_DRONE = "sim"
        $Backend = Start-Process -FilePath $Py -ArgumentList "-m", "medhop" `
            -WorkingDirectory (Join-Path $Root "backend") -NoNewWindow -PassThru
    }

    # Which backend the pages talk to is fixed when the site starts: the Python backend above, or the
    # simulator inside the page. There is no switching between them while it runs.
    if ($Browser) { $Mode = "browser" } else { $Mode = "python" }
    $env:VITE_BACKEND = $Mode
    $ViteArgs = @("`"$ViteJs`"")
    if ($Browser) { $ViteArgs += @("--mode", "browser") }
    Write-Host "dev-sim: starting the site on http://localhost:$FrontendPort"
    $Frontend = Start-Process -FilePath "node" -ArgumentList $ViteArgs `
        -WorkingDirectory (Join-Path $Root "frontend") -NoNewWindow -PassThru

    $Ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        if ($Backend -and $Backend.HasExited) { Fail "the backend exited during startup (see its log above)." }
        if ($Frontend.HasExited) { Fail "the site's dev server exited during startup (see its log above)." }
        $BackendUp = $Browser -or (Test-Answers "http://127.0.0.1:$BackendPort/api/health")
        if ($BackendUp -and (Test-Answers "http://localhost:$FrontendPort/")) {
            $Ready = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not $Ready) { Fail "the backend or the site did not answer within 60 s." }

    Write-Host ""
    if ($Browser) {
        Write-Host "dev-sim: ready (simulator inside the page, no backend, no drone)."
    } else {
        Write-Host "dev-sim: ready (Python simulator, no drone)."
    }
    Write-Host "  Home:      http://localhost:$FrontendPort/"
    Write-Host "  Pilot:     http://localhost:$FrontendPort/pilot"
    Write-Host "  Care:      http://localhost:$FrontendPort/care"
    Write-Host "  Caregiver: http://localhost:$FrontendPort/caregiver"
    Write-Host "  Press Ctrl-C to stop."
    Write-Host ""

    while (-not $Frontend.HasExited -and -not ($Backend -and $Backend.HasExited)) {
        Start-Sleep -Seconds 1
    }
    Fail "one of the processes exited (see its log above)."
} finally {
    foreach ($process in @($Frontend, $Backend)) {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Host "dev-sim: stopped."
}
