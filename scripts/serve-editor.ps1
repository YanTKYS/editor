# Local static HTTP server for the Web Text Editor release ZIP.
# Windows PowerShell 5.1 and PowerShell 7 compatible.
# Place next to index.html. No Node.js, Python, or IIS required.
param(
    [string]$Folder = $PSScriptRoot,
    [ValidateRange(1, 65535)]
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Folder).ProviderPath)
$rootPrefix = $root.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar

if (-not (Test-Path -LiteralPath (Join-Path $root 'index.html') -PathType Leaf)) {
    throw "index.html was not found in: $root"
}

$mimeTypes = @{
    '.html'  = 'text/html; charset=utf-8'
    '.js'    = 'text/javascript; charset=utf-8'
    '.mjs'   = 'text/javascript; charset=utf-8'
    '.css'   = 'text/css; charset=utf-8'
    '.json'  = 'application/json; charset=utf-8'
    '.svg'   = 'image/svg+xml'
    '.png'   = 'image/png'
    '.jpg'   = 'image/jpeg'
    '.jpeg'  = 'image/jpeg'
    '.webp'  = 'image/webp'
    '.gif'   = 'image/gif'
    '.ico'   = 'image/x-icon'
    '.txt'   = 'text/plain; charset=utf-8'
    '.woff'  = 'font/woff'
    '.woff2' = 'font/woff2'
    '.wasm'  = 'application/wasm'
}

$server = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$server.Start()
Write-Host "Serving: http://localhost:$Port/" -ForegroundColor Green
Write-Host "Folder:  $root"
Write-Host 'Press Ctrl+C to stop.'

try {
    while ($true) {
        $client = $server.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $stream.ReadTimeout = 10000
            $reader = [System.IO.StreamReader]::new(
                $stream, [System.Text.Encoding]::ASCII, $false, 1024, $true
            )
            $requestLine = $reader.ReadLine()
            if ([string]::IsNullOrWhiteSpace($requestLine)) { continue }

            # Consume HTTP request headers.
            while ($true) {
                $headerLine = $reader.ReadLine()
                if ($null -eq $headerLine -or $headerLine.Length -eq 0) { break }
            }

            $parts = $requestLine.Split(' ')
            $method = $parts[0]
            $uriPath = if ($parts.Length -gt 1) { ($parts[1] -split '\?', 2)[0] } else { '/' }
            $relative = [System.Uri]::UnescapeDataString($uriPath).TrimStart('/')
            if (-not $relative) { $relative = 'index.html' }

            $filePath = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
            $withinRoot = $filePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)

            if (-not $withinRoot) {
                $status = '403 Forbidden'
                $data = [System.Text.Encoding]::UTF8.GetBytes('Forbidden')
                $mime = 'text/plain; charset=utf-8'
            } elseif ($method -notin @('GET', 'HEAD')) {
                $status = '405 Method Not Allowed'
                $data = [System.Text.Encoding]::UTF8.GetBytes('Method Not Allowed')
                $mime = 'text/plain; charset=utf-8'
            } elseif (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
                $status = '404 Not Found'
                $data = [System.Text.Encoding]::UTF8.GetBytes('Not Found')
                $mime = 'text/plain; charset=utf-8'
            } else {
                $status = '200 OK'
                $data = [System.IO.File]::ReadAllBytes($filePath)
                $extension = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
                $mime = if ($mimeTypes.ContainsKey($extension)) {
                    $mimeTypes[$extension]
                } else {
                    'application/octet-stream'
                }
            }

            $headers = "HTTP/1.1 $status`r`nContent-Type: $mime`r`nContent-Length: $($data.Length)`r`nConnection: close`r`nCache-Control: no-store`r`n`r`n"
            $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            if ($method -ne 'HEAD') { $stream.Write($data, 0, $data.Length) }
            $stream.Flush()
        } catch {
            Write-Warning "HTTP request error: $_"
        } finally {
            $client.Close()
        }
    }
} finally {
    $server.Stop()
}
