# Resin Standalone Bootstrap Installer for Windows / PowerShell
# Cryptographically verified, standalone bootstrap installer.
# Helper URL: https://resin.sh/install-helper-v1.mjs
# Helper SHA-256: 4fdae2b7beb34bb5d74eee867f68ce143588990758595c4a7287ed258b9de12c

[CmdletBinding()]
param(
    [Parameter(Position=0)]
    [string]$Channel,

    [Parameter()]
    [string]$ChannelUrl,

    [Parameter()]
    [string]$ResinHome,

    [Parameter()]
    [string]$DownloadOnly,

    [Parameter()]
    [switch]$Help,

    [Parameter()]
    [switch]$Force,

    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = 'Stop'

# Pinned security constants
$PINNED_HELPER_URL = "https://resin.sh/install-helper-v1.mjs"
$PINNED_HELPER_SHA256 = "4fdae2b7beb34bb5d74eee867f68ce143588990758595c4a7287ed258b9de12c"
$MIN_NODE_VERSION = 22

function Show-ResinHelp {
    Write-Host @"
Resin Standalone Installer Bootstrap (PowerShell)

Installs the Resin CLI binary and runtime environment.
On Windows, installation requires WSL2 (Ubuntu or Debian recommended).
On Linux/macOS pwsh, installation runs locally with Node.js >= 22.

Usage:
  irm https://resin.sh/install.ps1 | iex
  install.ps1 [options]

Options:
  -Channel <name>              Release channel (e.g. stable, default: stable)
  -ChannelUrl <url>            Override channel manifest URL (testing/enterprise)
  -ResinHome <path>            Destination directory (default: ~/.resin)
  -DownloadOnly <path>         Download and verify helper script without executing
  -Help, -h, --help            Show this help text and exit
  -Force                       Bypass non-security warnings

Inspect-First Alternative:
  1. Download helper:
     powershell -Command "irm https://resin.sh/install.ps1 -OutFile install.ps1; .\install.ps1 -DownloadOnly ./install-helper.mjs"
  2. Inspect helper script:
     Get-Content ./install-helper.mjs
  3. Execute verified helper:
     node ./install-helper.mjs [options]
"@
}

# Parse CLI arguments if passed via $args or $RemainingArgs
$allArgs = [System.Collections.Generic.List[string]]::new()
if ($null -ne $RemainingArgs) {
    foreach ($a in $RemainingArgs) { $allArgs.Add($a) }
}
if ($null -ne $args) {
    foreach ($a in $args) { $allArgs.Add($a) }
}

if ($allArgs.Count -gt 0) {
    for ($i = 0; $i -lt $allArgs.Count; $i++) {
        $arg = $allArgs[$i]
        if ($arg -eq '--help' -or $arg -eq '-help' -or $arg -eq '-h') {
            $Help = $true
        }
        elseif ($arg -eq '--download-only') {
            if ($i + 1 -lt $allArgs.Count -and -not $allArgs[$i+1].StartsWith('-')) {
                $DownloadOnly = $allArgs[++$i]
            } else {
                $DownloadOnly = 'install-helper-v1.mjs'
            }
        }
        elseif ($arg.StartsWith('--download-only=')) {
            $DownloadOnly = $arg.Substring('--download-only='.Length)
        }
        elseif ($arg -eq '--channel') {
            if ($i + 1 -lt $allArgs.Count) { $Channel = $allArgs[++$i] }
        }
        elseif ($arg.StartsWith('--channel=')) {
            $Channel = $arg.Substring('--channel='.Length)
        }
        elseif ($arg -eq '--channel-url') {
            if ($i + 1 -lt $allArgs.Count) { $ChannelUrl = $allArgs[++$i] }
        }
        elseif ($arg.StartsWith('--channel-url=')) {
            $ChannelUrl = $arg.Substring('--channel-url='.Length)
        }
        elseif ($arg -eq '--resin-home' -or $arg -eq '--home') {
            if ($i + 1 -lt $allArgs.Count) { $ResinHome = $allArgs[++$i] }
        }
        elseif ($arg.StartsWith('--resin-home=')) {
            $ResinHome = $arg.Substring('--resin-home='.Length)
        }
        elseif ($arg -eq '--force' -or $arg -eq '-force') {
            $Force = $true
        }
    }
}

if ($Help) {
    Show-ResinHelp
    return
}

# Check operating system platform
$runningOnWindows = $false
if ($PSVersionTable.PSVersion.Major -ge 6) {
    $runningOnWindows = $IsWindows
} else {
    $runningOnWindows = ($env:OS -eq 'Windows_NT') -or ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)
}

