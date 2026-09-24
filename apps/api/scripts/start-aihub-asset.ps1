param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $skillRoot = $env:AIHUB_ASSET_SKILL_DIR
  if (-not $skillRoot) { throw 'Missing env: AIHUB_ASSET_SKILL_DIR' }
  if (-not $env:AIHUB_AGENT_TOKEN) { throw 'Missing env: AIHUB_AGENT_TOKEN' }

  . (Join-Path $skillRoot 'examples\_appids.ps1')
  if ($ValidateOnly) {
    [ordered]@{ ok = $true; configured = $true } | ConvertTo-Json -Compress
    exit 0
  }

  $inputData = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $alias = [string]$inputData.alias
  $label = [string]$inputData.label
  if ($alias -notin @('jimeng', 'gpt-image2', 'seedance')) { throw "Unsupported AIHub alias: $alias" }
  if ([string]::IsNullOrWhiteSpace($label)) { throw 'Missing asset task label' }
  if (-not $inputData.inputs) { throw 'Missing asset task inputs' }

  $appId = Get-AIHubAppId -Alias $alias
  $requestBody = [ordered]@{
    appId = $appId
    inputs = $inputData.inputs
    meta = @{ label = $label }
  } | ConvertTo-Json -Depth 30 -Compress

  $run = Invoke-RestMethod -Method Post -Uri 'https://bv.new.ndhy.com/api/agent/aihub/workflows/run' -Headers @{
    Authorization = "Bearer $env:AIHUB_AGENT_TOKEN"
    'Content-Type' = 'application/json; charset=utf-8'
  } -Body ([System.Text.Encoding]::UTF8.GetBytes($requestBody))

  [ordered]@{ ok = $true; runId = $run.runId; alias = $alias; status = $run.status } | ConvertTo-Json -Compress
} catch {
  $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
  $payload = [ordered]@{ ok = $false; error = $detail } | ConvertTo-Json -Compress
  [Console]::Error.WriteLine("AIHUB_ERROR_JSON:$payload")
  Write-Output $payload
  exit 0
}
