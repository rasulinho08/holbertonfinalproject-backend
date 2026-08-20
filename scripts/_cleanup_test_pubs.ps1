$BASE = 'http://localhost:4000/api/v1'
$PSQL = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
function pgsql($db, $sql) { $env:PGPASSWORD = 'kitabdostu'; return (& $PSQL '-h' 'localhost' '-p' '5432' '-U' 'kitabdostu' '-d' $db '-v' 'ON_ERROR_STOP=1' '-X' '-q' '-t' '-A' '-c' $sql 2>&1 | Out-String).Trim() }

$body = @{email='admin@kitabdostu.az';password='password123'} | ConvertTo-Json
$adminToken = (Invoke-RestMethod -UseBasicParsing -Uri "$BASE/auth/login" -Method Post -Body $body -Headers @{'Content-Type'='application/json'}).data.accessToken

# List remaining test pubs and delete each via API so no test rows persist
$remaining = pgsql kitabdostu "SELECT id::text FROM publications WHERE title LIKE 'LIST-CHECK%' OR title LIKE 'FINAL FIX%' OR title LIKE 'DELETE TEST%' OR title LIKE 'E2E DELETE%' OR title LIKE '%FINAL FIX%' OR title LIKE '8d371af3%';"
if ($remaining -and $remaining.Trim().Length -gt 0) {
  $ids = @($remaining -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
  Write-Host "Cleaning leftover test pubs: $($ids.Count) rows"
  foreach ($id in $ids) {
    try { Invoke-WebRequest -UseBasicParsing -Uri "$BASE/admin/posts/$id" -Method Delete -Headers @{'Authorization'="Bearer $adminToken"} | Out-Null ; Write-Host "  deleted $id" } catch {}
  }
}
$leftCount = pgsql kitabdostu "SELECT count(*) FROM publications;"
Write-Host "publications table row count after cleanup: $leftCount"
