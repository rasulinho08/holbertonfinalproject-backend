$BASE = if ($env:API_BASE) { $env:API_BASE } else { 'http://localhost:4000/api/v1' }
$PSQL = if ($env:PSQL_PATH) { $env:PSQL_PATH } else { 'C:\Program Files\PostgreSQL\18\bin\psql.exe' }
$PGHOST = if ($env:PGHOST) { $env:PGHOST } else { 'localhost' }
$PGPORT = if ($env:PGPORT) { $env:PGPORT } else { '5432' }
$APP_PGUSER = if ($env:APP_PGUSER) { $env:APP_PGUSER } else { 'kitabdostu' }
$APP_PGPASSWORD = if ($env:APP_PGPASSWORD) { $env:APP_PGPASSWORD } else { '' }
$PGDATABASE = if ($env:PGDATABASE) { $env:PGDATABASE } else { 'kitabdostu' }
$ADMIN_EMAIL = if ($env:ADMIN_EMAIL) { $env:ADMIN_EMAIL } else { 'admin@kitabdostu.az' }
$ADMIN_PASSWORD = if ($env:ADMIN_PASSWORD) { $env:ADMIN_PASSWORD } else { $(throw 'ADMIN_PASSWORD environment variable must be set') }
function pgsql($db, $sql) { $prev = $env:PGPASSWORD; $env:PGPASSWORD = $APP_PGPASSWORD; $result = (& $PSQL '-h' $PGHOST '-p' $PGPORT '-U' $APP_PGUSER '-d' $db '-v' 'ON_ERROR_STOP=1' '-X' '-q' '-t' '-A' '-c' $sql 2>&1 | Out-String).Trim(); $env:PGPASSWORD = $prev; return $result }

$body = @{email=$ADMIN_EMAIL;password=$ADMIN_PASSWORD} | ConvertTo-Json
$adminToken = (Invoke-RestMethod -UseBasicParsing -Uri "$BASE/auth/login" -Method Post -Body $body -Headers @{'Content-Type'='application/json'}).data.accessToken

# List remaining test pubs and delete each via API so no test rows persist
$remaining = pgsql $PGDATABASE "SELECT id::text FROM publications WHERE title LIKE 'LIST-CHECK%' OR title LIKE 'FINAL FIX%' OR title LIKE 'DELETE TEST%' OR title LIKE 'E2E DELETE%' OR title LIKE '%FINAL FIX%' OR title LIKE '8d371af3%';"
if ($remaining -and $remaining.Trim().Length -gt 0) {
  $ids = @($remaining -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
  Write-Host "Cleaning leftover test pubs: $($ids.Count) rows"
  foreach ($id in $ids) {
    try { Invoke-WebRequest -UseBasicParsing -Uri "$BASE/admin/posts/$id" -Method Delete -Headers @{'Authorization'="Bearer $adminToken"} | Out-Null ; Write-Host "  deleted $id" } catch {}
  }
}
$leftCount = pgsql $PGDATABASE "SELECT count(*) FROM publications;"
Write-Host "publications table row count after cleanup: $leftCount"
