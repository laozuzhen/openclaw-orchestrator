param(
  [string]$Target,
  [string]$Config,
  [ValidateSet('dev', 'copy')]
  [string]$Mode = 'dev',
  [string]$BaseUrl,
  [string]$AuthToken,
  [int]$TimeoutMs,
  [switch]$Force
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeScript = Join-Path $scriptDir 'install-openclaw-plugin.mjs'

$args = @($nodeScript, '--mode', $Mode)
if ($Target) {
  $args += '--target'
  $args += $Target
}
if ($Config) {
  $args += '--config'
  $args += $Config
}
if ($BaseUrl) {
  $args += '--base-url'
  $args += $BaseUrl
}
if ($AuthToken) {
  $args += '--auth-token'
  $args += $AuthToken
}
if ($PSBoundParameters.ContainsKey('TimeoutMs')) {
  $args += '--timeout-ms'
  $args += $TimeoutMs.ToString()
}
if ($Force) {
  $args += '--force'
}

node @args
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
