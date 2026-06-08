import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

// !! Critical: ok.ru's videoPlayerMetadata endpoint requires a Gecko UA !!
const GECKO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0';
const QUALITY_ORDER = ['1080p', '720p', '480p', '360p', '240p', '144p', 'mobile', 'hls'];

function pickBestVideo(videos, wantedQuality) {
  if (!videos || videos.length === 0) return null;
  if (wantedQuality) {
    const match = videos.find(v => v.quality.toLowerCase().includes(wantedQuality.toLowerCase()));
    if (match) return match;
  }
  videos.sort((a, b) => {
    const ai = QUALITY_ORDER.indexOf(a.quality);
    const bi = QUALITY_ORDER.indexOf(b.quality);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  return videos[0];
}

// ── Core resolver: POST to ok.ru's videoPlayerMetadata endpoint ──────────────
async function resolveVideo(videoId) {
  const url = `https://ok.ru/dk?cmd=videoPlayerMetadata&mid=${videoId}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': GECKO_UA,
      'Accept': 'application/json, text/javascript, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `https://ok.ru/video/${videoId}`,
      'Origin': 'https://ok.ru',
    },
    body: '',
  });

  const text = await res.text();

  // Try JSON parse
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }

  if (data.error) throw new Error(`ok.ru error: ${JSON.stringify(data.error)}`);

  // Response has a "videos" array: [{ name: "720p", url: "..." }, ...]
  if (!Array.isArray(data.videos) || data.videos.length === 0) {
    throw new Error(`No videos in response: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const videos = data.videos.map(v => ({
    quality: v.name || v.type || 'unknown',
    url: v.url,
  }));

  // Also grab HLS if present
  if (data.hlsManifestUrl) videos.push({ quality: 'hls', url: data.hlsManifestUrl });

  return videos;
}

// ── /resolve ──────────────────────────────────────────────────────────────────
app.get('/resolve', async (req, res) => {
  const { id, quality } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing video id' });

  try {
    const videos = await resolveVideo(id);
    const chosen = pickBestVideo(videos, quality);
    console.log(`[resolve] ✅ id=${id} chosen=${chosen.quality}`);
    return res.json({ id, chosen, allQualities: videos });
  } catch (err) {
    console.error(`[resolve] ❌ id=${id} err=${err.message}`);
    return res.status(422).json({ error: err.message });
  }
});

// ── /stream ───────────────────────────────────────────────────────────────────
app.get('/stream', async (req, res) => {
  const { id, quality } = req.query;
  if (!id) return res.status(400).send('Missing id');

  try {
    const videos = await resolveVideo(id);
    const chosen = pickBestVideo(videos, quality);
    if (!chosen) return res.status(422).send('No video found');

    const headers = {
      'User-Agent': GECKO_UA,
      'Referer': 'https://ok.ru/',
    };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const videoRes = await fetch(chosen.url, { headers });
    res.status(videoRes.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
      if (videoRes.headers.get(h)) res.setHeader(h, videoRes.headers.get(h));
    });
    videoRes.body.pipe(res);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ── /player ───────────────────────────────────────────────────────────────────
app.get('/player', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OK.ru Player</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0a0a0a;color:#fff;font-family:monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:1rem}
    h2{margin-bottom:1rem;color:#f90;font-size:1rem;letter-spacing:2px;text-transform:uppercase}
    video{width:100%;max-width:900px;border-radius:8px;background:#111}
    #status{margin-top:1rem;font-size:.75rem;color:#666;max-width:900px;word-break:break-all}
    #qualities{margin-top:.5rem;display:flex;gap:.5rem;flex-wrap:wrap}
    button{background:#222;color:#f90;border:1px solid #f90;padding:4px 12px;border-radius:4px;cursor:pointer;font-family:monospace;font-size:.75rem}
    button:hover,button.active{background:#f90;color:#000}
  </style>
</head><body>
  <h2>OK.ru — <span style="color:#888">${id}</span></h2>
  <video id="vid" controls playsinline></video>
  <div id="qualities"></div>
  <div id="status">Resolving…</div>
  <script>
    const vid=document.getElementById('vid'),status=document.getElementById('status'),qualDiv=document.getElementById('qualities');
    async function load(){
      const res=await fetch('/resolve?id=${id}');
      const data=await res.json();
      if(data.error){status.textContent='❌ '+data.error;return;}
      status.textContent='✅ '+data.chosen.quality+' — '+data.chosen.url.slice(0,80)+'…';
      vid.src='/stream?id=${id}&quality='+data.chosen.quality;
      (data.allQualities||[]).forEach(q=>{
        const btn=document.createElement('button');
        btn.textContent=q.quality;
        if(q.quality===data.chosen.quality)btn.classList.add('active');
        btn.onclick=()=>{
          vid.src='/stream?id=${id}&quality='+q.quality;
          document.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
          btn.classList.add('active');
        };
        qualDiv.appendChild(btn);
      });
    }
    load();
  </script>
</body></html>`);
});

// ── /debug — raw response from ok.ru metadata endpoint ───────────────────────
app.get('/debug', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');
  const url = `https://ok.ru/dk?cmd=videoPlayerMetadata&mid=${id}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': GECKO_UA, 'Referer': `https://ok.ru/video/${id}`, 'Origin': 'https://ok.ru' },
    body: '',
  });
  const text = await r.text();
  res.setHeader('Content-Type', 'text/plain');
  res.send(`Status: ${r.status}\n\n${text}`);
});

app.get('/', (req, res) => res.json({
  endpoints: {
    '/resolve?id=<videoId>': 'Returns all quality URLs (JSON)',
    '/stream?id=<videoId>&quality=720p': 'Proxies video bytes',
    '/player?id=<videoId>': 'HTML5 player page',
    '/debug?id=<videoId>': 'Raw ok.ru metadata response',
  },
  example: `https://anidl-proxy.onrender.com/player?id=11443520473746`,
}));

app.listen(PORT, () => {
  console.log(`\n✅ ok.ru proxy running — port ${PORT}`);
  console.log(`   Endpoint: POST ok.ru/dk?cmd=videoPlayerMetadata&mid=<id>`);
  console.log(`   UA: Gecko (required)\n`);
});