# Check test mode
$isTestMode = ($env:RESIN_INSTALL_TEST_ONLY -eq '1')

# Determine helper URL
$helperUrl = $PINNED_HELPER_URL
if ($isTestMode -and -not [string]::IsNullOrWhiteSpace($env:RESIN_INSTALL_HELPER_URL)) {
    $helperUrl = $env:RESIN_INSTALL_HELPER_URL
}

$helperUri = [System.Uri]::new($helperUrl)

# Scheme verification
if (-not $isTestMode -and $helperUri.Scheme -ne 'https') {
    Write-Error "Security Error: Helper URL must use HTTPS. Insecure scheme '$($helperUri.Scheme)' is rejected."
    exit 1
}

# SSRF Protection: validate IP address against forbidden/private ranges
function Test-IsRestrictedIPAddress {
    param([System.Net.IPAddress]$IP)

    if ($null -eq $IP) { return $true }

    if ($IP.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
        $bytes = $IP.GetAddressBytes()
        $b0 = [int]$bytes[0]
        $b1 = [int]$bytes[1]
        $b2 = [int]$bytes[2]
        $b3 = [int]$bytes[3]

        if ($b0 -eq 0) { return $true }                                      # 0.0.0.0/8 (Unspecified / this host)
        if ($b0 -eq 10) { return $true }                                     # 10.0.0.0/8 (Private RFC 1918)
        if ($b0 -eq 100 -and ($b1 -band 192) -eq 64) { return $true }       # 100.64.0.0/10 (CGNAT RFC 6598)
        if ($b0 -eq 127) { return $true }                                    # 127.0.0.0/8 (Loopback)
        if ($b0 -eq 169 -and $b1 -eq 254) { return $true }                  # 169.254.0.0/16 (Link-Local)
        if ($b0 -eq 172 -and $b1 -ge 16 -and $b1 -le 31) { return $true }   # 172.16.0.0/12 (Private RFC 1918)
        if ($b0 -eq 192 -and $b1 -eq 0 -and $b2 -eq 0) { return $true }     # 192.0.0.0/24 (IETF Protocol)
        if ($b0 -eq 192 -and $b1 -eq 0 -and $b2 -eq 2) { return $true }     # 192.0.2.0/24 (TEST-NET-1)
        if ($b0 -eq 192 -and $b1 -eq 88 -and $b2 -eq 99) { return $true }   # 192.88.99.0/24 (6to4 Relay Anycast)
        if ($b0 -eq 192 -and $b1 -eq 168) { return $true }                   # 192.168.0.0/16 (Private RFC 1918)
        if ($b0 -eq 198 -and ($b1 -eq 18 -or $b1 -eq 19)) { return $true }   # 198.18.0.0/15 (Benchmarking)
        if ($b0 -eq 198 -and $b1 -eq 51 -and $b2 -eq 100) { return $true }  # 198.51.100.0/24 (TEST-NET-2)
        if ($b0 -eq 203 -and $b1 -eq 0 -and $b2 -eq 113) { return $true }   # 203.0.113.0/24 (TEST-NET-3)
        if ($b0 -ge 224 -and $b0 -le 239) { return $true }                   # 224.0.0.0/4 (Multicast)
        if ($b0 -ge 240) { return $true }                                    # 240.0.0.0/4 (Reserved / Broadcast)

        return $false
    }

    if ($IP.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) {
        $bytes = $IP.GetAddressBytes()

        # ::/128 (Unspecified)
        $allZero = $true
        for ($j = 0; $j -lt 16; $j++) {
            if ($bytes[$j] -ne 0) { $allZero = $false; break }
        }
        if ($allZero) { return $true }

        # ::1/128 (Loopback)
        if ($IP.IsIPv6Loopback) { return $true }
        $isV6Loop = $true
        for ($j = 0; $j -lt 15; $j++) {
            if ($bytes[$j] -ne 0) { $isV6Loop = $false; break }
        }
        if ($isV6Loop -and $bytes[15] -eq 1) { return $true }

        # IPv4-Mapped IPv6 ::ffff:0:0/96 and ::ffff:0:0:0/96
        $isV4Mapped = $true
        for ($j = 0; $j -lt 10; $j++) {
            if ($bytes[$j] -ne 0) { $isV4Mapped = $false; break }
        }
        if ($isV4Mapped -and $bytes[10] -eq 255 -and $bytes[11] -eq 255) {
            $v4Bytes = [byte[]]@($bytes[12], $bytes[13], $bytes[14], $bytes[15])
            $v4Ip = [System.Net.IPAddress]::new($v4Bytes)
            return (Test-IsRestrictedIPAddress -IP $v4Ip)
        }

        # 64:ff9b::/96 (IPv4/IPv6 translation RFC 6052)
        if ($bytes[0] -eq 0 -and $bytes[1] -eq 100 -and $bytes[2] -eq 255 -and $bytes[3] -eq 155) {
            $isTrans = $true
            for ($j = 4; $j -lt 12; $j++) {
                if ($bytes[$j] -ne 0) { $isTrans = $false; break }
            }
            if ($isTrans) {
                $v4Bytes = [byte[]]@($bytes[12], $bytes[13], $bytes[14], $bytes[15])
                $v4Ip = [System.Net.IPAddress]::new($v4Bytes)
                return (Test-IsRestrictedIPAddress -IP $v4Ip)
            }
        }

        # 100::/64 (Discard-Only RFC 6666)
        if ($bytes[0] -eq 1 -and $bytes[1] -eq 0) {
            $isDiscard = $true
            for ($j = 2; $j -lt 8; $j++) {
                if ($bytes[$j] -ne 0) { $isDiscard = $false; break }
            }
            if ($isDiscard) { return $true }
        }

        # 2001:db8::/32 (Documentation RFC 3849)
        if ($bytes[0] -eq 32 -and $bytes[1] -eq 1 -and $bytes[2] -eq 13 -and $bytes[3] -eq 184) {
            return $true
        }

        # 2002::/16 (6to4 RFC 3056)
        if ($bytes[0] -eq 32 -and $bytes[1] -eq 2) {
            $v4Bytes = [byte[]]@($bytes[2], $bytes[3], $bytes[4], $bytes[5])
            $v4Ip = [System.Net.IPAddress]::new($v4Bytes)
            return (Test-IsRestrictedIPAddress -IP $v4Ip)
        }

        # fc00::/7 (Unique Local Address RFC 4193)
        if (($bytes[0] -band 254) -eq 252) { return $true }

        # fe80::/10 (Link-Local)
        if ($IP.IsIPv6LinkLocal) { return $true }
        if ($bytes[0] -eq 254 -and ($bytes[1] -band 192) -eq 128) { return $true }

        # ff00::/8 (Multicast)
        if ($IP.IsIPv6Multicast -or $bytes[0] -eq 255) { return $true }

        return $false
    }

    return $true
}

