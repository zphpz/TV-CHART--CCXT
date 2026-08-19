/**
 * server.js — Lightweight Local HTTP Server & Polymarket API Proxy v3.7
 * Usage: node server.js
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8088;
const ROOT_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function proxyPolymarketCrypto(req, res) {
  const targetUrl = 'https://polymarket.com' + req.url;
  console.log('[Proxy] Fetching:', targetUrl);

  const parsedUrl = new URL(targetUrl);
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Origin': 'https://polymarket.com',
      'Referer': 'https://polymarket.com/crypto/5m',
    }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[Proxy] Request failed:', err.message);
    res.writeHead(502, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ error: 'Proxy request failed: ' + err.message }));
  });

  proxyReq.end();
}

function handleTargetPrice(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  let startIso = parsedUrl.searchParams.get('startDate');
  let endIso = parsedUrl.searchParams.get('endDate');
  const lookback = parsedUrl.searchParams.get('twapLookbackSeconds') || '60';

  if (!startIso || !endIso) {
    const nowSec = Math.floor(Date.now() / 1000);
    const winStartSec = Math.floor(nowSec / 300) * 300;
    const winEndSec = winStartSec + 300;
    startIso = new Date(winStartSec * 1000).toISOString().replace('.000Z', 'Z');
    endIso = new Date(winEndSec * 1000).toISOString().replace('.000Z', 'Z');
  }

  const targetUrl = `https://api.preddy.trade/crypto/price?symbol=btc&startDate=${encodeURIComponent(startIso)}&endDate=${encodeURIComponent(endIso)}&twapLookbackSeconds=${lookback}`;

  https.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      res.writeHead(proxyRes.statusCode || 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
    });
  }).on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: err.message }));
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/save-history') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        fs.writeFileSync(path.join(ROOT_DIR, 'history.json'), body, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.url.startsWith('/api/target-price')) {
    handleTargetPrice(req, res);
    return;
  }

  if (req.url.startsWith('/api/crypto/')) {
    proxyPolymarketCrypto(req, res);
    return;
  }

  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';

  const filePath = path.join(ROOT_DIR, reqPath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found: ' + reqPath);
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Internal Server Error: ' + err.message);
      }
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log(`🚀 POLYMARKET BTC 1:1 LIVE SERVER (v7.1)`);
  console.log(`💻 Local: http://localhost:${PORT}`);
  console.log('='.repeat(60));
});
