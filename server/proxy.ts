import { IncomingMessage, ServerResponse } from 'http';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import zlib from 'zlib';

const PROXY_PATH = '/api/proxy';

// Persistent keep-alive agents — reuse TCP sockets across requests
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 512,
  maxFreeSockets: 128,
  timeout: 20000,
  scheduling: 'fifo',
});
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 512,
  maxFreeSockets: 128,
  timeout: 20000,
  scheduling: 'fifo',
});

// Simple in-memory cache for m3u8 manifests (short TTL)
interface CacheEntry { body: Buffer; contentType: string; ts: number; }
const manifestCache = new Map<string, CacheEntry>();
const MANIFEST_TTL = 4000;

function cleanCache() {
  const now = Date.now();
  for (const [k, v] of manifestCache) {
    if (now - v.ts > MANIFEST_TTL * 5) manifestCache.delete(k);
  }
}
setInterval(cleanCache, 30000);

function getSpooferHeaders(url: string): Record<string, string> {
  let referer = 'https://hianime.to/';
  let origin  = 'https://hianime.to';

  if (url.includes('megacloud'))         { referer = 'https://megacloud.com/';      origin = 'https://megacloud.com'; }
  else if (url.includes('rapid-cloud'))  { referer = 'https://rapid-cloud.co/';     origin = 'https://rapid-cloud.co'; }
  else if (url.includes('rabbitstream')) { referer = 'https://rabbitstream.net/';    origin = 'https://rabbitstream.net'; }
  else if (url.includes('vizcloud'))     { referer = 'https://vizcloud.co/';         origin = 'https://vizcloud.co'; }
  else if (url.includes('streamindia'))  { referer = 'https://streamindia.co.in/';  origin = 'https://streamindia.co.in'; }

  return {
    'Referer':              referer,
    'Origin':               origin,
    'User-Agent':           'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept':               '*/*',
    'Accept-Language':      'en-US,en;q=0.9',
    'Accept-Encoding':      'gzip, deflate, br',
    'Cache-Control':        'no-cache',
    'Pragma':               'no-cache',
    'Sec-Ch-Ua':            '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile':     '?0',
    'Sec-Ch-Ua-Platform':   '"Windows"',
    'Sec-Fetch-Dest':       'empty',
    'Sec-Fetch-Mode':       'cors',
    'Sec-Fetch-Site':       'cross-site',
    'DNT':                  '1',
    'Connection':           'keep-alive',
  };
}

function rewriteM3U8(body: string, baseUrl: string): string {
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;

    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
        try {
          const abs = new URL(uri, baseUrl).href;
          return `URI="${PROXY_PATH}?url=${encodeURIComponent(abs)}"`;
        } catch { return _m; }
      });
    }

    try {
      const abs = new URL(t, baseUrl).href;
      return `${PROXY_PATH}?url=${encodeURIComponent(abs)}`;
    } catch { return line; }
  }).join('\n');
}

function decompressResponse(proxyRes: IncomingMessage): NodeJS.ReadableStream {
  const enc = proxyRes.headers['content-encoding'] || '';
  if (enc.includes('br'))      return proxyRes.pipe(zlib.createBrotliDecompress());
  if (enc.includes('gzip'))    return proxyRes.pipe(zlib.createGunzip());
  if (enc.includes('deflate')) return proxyRes.pipe(zlib.createInflate());
  return proxyRes;
}