function Decode-ChunkedBytes {
    param(
        [byte[]]$Bytes,
        [int]$MaxBytes = 1048576
    )

    $msIn = [System.IO.MemoryStream]::new($Bytes)
    $msOut = [System.IO.MemoryStream]::new()
    $reader = [System.IO.BinaryReader]::new($msIn)

    while ($msIn.Position -lt $msIn.Length) {
        $lineChars = [System.Collections.Generic.List[char]]::new()
        while ($msIn.Position -lt $msIn.Length) {
            $b = $reader.ReadByte()
            if ($b -eq 10) { break }
            if ($b -ne 13) { $lineChars.Add([char]$b) }
        }
        $lineStr = (-join $lineChars).Trim()
        if ([string]::IsNullOrWhiteSpace($lineStr)) { continue }

        $chunkSizeHex = ($lineStr -split ';')[0].Trim()
        $chunkSize = 0
        try {
            $chunkSize = [System.Convert]::ToInt32($chunkSizeHex, 16)
        } catch {
            throw "Invalid chunk size in chunked encoding: '$chunkSizeHex'"
        }

        if ($chunkSize -lt 0) {
            throw "Negative chunk size in chunked encoding: $chunkSize"
        }

        if ($chunkSize -eq 0) { break }

        if ($msOut.Length + $chunkSize -gt $MaxBytes) {
            throw "Decoded chunked payload exceeds maximum limit of $MaxBytes bytes."
        }

        if ($msIn.Position + $chunkSize -gt $msIn.Length) {
            throw "Unexpected end of stream while reading chunk of $chunkSize bytes."
        }

        $chunkBytes = $reader.ReadBytes($chunkSize)
        $msOut.Write($chunkBytes, 0, $chunkBytes.Length)

        if ($msIn.Position -lt $msIn.Length) {
            $b0 = $reader.ReadByte()
            if ($b0 -eq 13 -and $msIn.Position -lt $msIn.Length) {
                $null = $reader.ReadByte()
            }
        }
    }

    return $msOut.ToArray()
}

