
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$docx = 'D:\A.R.T.H.U.R\ARTHUR_Phase_2_Memory_RAG_DeepSeek_Implementation_Spec_v1.0.docx'
$zip = [System.IO.Compression.ZipFile]::OpenRead($docx)
try {
  $entry = $zip.Entries | Where-Object { $_.FullName -eq 'word/document.xml' }
  $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
  $xml = $reader.ReadToEnd()
  $reader.Close()
} finally { $zip.Dispose() }
$xml = $xml -replace '</w:p>', [Environment]::NewLine
$xml = $xml -replace '<w:tab[^>]*/>', [char]9
$xml = $xml -replace '<[^>]+>', ''
$text = [System.Net.WebUtility]::HtmlDecode($xml)
$out = 'D:\A.R.T.H.U.R\.ai-harness\phase2-spec-extracted.txt'
[System.IO.File]::WriteAllText($out, $text, [System.Text.Encoding]::UTF8)
Write-Output ("WROTE " + $out)
Write-Output ("CHARS: " + $text.Length)
