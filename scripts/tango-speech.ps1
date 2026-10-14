param([ValidateSet('capabilities','transcribe')][string]$Mode = 'capabilities', [string]$AudioPath, [string]$Language = 'zh-CN')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$recognizer = $null
try {
  Add-Type -AssemblyName System.Speech
  $installed = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
  if ($Mode -eq 'capabilities') {
    @{ available = ($installed.Count -gt 0); languages = @($installed | ForEach-Object { $_.Culture.Name } | Select-Object -Unique) } | ConvertTo-Json -Compress
    exit 0
  }
  $selected = $installed | Where-Object { $_.Culture.Name -eq $Language } | Select-Object -First 1
  if ($null -eq $selected) { throw 'language-unavailable' }
  $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new($selected)
  $recognizer.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
  $recognizer.SetInputToWaveFile($AudioPath)
  $phrases = [System.Collections.Generic.List[string]]::new()
  while ($null -ne ($result = $recognizer.Recognize([TimeSpan]::FromSeconds(8)))) {
    if ($result.Confidence -ge 0.15) { $phrases.Add($result.Text) }
    if (($phrases -join ' ').Length -ge 600) { break }
  }
  @{ text = ($phrases -join ' ') } | ConvertTo-Json -Compress
} catch {
  @{ error = 'recognition-failed' } | ConvertTo-Json -Compress
  exit 1
} finally {
  if ($null -ne $recognizer) { $recognizer.Dispose() }
}
