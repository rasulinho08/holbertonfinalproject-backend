$BASE = if ($env:API_BASE) { $env:API_BASE } else { 'http://localhost:4000/api/v1' }
$ADMIN_EMAIL = if ($env:ADMIN_EMAIL) { $env:ADMIN_EMAIL } else { 'admin@kitabdostu.az' }
$ADMIN_PASSWORD = if ($env:ADMIN_PASSWORD) { $env:ADMIN_PASSWORD } else { $(throw 'ADMIN_PASSWORD environment variable must be set') }
$body = @{email=$ADMIN_EMAIL;password=$ADMIN_PASSWORD} | ConvertTo-Json
$adminToken = (Invoke-RestMethod -UseBasicParsing -Uri "$BASE/auth/login" -Method Post -Body $body -Headers @{'Content-Type'='application/json'}).data.accessToken

$book = (Invoke-RestMethod -UseBasicParsing "$BASE/books?limit=1").data[0]
$pubBody = @{ title = 'LIST-CHECK TEST PUB'; content = ('y'*200); coverUrl = $null; recommendedBooks = @( @{ bookId = $book.id; note = 'R'; position = 0 } ) } | ConvertTo-Json -Depth 5
$pubId = (Invoke-RestMethod -UseBasicParsing -Uri "$BASE/admin/posts" -Method Post -Body $pubBody -Headers @{'Content-Type'='application/json'; 'Authorization'="Bearer $adminToken"}).data.id
Write-Host "Created: $pubId"

Write-Host "--- GET /admin/posts - response: ---"
try {
  $resp = Invoke-WebRequest -UseBasicParsing -Uri "$BASE/admin/posts?limit=3" -Headers @{'Authorization'="Bearer $adminToken"}
  Write-Host "HTTP $($resp.StatusCode)"
  $json = $resp.Content | ConvertFrom-Json
  Write-Host "total=$($json.data.meta.total) count=$($json.data.data.Count)"
  $json.data.data | Select-Object id, title | Format-Table -AutoSize | Out-String
} catch {
  $resp = $_.Exception.Response
  $code = if ($resp) { [int]$resp.StatusCode } else { 0 }
  $bodyText = if ($resp) { (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } else { $_.Exception.Message }
  Write-Host "HTTP ${code}: ${bodyText}"
}

Write-Host "--- GET /admin/posts/:id - response: ---"
try {
  $resp = Invoke-WebRequest -UseBasicParsing -Uri "$BASE/admin/posts/$pubId" -Headers @{'Authorization'="Bearer $adminToken"}
  Write-Host "HTTP $($resp.StatusCode)"
  $d = ($resp.Content | ConvertFrom-Json).data
  Write-Host "admin detail: $($d.title)"
} catch {
  $resp = $_.Exception.Response
  $code = if ($resp) { [int]$resp.StatusCode } else { 0 }
  $bodyText = if ($resp) { (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } else { $_.Exception.Message }
  Write-Host "HTTP ${code}: ${bodyText}"
}
