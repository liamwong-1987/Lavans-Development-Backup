param(
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)][string]$OutputJson
)

$ErrorActionPreference = 'Stop'
$records = [System.Collections.Generic.List[object]]::new()
$word = $null
$excel = $null

try {
    $wordFiles = Get-ChildItem -LiteralPath $SourceRoot -Recurse -File | Where-Object { $_.Extension.ToLowerInvariant() -in @('.doc', '.wps') }
    if ($wordFiles.Count -gt 0) {
        $word = New-Object -ComObject Word.Application
        $word.Visible = $false
        $word.DisplayAlerts = 0
        foreach ($file in $wordFiles) {
            try {
                $doc = $word.Documents.Open($file.FullName, $false, $true, $false)
                $text = $doc.Content.Text
                $doc.Close($false)
                [System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null
                $records.Add([PSCustomObject]@{path=$file.FullName; extension=$file.Extension.ToLowerInvariant(); text=$text; status='ok'; error=$null})
            } catch {
                $records.Add([PSCustomObject]@{path=$file.FullName; extension=$file.Extension.ToLowerInvariant(); text=''; status='failed'; error=$_.Exception.Message})
            }
        }
    }

    $excelFiles = Get-ChildItem -LiteralPath $SourceRoot -Recurse -File | Where-Object { $_.Extension.ToLowerInvariant() -eq '.xls' }
    if ($excelFiles.Count -gt 0) {
        $excel = New-Object -ComObject Excel.Application
        $excel.Visible = $false
        $excel.DisplayAlerts = $false
        foreach ($file in $excelFiles) {
            try {
                $book = $excel.Workbooks.Open($file.FullName, 0, $true)
                $parts = [System.Collections.Generic.List[string]]::new()
                foreach ($sheet in $book.Worksheets) {
                    $parts.Add("【工作表：$($sheet.Name)】")
                    $values = $sheet.UsedRange.Value2
                    if ($values -is [System.Array]) {
                        for ($r=1; $r -le $values.GetLength(0); $r++) {
                            $row = [System.Collections.Generic.List[string]]::new()
                            for ($c=1; $c -le $values.GetLength(1); $c++) {
                                $value = $values[$r,$c]
                                if ($null -ne $value -and "$value".Trim()) { $row.Add("$value".Trim()) }
                            }
                            if ($row.Count -gt 0) { $parts.Add(($row -join ' | ')) }
                        }
                    } elseif ($null -ne $values) { $parts.Add("$values") }
                }
                $book.Close($false)
                [System.Runtime.InteropServices.Marshal]::ReleaseComObject($book) | Out-Null
                $records.Add([PSCustomObject]@{path=$file.FullName; extension='.xls'; text=($parts -join "`n"); status='ok'; error=$null})
            } catch {
                $records.Add([PSCustomObject]@{path=$file.FullName; extension='.xls'; text=''; status='failed'; error=$_.Exception.Message})
            }
        }
    }
} finally {
    if ($word) { $word.Quit(); [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null }
    if ($excel) { $excel.Quit(); [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}

$records | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $OutputJson -Encoding utf8
Write-Output ("EXTRACTED=" + (($records | Where-Object status -eq 'ok').Count))
Write-Output ("FAILED=" + (($records | Where-Object status -eq 'failed').Count))
