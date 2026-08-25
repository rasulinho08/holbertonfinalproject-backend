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
$adminId = (Invoke-RestMethod -UseBasicParsing -Uri "$BASE/auth/login" -Method Post -Body $body -Headers @{'Content-Type'='application/json'}).data.user.id

# Delete any remaining publications via admin-user's own authorId check
$rows = pgsql $PGDATABASE "SELECT id::text, title FROM publications;"
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
$count = pgsql $PGDATABASE "SELECT count(*) FROM publications;"
Write-Host "Final publications row count: $count"