function fetchWithRetry(
  targetUrl: string,
  headers: Record<string, string>,
  res: ServerResponse,
  attempt = 0
): void {
  const isHttps = targetUrl.startsWith('https');
  const client  = isHttps ? https : http;
  const agent   = isHttps ? httpsAgent : httpAgent;
  const timeout = attempt === 0 ? 12000 : 18000;

  // Track whether we have started writing the response (headers sent or piping started).
  // Once this is true, retrying is no longer safe.
  let responseStarted = false;

  const proxyReq = client.request(targetUrl, {
    method: 'GET',
    headers,
    agent,
    timeout,
  }, (proxyRes) => {
    const status = proxyRes.statusCode || 200;

    // Retry on Cloudflare / server challenges only if nothing was written yet
    if ((status === 403 || status === 429 || status === 503) && attempt < 2) {
      proxyRes.resume();
      setTimeout(() => fetchWithRetry(targetUrl, headers, res, attempt + 1), 300 * (attempt + 1));
      return;
    }

    responseStarted = true;

    // CORS headers on every response
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');

    const rawContentType = proxyRes.headers['content-type'] || '';
    const isM3U8 = rawContentType.includes('mpegurl') ||
                   rawContentType.includes('mpegURL') ||
                   targetUrl.split('?')[0].endsWith('.m3u8') ||
                   targetUrl.includes('playlist');

    if (isM3U8) {
      // Serve from cache if fresh
      const cached = manifestCache.get(targetUrl);
      if (cached && Date.now() - cached.ts < MANIFEST_TTL) {
        proxyRes.resume();
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(cached.body);
        return;
      }

      const chunks: Buffer[] = [];
      const stream = decompressResponse(proxyRes);
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const raw      = Buffer.concat(chunks).toString('utf-8');
        const rewritten = rewriteM3U8(raw, targetUrl);
        const outBuf   = Buffer.from(rewritten, 'utf-8');

        manifestCache.set(targetUrl, { body: outBuf, contentType: 'application/vnd.apple.mpegurl', ts: Date.now() });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Content-Length', outBuf.length);
        res.setHeader('Cache-Control', 'no-cache');
        res.end(outBuf);
      });
      stream.on('error', () => {
        if (!res.headersSent) { res.statusCode = 502; res.end('M3U8 read error'); }
      });
    } else {
      // Binary segment — pipe directly, no buffering
      res.statusCode = status;
      res.setHeader('Content-Type', rawContentType || 'video/mp2t');
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

      if (proxyRes.headers['content-length']) {
        res.setHeader('Content-Length', proxyRes.headers['content-length']);
      }
      if (proxyRes.headers['content-range']) {
        res.setHeader('Content-Range', proxyRes.headers['content-range']!);
      }

      proxyRes.pipe(res);
      proxyRes.on('error', () => { try { res.end(); } catch {} });
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!responseStarted && attempt < 2) {
      fetchWithRetry(targetUrl, headers, res, attempt + 1);
    } else if (!res.headersSent) {
      res.statusCode = 504;
      res.end('Proxy Timeout');
    }
  });

  proxyReq.on('error', (err) => {
    if (!responseStarted && attempt < 2) {
      setTimeout(() => fetchWithRetry(targetUrl, headers, res, attempt + 1), 200 * (attempt + 1));
    } else if (!res.headersSent) {
      res.statusCode = 502;
      res.end(`Proxy Error: ${err.message}`);
    }
  });

  proxyReq.end();
}

export function handleProxyRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url) return false;

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!urlObj.pathname.startsWith(PROXY_PATH)) return false;

  // Handle CORS preflight fast
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.statusCode = 204;
    res.end();
    return true;
  }

    // Extract `url=` from the raw query string using a single decodeURIComponent.
    // We must NOT use urlObj.searchParams.get('url') because the URL API
    // auto-decodes query params, which over-decodes nested encoded URLs
    // like ts-proxy?url=...&headers=%7B...%7D → headers={...} (literal JSON),
    // causing downstream servers to reject the request with a 500.
    const rawSearch = urlObj.search.slice(1); // strip leading '?'
    let targetUrl: string | null = null;

    const urlMatch = rawSearch.match(/(?:^|&)url=([^&]*)/);
    if (urlMatch) {
      try { targetUrl = decodeURIComponent(urlMatch[1]); } catch { targetUrl = urlMatch[1]; }
    }

    if (!targetUrl) {
      const b64Match = rawSearch.match(/(?:^|&)b64=([^&]*)/);
      if (b64Match) {
        try { targetUrl = Buffer.from(decodeURIComponent(b64Match[1]), 'base64').toString('utf-8'); } catch {}
      }
    }

  if (!targetUrl) {
    res.statusCode = 400;
    res.end('Missing url or b64 parameter');
    return true;
  }

  const headers = getSpooferHeaders(targetUrl);
  fetchWithRetry(targetUrl, headers, res, 0);
  return true;
}
