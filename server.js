import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://ok.ru/',
  'Origin': 'https://ok.ru',
  'X-Requested-With': 'XMLHttpRequest',
};

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

// ── GWT-RPC helpers ───────────────────────────────────────────────────────────

// GWT wire format: //OK[<csv of values>]  or  //EX[<csv>] on error.
// Values are a mix of numbers (indices into string table) and raw primitives.
// The last comma-separated chunk before the closing ] is the string table array.
// Table is 1-indexed: value "5" means strings[5-1].
function parseGwtResponse(raw) {
  if (!raw || raw.trim() === '') throw new Error('Empty GWT response');
  if (raw.startsWith('//EX')) throw new Error('GWT server error: ' + raw.slice(0, 200));
  if (!raw.startsWith('//OK')) throw new Error('Unexpected GWT response: ' + raw.slice(0, 200));

  // Strip //OK[ ... ]
  const inner = raw.replace(/^\/\/OK\[/, '').replace(/\]\s*$/, '');

  // Tokenise respecting quoted strings
  const tokens = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' && inner[i - 1] !== '\\') { inStr = !inStr; cur += c; }
    else if (c === ',' && !inStr) { tokens.push(cur); cur = ''; }
    else { cur += c; }
  }
  if (cur !== '') tokens.push(cur);

  // Last token is the string table count, second-to-last group are the strings
  // The format is: [data values...], [string table length (int)]
  // String table entries appear as quoted strings interspersed in reverse
  // Simplest robust approach: collect all quoted strings as the table,
  // and all unquoted tokens as the value stack.
  const stringTable = [];
  const valueStack = [];
  for (const t of tokens) {
    const trimmed = t.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      stringTable.push(trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    } else {
      valueStack.push(trimmed);
    }
  }

  return { stringTable, valueStack };
}

// Scan every string in the table for CDN video URLs
function extractUrlsFromGwtStrings(stringTable) {
  const results = [];
  const cdnPattern = /^https?:\/\/(vd\d+\.okcdn\.ru|ukvd\d*\.okcdn\.ru|cdntu\.okcdn\.ru)[^\s]+/;
  const hlsPattern = /^https?:\/\/[^\s]+\.m3u8[^\s]*/;

  for (const s of stringTable) {
    if (cdnPattern.test(s)) {
      // Infer quality from URL param or path hint if present
      const qMatch = s.match(/[?&](?:qual|quality|res|bitrate)=([^&]+)/i)
                  || s.match(/\/(1080|720|480|360|240|144)p?\//);
      const quality = qMatch ? qMatch[1] + (qMatch[1].match(/^\d+$/) ? 'p' : '') : 'cdn';
      results.push({ quality, url: s });
    } else if (hlsPattern.test(s)) {
      results.push({ quality: 'hls', url: s });
    }
  }
  return results;
}

// ── Strategy 1: GWT-RPC (primary — this is what ok.ru player actually uses) ───
async function resolveViaGwt(videoId) {
  const embedUrl = `https://ok.ru/videoembed/${videoId}`;

  // Step 1: fetch embed page to extract gwtHash + session cookies
  const pageRes = await fetch(embedUrl, {
    headers: {
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://ok.ru/',
    }
  });
  if (!pageRes.ok) throw new Error(`Embed page fetch failed: ${pageRes.status}`);
  const html = await pageRes.text();

  // Carry session cookies into the GWT POST (ok.ru validates them)
  const rawCookies = pageRes.headers.raw?.()?.['set-cookie']
    ?? pageRes.headers.getSetCookie?.()
    ?? [];
  const cookieHeader = rawCookies
    .map(c => c.split(';')[0])
    .join('; ');

  const gwtHashMatch = html.match(/gwtHash\s*:\s*"([^"]+)"/);
  if (!gwtHashMatch) throw new Error('gwtHash not found in embed page');
  const gwtHash = gwtHashMatch[1];

  // Step 2: build the GWT-RPC payload
  const MODULE_BASE = 'https://ok.ru/';
  const SERVICE_IFACE = 'ru.odnoklassniki.client.video.VideoService';
  const METHOD_NAME = 'getVideoInfo';
  const PARAM_TYPE = 'java.lang.String/2004016611';

  const stringTable = [MODULE_BASE, gwtHash, SERVICE_IFACE, METHOD_NAME, PARAM_TYPE, videoId];
  const payload = [
    '7',                          // GWT version
    '0',                          // flags
    stringTable.length.toString(),
    ...stringTable,
    '1',  // number of parameters
    '2',  // ref → SERVICE_IFACE
    '3',  // ref → METHOD_NAME
    '4',  // ref → PARAM_TYPE
    '5',  // param count = 1
    '6',  // ref → videoId
  ].join('|');

  // Step 3: POST to the GWT-RPC endpoint
  const gwtUrl = `https://ok.ru/gwt/videoService`;
  const gwtRes = await fetch(gwtUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/x-gwt-rpc; charset=UTF-8',
      'X-GWT-Module-Base': MODULE_BASE,
      'X-GWT-Permutation': gwtHash,
      'Referer': embedUrl,
      'Origin': 'https://ok.ru',
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(cookieHeader && { 'Cookie': cookieHeader }),
    },
    body: payload,
  });

  const rawResponse = await gwtRes.text();

  // Step 4: parse wire-format response
  const { stringTable: respStrings, valueStack } = parseGwtResponse(rawResponse);

  let videos = extractUrlsFromGwtStrings(respStrings);

  // Deduplicate
  const seen = new Set();
  videos = videos.filter(v => {
    if (seen.has(v.url)) return false;
    seen.add(v.url);
    return true;
  });

  if (videos.length > 0) return { videos, gwtHash, rawResponse };

  // No URLs found — return raw strings so /gwt-debug can show them
  return { videos: [], gwtHash, rawResponse, rawStrings: respStrings };
}