function Download-HelperBytes {
    param(
        [Uri]$Uri,
        [System.Net.IPAddress]$TargetIP,
        [bool]$IsTest
    )

    $MAX_HEADER_SIZE = 64 * 1024       # 64 KiB
    $MAX_BODY_SIZE = 1024 * 1024       # 1 MiB
    $CONNECT_TIMEOUT_MS = 15000        # 15s connect timeout
    $IDLE_TIMEOUT_MS = 15000           # 15s idle timeout
    $TOTAL_TIMEOUT_MS = 60000          # 60s total deadline

    $port = $Uri.Port
    if ($port -le 0) {
        if ($Uri.Scheme -eq 'https') { $port = 443 } else { $port = 80 }
    }

    # Certificate validation: allow bypass ONLY in explicit loopback test mode
    $isLoopbackTarget = ($TargetIP.ToString() -eq '127.0.0.1' -or $TargetIP.ToString() -eq '::1' -or [System.Net.IPAddress]::IsLoopback($TargetIP))

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $tcpClient = [System.Net.Sockets.TcpClient]::new($TargetIP.AddressFamily)
    $activeStream = $null

    try {
        $asyncConnect = $tcpClient.BeginConnect($TargetIP, $port, $null, $null)
        if (-not $asyncConnect.AsyncWaitHandle.WaitOne($CONNECT_TIMEOUT_MS, $false)) {
            $tcpClient.Close()
            throw "Connection to $TargetIP`:$port timed out after $($CONNECT_TIMEOUT_MS / 1000)s."
        }
        $tcpClient.EndConnect($asyncConnect)

        $tcpClient.ReceiveTimeout = $IDLE_TIMEOUT_MS
        $tcpClient.SendTimeout = $IDLE_TIMEOUT_MS
        $stream = $tcpClient.GetStream()

        if ($Uri.Scheme -eq 'https') {
            $sslStream = [System.Net.Security.SslStream]::new(
                $stream,
                $false,
                [System.Net.Security.RemoteCertificateValidationCallback]{
                    param($sender, $certificate, $chain, $sslPolicyErrors)
                    if ($IsTest -and $isLoopbackTarget) { return $true }
                    return ($sslPolicyErrors -eq [System.Net.Security.SslPolicyErrors]::None)
                }
            )
            $sslStream.ReadTimeout = $IDLE_TIMEOUT_MS
            $sslStream.WriteTimeout = $IDLE_TIMEOUT_MS
            $sslStream.AuthenticateAsClient($Uri.Host)
            $activeStream = $sslStream
        } else {
            $stream.ReadTimeout = $IDLE_TIMEOUT_MS
            $stream.WriteTimeout = $IDLE_TIMEOUT_MS
            $activeStream = $stream
        }

        $pathAndQuery = $Uri.PathAndQuery
        if ([string]::IsNullOrEmpty($pathAndQuery)) { $pathAndQuery = '/' }

        $hostHeader = $Uri.Host
        if (($Uri.Scheme -eq 'http' -and $port -ne 80) -or ($Uri.Scheme -eq 'https' -and $port -ne 443)) {
            $hostHeader = "$($Uri.Host):$port"
        }

        $requestStr = "GET $pathAndQuery HTTP/1.1`r`n" +
                      "Host: $hostHeader`r`n" +
                      "User-Agent: Resin-Installer/1.0 (PowerShell)`r`n" +
                      "Connection: close`r`n" +
                      "Accept: */*`r`n`r`n"

        $requestBytes = [System.Text.Encoding]::ASCII.GetBytes($requestStr)
        $activeStream.Write($requestBytes, 0, $requestBytes.Length)
        $activeStream.Flush()

        # Read response headers with 64 KiB cap and idle/total deadlines
        $rawResponseMs = [System.IO.MemoryStream]::new()
        $buffer = [byte[]]::new(4096)
        $headerEndIndex = -1

        while ($true) {
            $elapsed = $stopwatch.ElapsedMilliseconds
            if ($elapsed -ge $TOTAL_TIMEOUT_MS) {
                throw "Download exceeded total request deadline of $($TOTAL_TIMEOUT_MS / 1000)s."
            }
            $remaining = [int]($TOTAL_TIMEOUT_MS - $elapsed)
            $currentTimeout = [Math]::Min($IDLE_TIMEOUT_MS, $remaining)
            $tcpClient.ReceiveTimeout = $currentTimeout
            try { $activeStream.ReadTimeout = $currentTimeout } catch {}

            try {
                $read = $activeStream.Read($buffer, 0, $buffer.Length)
            } catch [System.IO.IOException] {
                throw "Network read timed out or connection reset: $_"
            }
            if ($read -le 0) { break }

            $rawResponseMs.Write($buffer, 0, $read)

            # Check if headers end with \r\n\r\n
            $currentBytes = $rawResponseMs.ToArray()
            for ($k = 3; $k -lt $currentBytes.Length; $k++) {
                if ($currentBytes[$k-3] -eq 13 -and $currentBytes[$k-2] -eq 10 -and $currentBytes[$k-1] -eq 13 -and $currentBytes[$k] -eq 10) {
                    $headerEndIndex = $k + 1
                    break
                }
            }

            if ($headerEndIndex -ge 0) {
                break
            }

            if ($rawResponseMs.Length -gt $MAX_HEADER_SIZE) {
                throw "HTTP response headers exceeded limit of $($MAX_HEADER_SIZE / 1024) KiB."
            }
        }

        if ($headerEndIndex -lt 0) {
            throw "Invalid HTTP response: headers did not terminate properly or response was empty."
        }

        $allData = $rawResponseMs.ToArray()
        $headerRaw = [System.Text.Encoding]::ASCII.GetString($allData, 0, $headerEndIndex)
        $headerLines = $headerRaw -split "`r`n"
        $statusLine = $headerLines[0]

        $statusMatch = [regex]::Match($statusLine, '^HTTP/\d\.\d\s+(\d+)')
        if (-not $statusMatch.Success) {
            throw "Invalid HTTP status line: $statusLine"
        }
        $statusCode = [int]$statusMatch.Groups[1].Value
        if ($statusCode -ne 200) {
            throw "HTTP request failed with status code $statusCode."
        }

        $contentLength = -1
        $isChunked = $false
        foreach ($line in $headerLines) {
            if ($line -match '(?i)^Content-Length:\s*(\d+)') {
                $contentLength = [int]$Matches[1]
            }
            if ($line -match '(?i)^Transfer-Encoding:\s*chunked') {
                $isChunked = $true
            }
        }

        if ($contentLength -gt $MAX_BODY_SIZE) {
            throw "Helper payload Content-Length ($contentLength bytes) exceeds maximum limit of $($MAX_BODY_SIZE / 1024 / 1024) MiB."
        }

        # Read body with 1 MiB cap and idle/total deadlines
        $bodyStream = [System.IO.MemoryStream]::new()
        $initialBodyLength = $allData.Length - $headerEndIndex
        if ($initialBodyLength -gt 0) {
            if ($initialBodyLength -gt $MAX_BODY_SIZE) {
                throw "Helper payload exceeded maximum limit of $($MAX_BODY_SIZE / 1024 / 1024) MiB."
            }
            $bodyStream.Write($allData, $headerEndIndex, $initialBodyLength)
        }

        while ($true) {
            if ($contentLength -ge 0 -and $bodyStream.Length -ge $contentLength) {
                break
            }

            $elapsed = $stopwatch.ElapsedMilliseconds
            if ($elapsed -ge $TOTAL_TIMEOUT_MS) {
                throw "Download exceeded total request deadline of $($TOTAL_TIMEOUT_MS / 1000)s."
            }
            $remaining = [int]($TOTAL_TIMEOUT_MS - $elapsed)
            $currentTimeout = [Math]::Min($IDLE_TIMEOUT_MS, $remaining)
            $tcpClient.ReceiveTimeout = $currentTimeout
            try { $activeStream.ReadTimeout = $currentTimeout } catch {}

            try {
                $read = $activeStream.Read($buffer, 0, $buffer.Length)
            } catch [System.IO.IOException] {
                throw "Network read timed out or connection reset: $_"
            }
            if ($read -le 0) { break }

            if ($bodyStream.Length + $read -gt $MAX_BODY_SIZE) {
                throw "Helper payload exceeded maximum limit of $($MAX_BODY_SIZE / 1024 / 1024) MiB."
            }
            $bodyStream.Write($buffer, 0, $read)
        }

        $rawBodyBytes = $bodyStream.ToArray()

        if ($isChunked) {
            $rawBodyBytes = Decode-ChunkedBytes -Bytes $rawBodyBytes -MaxBytes $MAX_BODY_SIZE
        }
        elseif ($contentLength -ge 0 -and $rawBodyBytes.Length -ne $contentLength) {
            throw "Content-Length mismatch: expected $contentLength bytes, received $($rawBodyBytes.Length)"
        }

        if ($rawBodyBytes.Length -gt $MAX_BODY_SIZE) {
            throw "Helper payload exceeded maximum limit of $($MAX_BODY_SIZE / 1024 / 1024) MiB."
        }

        return $rawBodyBytes
    }
    finally {
        if ($null -ne $activeStream) {
            try { $activeStream.Dispose() } catch {}
        }
        if ($null -ne $tcpClient) {
            try { $tcpClient.Close() } catch {}
        }
    }
}

