<# Fixed operations let native PowerShell launch .cmd files without constructing shell command text. #>
param([Parameter(Mandatory)][ValidateSet('dependencies','cli')][string]$Mode, [string]$Launcher)
$ErrorActionPreference = 'Stop'
if ($Mode -eq 'dependencies') { pnpm install --frozen-lockfile; exit $LASTEXITCODE }
if (-not [IO.Path]::IsPathFullyQualified($Launcher) -or [IO.Path]::GetFileName($Launcher) -ne 'dsh-next.cmd') { throw 'Expected the actual owned Next command.' }
& $Launcher --version
exit $LASTEXITCODE
