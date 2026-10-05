# Resin Standalone Bootstrap Installer for Windows / PowerShell
# Cryptographically verified, standalone bootstrap installer.
# Helper URL: https://dist.resin.sh/releases/v1/installers/install-helper-v1.mjs
# Helper SHA-256: 0e49e3daeaa6acb81fb7f6df5b60d90908808f206307c4ee60c5ff983fbe409f
#
# Native Windows (Windows PowerShell 5.1 or PowerShell 7+, Node.js >= 22):
#   irm https://resin.sh/install.ps1 | iex
# With options (e.g. the legacy WSL2 install):
#   & ([scriptblock]::Create((irm https://resin.sh/install.ps1))) -UseWsl

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

    [Parameter()]
    [switch]$UseWsl,

    [Parameter()]
    [switch]$NoPathUpdate,

    [Parameter()]
    [switch]$NoOnboarding,

    [Parameter()]
    [switch]$NonInteractive,

    [Parameter()]
    [switch]$LocalOnly,

    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = 'Stop'

# Pinned security constants
$PINNED_HELPER_URL = "https://dist.resin.sh/releases/v1/installers/install-helper-v1.mjs"
$PINNED_HELPER_SHA256 = "0e49e3daeaa6acb81fb7f6df5b60d90908808f206307c4ee60c5ff983fbe409f"
$MIN_NODE_VERSION = 22

# Install telemetry: best-effort install_started / install_completed / install_failed events
# (step, OS, architecture, exit code, a fixed reason code; no paths, arguments or output).
# Disabled by DO_NOT_TRACK, RESIN_ERROR_REPORTING=0, RESIN_TELEMETRY_ENABLED=0, a device config
# with errorReportingEnabled/telemetryEnabled false, or test mode. Each send has a 3 s cap and
# can never fail the install.
# The key must equal RESIN_POSTHOG_PROJECT_API_KEY in
# apps/observer/src/error-reporting/facade.ts (the single source of truth; a unit test checks).
$RESIN_POSTHOG_PROJECT_API_KEY = "phc_xkn83r4yVHBSfLrdrQVgB856j2DS4BUJNi6Ds6fDA9uW"
$script:ResinInstallStep = 'arguments'
$script:ResinAnalyticsId = $null

function Get-ResinTelemetryKey {
    if (-not [string]::IsNullOrWhiteSpace($env:RESIN_POSTHOG_KEY)) { return $env:RESIN_POSTHOG_KEY.Trim() }
    return $RESIN_POSTHOG_PROJECT_API_KEY
}

function Get-ResinHomeDirectory {
    if (-not [string]::IsNullOrWhiteSpace($ResinHome)) { return $ResinHome }
    if (-not [string]::IsNullOrWhiteSpace($env:RESIN_HOME)) { return $env:RESIN_HOME }
    return [System.IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), '.resin')
}

function Test-ResinTelemetryEnabled {
    try {
        if ((Get-ResinTelemetryKey) -notmatch '^phc_[A-Za-z0-9_-]{16,}$') { return $false }
        $dnt = "$env:DO_NOT_TRACK".Trim().ToLowerInvariant()
        if ($dnt -ne '' -and $dnt -ne '0' -and $dnt -ne 'false') { return $false }
        $reporting = "$env:RESIN_ERROR_REPORTING".Trim().ToLowerInvariant()
        if (@('0', 'false', 'off', 'no', 'disabled') -contains $reporting) { return $false }
        if ($null -ne $env:RESIN_TELEMETRY_ENABLED -and $env:RESIN_TELEMETRY_ENABLED -ne '1' -and $env:RESIN_TELEMETRY_ENABLED -ne 'true') { return $false }
        if ($env:RESIN_INSTALL_TEST_ONLY -eq '1' -and $reporting -ne '1') { return $false }
        $configFile = [System.IO.Path]::Combine((Get-ResinHomeDirectory), 'config', 'config.json')
        if (Test-Path -LiteralPath $configFile) {
            $config = [System.IO.File]::ReadAllText($configFile)
            if ($config -match '"(errorReportingEnabled|telemetryEnabled)"\s*:\s*false') { return $false }
        }
        return $true
    } catch {
        return $false
    }
}

