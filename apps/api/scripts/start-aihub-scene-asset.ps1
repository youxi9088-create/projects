param(
  [string]$Prompt,
  [string]$Label,
  [string]$InputPath,
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  if ($InputPath) {
    $inputData = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $Prompt = [string]$inputData.prompt
    $Label = [string]$inputData.label
  }
  if (-not $ValidateOnly -and ([string]::IsNullOrWhiteSpace($Prompt) -or [string]::IsNullOrWhiteSpace($Label))) {
    throw 'Missing scene asset prompt or label'
  }

  $skillRoot = $env:AIHUB_ASSET_SKILL_DIR
  if (-not $skillRoot) { throw 'Missing env: AIHUB_ASSET_SKILL_DIR' }
  if (-not $env:AIHUB_AGENT_TOKEN) { throw 'Missing env: AIHUB_AGENT_TOKEN' }

  . (Join-Path $skillRoot 'examples\_appids.ps1')

  $alias = 'jimeng'
  $appId = Get-AIHubAppId -Alias $alias
  if ($ValidateOnly) {
    [ordered]@{ ok = $true; alias = $alias; configured = $true } | ConvertTo-Json -Compress
    exit 0
  }

  $modelVersion = ([char]0x5373).ToString() + [char]0x68A6 + '5.0'
  $expertDisabled = ([char]0x5426).ToString()
  $requestBody = [ordered]@{
    appId = $appId
    inputs = @{
      prompt = $Prompt
      aspect_ratio = '4096x2304'
      version = $modelVersion
      is_expert = $expertDisabled
      count = 1
    }
    meta = @{ label = $Label }
  } | ConvertTo-Json -Depth 20 -Compress
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
