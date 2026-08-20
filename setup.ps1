# kimi-base setup entry (PowerShell 5.1 compatible, 100% ASCII by design).
# Usage: powershell -File setup.ps1 <target-project-dir> [--dry-run]
# Wraps: node runtime/kimi-base.mjs install <target>, then prints the plugin hint.
# NOTE: keep this file ASCII-only; non-ASCII bytes break PowerShell 5.1 parsing.

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($args.Count -lt 1) {
    Write-Host "Usage: powershell -File setup.ps1 <target-project-dir> [--dry-run]"
    exit 1
}

$Target = $args[0]
$Rest = @()
if ($args.Count -gt 1) { $Rest = $args[1..($args.Count - 1)] }

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
    Write-Host "ERROR: node not found (Node >= 18 is required)"
    exit 1
}

& node "$ScriptDir\runtime\kimi-base.mjs" install $Target @Rest
$Code = $LASTEXITCODE

if ($Code -eq 0) {
    Write-Host ""
    Write-Host "Project files installed. One more step: install the Kimi Code plugin (provides global hooks):"
    Write-Host "  /plugins install $ScriptDir"
    Write-Host "Without the plugin, hook gates (dangerous command blocker, pre-write guard, stop gate)"
    Write-Host "are NOT mounted; governance is advisory via manual CLI calls only."
}

exit $Code
