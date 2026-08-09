param(
    [string]$HostName = '127.0.0.1',
    [int]$Port = 6742,
    [int]$SettleSeconds = 8,
    [string]$LogPath = "$env:LOCALAPPDATA\OpenRGBSignalStartup\startup.log"
)

$ErrorActionPreference = 'Stop'

function Write-RecoveryLog([string]$Message) {
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $LogPath -Value "[$timestamp] $Message"
}

function New-OpenRGBPacket([uint32]$CommandId, [byte[]]$Payload = @(), [uint32]$DeviceId = 0) {
    $stream = [System.IO.MemoryStream]::new()
    $writer = [System.IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([byte[]](0x4F, 0x52, 0x47, 0x42))
        $writer.Write($DeviceId)
        $writer.Write($CommandId)
        $writer.Write([uint32]$Payload.Length)
        if ($Payload.Length -gt 0) {
            $writer.Write($Payload)
        }
        $writer.Flush()
        return $stream.ToArray()
    }
    finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

function Read-ExactBytes([System.IO.Stream]$Stream, [int]$Count) {
    $buffer = [byte[]]::new($Count)
    $offset = 0
    while ($offset -lt $Count) {
        $read = $Stream.Read($buffer, $offset, $Count - $offset)
        if ($read -le 0) {
            throw 'OpenRGB closed the SDK connection unexpectedly.'
        }
        $offset += $read
    }
    return $buffer
}

if (Get-Process -Name 'SignalRgb' -ErrorAction SilentlyContinue) {
    Write-RecoveryLog 'Safe rescan refused because SignalRGB is running.'
    throw 'Close SignalRGB completely before requesting a safe OpenRGB rescan.'
}

$client = [System.Net.Sockets.TcpClient]::new()
try {
    $connection = $client.ConnectAsync($HostName, $Port)
    if (-not $connection.Wait(5000) -or -not $client.Connected) {
        throw "OpenRGB SDK did not accept a connection at ${HostName}:$Port."
    }

    $client.ReceiveTimeout = 5000
    $client.SendTimeout = 5000
    $network = $client.GetStream()

    # Negotiate SDK protocol v5 before using Request Rescan Devices (command 140).
    $protocolRequest = New-OpenRGBPacket -CommandId 40 -Payload ([BitConverter]::GetBytes([uint32]5))
    $network.Write($protocolRequest, 0, $protocolRequest.Length)
    $header = Read-ExactBytes -Stream $network -Count 16
    if ($header[0] -ne 0x4F -or $header[1] -ne 0x52 -or $header[2] -ne 0x47 -or $header[3] -ne 0x42) {
        throw 'OpenRGB returned an invalid SDK packet.'
    }
    $payloadLength = [BitConverter]::ToUInt32($header, 12)
    $protocolPayload = Read-ExactBytes -Stream $network -Count $payloadLength
    $protocolVersion = [BitConverter]::ToUInt32($protocolPayload, 0)
    if ($protocolVersion -lt 5) {
        throw "OpenRGB negotiated SDK protocol v$protocolVersion; safe rescan requires v5."
    }

    $clientName = [Text.Encoding]::ASCII.GetBytes("Matheus OpenRGB Safe Recovery`0")
    $namePacket = New-OpenRGBPacket -CommandId 50 -Payload $clientName
    $network.Write($namePacket, 0, $namePacket.Length)

    $rescanPacket = New-OpenRGBPacket -CommandId 140
    $network.Write($rescanPacket, 0, $rescanPacket.Length)
    $network.Flush()
    Write-RecoveryLog "Requested one OpenRGB hardware rescan while SignalRGB was closed; settling for $SettleSeconds seconds."
}
finally {
    $client.Dispose()
}

Start-Sleep -Seconds $SettleSeconds
Write-RecoveryLog 'OpenRGB safe recovery completed.'
