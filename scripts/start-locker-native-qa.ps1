#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$ExePath,[int]$Port=9234)
$ErrorActionPreference='Stop'
$binary=(Resolve-Path -LiteralPath $ExePath).Path
$repoRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $binary.StartsWith($repoRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($binary) -ne 'git-keymaster.exe') { throw 'Only launch this repository build.' }
$qaRoot=Join-Path $env:LOCALAPPDATA ('GitKeymasterDev\locker-qa-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach($part in @('roaming','local','profile','profile\AppData\Local','profile\AppData\Roaming','temp','webview')) { New-Item -ItemType Directory -Path (Join-Path $qaRoot $part) -Force | Out-Null }
$startInfo=New-Object Diagnostics.ProcessStartInfo
$startInfo.FileName=$binary
$startInfo.WorkingDirectory=[IO.Path]::GetDirectoryName($binary)
$startInfo.UseShellExecute=$false
$startInfo.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
# Child-process overrides only. Existing app/config/SSH/profile stay isolated.
$startInfo.EnvironmentVariables['APPDATA']=Join-Path $qaRoot 'roaming'
$startInfo.EnvironmentVariables['LOCALAPPDATA']=Join-Path $qaRoot 'local'
$startInfo.EnvironmentVariables['USERPROFILE']=Join-Path $qaRoot 'profile'
$startInfo.EnvironmentVariables['TEMP']=Join-Path $qaRoot 'temp'
$startInfo.EnvironmentVariables['TMP']=Join-Path $qaRoot 'temp'
$startInfo.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER']=Join-Path $qaRoot 'webview'
$startInfo.EnvironmentVariables['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS']="--remote-debugging-port=$Port"
$startInfo.EnvironmentVariables.Remove('SSH_AUTH_SOCK')
$startInfo.EnvironmentVariables.Remove('SSH_AGENT_PID')
$process=[Diagnostics.Process]::Start($startInfo)
$result=[ordered]@{processId=$process.Id;qaRoot=$qaRoot;binary=$binary;port=$Port}
$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $qaRoot 'launch.json') -Encoding utf8
$result | ConvertTo-Json
