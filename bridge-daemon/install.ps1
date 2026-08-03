$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDir = Join-Path $env:LOCALAPPDATA 'OpenRGBBridge\service'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$installedNode = Join-Path $installDir 'node.exe'
$installedScript = Join-Path $installDir 'server.js'

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Copy-Item -LiteralPath $nodePath -Destination $installedNode -Force
Copy-Item -LiteralPath (Join-Path $projectDir 'server.js') -Destination $installedScript -Force

$action = New-ScheduledTaskAction -Execute $installedNode -Argument ('"' + $installedScript + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName 'OpenRGB Bridge Service' `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Keeps one persistent OpenRGB SDK connection for SignalRGB.' `
    -Force | Out-Null

Start-ScheduledTask -TaskName 'OpenRGB Bridge Service'
Write-Output "OpenRGB Bridge Service installed in $installDir"
