$ErrorActionPreference = 'Stop'

$signalLauncher = "$env:LOCALAPPDATA\VortxEngine\SignalRgbLauncher.exe"
$runtimeDirectory = "$env:LOCALAPPDATA\OpenRGBSignalStartup"
$recoveryScript = Join-Path $runtimeDirectory 'Invoke-OpenRGBSafeRescan.ps1'
$logPath = Join-Path $runtimeDirectory 'startup.log'
$deadline = [DateTime]::UtcNow.AddSeconds(90)

function Write-StartupLog([string]$Message) {
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $logPath -Value "[$timestamp] $Message"
}

if (Get-Process -Name 'SignalRgb' -ErrorAction SilentlyContinue) {
    Write-StartupLog 'SignalRGB is already running; no action needed.'
    exit 0
}

Write-StartupLog 'Waiting for the OpenRGB SDK server at 127.0.0.1:6742.'
$sdkReady = $false
while ([DateTime]::UtcNow -lt $deadline) {
    $tcp = [System.Net.Sockets.TcpClient]::new()
    try {
        $connection = $tcp.ConnectAsync('127.0.0.1', 6742)
        if ($connection.Wait(750) -and $tcp.Connected) {
            $sdkReady = $true
            break
        }
    }
    catch {
        # OpenRGB is still loading its hardware controllers.
    }
    finally {
        $tcp.Dispose()
    }
    Start-Sleep -Seconds 1
}

if (-not $sdkReady) {
    Write-StartupLog 'OpenRGB SDK did not become ready within 90 seconds; SignalRGB was not started.'
    exit 1
}

# Recovery runs outside SignalRGB, before its plugin scan and render threads exist.
& $recoveryScript -LogPath $logPath
Write-StartupLog 'Starting SignalRGB after OpenRGB recovery.'
Start-Process -FilePath $signalLauncher -ArgumentList '--silent' -WindowStyle Hidden
