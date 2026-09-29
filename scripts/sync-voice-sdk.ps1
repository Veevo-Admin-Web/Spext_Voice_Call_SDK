# Keep D:\spextlocal\fe\sdk and Spext backend voice-sdk identical.
# Usage:
#   .\sync-voice-sdk.ps1           # push local -> backend (default)
#   .\sync-voice-sdk.ps1 -Pull     # pull backend -> local
#   .\sync-voice-sdk.ps1 -Both      # sync both directions (newer files win per side)

param(
    [switch]$Pull,
    [switch]$Both
)

$Local  = Join-Path $PSScriptRoot '..'
$Backend = '\\172.18.0.104\applications\spext_v2\production\backend\voice-sdk'

if (-not (Test-Path $Backend)) {
    Write-Error "Backend SDK not found: $Backend"
    exit 1
}

$robocopyArgs = @('/E', '/XD', 'node_modules', '/IS', '/IT')

function Invoke-SdkRobocopy {
    param([string]$Source, [string]$Target)
    robocopy $Source $Target @robocopyArgs
    $code = $LASTEXITCODE
    if ($code -ge 8) { exit $code }
}

if ($Both) {
    Invoke-SdkRobocopy -Source $Local -Target $Backend
    Invoke-SdkRobocopy -Source $Backend -Target $Local
    Write-Host "SDK synced both ways: $Local <-> $Backend"
    exit 0
}

if ($Pull) {
    Invoke-SdkRobocopy -Source $Backend -Target $Local
    Write-Host "SDK pulled: $Backend -> $Local"
    exit 0
}

Invoke-SdkRobocopy -Source $Local -Target $Backend
Write-Host "SDK pushed: $Local -> $Backend"
exit 0