# Resolve DNS and validate host IPs
Write-Host "Resolving helper endpoint $($helperUri.Host)..."
$hostAddresses = [System.Net.Dns]::GetHostAddresses($helperUri.Host)
if ($null -eq $hostAddresses -or $hostAddresses.Length -eq 0) {
    Write-Error "DNS resolution failed: no IP addresses found for $($helperUri.Host)"
    exit 1
}

$validAddresses = [System.Collections.Generic.List[System.Net.IPAddress]]::new()
foreach ($addr in $hostAddresses) {
    $isRestricted = Test-IsRestrictedIPAddress -IP $addr
    if ($isRestricted) {
        if ($isTestMode) {
            $validAddresses.Add($addr)
        } else {
            Write-Error "Security Error: Host $($helperUri.Host) resolved to forbidden IP address $($addr.ToString()). Helper acquisition aborted."
            exit 1
        }
    } else {
        $validAddresses.Add($addr)
    }
}

if ($validAddresses.Count -eq 0) {
    Write-Error "Security Error: No valid public IP addresses found for $($helperUri.Host)."
    exit 1
}

$chosenIP = $validAddresses[0]

# Download helper payload
Write-Host "Downloading verified installer helper from $helperUrl..."
try {
    $helperBytes = Download-HelperBytes -Uri $helperUri -TargetIP $chosenIP -IsTest $isTestMode
} catch {
    Write-Error "Failed to download installer helper: $_"
    exit 1
}

