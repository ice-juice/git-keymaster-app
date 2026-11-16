#Requires -Version 5.1
<#
.SYNOPSIS
  Load this project's Android toolchain into the current PowerShell process.
.EXAMPLE
  . .\scripts\dev-env.ps1
  cd app
  npm run tauri android build --debug --apk --target aarch64
#>
$ErrorActionPreference = 'Stop'

$jdkRoot = $env:JAVA17_HOME
if (-not $jdkRoot -and $env:JAVA_HOME -and (Test-Path "$env:JAVA_HOME\release")) {
    if (Select-String -LiteralPath "$env:JAVA_HOME\release" -Pattern '^JAVA_VERSION="17[.\"]' -Quiet) {
        $jdkRoot = $env:JAVA_HOME
    }
}
if (-not $jdkRoot) {
    $jdkRoot = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs\Eclipse Adoptium') -Directory -Filter 'jdk-17*' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $jdkRoot) { throw 'JDK 17 was not found. Set JAVA17_HOME to its installation directory.' }
$sdkRoot = $env:ANDROID_HOME
if (-not $sdkRoot) { $sdkRoot = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$ndkRoot = $env:NDK_HOME
if (-not $ndkRoot) { $ndkRoot = Join-Path $sdkRoot 'ndk\29.0.14206865' }

foreach ($tool in @(
    "$jdkRoot\bin\javac.exe",
    "$sdkRoot\platform-tools\adb.exe",
    "$ndkRoot\toolchains\llvm\prebuilt\windows-x86_64\bin\clang.exe"
)) {
    if (-not (Test-Path -LiteralPath $tool)) { throw "Missing Android development tool: $tool" }
}

# Process-scoped: other projects keep their existing Java version.
$env:JAVA_HOME = $jdkRoot
$env:JAVA17_HOME = $jdkRoot
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:NDK_HOME = $ndkRoot
$env:ANDROID_NDK_HOME = $ndkRoot
$devPaths = @("$jdkRoot\bin", "$sdkRoot\platform-tools", "$sdkRoot\cmdline-tools\latest\bin", "$env:USERPROFILE\.cargo\bin")
$env:Path = (($devPaths + ($env:Path -split ';') | Select-Object -Unique) -join ';')

# Kotlin 1.9 incremental compilation cannot relativize C: Cargo sources to an E: project.
# Keep Gradle task caching and Rust incremental compilation; only disable Kotlin's
# incremental compiler for a cross-drive layout in this process.
$cargoRoot = $env:CARGO_HOME
if (-not $cargoRoot) { $cargoRoot = Join-Path $env:USERPROFILE '.cargo' }
if ([IO.Path]::GetPathRoot($cargoRoot) -ne [IO.Path]::GetPathRoot($PSScriptRoot)) {
    [Environment]::SetEnvironmentVariable('ORG_GRADLE_PROJECT_kotlin.incremental', 'false', 'Process')
}
Write-Host "Android environment ready: JDK=$jdkRoot; SDK=$sdkRoot; NDK=$ndkRoot"
