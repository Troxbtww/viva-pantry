$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$pantryPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pantryPython)) {
    Write-Host 'Create the Python 3.12 virtual environment and install requirements.txt first. See README.md.'
    exit 1
}
$pantryUrl = 'http://127.0.0.1:8765'
try {
    $pantryHealth = Invoke-RestMethod "$pantryUrl/health" -TimeoutSec 2
} catch {
    Start-Process -FilePath $pantryPython -ArgumentList 'app.py' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'server-error.log')
    for ($pantryTry = 0; $pantryTry -lt 30; $pantryTry++) {
        Start-Sleep -Milliseconds 300
        try {
            $pantryHealth = Invoke-RestMethod "$pantryUrl/health" -TimeoutSec 1
            break
        } catch {}
    }
}
if (-not $pantryHealth) { throw 'The tracker could not start. Check server-error.log.' }
Start-Process $pantryUrl