// ── Strategy 2 (was 1): ok.ru JSON API endpoint ───────────────────────────────
async function resolveViaApi(videoId) {
  const embedUrl = `https://ok.ru/videoembed/${videoId}`;
  const apiUrl = `https://ok.ru/api/videoembed/getVideoInfo`;
  const params = new URLSearchParams({ videoId, retry: '0' });

  const apiRes = await fetch(`${apiUrl}?${params}`, {
    headers: { ...BROWSER_HEADERS, 'Referer': embedUrl }
  });
  if (!apiRes.ok) return null;

  const data = await apiRes.json();
  if (data && (data.videos || data.hlsManifestUrl)) return parseVideoData(data);
  return null;
}

// ── Strategy 2: Parse the embed page's inline JSON (fallback) ─────────────────
async function resolveViaEmbed(videoId) {
  const embedUrl = `https://ok.ru/videoembed/${videoId}`;
  const res = await fetch(embedUrl, {
    headers: {
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://ok.ru/',
    }
  });
  const html = await res.text();

  // Pattern A: data-options attribute (HTML-entity encoded JSON)
  const dataOptMatch = html.match(/data-options="({[^"]*(?:videos|hlsManifest|feedId)[^"]*})"/i);
  if (dataOptMatch) {
    try {
      const decoded = dataOptMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
      return parseVideoData(JSON.parse(decoded));
    } catch {}
  }

  // Pattern B: videoSources or videos JSON array anywhere in the page
  const videosMatch = html.match(/"videos"\s*:\s*(\[.+?\])/s);
  if (videosMatch) {
    try {
      const videos = JSON.parse(videosMatch[1]);
      return videos.map(v => ({ quality: v.name || v.type || 'unknown', url: v.url }));
    } catch {}
  }

  // Pattern C: direct okcdn.ru video URLs (not static assets)
  const cdnMatches = [...html.matchAll(/https?:\/\/vd\d+\.okcdn\.ru\/[^"'\s]+/g)];
  if (cdnMatches.length > 0) {
    return cdnMatches.map((m, i) => ({ quality: `stream${i}`, url: m[0] }));
  }

  return null;
}

// ── Strategy 3: ok.ru's video page (non-embed) ───────────────────────────────
async function resolveViaVideoPage(videoId) {
  const videoUrl = `https://ok.ru/video/${videoId}`;
  const res = await fetch(videoUrl, {
    headers: {
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://ok.ru/',
    }
  });
  const html = await res.text();

  // Look for playerV2Params or similar
  const playerParamsMatch = html.match(/playerV2Params['":\s]+({.+?})[,;]/s);
  if (playerParamsMatch) {
    try {
      return parseVideoData(JSON.parse(playerParamsMatch[1]));
    } catch {}
  }

  // Encoded JSON with video info
  const encodedMatch = html.match(/data-options="({[^"]*(?:videos|feedId|hlsManifest)[^"]*})"/i);
  if (encodedMatch) {
    try {
      const decoded = encodedMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      return parseVideoData(JSON.parse(decoded));
    } catch {}
  }

  return null;
}

function parseVideoData(data) {
  const results = [];

  if (Array.isArray(data.videos)) {
    for (const v of data.videos) {
      if (v.url) results.push({ quality: v.name || v.type || 'unknown', url: v.url });
    }
  }
  if (data.hlsManifestUrl) results.push({ quality: 'hls', url: data.hlsManifestUrl });
  if (data.metadata?.videos) {
    for (const v of data.metadata.videos) {
      if (v.url) results.push({ quality: v.name || 'unknown', url: v.url });
    }
  }

  return results.length > 0 ? results : null;
}

// ── /resolve ──────────────────────────────────────────────────────────────────
app.get('/resolve', async (req, res) => {
  const { id, quality } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing video id' });

  const tried = [];

  try {
    // Strategy 1: GWT-RPC (primary — mirrors what the ok.ru player actually does)
    tried.push('gwt');
    const gwtResult = await resolveViaGwt(id);
    if (gwtResult.videos && gwtResult.videos.length > 0) {
      const chosen = pickBestVideo(gwtResult.videos, quality);
      return res.json({ id, strategy: 'gwt', gwtHash: gwtResult.gwtHash, chosen, allQualities: gwtResult.videos });
    }
    // GWT responded but we couldn't parse URLs — log for debugging
    tried.push(`gwt_no_urls:strings=${gwtResult.rawStrings?.length ?? 0}`);
  } catch (e) { tried.push(`gwt_err:${e.message}`); }

  try {
    // Strategy 2: JSON API endpoint
    tried.push('api');
    const apiResult = await resolveViaApi(id);
    if (apiResult && apiResult.length > 0) {
      const chosen = pickBestVideo(apiResult, quality);
      return res.json({ id, strategy: 'api', chosen, allQualities: apiResult });
    }
  } catch (e) { tried.push(`api_err:${e.message}`); }

  try {
    // Strategy 3: Embed page scrape
    tried.push('embed');
    const embedResult = await resolveViaEmbed(id);
    if (embedResult && embedResult.length > 0) {
      const chosen = pickBestVideo(embedResult, quality);
      return res.json({ id, strategy: 'embed', chosen, allQualities: embedResult });
    }
  } catch (e) { tried.push(`embed_err:${e.message}`); }

  try {
    // Strategy 4: Video page scrape
    tried.push('videopage');
    const pageResult = await resolveViaVideoPage(id);
    if (pageResult && pageResult.length > 0) {
      const chosen = pickBestVideo(pageResult, quality);
      return res.json({ id, strategy: 'videopage', chosen, allQualities: pageResult });
    }
  } catch (e) { tried.push(`videopage_err:${e.message}`); }

  return res.status(422).json({
    error: 'All strategies failed to find video URLs',
    tried,
    hint: 'Run /gwt-debug?id=' + id + ' to inspect raw GWT response',
  });
});

// ── /gwt-debug ────────────────────────────────────────────────────────────────
// Shows the raw GWT-RPC response + parsed string table — use this when /resolve
// fails to understand what ok.ru is actually returning.
app.get('/gwt-debug', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  try {
    const result = await resolveViaGwt(id);
    res.json({
      id,
      gwtHash: result.gwtHash,
      parsedVideos: result.videos,
      stringTableLength: result.rawStrings?.length ?? '(urls found, skipped)',
      stringTable: result.rawStrings ?? '(not captured — videos were found)',
      // First 2000 chars of raw response for inspection
      rawResponsePreview: result.rawResponse?.slice(0, 2000),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /stream ───────────────────────────────────────────────────────────────────
app.get('/stream', async (req, res) => {
  const { id, quality } = req.query;
  if (!id) return res.status(400).send('Missing id');

  try {
    const resolveRes = await fetch(`http://localhost:${PORT}/resolve?id=${id}&quality=${quality || ''}`);
    const data = await resolveRes.json();
    if (!data.chosen) return res.status(422).send(data.error || 'Could not resolve');

    const headers = { ...BROWSER_HEADERS };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const videoRes = await fetch(data.chosen.url, { headers });
    res.status(videoRes.status);
    ['content-type','content-length','content-range','accept-ranges'].forEach(h => {
      if (videoRes.headers.get(h)) res.setHeader(h, videoRes.headers.get(h));
    });
    videoRes.body.pipe(res);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ── /debug ────────────────────────────────────────────────────────────────────
app.get('/debug', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');
  const embedUrl = `https://ok.ru/videoembed/${id}`;
  const r = await fetch(embedUrl, {
    headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], 'Referer': 'https://ok.ru/' }
  });
  const html = await r.text();
  res.setHeader('Content-Type', 'text/plain');
  res.send(html);
});

// ── /player ───────────────────────────────────────────────────────────────────
app.get('/player', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OK.ru Player</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#0a0a0a; color:#fff; font-family:monospace; display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; padding:1rem; }
    h2 { margin-bottom:1rem; color:#f90; font-size:1rem; letter-spacing:2px; text-transform:uppercase; }
    video { width:100%; max-width:900px; border-radius:8px; background:#111; }
    #status { margin-top:1rem; font-size:0.75rem; color:#666; max-width:900px; word-break:break-all; }
    #qualities { margin-top:0.5rem; display:flex; gap:0.5rem; flex-wrap:wrap; }
    button { background:#222; color:#f90; border:1px solid #f90; padding:4px 12px; border-radius:4px; cursor:pointer; font-family:monospace; font-size:0.75rem; }
    button:hover, button.active { background:#f90; color:#000; }
  </style>
</head>
<body>
  <h2>OK.ru Proxy — <span style="color:#888">${id}</span></h2>
  <video id="vid" controls playsinline></video>
  <div id="qualities"></div>
  <div id="status">Resolving…</div>
  <script>
    const vid = document.getElementById('vid');
    const status = document.getElementById('status');
    const qualDiv = document.getElementById('qualities');
    async function load() {
      const res = await fetch('/resolve?id=${id}');
      const data = await res.json();
      if (data.error) { status.textContent = 'Error: ' + data.error + ' | tried: ' + (data.tried||[]).join(', '); return; }
      status.textContent = '[' + data.strategy + '] ' + data.chosen.quality + ' — ' + data.chosen.url.slice(0,80) + '…';
      vid.src = '/stream?id=${id}&quality=' + data.chosen.quality;
      if (data.allQualities) {
        data.allQualities.forEach(q => {
          const btn = document.createElement('button');
          btn.textContent = q.quality;
          if (q.quality === data.chosen.quality) btn.classList.add('active');
          btn.onclick = () => {
            vid.src = '/stream?id=${id}&quality=' + q.quality;
            document.querySelectorAll('button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          };
          qualDiv.appendChild(btn);
        });
      }
    }
    load();
  </script>
</body>
</html>`);
});
app.get('/cookie-debug', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  
  const embedUrl = `https://ok.ru/videoembed/${id}`;
  const pageRes = await fetch(embedUrl, {
    headers: {
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://ok.ru/',
    }
  });
  const html = await pageRes.text();
  
  const rawCookies = pageRes.headers.raw?.()?.['set-cookie']
    ?? pageRes.headers.getSetCookie?.()
    ?? [];

  // Grab anything that looks like a GWT service URL from the page JS
  const gwtUrls = [...html.matchAll(/["'](\/[^"']*(?:gwt|rpc|service|video)[^"']*?)["']/gi)]
    .map(m => m[1])
    .filter(u => u.length < 100);

  // Also grab the moduleBase hint
  const moduleBase = html.match(/moduleBase\s*[=:]\s*["']([^"']+)["']/)?.[1];
  const gwtHash = html.match(/gwtHash\s*:\s*"([^"]+)"/)?.[1];

  res.json({
    cookieCount: rawCookies.length,
    cookies: rawCookies.map(c => c.split(';')[0]),
    gwtUrlCandidates: [...new Set(gwtUrls)],
    moduleBase,
    gwtHash,
  });
});
app.get('/', (req, res) => res.json({
  endpoints: {
    '/resolve?id=<videoId>': 'Returns all quality URLs (JSON)',
    '/stream?id=<videoId>&quality=720p': 'Proxies video bytes',
    '/player?id=<videoId>': 'HTML5 player page',
    '/debug?id=<videoId>': 'Raw embed page HTML',
  }
}));

app.listen(PORT, () => {
  console.log(`\n✅ ok.ru proxy running at http://localhost:${PORT}`);
  console.log(`   Player:  http://localhost:${PORT}/player?id=11443520473746`);
  console.log(`   Resolve: http://localhost:${PORT}/resolve?id=11443520473746\n`);
});
                       