# Compute and verify SHA-256
$sha256Provider = [System.Security.Cryptography.SHA256]::Create()
$computedHashBytes = $sha256Provider.ComputeHash($helperBytes)
$computedHashHex = [System.BitConverter]::ToString($computedHashBytes).Replace('-', '').ToLowerInvariant()

if ($computedHashHex -ne $PINNED_HELPER_SHA256) {
    Write-Error "Security Error: Helper SHA-256 mismatch!`nExpected: $PINNED_HELPER_SHA256`nActual:   $computedHashHex`nHelper acquisition aborted."
    exit 1
}

Write-Host "Helper integrity verified (SHA-256: $computedHashHex)."

# Handle -DownloadOnly inspect flow
if (-not [string]::IsNullOrWhiteSpace($DownloadOnly)) {
    $destPath = [System.IO.Path]::GetFullPath($DownloadOnly)
    $destDir = [System.IO.Path]::GetDirectoryName($destPath)
    if (-not [string]::IsNullOrWhiteSpace($destDir) -and -not (Test-Path -Path $destDir)) {
        $null = [System.IO.Directory]::CreateDirectory($destDir)
    }
    [System.IO.File]::WriteAllBytes($destPath, $helperBytes)
    Write-Host "✔ Successfully downloaded and verified Resin install helper."
    Write-Host "  Location: $destPath"
    Write-Host "  SHA-256:  $computedHashHex"
    Write-Host ""
    Write-Host "To inspect the script before running:"
    Write-Host "  cat `"$destPath`""
    Write-Host ""
    Write-Host "To execute the verified installer:"
    Write-Host "  node `"$destPath`""
    exit 0
}

