param([string]$UpstreamPython = '', [switch]$SkipUpstreamBuild)
$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$upstream = Join-Path $project '..\sapgui.mcp'
$assetDir = Join-Path $project 'internal\runtime'
$asset = Join-Path $assetDir 'sapgui_mcp_windows.exe'
if (-not $SkipUpstreamBuild) {
    if (Test-Path -LiteralPath (Join-Path $upstream '.env.production')) {
        throw 'Remove upstream .env.production before building the public connector; the upstream spec would bundle its remote logging defaults'
    }
    if (-not $UpstreamPython) {
        $UpstreamPython = Join-Path $upstream '.venv\Scripts\python.exe'
        if (-not (Test-Path -LiteralPath $UpstreamPython)) {
            uv sync --project $upstream --group build_executable
            if ($LASTEXITCODE -ne 0) { throw 'Could not prepare upstream Python build environment' }
        }
    }
    $UpstreamPython = (Resolve-Path -LiteralPath $UpstreamPython).Path
    $env:SAPGUI_BUILD_NAME = 'sapgui_mcp_windows'
    Push-Location $upstream
    try {
        & $UpstreamPython -m PyInstaller --noconfirm --clean --distpath $assetDir --workpath (Join-Path $project '.build-sapgui') sapgui_mcp_windows.spec
        if ($LASTEXITCODE -ne 0) { throw 'Upstream sapgui.mcp build failed' }
    } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath $asset)) { throw 'Upstream executable missing; run without -SkipUpstreamBuild' }
Set-Location -LiteralPath $project
$env:GOCACHE = Join-Path $project '.gocache'
New-Item -ItemType Directory -Path (Join-Path $project 'dist') -Force | Out-Null
go build -trimpath -ldflags='-s -w' -o dist\edge-gui.exe .\cmd\edge-gui
if ($LASTEXITCODE -ne 0) { throw 'Go connector build failed' }
Copy-Item -LiteralPath (Join-Path $upstream 'LICENSE') -Destination (Join-Path $project 'dist\sapgui.mcp-LICENSE.txt') -Force