# Reuses <RESIN_HOME>\state\analytics-id, else mints anon_<uuid>; the helper persists it so later
# CLI events join the install.
function Get-ResinAnalyticsId {
    try {
        $idFile = [System.IO.Path]::Combine((Get-ResinHomeDirectory), 'state', 'analytics-id')
        if (Test-Path -LiteralPath $idFile) {
            $existing = ([System.IO.File]::ReadAllText($idFile)).Trim()
            if ($existing -match '^anon_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { return $existing }
        }
    } catch {}
    return "anon_$([System.Guid]::NewGuid().ToString('D').ToLowerInvariant())"
}

# Send-ResinInstallEvent: all values are fixed tokens; failures are ignored.
function Send-ResinInstallEvent {
    param(
        [Parameter(Mandatory=$true)][string]$EventName,
        [Parameter(Mandatory=$true)][string]$Step,
        [int]$ExitCode = 0,
        [string]$Reason = 'none'
    )
    if ($null -eq $script:ResinAnalyticsId) { return }
    try {
        $arch = "$env:PROCESSOR_ARCHITEW6432"
        if ([string]::IsNullOrWhiteSpace($arch)) { $arch = "$env:PROCESSOR_ARCHITECTURE" }
        $hostUrl = 'https://resin.sh/ingest'
        if ("$env:RESIN_POSTHOG_HOST" -match '^https://') { $hostUrl = $env:RESIN_POSTHOG_HOST.TrimEnd('/') }
        $body = @{
            api_key = (Get-ResinTelemetryKey)
            event = $EventName
            distinct_id = $script:ResinAnalyticsId
            properties = @{
                resin_surface = 'installer'
                installer = 'install.ps1'
                environment = 'production'
                step = $Step
                exit_code = $ExitCode
                reason = $Reason
                os = 'win32'
                arch = ($arch.ToLowerInvariant() -replace '[^a-z0-9_]', '')
                powershell_version = "$($PSVersionTable.PSVersion.Major)"
                '$geoip_disable' = $true
                '$lib' = 'resin-install-ps1'
            }
        } | ConvertTo-Json -Depth 4 -Compress
        $previousProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        try {
            $null = Invoke-WebRequest -Uri "$hostUrl/i/v0/e/" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        } finally {
            $ProgressPreference = $previousProgress
        }
    } catch {}
}

function Show-ResinHelp {
    Write-Host @"
Resin Standalone Installer Bootstrap (PowerShell)

Installs the Resin CLI and its background service for the current user.
On Windows, Resin installs natively (no WSL2 needed) and requires Node.js >= 22
(https://nodejs.org or: winget install OpenJS.NodeJS.LTS). Windows x64 and arm64.
Runs under Windows PowerShell 5.1 and PowerShell 7+. Use -UseWsl for the WSL2 install.
On Linux/macOS pwsh, installation runs locally with Node.js >= 22.

Usage:
  irm https://resin.sh/install.ps1 | iex
  & ([scriptblock]::Create((irm https://resin.sh/install.ps1))) [options]
  install.ps1 [options]

Options:
  -Channel <name>              Release channel (e.g. stable, default: stable)
  -ChannelUrl <url>            Override channel manifest URL (testing/enterprise)
  -ResinHome <path>            Destination directory (default: %USERPROFILE%\.resin or RESIN_HOME)
  -NoPathUpdate                Do not add <ResinHome>\bin to the user PATH
  -NoOnboarding                Install only; skip 'resin init' (device authorization, harness setup)
  -NonInteractive              Disable interactive prompts and onboarding
  -LocalOnly                   Skip cloud pairing and configure local-only MCP
  -UseWsl                      Install into the default WSL2 distribution instead (legacy)
  -DownloadOnly <path>         Download and verify helper script without executing
  -Help, -h, --help            Show this help text and exit
  -Force                       Bypass non-security warnings

Environment:
  RESIN_HOME                   Resin home directory (same as -ResinHome)
  RESIN_INSTALL_USE_WSL=1      Same as -UseWsl (for irm | iex)
  RESIN_NO_PATH_UPDATE=1       Same as -NoPathUpdate (for irm | iex)

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
        elseif ($arg -eq '--use-wsl') {
            $UseWsl = $true
        }
        elseif ($arg -eq '--no-path-update' -or $arg -eq '--skip-path-setup') {
            $NoPathUpdate = $true
        }
        elseif ($arg -eq '--no-onboarding' -or $arg -eq '--skip-onboarding') {
            $NoOnboarding = $true
        }
        elseif ($arg -eq '--non-interactive') {
            $NonInteractive = $true
        }
        elseif ($arg -eq '--local-only') {
            $LocalOnly = $true
        }
    }
}

if ($env:RESIN_INSTALL_USE_WSL -eq '1') { $UseWsl = $true }
if ($env:RESIN_NO_PATH_UPDATE -eq '1') { $NoPathUpdate = $true }

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

# Node.js major version, or $null when 'node' is missing or unusable.
function Get-ResinNodeVersion {
    $nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
    if (-not $nodeCmd) { return $null }
    try {
        $raw = (& node -v 2>$null | Out-String).Trim()
    } catch {
        return $null
    }
    $match = [regex]::Match($raw, 'v?(\d+)\.(\d+)\.(\d+)')
    if (-not $match.Success) { return $null }
    return [pscustomobject]@{ Major = [int]$match.Groups[1].Value; Raw = $raw }
}

# Windows processor architecture (x64 / arm64), independent of an emulated PowerShell process.
function Get-ResinWindowsArchitecture {
    $machine = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($machine)) { $machine = $env:PROCESSOR_ARCHITECTURE }
    switch -Regex ($machine) {
        '^(AMD64|x64)$' { return 'x64' }
        '^ARM64$' { return 'arm64' }
        default { return $null }
    }
}

# Runs the verified helper and returns its parsed success JSON (throws on any failure).
function Invoke-ResinHelper {
    param(
        [Parameter(Mandatory=$true)][string]$Command,
        [Parameter(Mandatory=$true)][string[]]$Arguments
    )
    # The helper reports progress on stderr. Windows PowerShell 5.1 turns redirected native stderr
    # into error records, which the script-wide 'Stop' preference would make terminating, so the
    # call runs under 'Continue': stderr lines are shown as host output (so `*>` logs keep them)
    # and only stdout (the success JSON) is captured. The exit code decides success.
    $script:ResinInstallStep = 'helper'
    $helperOutput = & {
        $ErrorActionPreference = 'Continue'
        & $Command @Arguments 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                # The wrapped exception's message is the exact stderr line (empty for a blank line);
                # ToString() on an empty record would print the exception type name instead.
                Write-Host $_.Exception.Message
            } else {
                $_
            }
        }
    }
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "Installer helper failed with exit code $exitCode."
    }

    $script:ResinInstallStep = 'helper_result'
    $stdoutStr = if ($helperOutput -is [array]) { ($helperOutput -join "`n").Trim() } else { "$helperOutput".Trim() }
    if ([string]::IsNullOrWhiteSpace($stdoutStr)) {
        Write-Error "Installer helper exited with code 0 but emitted no output. Expected success JSON payload."
    }

    try {
        $parsedJson = $stdoutStr | ConvertFrom-Json
    } catch {
        Write-Error "Installer helper output is not valid JSON: $_`nRaw output:`n$stdoutStr"
    }

    if ($null -eq $parsedJson -or $parsedJson.success -ne $true -or [string]::IsNullOrWhiteSpace($parsedJson.version)) {
        Write-Error "Installer helper did not report successful installation. Payload: $stdoutStr"
    }
    return $parsedJson
}

