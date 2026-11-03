import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 8888;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ENV_FILE = path.join(__dirname, '.env');
const API_FILE = path.join(__dirname, 'netlify', 'functions', 'api.mjs');

// 1. Carregar variáveis do .env caso existam
if (fs.existsSync(ENV_FILE)) {
  const envContent = fs.readFileSync(ENV_FILE, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      const k = trimmed.substring(0, idx).trim();
      const v = trimmed.substring(idx + 1).trim();
      process.env[k] = v;
    }
  }
}

// 2. Importar o backend da API
let apiHandler = null;
try {
  const apiModule = await import(pathToFileURL(API_FILE).href);
  apiHandler = apiModule.default;
} catch (err) {
  console.error('[ERRO] Falha ao carregar netlify/functions/api.mjs:', err);
}

// Mapa de tipos MIME
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

// Obter os IPs locais para exibição no terminal
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

// 3. Criar Servidor HTTP
const server = http.createServer(async (req, res) => {
  const originHeader = req.headers.host || `localhost:${PORT}`;
  const requestUrl = new URL(req.url, `http://${originHeader}`);
  const pathname = requestUrl.pathname;

  // Headers de segurança globais (definidos no netlify.toml)
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Roteamento da API (/api/* ou /.netlify/functions/api/*)
  if (pathname.startsWith('/api') || pathname.startsWith('/.netlify/functions/api')) {
    if (!apiHandler) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: 'API Handler não carregado.' }));
      return;
    }

    try {
      // Coletar body de requisições POST/PUT/PATCH
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks);

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) {
          for (const item of v) headers.append(k, item);
        } else if (v !== undefined) {
          headers.set(k, v);
        }
      }

      const webRequest = new Request(requestUrl.href, {
        method: req.method,
        headers,
        body: (req.method !== 'GET' && req.method !== 'HEAD' && rawBody.length > 0) ? rawBody : undefined,
        duplex: 'half'
      });

      const webResponse = await apiHandler(webRequest);

      res.statusCode = webResponse.status;
      webResponse.headers.forEach((val, key) => {
        if (key.toLowerCase() === 'set-cookie') {
          const rawCookies = webResponse.headers.getSetCookie ? webResponse.headers.getSetCookie() : [val];
          res.setHeader('Set-Cookie', rawCookies);
        } else {
          res.setHeader(key, val);
        }
      });

      const bodyBuf = await webResponse.arrayBuffer();
      res.end(Buffer.from(bodyBuf));
      return;
    } catch (err) {
      console.error('[ERRO API]:', err);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: 'Erro interno no servidor local.' }));
      return;
    }
  }

  // Roteamento de Arquivos Estáticos (Frontend em public/)
  let targetPath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  // Prevenção contra Directory Traversal
  if (!targetPath.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    res.end('Acesso negado');
    return;
  }

  // Fallback SPA: se o arquivo não existir, entrega o index.html
  if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
    targetPath = path.join(PUBLIC_DIR, 'index.html');
  }

  if (fs.existsSync(targetPath)) {
    const ext = path.extname(targetPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 200;
    fs.createReadStream(targetPath).pipe(res);
  } else {
    res.statusCode = 404;
    res.end('Arquivo nao encontrado em public/');
  }
});

server.listen(PORT, HOST, () => {
  console.log('===========================================================');
  console.log('   LOGISTIX360 — SERVIDOR LOCAL (SUPABASE DATABASE)        ');
  console.log('===========================================================');
  console.log(`\n  🚀 Servidor ativo e escutando na porta ${PORT}!\n`);
  console.log(`  🔗 Acesso Local:       http://localhost:${PORT}`);
  const ips = getLocalIPs();
  for (const ip of ips) {
    console.log(`  🌐 Acesso na Rede:     http://${ip}:${PORT}`);
  }
  console.log('\n  Pressione Ctrl+C para encerrar o servidor.');
  console.log('===========================================================\n');
});