# Execution flow: Preflight checks
if ($runningOnWindows) {
    # Check WSL2 availability
    $wslCmd = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $wslCmd) {
        Write-Error "Resin requires WSL2 on Windows, but 'wsl.exe' was not found.`nPlease install WSL2 (wsl --install) and try again."
        exit 1
    }

    # Verify WSL is responsive and running
    try {
        $wslStatus = & wsl.exe --status 2>&1
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            Write-Error "WSL is not properly configured. Please run 'wsl --install' or 'wsl --update'.`n$wslStatus"
            exit 1
        }
    } catch {
        Write-Error "Failed to execute wsl.exe: $_"
        exit 1
    }

    # Check Node.js inside WSL
    $wslNodeCheck = & wsl.exe --exec node -v 2>&1
    $wslNodeExit = $LASTEXITCODE
    if ($wslNodeExit -ne 0) {
        Write-Error "Resin requires Node.js v$MIN_NODE_VERSION or later inside WSL, but 'node' was not found or failed to execute.`nPlease install Node.js >= $MIN_NODE_VERSION inside your default WSL distribution.`nDetails: $wslNodeCheck"
        exit 1
    }

    $wslNodeVersionMatch = [regex]::Match($wslNodeCheck.ToString(), 'v?(\d+)\.(\d+)\.(\d+)')
    if (-not $wslNodeVersionMatch.Success -or [int]$wslNodeVersionMatch.Groups[1].Value -lt $MIN_NODE_VERSION) {
        Write-Error "Resin requires Node.js v$MIN_NODE_VERSION or later inside WSL. Detected: $($wslNodeCheck.ToString().Trim())`nPlease upgrade Node.js inside WSL."
        exit 1
    }
} else {
    # Non-Windows pwsh: check local Node.js >= 22
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Error "Resin requires Node.js v$MIN_NODE_VERSION or later, but 'node' was not found in PATH.`nPlease install Node.js >= $MIN_NODE_VERSION and try again."
        exit 1
    }

    $nodeVersionRaw = & node -v 2>&1
    $nodeVersionMatch = [regex]::Match($nodeVersionRaw.ToString(), 'v?(\d+)\.(\d+)\.(\d+)')
    if (-not $nodeVersionMatch.Success -or [int]$nodeVersionMatch.Groups[1].Value -lt $MIN_NODE_VERSION) {
        Write-Error "Resin requires Node.js v$MIN_NODE_VERSION or later. Detected: $($nodeVersionRaw.ToString().Trim())`nPlease upgrade Node.js."
        exit 1
    }
}

# Create secure temporary directory (fail-closed ACL / permission enforcement)
$tempDir = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "resin-install-$([System.Guid]::NewGuid().ToString('N'))")
$null = [System.IO.Directory]::CreateDirectory($tempDir)

if ($runningOnWindows) {
    try {
        $acl = Get-Acl -Path $tempDir
        $acl.SetAccessRuleProtection($true, $false)
        $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        if ($null -eq $currentUser) {
            throw "Unable to determine current user SID for ACL enforcement."
        }
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $currentUser,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        $acl.AddAccessRule($rule)
        Set-Acl -Path $tempDir -AclObject $acl
    } catch {
        Write-Error "Security Error: Failed to enforce owner-only ACLs on temporary directory '$tempDir': $_"
        exit 1
    }
} else {
    try {
        $chmodCmd = Get-Command chmod -ErrorAction SilentlyContinue
        if ($chmodCmd) {
            & chmod 0700 $tempDir
        }
    } catch {
        Write-Error "Security Error: Failed to set owner-only permissions on temporary directory '$tempDir': $_"
        exit 1
    }
}

$tempHelperFile = [System.IO.Path]::Combine($tempDir, "install-helper-v1.mjs")
[System.IO.File]::WriteAllBytes($tempHelperFile, $helperBytes)

