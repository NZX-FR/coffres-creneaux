// Serveur local de test : sert public/ et l'API avec un stockage en mémoire.  node tests/dev-server.mjs 8787
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { handle } from '../netlify/lib/core.mjs';
import { memStore } from './memstore.mjs';
const st = memStore(), port = +process.argv[2] || 8787;
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handle(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks) }), st);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  try { const f = await readFile(new URL('../public' + (url.pathname === '/' ? '/index.html' : url.pathname), import.meta.url)); res.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' }); res.end(f); }
  catch { res.writeHead(404); res.end('404'); }
}).listen(port, () => console.log('http://localhost:' + port));
