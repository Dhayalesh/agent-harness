$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:GOCACHE = Join-Path $PSScriptRoot '.gocache'
New-Item -ItemType Directory -Path '.\dist' -Force | Out-Null
go build -trimpath -ldflags='-s -w' -o .\dist\gui-edge-server.exe .\cmd\gui-edge-server
if ($LASTEXITCODE -ne 0) { throw 'Go GUI Edge Server build failed' }
