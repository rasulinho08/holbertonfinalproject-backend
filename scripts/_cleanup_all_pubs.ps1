$BASE = 'http://localhost:4000/api/v1'
$PSQL = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
function pgsql($db, $sql) { $env:PGPASSWORD = 'kitabdostu'; return (& $PSQL '-h' 'localhost' '-p' '5432' '-U' 'kitabdostu' '-d' $db '-v' 'ON_ERROR_STOP=1' '-X' '-q' '-t' '-A' '-c' $sql 2>&1 | Out-String).Trim() }

$body = @{email='admin@kitabdostu.az';password='password123'} | ConvertTo-Json
$adminToken = (Invoke-RestMethod -UseBasicParsing -Uri "$BASE/auth/login" -Method Post -Body $body -Headers @{'Content-Type'='application/json'}).data.accessToken
$adminId = (Invoke-RestMethod -UseBasicParsing -Uri "$BASE/auth/login" -Method Post -Body $body -Headers @{'Content-Type'='application/json'}).data.user.id

# Delete any remaining publications via admin-user's own authorId check
$rows = pgsql kitabdostu "SELECT id::text, title FROM publications;"
if (-not $rows -or $rows.Trim().Length -eq 0) {
  Write-Host "No publications remaining. OK."
  exit 0
}
$rows
foreach ($line in @($rows -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 -and $_.Contains('|') })) {
  $parts = $line -split '\|'
  $id = $parts[0].Trim()
  try { Invoke-WebRequest -UseBasicParsing -Uri "$BASE/admin/posts/$id" -Method Delete -Headers @{'Authorization'="Bearer $adminToken"} | Out-Null ; Write-Host "deleted $id OK" } catch { $resp = $_.Exception.Response; $code = if ($resp) { [int]$resp.StatusCode } else { 0 }; $msg = if ($resp) { (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } else { $_.Exception.Message }; Write-Host "skip $id HTTP ${code}: ${msg}" }
}
$count = pgsql kitabdostu "SELECT count(*) FROM publications;"
Write-Host "Final publications row count: $count"
