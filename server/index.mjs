import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { config } from './config.mjs';
import { handleApi } from './api.mjs';
import { getSession, attachSocket } from './pty.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// arquivos de biblioteca servidos de node_modules (sem build step)
const VENDOR = {
  '/vendor/xterm/xterm.js': path.join(config.root, 'node_modules/@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm/xterm.css': path.join(config.root, 'node_modules/@xterm/xterm/css/xterm.css'),
  '/vendor/xterm/addon-fit.js': path.join(config.root, 'node_modules/@xterm/addon-fit/lib/addon-fit.js'),
  '/vendor/marked/marked.min.js': path.join(config.root, 'node_modules/marked/marked.min.js'),
};

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('método não permitido');
  }

  const vendorPath = VENDOR[url.pathname];
  if (vendorPath) {
    if (!fs.existsSync(vendorPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('vendor ausente — rode npm install');
    }
    return serveFile(res, vendorPath);
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const resolved = path.normalize(path.join(config.publicDir, pathname));
  if (!resolved.startsWith(config.publicDir + path.sep) && resolved !== config.publicDir) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('proibido');
  }

  let target = resolved;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // SPA: qualquer rota desconhecida cai no index
    target = path.join(config.publicDir, 'index.html');
  }
  if (!fs.existsSync(target)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('não encontrado');
  }
  serveFile(res, target);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  serveStatic(req, res, url);
});

// WebSocket dos terminais: /api/pty/<id>
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const m = url.pathname.match(/^\/api\/pty\/([\w-]+)$/);
  if (!m) {
    socket.destroy();
    return;
  }
  const session = getSession(m[1]);
  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => attachSocket(session, ws));
});

server.listen(config.port, config.host, () => {
  console.log(`ai-memory-app em http://${config.host}:${config.port}`);
  console.log(`  cli: ${config.bin}`);
  console.log(`  data-dir: ${config.dataDir}`);
  console.log(`  mcp: ${config.serverUrl}/mcp`);
});

server.on('error', (err) => {
  console.error('falha no servidor:', err.message);
  process.exit(1);
});
