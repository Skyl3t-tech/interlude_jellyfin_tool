# Installs what Rust needs on Windows, builds Interlude.exe and adds a Start menu shortcut.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

function Reload-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:USERPROFILE\.cargo\bin"
}

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasMsvc = (Test-Path $vswhere) -and
    (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if (-not $hasMsvc) {
    Write-Host "Installing Visual Studio C++ Build Tools. This takes a while, and Windows will ask for permission."
    winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --accept-source-agreements --accept-package-agreements `
        --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
}

Reload-Path
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Rust."
    winget install --id Rustlang.Rustup --exact --accept-source-agreements --accept-package-agreements
    Reload-Path
}
if (Get-Command rustup -ErrorAction SilentlyContinue) { rustup default stable-msvc }

Write-Host "Building Interlude. The first build takes several minutes."
cargo build --release --manifest-path "$root\src-tauri\Cargo.toml"
if ($LASTEXITCODE -ne 0) { throw "Build failed." }

$exe = "$root\Interlude.exe"

# Registers Interlude with Windows so its notifications are shown.
$aumid = "HKCU:\Software\Classes\AppUserModelId\app.interlude.tracker"
New-Item -Path $aumid -Force | Out-Null
Set-ItemProperty -Path $aumid -Name DisplayName -Value "Interlude"
Set-ItemProperty -Path $aumid -Name IconUri -Value "$root\src-tauri\icons\icon.png"

# Close a running copy so the new build can replace it.
Get-Process interlude -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Copy-Item "$root\src-tauri\target\release\interlude.exe" $exe -Force

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Interlude.lnk")
$link.TargetPath = $exe
$link.WorkingDirectory = $root
$link.Save()

Write-Host "Done. Start Interlude from the Start menu or run $exe."
