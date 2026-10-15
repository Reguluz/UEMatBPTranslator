param(
  [string]$CodePath = 'E:\Program Files\Microsoft VS Code\Code.exe'
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not (Test-Path -LiteralPath $CodePath -PathType Leaf)) {
  throw "VSCode executable not found: $CodePath"
}
if (-not (Test-Path -LiteralPath (Join-Path $workspaceRoot 'packages\vscode\dist\extension.js') -PathType Leaf)) {
  throw 'Build the extension first with npm run build:extension.'
}

$runName = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6)
$runRoot = Join-Path $workspaceRoot "artifacts\vscode-smoke\$runName"
$profilePath = Join-Path $runRoot 'user-data'
$extensionsPath = Join-Path $runRoot 'extensions'
New-Item -ItemType Directory -Path $profilePath, $extensionsPath -Force | Out-Null
$resultPath = Join-Path $runRoot 'result.json'
$stdoutPath = Join-Path $runRoot 'stdout.log'
$stderrPath = Join-Path $runRoot 'stderr.log'
$extensionPath = Join-Path $workspaceRoot 'packages\vscode'
$testPath = Join-Path $PSScriptRoot 'vscode-host-test.cjs'

# Each value is separately quoted for Windows process argument parsing.
$argumentValues = @(
  '--user-data-dir', $profilePath,
  '--extensions-dir', $extensionsPath,
  '--extensionDevelopmentPath', $extensionPath,
  '--extensionTestsPath', $testPath,
  '--new-window', '--skip-welcome', '--skip-release-notes',
  '--disable-workspace-trust', '--disable-updates', '--disable-gpu',
  '--telemetry-level', 'off'
)
$launchArguments = $argumentValues | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }
$previousResult = $env:UE_MATERIAL_SMOKE_RESULT
try {
  $env:UE_MATERIAL_SMOKE_RESULT = $resultPath
  $launched = Start-Process -FilePath $CodePath -ArgumentList $launchArguments -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
} finally {
  $env:UE_MATERIAL_SMOKE_RESULT = $previousResult
}
$metadata = [ordered]@{
  processId = $launched.Id
  result = $resultPath
  stdout = $stdoutPath
  stderr = $stderrPath
  userDataDir = $profilePath
  extensionsDir = $extensionsPath
}
$metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'launch.json') -Encoding utf8
$metadata | ConvertTo-Json
