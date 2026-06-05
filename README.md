# ok.ru Video Proxy

Fetches ok.ru video metadata **server-side**, extracts IP-locked CDN URLs, and proxies the stream so the `srcIp` parameter stays consistent.

## Why this exists

ok.ru embeds serve video from `vd1.okcdn.ru` URLs that include a `srcIp=` parameter tied to the requesting IP. The browser can't fetch these directly because:
1. CORS blocks cross-origin requests from the browser
2. The CDN URL only works from the IP that originally resolved it

This proxy handles both problems: it makes the resolution request from your **server's IP**, then streams the bytes through itself.

## Endpoints

| Endpoint | Description |
|---|---|
| `/resolve?id=<videoId>` | Returns all available quality URLs as JSON |
| `/stream?id=<videoId>&quality=720p` | Proxies the video bytes (use this as your `<video src>`) |
| `/player?id=<videoId>` | Built-in HTML5 player page for testing |
| `/debug?id=<videoId>` | Returns raw embed page HTML — useful if parsing breaks |

## Setup

```bash
npm install
npm start
# Server runs on port 3000 by default
# PORT=8080 npm start  — to change port
```

## Usage

### Get video URLs (JSON)
```
GET /resolve?id=11443520473746
```
Returns:
```json
{
  "id": "11443520473746",
  "chosen": {
    "quality": "720p",
    "url": "https://vd1.okcdn.ru/...&srcIp=YOUR_SERVER_IP..."
  },
  "allQualities": [
    { "quality": "720p", "url": "..." },
    { "quality": "480p", "url": "..." },
    { "quality": "360p", "url": "..." }
  ]
}
```

### Embed in your own page
```html
<!-- Resolves + streams, seeking supported via Range headers -->
<video src="http://your-server/stream?id=11443520473746" controls></video>
```

### Specify quality
```
/stream?id=11443520473746&quality=480p
/resolve?id=11443520473746&quality=480p
```

## Deployment

Deploy to any Node.js host with an outbound internet connection:

### Railway / Render / Fly.io
```bash
# Just push the repo — they auto-detect Node
# Set PORT env var if needed
```

### VPS (Ubuntu)
```bash
npm install
npm install -g pm2
pm2 start server.js --name okru-proxy
pm2 save
```

### Termux (Android, local testing only)
```bash
pkg install nodejs
npm install
node server.js
# Access at http://localhost:3000
```

## How the parsing works

ok.ru bakes the video metadata as a JSON blob in a `data-options` attribute on the player div, HTML-entity-encoded. The server:

1. Fetches `https://ok.ru/videoembed/<id>` with browser-like headers
2. Extracts the JSON blob via regex (3 fallback patterns)
3. Parses the `videos` array from the metadata
4. Sorts by quality preference: 1080p → 720p → 480p → 360p → ...
5. Returns the chosen URL (locked to the server's IP)

If ok.ru changes their page structure, hit `/debug?id=<id>` to inspect the raw HTML and update the regex patterns in `extractVideoData()`.

## Notes

- The CDN URLs expire after some time — don't cache them for more than a few hours
- Range requests are forwarded so seek/scrub works in `<video>` elements
- HLS manifest URLs (`hlsManifestUrl`) are also extracted if present — use hls.js on the client to play those
