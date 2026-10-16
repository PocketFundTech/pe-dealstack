#!/usr/bin/env node
/**
 * Avise API console server: serves index.html and forwards the page's calls to
 * an allowlisted API base, so the page also works against hosts whose CORS
 * allowlist doesn't include localhost.
 *
 *   node apps/api/tools/api-console/server.mjs        # http://localhost:4000
 *
 * Zero dependencies. Safety rails:
 *   - binds to 127.0.0.1 only
 *   - forwards only to the bases in ALLOWED_BASES
 *   - accepts /run only when the browser's Origin is this server itself
 *   - the key is sent per request from the page's memory; never stored or logged
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);
const HOST = '127.0.0.1';
const ALLOWED_BASES = new Set([
  'http://localhost:3101', 'http://localhost:3102', 'http://localhost:3103',
  'https://app.avise.io', 'https://deals.avise.io',
]);
const SELF_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(await readFile(join(here, 'index.html')));
  }
  if (req.method === 'GET' && req.url === '/bases') return send(res, 200, [...ALLOWED_BASES]);
  if (req.method === 'POST' && req.url === '/run') {
    if (!SELF_ORIGINS.has(req.headers.origin || '')) return send(res, 403, { status: 0, text: 'foreign origin' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const { base, method, path, key, body } = JSON.parse(raw);
      if (!ALLOWED_BASES.has(base)) throw new Error('base not allowlisted: ' + base);
      if (!/^\/api\/[\w\-./?=&%:]*$/.test(path)) throw new Error('bad path');
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw new Error('bad method');
      const headers = {};
      if (key) headers.Authorization = `Bearer ${key}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const started = Date.now();
      const r = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await r.text();
      return send(res, 200, { status: r.status, ms: Date.now() - started, text: text.slice(0, 20000) });
    } catch (err) {
      return send(res, 200, { status: 0, ms: 0, text: String(err?.message || err) });
    }
  }
  res.writeHead(404).end();
}).listen(PORT, HOST, () => console.log(`Avise API console → http://localhost:${PORT}`));
