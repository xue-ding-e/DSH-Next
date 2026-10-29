# Verify every client bundle is a loadable classic script.
#
# A client bundle is loaded as a plain <script>, not a module, so a stray `export`
# crashes the shell to a white screen with only a console message the user never
# sees. Two more silent traps:
#
#   * calling `require(...)` without accepting the loader's `require` parameter
#     throws "require is not defined" the moment the bundle's factory runs;
#   * Accepting `require` but bundling a second copy of React splits the context
#     so hooks attach to the wrong dispatcher.
#
# This checks the invariants that are cheap to verify and expensive to debug.
#
# Exit 0 = all bundles sound; 1 = a bundle would fail at load time.
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$plugins = @('dsh-browser-control', 'dsh-nav-buttons', 'dsh-input-guard')
$failures = @()

foreach ($plugin in $plugins) {
    $file = Join-Path $root "$plugin\lib\client.js"
    if (-not (Test-Path -LiteralPath $file)) { $failures += "missing bundle: $plugin"; continue }

    $source = Get-Content -LiteralPath $file -Raw -Encoding UTF8

    # 1. Classic-script form.
    if (-not $source.TrimStart().StartsWith('window.__ModuleLoader__.load({')) {
        $failures += "$plugin : does not start with window.__ModuleLoader__.load({"
    }
    # 2. No ESM syntax anywhere. Comments may mention the words, so only flag a
    #    line that actually begins with the keyword.
    $esm = [regex]::Matches($source, '(?m)^\s*(import|export)\s')
    if ($esm.Count -gt 0) { $failures += "$plugin : contains ESM syntax ($($esm.Count) lines)" }

    # 3. require() and its parameter must agree.
    $calls = [regex]::IsMatch($source, '\brequire\(')
    $declares = [regex]::IsMatch($source, 'factory\s*\(\s*require\s*\)')
    if ($calls -and -not $declares) {
        $failures += "$plugin : calls require() but the factory does not accept it"
    }
    if ($declares -and -not $calls) {
        # Harmless, but it signals a copy-paste that was never finished.
        Write-Host "  note: $plugin accepts require but never uses it" -ForegroundColor DarkGray
    }

    # 4. Syntax.
    $syntax = & node --check $file 2>&1
    if ($LASTEXITCODE -ne 0) { $failures += "$plugin : node --check failed`n$syntax" }

    if ($failures.Count -eq 0) {
        Write-Host "  ok  $plugin" -ForegroundColor Green
    }
}

# The host halves are ordinary ESM modules; check them too.
foreach ($plugin in $plugins) {
    $file = Join-Path $root "$plugin\lib\index.js"
    if (-not (Test-Path -LiteralPath $file)) { $failures += "missing host half: $plugin"; continue }
    $null = & node --check $file 2>&1
    if ($LASTEXITCODE -ne 0) { $failures += "$plugin host half : node --check failed" }
}

if ($failures.Count -eq 0) {
    Write-Host ''
    Write-Host "all $($plugins.Count) bundles are loadable classic scripts" -ForegroundColor Green
    exit 0
}
Write-Host ''
$failures | ForEach-Object { Write-Host "  FAIL $_" -ForegroundColor Red }
exit 1
