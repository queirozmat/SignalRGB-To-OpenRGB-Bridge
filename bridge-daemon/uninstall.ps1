$ErrorActionPreference = 'Stop'

Stop-ScheduledTask -TaskName 'OpenRGB Bridge Service' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'OpenRGB Bridge Service' -Confirm:$false -ErrorAction SilentlyContinue

Write-Output 'OpenRGB Bridge Service task removed. Runtime files were kept for recovery.'
