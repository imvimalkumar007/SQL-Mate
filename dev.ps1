# Dev environment setup for SQL Mate on Windows.
#
# Dot-source this script (note the leading "dot space") to configure your
# shell for cargo + pnpm tauri dev:
#
#     . .\dev.ps1
#
# It does three things:
#   1. Sets CARGO_HOME to <repo>/.cargo-home so the registry lives off C:.
#   2. Adds the rustup-installed cargo/rustc to PATH if not already there.
#   3. Sources MSVC's vcvars64.bat (auto-detected via vswhere) so the linker
#      and Windows SDK headers/libs are findable.
#
# After dot-sourcing, run cargo / pnpm tauri dev as usual in the same shell.

# Save the caller's ErrorActionPreference so we don't leak ours when dot-sourced.
$__devps1_saved_eap = $ErrorActionPreference
$ErrorActionPreference = "Stop"

# 1. CARGO_HOME — local to this repo.
$projectDir = $PSScriptRoot
$cargoHome = Join-Path $projectDir ".cargo-home"
if (-not (Test-Path $cargoHome)) { New-Item -ItemType Directory -Path $cargoHome | Out-Null }
$env:CARGO_HOME = $cargoHome
Write-Host "CARGO_HOME = $env:CARGO_HOME"

# 2. Add rustup-installed bin to PATH if not present.
$rustBin = Join-Path $env:USERPROFILE ".cargo\bin"
if ((Test-Path $rustBin) -and ($env:Path -notlike "*$rustBin*")) {
    $env:Path = "$rustBin;$env:Path"
}

# 2a. Make Perl reachable for openssl-src (vendored OpenSSL build, used by
# rusqlite's SQLCipher feature). Git for Windows bundles a usable Perl that we
# can borrow rather than installing Strawberry Perl globally.
# Strawberry Perl portable on E: is preferred — Git for Windows ships a minimal
# Perl that lacks core modules (Locale::Maketext::Simple etc.) that openssl-src
# needs.
$perlCandidates = @(
    "E:\strawberry-perl-portable\perl\bin"
    "C:\Strawberry\perl\bin"
    "C:\Perl64\bin"
    "C:\Program Files\Git\usr\bin"
)
if (-not (Get-Command perl -ErrorAction SilentlyContinue)) {
    foreach ($candidate in $perlCandidates) {
        if (Test-Path (Join-Path $candidate "perl.exe")) {
            if ($env:Path -notlike "*$candidate*") {
                $env:Path = "$candidate;$env:Path"
            }
            break
        }
    }
}

# 3. Source MSVC env via vcvars64. Locate VS via vswhere.
$vsInstallerDir = "C:\Program Files (x86)\Microsoft Visual Studio\Installer"
$vswhere = Join-Path $vsInstallerDir "vswhere.exe"
if (-not (Test-Path $vswhere)) {
    throw "vswhere.exe not found at $vswhere. Install Visual Studio Build Tools per SETUP.md step 1."
}
$vsInstall = & $vswhere -latest -products * -property installationPath
if (-not $vsInstall) {
    throw "vswhere found no Visual Studio installation. Install per SETUP.md step 1."
}
$vcvars = Join-Path $vsInstall "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) {
    throw "vcvars64.bat not found at $vcvars. The VS install seems incomplete; ensure the C++ Build Tools workload is installed."
}
# vcvars64.bat itself shells out to vswhere by bare name, so make sure the
# Installer directory is on PATH for the cmd subshell that runs vcvars.
if ($env:Path -notlike "*$vsInstallerDir*") {
    $env:Path = "$vsInstallerDir;$env:Path"
}
cmd /c "`"$vcvars`" && set" 2>&1 | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') {
        Set-Item -Path "env:$($Matches[1])" -Value $Matches[2]
    }
}
Write-Host "MSVC env loaded from $vsInstall"

# Sanity check.
$cargoVersion = (& cargo --version 2>&1) -join " "
Write-Host "  $cargoVersion"
$linkExists = $null -ne (Get-Command link.exe -ErrorAction SilentlyContinue)
Write-Host "  link.exe on PATH: $linkExists"

Write-Host ""
Write-Host "Dev env ready. Run cargo / pnpm tauri dev in this shell."

# Restore caller's ErrorActionPreference. Cargo writes informational messages
# (e.g. "Compiling foo") to stderr; with ErrorActionPreference=Stop, PowerShell
# would treat those as terminating errors and kill the calling script.
$ErrorActionPreference = $__devps1_saved_eap
Remove-Variable -Name __devps1_saved_eap -ErrorAction SilentlyContinue