function Invoke-ResinInstall {
    # Check operating system platform
    $runningOnWindows = $false
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        $runningOnWindows = $IsWindows
    } else {
        $runningOnWindows = ($env:OS -eq 'Windows_NT') -or ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)
    }
    $useWslInstall = $runningOnWindows -and $UseWsl

    # Check test mode
    $isTestMode = ($env:RESIN_INSTALL_TEST_ONLY -eq '1')

    # Expected helper digest: the pin, or (test mode only) an explicit override
    $expectedHelperSha256 = $PINNED_HELPER_SHA256
    if ($isTestMode -and -not [string]::IsNullOrWhiteSpace($env:RESIN_TEST_HELPER_SHA256)) {
        $expectedHelperSha256 = $env:RESIN_TEST_HELPER_SHA256.Trim().ToLowerInvariant()
    }

    # Determine helper URL
    $helperUrl = $PINNED_HELPER_URL
    if ($isTestMode -and -not [string]::IsNullOrWhiteSpace($env:RESIN_INSTALL_HELPER_URL)) {
        $helperUrl = $env:RESIN_INSTALL_HELPER_URL
    }
    $localHelperPath = $null
    if ($isTestMode -and -not [string]::IsNullOrWhiteSpace($env:RESIN_INSTALL_HELPER_PATH)) {
        $localHelperPath = [System.IO.Path]::GetFullPath($env:RESIN_INSTALL_HELPER_PATH)
    }

    $helperUri = [System.Uri]::new($helperUrl)
    $script:ResinInstallStep = 'helper_download'

    # Scheme verification
    if (-not $isTestMode -and $helperUri.Scheme -ne 'https') {
        Write-Error "Security Error: Helper URL must use HTTPS. Insecure scheme '$($helperUri.Scheme)' is rejected."
    }

    if ($null -ne $localHelperPath) {
        # Test/CI mode: a local helper file (e.g. the repository build) instead of the download
        Write-Host "Using local installer helper $localHelperPath (test mode)..."
        $helperBytes = [System.IO.File]::ReadAllBytes($localHelperPath)
    } else {
        # Resolve DNS and validate host IPs
        Write-Host "Resolving helper endpoint $($helperUri.Host)..."
        $hostAddresses = [System.Net.Dns]::GetHostAddresses($helperUri.Host)
        if ($null -eq $hostAddresses -or $hostAddresses.Length -eq 0) {
            Write-Error "DNS resolution failed: no IP addresses found for $($helperUri.Host)"
        }

        $validAddresses = [System.Collections.Generic.List[System.Net.IPAddress]]::new()
        foreach ($addr in $hostAddresses) {
            $isRestricted = Test-IsRestrictedIPAddress -IP $addr
            if ($isRestricted) {
                if ($isTestMode) {
                    $validAddresses.Add($addr)
                } else {
                    Write-Error "Security Error: Host $($helperUri.Host) resolved to forbidden IP address $($addr.ToString()). Helper acquisition aborted."
                }
            } else {
                $validAddresses.Add($addr)
            }
        }

        if ($validAddresses.Count -eq 0) {
            Write-Error "Security Error: No valid public IP addresses found for $($helperUri.Host)."
        }

        $chosenIP = $validAddresses[0]

        # Download helper payload
        Write-Host "Downloading verified installer helper from $helperUrl..."
        try {
            $helperBytes = Download-HelperBytes -Uri $helperUri -TargetIP $chosenIP -IsTest $isTestMode
        } catch {
            Write-Error "Failed to download installer helper: $_"
        }
    }

    # Compute and verify SHA-256
    $sha256Provider = [System.Security.Cryptography.SHA256]::Create()
    $computedHashBytes = $sha256Provider.ComputeHash($helperBytes)
    $computedHashHex = [System.BitConverter]::ToString($computedHashBytes).Replace('-', '').ToLowerInvariant()

    if ($computedHashHex -ne $expectedHelperSha256) {
        Write-Error "Security Error: Helper SHA-256 mismatch!`nExpected: $expectedHelperSha256`nActual:   $computedHashHex`nHelper acquisition aborted."
    }

    Write-Host "Helper integrity verified (SHA-256: $computedHashHex)."

    # Handle -DownloadOnly inspect flow
    if (-not [string]::IsNullOrWhiteSpace($DownloadOnly)) {
        $destPath = [System.IO.Path]::GetFullPath($DownloadOnly)
        $destDir = [System.IO.Path]::GetDirectoryName($destPath)
        if (-not [string]::IsNullOrWhiteSpace($destDir) -and -not (Test-Path -LiteralPath $destDir)) {
            $null = [System.IO.Directory]::CreateDirectory($destDir)
        }
        [System.IO.File]::WriteAllBytes($destPath, $helperBytes)
        Write-Host "Successfully downloaded and verified Resin install helper."
        Write-Host "  Location: $destPath"
        Write-Host "  SHA-256:  $computedHashHex"
        Write-Host ""
        Write-Host "To inspect the script before running:"
        Write-Host "  Get-Content `"$destPath`""
        Write-Host ""
        Write-Host "To execute the verified installer:"
        Write-Host "  node `"$destPath`""
        return
    }

    # Execution flow: Preflight checks
    $script:ResinInstallStep = 'preflight'
    if ($useWslInstall) {
        # Check WSL2 availability
        $wslCmd = Get-Command wsl.exe -ErrorAction SilentlyContinue
        if (-not $wslCmd) {
            Write-Error "Resin -UseWsl requires WSL2, but 'wsl.exe' was not found.`nPlease install WSL2 (wsl --install) and try again, or omit -UseWsl for the native Windows install."
        }

        # Verify WSL is responsive and running
        try {
            $wslStatus = & wsl.exe --status 2>&1
            $exitCode = $LASTEXITCODE
        } catch {
            Write-Error "Failed to execute wsl.exe: $_"
        }
        if ($exitCode -ne 0) {
            Write-Error "WSL is not properly configured. Please run 'wsl --install' or 'wsl --update'.`n$wslStatus"
        }

        # Check Node.js inside WSL
        $wslNodeCheck = & wsl.exe --exec node -v 2>&1
        $wslNodeExit = $LASTEXITCODE
        if ($wslNodeExit -ne 0) {
            Write-Error "Resin requires Node.js v$MIN_NODE_VERSION or later inside WSL, but 'node' was not found or failed to execute.`nPlease install Node.js >= $MIN_NODE_VERSION inside your default WSL distribution.`nDetails: $wslNodeCheck"
        }

        $wslNodeVersionMatch = [regex]::Match($wslNodeCheck.ToString(), 'v?(\d+)\.(\d+)\.(\d+)')
        if (-not $wslNodeVersionMatch.Success -or [int]$wslNodeVersionMatch.Groups[1].Value -lt $MIN_NODE_VERSION) {
            Write-Error "Resin requires Node.js v$MIN_NODE_VERSION or later inside WSL. Detected: $($wslNodeCheck.ToString().Trim())`nPlease upgrade Node.js inside WSL."
        }
    } else {
        if ($runningOnWindows) {
            $windowsArch = Get-ResinWindowsArchitecture
            if ($null -eq $windowsArch) {
                Write-Error "Resin supports Windows on x64 and arm64 only (detected processor architecture '$env:PROCESSOR_ARCHITECTURE')."
            }
        }
        # Local Node.js >= 22 (native Windows and non-Windows pwsh)
        $nodeVersion = Get-ResinNodeVersion
        if ($null -eq $nodeVersion) {
            if ($runningOnWindows) {
                Write-Error "Resin requires Node.js v$MIN_NODE_VERSION or later, but 'node' was not found in PATH.`nInstall Node.js $MIN_NODE_VERSION LTS or newer (https://nodejs.org/ or: winget install OpenJS.NodeJS.LTS), open a new terminal, and run this installer again."
            }
            Write-Error "Resin requires Node.js v$MIN_NODE_VERSION or later, but 'node' was not found in PATH.`nPlease install Node.js >= $MIN_NODE_VERSION and try again."
        }
        if ($nodeVersion.Major -lt $MIN_NODE_VERSION) {
            Write-Error "Resin requires Node.js v$MIN_NODE_VERSION or later. Detected: $($nodeVersion.Raw)`nPlease upgrade Node.js (https://nodejs.org/) and run this installer again."
        }
        if ($runningOnWindows) {
            $nodeArch = (& node -p "process.arch" 2>$null | Out-String).Trim()
            if ($nodeArch -ne 'x64' -and $nodeArch -ne 'arm64') {
                Write-Error "Resin needs a 64-bit Node.js (x64 or arm64) on Windows; detected '$nodeArch'."
            }
            if ($nodeArch -ne $windowsArch) {
                Write-Warning "Node.js is $nodeArch but Windows is $windowsArch; Resin installs the $nodeArch build to match Node.js."
            }
        }
    }

    # Create secure temporary directory (fail-closed ACL / permission enforcement)
    $script:ResinInstallStep = 'staging'
    $tempDir = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "resin-install-$([System.Guid]::NewGuid().ToString('N'))")
    $null = [System.IO.Directory]::CreateDirectory($tempDir)

    $wslStagingDir = $null
    try {
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
            }
        } else {
            try {
                $chmodCmd = Get-Command chmod -ErrorAction SilentlyContinue
                if ($chmodCmd) {
                    & chmod 0700 $tempDir
                }
            } catch {
                Write-Error "Security Error: Failed to set owner-only permissions on temporary directory '$tempDir': $_"
            }
        }

        $tempHelperFile = [System.IO.Path]::Combine($tempDir, "install-helper-v1.mjs")
        [System.IO.File]::WriteAllBytes($tempHelperFile, $helperBytes)

        # Options shared by the WSL and native helper runs
        $helperOptions = [System.Collections.Generic.List[string]]::new()
        if (-not [string]::IsNullOrWhiteSpace($Channel)) {
            $helperOptions.Add('--channel')
            $helperOptions.Add($Channel)
        }
        if (-not [string]::IsNullOrWhiteSpace($ChannelUrl)) {
            $helperOptions.Add('--channel-url')
            $helperOptions.Add($ChannelUrl)
        }
        if (-not [string]::IsNullOrWhiteSpace($ResinHome)) {
            $helperOptions.Add('--resin-home')
            $helperOptions.Add($ResinHome)
        }
        if ($NoPathUpdate) { $helperOptions.Add('--no-path-update') }
        if ($NoOnboarding) { $helperOptions.Add('--no-onboarding') }
        if ($NonInteractive) { $helperOptions.Add('--non-interactive') }
        if ($LocalOnly) { $helperOptions.Add('--local-only') }
        if ($isTestMode) {
            $helperOptions.Add('--allow-insecure-loopback')
        }

        if ($useWslInstall) {
            # Step 1: Create owner-only 0700 staging directory inside WSL native Linux filesystem
            $wslStagingDir = (& wsl.exe --exec sh -c 'd=$(mktemp -d /tmp/resin-install.XXXXXX) && chmod 0700 "$d" && printf "%s" "$d"').ToString().Trim()
            $wslExit = $LASTEXITCODE
            if ($wslExit -ne 0 -or [string]::IsNullOrWhiteSpace($wslStagingDir)) {
                Write-Error "Security Error: Failed to create owner-only staging directory inside WSL (exit code $wslExit)."
            }

            # Step 2: Convert Windows path to WSL path
            $wslSrcPath = (& wsl.exe --exec wslpath -u $tempHelperFile).ToString().Trim()
            if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($wslSrcPath)) {
                Write-Error "Security Error: Failed to resolve WSL path for '$tempHelperFile'."
            }

            # Step 3: Copy verified helper into the WSL 0700 staging directory and protect permissions
            $wslDestHelper = "$wslStagingDir/install-helper-v1.mjs"
            & wsl.exe --exec cp $wslSrcPath $wslDestHelper
            if ($LASTEXITCODE -ne 0) {
                Write-Error "Security Error: Failed to copy verified helper into WSL staging directory."
            }
            & wsl.exe --exec chmod 0600 $wslDestHelper

            # Step 4: Run the helper with WSL's node (Windows PATH changes do not apply to WSL)
            $wslArgs = [System.Collections.Generic.List[string]]::new()
            $wslArgs.Add('--exec')
            $wslArgs.Add('node')
            $wslArgs.Add($wslDestHelper)
            foreach ($option in $helperOptions) { $wslArgs.Add($option) }

            Write-Host "Running Resin installer helper inside WSL2..."
            $parsedJson = Invoke-ResinHelper -Command 'wsl.exe' -Arguments $wslArgs.ToArray()
            Write-Host "Resin v$($parsedJson.version) installed inside WSL2."
            return
        }

        $nodeArgs = [System.Collections.Generic.List[string]]::new()
        $nodeArgs.Add($tempHelperFile)
        foreach ($option in $helperOptions) { $nodeArgs.Add($option) }
        if ($isTestMode -and -not [string]::IsNullOrWhiteSpace($env:RESIN_INSTALL_TRUSTED_KEYS_JSON)) {
            # Test/CI only: trust the test-domain key that signed a locally packaged release
            $nodeArgs.Add('--trusted-keys-file')
            $nodeArgs.Add([System.IO.Path]::GetFullPath($env:RESIN_INSTALL_TRUSTED_KEYS_JSON))
        }

        Write-Host "Running Resin installer helper..."
        $parsedJson = Invoke-ResinHelper -Command 'node' -Arguments $nodeArgs.ToArray()

        if ($runningOnWindows) {
            $binDir = [System.IO.Path]::Combine([string]$parsedJson.resinHome, 'bin')
            if (-not $NoPathUpdate) {
                # The helper updated the user PATH for new terminals; make 'resin' work here too.
                $sessionEntries = @($env:Path -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') })
                if ($sessionEntries -notcontains $binDir.TrimEnd('\')) {
                    $env:Path = "$env:Path;$binDir"
                }
                Write-Host "Resin v$($parsedJson.version) installed. Run 'resin' to get started (new terminals find it on PATH)."
            } else {
                Write-Host "Resin v$($parsedJson.version) installed. PATH was not changed; run '$binDir\resin.cmd'."
            }
        }
    }
    finally {
        # Ensure complete cleanup of WSL staging directory on all exits
        if ($useWslInstall -and -not [string]::IsNullOrWhiteSpace($wslStagingDir)) {
            try {
                & wsl.exe --exec rm -rf $wslStagingDir 2>$null
            } catch {}
        }

        # Ensure complete cleanup of temporary directory on all exits
        if (Test-Path -Path $tempDir) {
            Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

if ($Help) {
    Show-ResinHelp
    return
}

# Errors end this script without closing the caller's window when run through 'irm | iex';
# a script file run (powershell -File install.ps1) exits with a non-zero code instead.
$resinInstallRunAsFile = -not [string]::IsNullOrEmpty($PSCommandPath)
$resinTelemetryEnv = @{
    RESIN_INSTALL_ANALYTICS_ID = $env:RESIN_INSTALL_ANALYTICS_ID
    RESIN_INSTALL_TELEMETRY_OWNER = $env:RESIN_INSTALL_TELEMETRY_OWNER
    WSLENV = $env:WSLENV
}
if ([string]::IsNullOrWhiteSpace($DownloadOnly) -and (Test-ResinTelemetryEnabled)) {
    $script:ResinAnalyticsId = Get-ResinAnalyticsId
    # The helper persists this id and leaves start/completion events to this script. WSLENV carries
    # these (and the opt-outs) into a -UseWsl helper run.
    $env:RESIN_INSTALL_ANALYTICS_ID = $script:ResinAnalyticsId
    $env:RESIN_INSTALL_TELEMETRY_OWNER = 'bootstrap'
    $env:WSLENV = (@('RESIN_INSTALL_ANALYTICS_ID/u', 'RESIN_INSTALL_TELEMETRY_OWNER/u', 'DO_NOT_TRACK/u', 'RESIN_ERROR_REPORTING/u', $env:WSLENV) | Where-Object { -not [string]::IsNullOrEmpty($_) }) -join ':'
    Send-ResinInstallEvent -EventName 'install_started' -Step 'bootstrap'
}
try {
    Invoke-ResinInstall
    if ($null -ne $script:ResinAnalyticsId) {
        Send-ResinInstallEvent -EventName 'install_completed' -Step 'complete'
    }
} catch {
    if ($null -ne $script:ResinAnalyticsId -and $script:ResinInstallStep -ne 'helper') {
        # The helper reports its own failures with a precise reason.
        Send-ResinInstallEvent -EventName 'install_failed' -Step $script:ResinInstallStep -ExitCode 1 -Reason "$($script:ResinInstallStep)_failed"
    }
    if ($resinInstallRunAsFile) {
        [Console]::Error.WriteLine("Resin installation failed: $($_.Exception.Message)")
        exit 1
    }
    throw
} finally {
    # 'irm | iex' runs in the caller's session: leave its environment as it was.
    foreach ($name in $resinTelemetryEnv.Keys) {
        if ($null -eq $resinTelemetryEnv[$name]) {
            Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
        } else {
            Set-Item -Path "Env:$name" -Value $resinTelemetryEnv[$name]
        }
    }
}
