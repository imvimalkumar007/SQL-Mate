# SQL Mate update script
# Rebuilds the app from source and reinstalls it in four steps.
# Run via update.bat (double-click) or directly in PowerShell.

$ErrorActionPreference = "Stop"
$projectRoot = $PSScriptRoot

function Write-Step($n, $total, $msg) {
    Write-Host ""
    Write-Host "[$n/$total] $msg" -ForegroundColor Cyan
}

function Abort($msg) {
    Write-Host ""
    Write-Host "FAILED: $msg" -ForegroundColor Red
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  SQL Mate — rebuild + reinstall" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan

# ── Step 1: build environment ──────────────────────────────────────────────
Write-Step 1 4 "Setting up build environment"
$env:PATH = "C:\Strawberry\perl\bin;C:\Strawberry\c\bin;" + $env:PATH
Write-Host "  Strawberry Perl prepended to PATH."

# ── Step 2: build ──────────────────────────────────────────────────────────
Write-Step 2 4 "Running pnpm tauri build  (5-10 min, please wait)"
Set-Location $projectRoot

$buildOutput = & pnpm tauri build 2>&1
$buildExitCode = $LASTEXITCODE

# Echo the last 30 lines of build output so the user can see what happened.
$buildOutput | Select-Object -Last 30 | ForEach-Object { Write-Host "  $_" }

if ($buildExitCode -ne 0) {
    Abort "Build exited with code $buildExitCode. Check the output above."
}
Write-Host "  Build succeeded." -ForegroundColor Green

# ── Step 3: close running app ──────────────────────────────────────────────
Write-Step 3 4 "Closing SQL Mate if it is running"
$procs = Get-Process | Where-Object { $_.Name -like "*SQL*Mate*" -or $_.Name -eq "SQL Mate" }
if ($procs) {
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host "  Stopped $($procs.Count) process(es)."
    Start-Sleep -Seconds 1
} else {
    Write-Host "  Not running — nothing to close."
}

# ── Step 4: run installer ──────────────────────────────────────────────────
Write-Step 4 4 "Launching installer"
$nsisDir = Join-Path $projectRoot "src-tauri\target\release\bundle\nsis"
$installerPath = Get-ChildItem -Path $nsisDir -Filter "*x64-setup.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $installerPath) {
    Abort "Installer not found in:`n  $nsisDir`n`nThe build may have succeeded but placed the file elsewhere. Check src-tauri\target\release\bundle\nsis\"
}
Write-Host "  Running: $installerPath"
Write-Host "  Complete the wizard, then launch SQL Mate from the Start Menu."
Start-Process -FilePath $installerPath -Wait

Write-Host ""
Write-Host "======================================" -ForegroundColor Green
Write-Host "  Done. Launch SQL Mate from the" -ForegroundColor Green
Write-Host "  Start Menu or desktop shortcut." -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Green
Write-Host ""
Read-Host "Press Enter to close this window"