$wslStagingDir = $null
try {
    if ($runningOnWindows) {
        # Step 1: Create owner-only 0700 staging directory inside WSL native Linux filesystem
        $wslStagingDir = (& wsl.exe --exec sh -c 'd=$(mktemp -d /tmp/resin-install.XXXXXX) && chmod 0700 "$d" && printf "%s" "$d"').ToString().Trim()
        $wslExit = $LASTEXITCODE
        if ($wslExit -ne 0 -or [string]::IsNullOrWhiteSpace($wslStagingDir)) {
            Write-Error "Security Error: Failed to create owner-only staging directory inside WSL (exit code $wslExit)."
            exit 1
        }

        # Step 2: Convert Windows path to WSL path
        $wslSrcPath = (& wsl.exe --exec wslpath -u $tempHelperFile).ToString().Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($wslSrcPath)) {
            Write-Error "Security Error: Failed to resolve WSL path for '$tempHelperFile'."
            exit 1
        }

        # Step 3: Copy verified helper into the WSL 0700 staging directory and protect permissions
        $wslDestHelper = "$wslStagingDir/install-helper-v1.mjs"
        & wsl.exe --exec cp $wslSrcPath $wslDestHelper
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Security Error: Failed to copy verified helper into WSL staging directory."
            exit 1
        }
        & wsl.exe --exec chmod 0600 $wslDestHelper

        # Step 4: Build argument list for WSL node execution
        $wslArgs = [System.Collections.Generic.List[string]]::new()
        $wslArgs.Add('node')
        $wslArgs.Add($wslDestHelper)

        if (-not [string]::IsNullOrWhiteSpace($Channel)) {
            $wslArgs.Add('--channel')
            $wslArgs.Add($Channel)
        }
        if (-not [string]::IsNullOrWhiteSpace($ChannelUrl)) {
            $wslArgs.Add('--channel-url')
            $wslArgs.Add($ChannelUrl)
        }
        if (-not [string]::IsNullOrWhiteSpace($ResinHome)) {
            $wslArgs.Add('--resin-home')
            $wslArgs.Add($ResinHome)
        }
        if ($isTestMode) {
            $wslArgs.Add('--allow-insecure-loopback')
        }

        Write-Host "Running Resin installer helper inside WSL2..."
        $helperOutput = & wsl.exe --exec @wslArgs
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            exit $exitCode
        }

        # Step 5: Validate success JSON output
        $stdoutStr = if ($helperOutput -is [array]) { ($helperOutput -join "`n").Trim() } else { "$helperOutput".Trim() }
        if ([string]::IsNullOrWhiteSpace($stdoutStr)) {
            Write-Error "Installer helper exited with code 0 but emitted no output. Expected success JSON payload."
            exit 1
        }

        try {
            $parsedJson = $stdoutStr | ConvertFrom-Json
        } catch {
            Write-Error "Installer helper output is not valid JSON: $_`nRaw output:`n$stdoutStr"
            exit 1
        }

        if ($null -eq $parsedJson -or $parsedJson.success -ne $true -or [string]::IsNullOrWhiteSpace($parsedJson.version)) {
            Write-Error "Installer helper did not report successful installation. Payload: $stdoutStr"
            exit 1
        }
    } else {
        $nodeArgs = [System.Collections.Generic.List[string]]::new()
        $nodeArgs.Add($tempHelperFile)

        if (-not [string]::IsNullOrWhiteSpace($Channel)) {
            $nodeArgs.Add('--channel')
            $nodeArgs.Add($Channel)
        }
        if (-not [string]::IsNullOrWhiteSpace($ChannelUrl)) {
            $nodeArgs.Add('--channel-url')
            $nodeArgs.Add($ChannelUrl)
        }
        if (-not [string]::IsNullOrWhiteSpace($ResinHome)) {
            $nodeArgs.Add('--resin-home')
            $nodeArgs.Add($ResinHome)
        }
        if ($isTestMode) {
            $nodeArgs.Add('--allow-insecure-loopback')
        }

        Write-Host "Running Resin installer helper..."
        $helperOutput = & node @nodeArgs
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            exit $exitCode
        }

        # Validate success JSON output
        $stdoutStr = if ($helperOutput -is [array]) { ($helperOutput -join "`n").Trim() } else { "$helperOutput".Trim() }
        if ([string]::IsNullOrWhiteSpace($stdoutStr)) {
            Write-Error "Installer helper exited with code 0 but emitted no output. Expected success JSON payload."
            exit 1
        }

        try {
            $parsedJson = $stdoutStr | ConvertFrom-Json
        } catch {
            Write-Error "Installer helper output is not valid JSON: $_`nRaw output:`n$stdoutStr"
            exit 1
        }

        if ($null -eq $parsedJson -or $parsedJson.success -ne $true -or [string]::IsNullOrWhiteSpace($parsedJson.version)) {
            Write-Error "Installer helper did not report successful installation. Payload: $stdoutStr"
            exit 1
        }
    }
}
finally {
    # Ensure complete cleanup of WSL staging directory on all exits
    if ($runningOnWindows -and -not [string]::IsNullOrWhiteSpace($wslStagingDir)) {
        try {
            & wsl.exe --exec rm -rf $wslStagingDir 2>$null
        } catch {}
    }

    # Ensure complete cleanup of temporary directory on all exits
    if (Test-Path -Path $tempDir) {
        Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
