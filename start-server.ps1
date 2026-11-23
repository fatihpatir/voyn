# VOYN Yerel Geliştirme Sunucusu (Saf PowerShell — Node/Python gerektirmez)
$port = 3000
$root = $PSScriptRoot

$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$port/"
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
} catch {
    Write-Host "Port $port meşgul, 8080 deneniyor..." -ForegroundColor Yellow
    $port = 8080
    $listener = New-Object System.Net.HttpListener
    $prefix = "http://localhost:$port/"
    $listener.Prefixes.Add($prefix)
    $listener.Start()
}

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  VOYN PWA Yerel Sunucu Başlatıldı!" -ForegroundColor Green
Write-Host "  Adres: $prefix" -ForegroundColor Yellow
Write-Host "  Durdurmak için Ctrl+C tuşlarına basın." -ForegroundColor Gray
Write-Host "=============================================" -ForegroundColor Cyan

# Tarayıcıyı otomatik aç
Start-Process $prefix

$mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".htm"  = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".svg"  = "image/svg+xml"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".ico"  = "image/x-icon"
    ".webp" = "image/webp"
    ".mp3"  = "audio/mpeg"
    ".ogg"  = "audio/ogg"
    ".wav"  = "audio/wav"
    ".mp4"  = "video/mp4"
    ".pdf"  = "application/pdf"
}

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $urlPath = $request.Url.LocalPath.TrimStart('/')
        if ([string]::IsNullOrEmpty($urlPath) -or $urlPath -eq "/") {
            $urlPath = "index.html"
        }

        $localPath = Join-Path $root $urlPath

        if (Test-Path $localPath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($localPath).ToLower()
            $mime = "application/octet-stream"
            if ($mimeTypes.ContainsKey($ext)) {
                $mime = $mimeTypes[$ext]
            }

            $bytes = [System.IO.File]::ReadAllBytes($localPath)
            $response.ContentType = $mime
            $response.ContentLength64 = $bytes.Length
            $response.AddHeader("Access-Control-Allow-Origin", "*")
            $response.AddHeader("Service-Worker-Allowed", "/")
            $response.AddHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            $response.AddHeader("Pragma", "no-cache")
            $response.AddHeader("Expires", "0")
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.StatusCode = 200
        } else {
            $response.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("404 - Dosya bulunamadı")
            $response.ContentType = "text/plain; charset=utf-8"
            $response.ContentLength64 = $msg.Length
            $response.OutputStream.Write($msg, 0, $msg.Length)
        }
        $response.Close()
    } catch {
        # İstek işleme hatası
    }
}
