import fs from 'node:fs';
import path from 'node:path';

const LOCAL_STORE = path.join(process.cwd(), '.local_store.json');
const readStoreRaw = () => fs.readFileSync(LOCAL_STORE, 'utf8').replace(/^\uFEFF/, '');
function getLocal(k, def) {
  try {
    if (fs.existsSync(LOCAL_STORE)) {
      const s = JSON.parse(readStoreRaw());
      if (k in s) return s[k];
    }
  } catch {}
  return def;
}
function setLocal(k, v) {
  try {
    let s = {};
    if (fs.existsSync(LOCAL_STORE)) s = JSON.parse(readStoreRaw());
    s[k] = v;
    fs.writeFileSync(LOCAL_STORE, JSON.stringify(s, null, 2), 'utf8');
  } catch (e) {
    console.error('[LocalStore Error]:', e);
  }
}
function delLocal(k) {
  try {
    if (fs.existsSync(LOCAL_STORE)) {
      const s = JSON.parse(readStoreRaw());
      delete s[k];
      fs.writeFileSync(LOCAL_STORE, JSON.stringify(s, null, 2), 'utf8');
    }
  } catch {}
}
import crypto from 'node:crypto';

// ==============================================================================
// CONFIGURAÇÃO DO BANCO DE DADOS SUPABASE
// ==============================================================================
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const SITE_URL = (process.env.SITE_URL || process.env.URL || 'http://localhost:8888').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';
const TABLE_NAME = process.env.SUPABASE_TABLE || 'logistix_store';

let _supabase = null;
let _sdkAttempted = false;

async function getSupabase() {
  if (!_supabase && !_sdkAttempted && SUPABASE_URL && SUPABASE_KEY) {
    _sdkAttempted = true;
    try {
      const { createClient } = await import('@supabase/supabase-js');
      _supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
    } catch {
      // SDK opcional: caso não esteja instalado, a API utiliza o cliente HTTP REST nativo
    }
  }
  return _supabase;
}

async function sendResendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY || '';
  if (!apiKey) {
    console.warn('[Resend] RESEND_API_KEY não configurada no ambiente.');
    return { ok: false, error: 'Serviço de e-mail não configurado.' };
  }
  const fromEmail = process.env.RESEND_FROM || 'onboarding@resend.dev';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Logistix360 <' + fromEmail + '>',
        to: Array.isArray(to) ? to : [to],
        subject,
        html
      })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[Resend Error]', data);
      return { ok: false, error: data.message || 'Falha ao enviar e-mail pelo Resend.' };
    }
    return { ok: true, data };
  } catch (err) {
    console.error('[Resend Fetch Exception]', err);
    return { ok: false, error: err.message || 'Erro de conexão com Resend.' };
  }
}

const SESSION_TTL = 8 * 60 * 60 * 1000;
const COOKIE = 'logi_session';

const json = (data, status=200, headers={}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  }
});

const b64u = b => Buffer.from(b).toString('base64url');
const random = n => crypto.randomBytes(n).toString('base64url');
const hashPassword = (password, salt=random(16)) => ({
  salt,
  hash: crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('base64url')
});

const checkPassword = (password, u) => {
  if (!u) return false;
  if (u.plainPassword && (password === u.plainPassword || password === String(u.plainPassword).trim())) return true;
  if (u.senha && (password === u.senha || password === String(u.senha).trim())) return true;
  if (!u?.passwordHash || !u?.passwordSalt) return false;
  for (const iterations of [Number(u.passwordIterations) || 210000, 120000]) {
    const h = crypto.pbkdf2Sync(password, u.passwordSalt, iterations, 32, 'sha256').toString('base64url');
    const a = Buffer.from(h), b = Buffer.from(u.passwordHash);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
};

const isHttps = req => {
  try { if (new URL(req.url).protocol === 'https:') return true; } catch {}
  return String(req.headers.get('x-forwarded-proto') || '').toLowerCase().split(',')[0].trim() === 'https';
};
const cookie = (token, maxAge=SESSION_TTL, req=null) => `${COOKIE}=${token}; Path=/; HttpOnly;${(!req || isHttps(req)) ? ' Secure;' : ''} SameSite=Lax; Max-Age=${Math.floor(maxAge/1000)}`;

// ==============================================================================
// OPERAÇÕES DE PERSISTÊNCIA NO SUPABASE (SDK + Fallback REST Nativo)
// ==============================================================================
async function read(key, fallback) {
  const localVal = getLocal(key, null);
  if (localVal !== null) fallback = localVal;
  const sb = await getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from(TABLE_NAME)
      .select('value')
      .eq('key', key)
      .maybeSingle();

    if (error) {
      console.error(`[Supabase Read Error "${key}"]:`, error.message);
      return fallback;
    }
    return data?.value ?? fallback;
  }

  // Fallback direto via REST HTTP nativo (PostgREST do Supabase)
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE_NAME}?key=eq.${encodeURIComponent(key)}&select=value`, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Accept': 'application/json'
        }
      });
      if (res.ok) {
        const rows = await res.json();
        return rows?.[0]?.value ?? fallback;
      }
    } catch (e) {
      console.error(`[Supabase REST Read Error "${key}"]:`, e);
    }
  }

  console.warn(`[Supabase] Credenciais não configuradas para leitura da chave "${key}". Retornando fallback.`);
  return fallback;
}

async function write(key, value) {
  invalidateStateCache();
  setLocal(key, value);
  const now = new Date().toISOString();
  const sb = await getSupabase();
  if (sb) {
    const { error } = await sb
      .from(TABLE_NAME)
      .upsert({ key, value, updated_at: now }, { onConflict: 'key' });

    if (error) {
      console.error(`[Supabase Write Error "${key}"]:`, error.message);
      throw error;
    }
    return;
  }

  // Fallback direto via REST HTTP nativo (PostgREST do Supabase)
  if (SUPABASE_URL && SUPABASE_KEY) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE_NAME}`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify([{ key, value, updated_at: now }])
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Supabase REST Write Error "${key}"]:`, errText);
      return;
    }
    return;
  }

  return;
}

async function del(key) {
  delLocal(key);
  const sb = await getSupabase();
  if (sb) {
    const { error } = await sb
      .from(TABLE_NAME)
      .delete()
      .eq('key', key);

    if (error) console.error(`[Supabase Delete Error "${key}"]:`, error.message);
    return;
  }

  // Fallback direto via REST HTTP nativo (PostgREST do Supabase)
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/${TABLE_NAME}?key=eq.${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      });
    } catch (e) {
      console.error(`[Supabase REST Delete Error "${key}"]:`, e);
    }
  }
}

// ==============================================================================
// GESTÃO DE USUÁRIOS E SEGURANÇA
// ==============================================================================
const envPasswordFingerprint = password => password ? crypto.createHash('sha256').update(String(password)).digest('base64url') : null;

const sharedEmail = () => String(process.env.LOGISTIX_SHARED_EMAIL || '').trim().toLowerCase();

// Perfis individualizados por usuario (Fornecedores e Transportadoras distintas e independentes)
const EXTRA_SHARED_USERS = [
  {
    prefix: 'samuel',
    nomeAdmin: 'Samuel Fragoso (Admin)',
    nomeForn: 'Malharia Farm Rio',
    nomeTransp: 'Total Express Cargas',
    email: 'samuel.fragoso@farmrio.com.br'
  },
  {
    prefix: 'natalia',
    nomeAdmin: 'Natalia Alves (Admin)',
    nomeForn: 'Oficina Carioca Reserva',
    nomeTransp: 'Jadlog Express',
    email: 'natalia.alves@usereserva.com'
  },
  {
    prefix: 'adriano',
    nomeAdmin: 'Adriano Soares (Admin)',
    nomeForn: 'Farm Rio Confeccoes',
    nomeTransp: 'Rodonaves Transportes',
    email: 'adriano.soares@farmrio.com.br'
  }
];

// IDs gerenciados pelo sistema
const MANAGED_IDS = [
  'admin01', 'forn01', 'brasspress01',
  ...EXTRA_SHARED_USERS.flatMap(u => [u.prefix + '_admin', u.prefix + '_forn', u.prefix + '_transp'])
];

async function ensureUsers() {
  let users = await read('users', null);
  const shared = sharedEmail();
  const adminPass = process.env.LOGISTIX_ADMIN_PASSWORD || '';
  const fornPass = process.env.LOGISTIX_FORNECEDOR_PASSWORD || '';
  const transpPass = process.env.LOGISTIX_TRANSPORTADORA_PASSWORD || '';

  const make = (id, nome, tipo, email, pass, cobertura=[]) => {
    const h = hashPassword(pass);
    return {
      id, nome, tipo, email, cobertura,
      passwordSalt: h.salt,
      passwordHash: h.hash,
      passwordIterations: 210000,
      emailVinculado: true,
      dadosColeta: {},
      createdAt: new Date().toISOString(),
      managedPasswordFingerprint: envPasswordFingerprint(pass)
    };
  };

  const a = adminPass || 'Admin@123', f = fornPass || 'Forn@123', t = transpPass || 'Brass@123';

  if (!Array.isArray(users) || !users.length) {
    users = [
      make('admin01', 'Raony Borges (Admin Reserva)', 'admin', shared || 'admin@logistix.com', a, ['TODAS']),
      make('forn01', 'Reserva Confeccoes & Industria', 'fornecedor', shared || 'fornecedor@empresa.com', f, []),
      make('brasspress01', 'Braspress Logistica', 'transportadora', shared || 'brasspress@logistix.com', t, ['TODAS'])
    ];
    for (const eu of EXTRA_SHARED_USERS) {
      users.push(
        make(eu.prefix + '_admin', eu.nomeAdmin, 'admin', eu.email, a, ['TODAS']),
        make(eu.prefix + '_forn', eu.nomeForn, 'fornecedor', eu.email, f, []),
        make(eu.prefix + '_transp', eu.nomeTransp, 'transportadora', eu.email, t, ['SP', 'RJ', 'MG', 'ES'])
      );
    }
    await write('users', users);
    return users;
  }

  // Sincronizar perfis base (Raony)
  const baseConfig = [
    { id: 'admin01', nome: 'Raony Borges (Admin Reserva)', pass: a },
    { id: 'forn01', nome: 'Reserva Confeccoes & Industria', pass: f },
    { id: 'brasspress01', nome: 'Braspress Logistica', pass: t }
  ];
  let changed = false;
  for (const b of baseConfig) {
    const i = users.findIndex(x => x.id === b.id);
    if (i < 0) continue;
    if (users[i].nome !== b.nome) { users[i].nome = b.nome; changed = true; }
    if (shared && String(users[i].email || '').toLowerCase() !== shared) {
      users[i] = { ...users[i], email: shared };
      changed = true;
    }
    if (b.pass) {
      const fp = envPasswordFingerprint(b.pass);
      if (users[i].managedPasswordFingerprint !== fp) {
        const h = hashPassword(b.pass);
        users[i] = {
          ...users[i],
          passwordSalt: h.salt,
          passwordHash: h.hash,
          passwordIterations: 210000,
          managedPasswordFingerprint: fp,
          customPassword: false
        };
        delete users[i].plainPassword;
        delete users[i].senha;
        changed = true;
      }
    }
  }

  // Provisionar e sincronizar perfis individuais dos demais usuarios
  for (const eu of EXTRA_SHARED_USERS) {
    const profs = [
      { id: eu.prefix + '_admin', nome: eu.nomeAdmin, tipo: 'admin', pass: a, cob: ['TODAS'] },
      { id: eu.prefix + '_forn', nome: eu.nomeForn, tipo: 'fornecedor', pass: f, cob: [] },
      { id: eu.prefix + '_transp', nome: eu.nomeTransp, tipo: 'transportadora', pass: t, cob: ['SP', 'RJ', 'MG', 'ES'] }
    ];
    for (const p of profs) {
      const idx = users.findIndex(x => x.id === p.id);
      if (idx < 0) {
        users.push(make(p.id, p.nome, p.tipo, eu.email, p.pass, p.cob));
        changed = true;
      } else {
        if (users[idx].nome !== p.nome) {
          users[idx].nome = p.nome;
          changed = true;
        }
        if (String(users[idx].email || '').toLowerCase() !== eu.email.toLowerCase()) {
          users[idx] = { ...users[idx], email: eu.email };
          changed = true;
        }
        const fp = envPasswordFingerprint(p.pass);
        if (users[idx].managedPasswordFingerprint !== fp) {
          const h = hashPassword(p.pass);
          users[idx] = {
            ...users[idx],
            passwordSalt: h.salt,
            passwordHash: h.hash,
            passwordIterations: 210000,
            managedPasswordFingerprint: fp,
            customPassword: false
          };
          delete users[idx].plainPassword;
          delete users[idx].senha;
          changed = true;
        }
      }
    }
  }

  if (changed) await write('users', users);
  return users;
}
async function getSession(req) {
  const raw = req.headers.get('cookie') || '';
  const m = raw.match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return null;
  const s = await read('session:' + m[1], null);
  if (!s || Date.now() > s.exp) {
    if (s) await del('session:' + m[1]);
    return null;
  }
  return s;
}

function publicUser(u) {
  const { passwordHash, passwordSalt, ...safe } = u;
  return safe;
}

function cobreUF(u, ufOrigem) {
  const cobertura = Array.isArray(u?.cobertura) ? u.cobertura : [];
  if (cobertura.some(x => String(x).trim().toUpperCase() === 'TODAS' || String(x).trim().toUpperCase() === 'NACIONAL' || String(x).trim().toUpperCase() === 'NATIONAL')) return true;
  const uf = String(ufOrigem || '').trim().toUpperCase();
  return Boolean(uf) && cobertura.some(x => String(x).trim().toUpperCase() === uf);
}

function allowed(p, u) {
  if (!p || !u) return false;
  if (u.tipo === 'admin') return true;
  if (u.tipo === 'fornecedor') return p.criadoPorId === u.id;
  if (u.tipo === 'transportadora') return p.transportadoraVencedoraID === u.id || (p.status === 'Aguardando Aceite da Transportadora' && cobreUF(u, p.ufOrigem));
  return false;
}

function visibleOrders(orders, u) {
  return (orders || []).filter(p => allowed(p, u)).map(p => {
    if (u.tipo === 'transportadora' && p.transportadoraVencedoraID !== u.id) {
      const safe = { ...p };
      delete safe.mensagensChat;
      return safe;
    }
    if (u.tipo === 'fornecedor') {
      // Fornecedor vê apenas canal admin_fornecedor
      const safe = { ...p };
      safe.mensagensChat = (p.mensagensChat || []).filter(m => !m.canal || m.canal === 'admin_fornecedor');
      return safe;
    }
    if (u.tipo === 'transportadora') {
      // Transportadora vê apenas canal admin_transportadora
      const safe = { ...p };
      safe.mensagensChat = (p.mensagensChat || []).filter(m => m.canal === 'admin_transportadora');
      return safe;
    }
    return p;
  });
}

function visibleTickets(tickets, u) {
  if (u.tipo === 'admin') return tickets || [];
  return (tickets || []).filter(t => t.criadoPorId === u.id || t.usuarioId === u.id || t.perfilId === u.id || t.pedido?.criadoPorId === u.id || t.pedido?.transportadoraVencedoraID === u.id);
}

// Cache de estado bruto por 2 s para evitar releituras em rajadas de requisições
const _rawStateCache = { data: null, at: 0 };
async function rawState() {
  const now = Date.now();
  if (_rawStateCache.data && now - _rawStateCache.at < 2000) return _rawStateCache.data;
  const [orders, tickets, users, meta] = await Promise.all([
    read('orders', []),
    read('tickets', []),
    ensureUsers(),
    read('meta', { version: 0 })
  ]);
  _rawStateCache.data = { orders, tickets, users, meta };
  _rawStateCache.at = now;
  return _rawStateCache.data;
}
function invalidateStateCache() { _rawStateCache.at = 0; }

async function stateFor(u) {
  const { orders, tickets, users, meta } = await rawState();
  return {
    pedidos: visibleOrders(orders, u),
    usuarios: u.tipo === 'admin' ? users.map(publicUser) : [publicUser(users.find(x => x.id === u.id))].filter(Boolean),
    ticketsSuporte: visibleTickets(tickets, u),
    version: Number(meta?.version || 0),
    timestamp: Date.now()
  };
}

function forbidden(msg='Acesso negado') {
  return json({ ok: false, error: msg }, 403);
}

// ==============================================================================
// HANDLERS DE AUTENTICAÇÃO E SINCRONIZAÇÃO
// ==============================================================================
async function login(req) {
  const body = await req.json();
  const emailInput = String(body.email || body.perfil || '').trim().toLowerCase();
  const pass = String(body.senha || '');
  if (!emailInput || !pass) return json({ ok: false, error: 'Informe seu e-mail e senha.' }, 400);

  const users = await ensureUsers();
  // Pode haver mais de um perfil com o mesmo e-mail: a senha digitada define qual deles entra.
  const candidates = users.filter(x =>
    (x.email && x.email.toLowerCase() === emailInput) ||
    String(x.id).toLowerCase() === emailInput
  );

  if (!candidates.length) return json({ ok: false, error: 'E-mail não cadastrado.' }, 401);

  // Senhas padrão de demonstração só valem se a senha do perfil NÃO estiver definida no ambiente
  const demoPasswords = {
    admin01: [process.env.LOGISTIX_ADMIN_PASSWORD, ['AdminLocal@123', 'Admin@123']],
    forn01: [process.env.LOGISTIX_FORNECEDOR_PASSWORD, ['FornLocal@123', 'Forn@123']],
    brasspress01: [process.env.LOGISTIX_TRANSPORTADORA_PASSWORD, ['BrassLocal@123', 'Brass@123']]
  };
  // Estender demoPasswords para usuarios extras
  for (const eu of EXTRA_SHARED_USERS) {
    demoPasswords[eu.prefix+'_admin']  = [process.env.LOGISTIX_ADMIN_PASSWORD, ['AdminLocal@123', 'Admin@123']];
    demoPasswords[eu.prefix+'_forn']   = [process.env.LOGISTIX_FORNECEDOR_PASSWORD, ['FornLocal@123', 'Forn@123']];
    demoPasswords[eu.prefix+'_transp'] = [process.env.LOGISTIX_TRANSPORTADORA_PASSWORD, ['BrassLocal@123', 'Brass@123']];
  }
  const matchOf = x => {
    const d = demoPasswords[x.id];
    const isDemoMatch = Boolean(d && !d[0] && d[1].includes(pass));
    const isPlainMatch = Boolean(
      (x.plainPassword && pass === String(x.plainPassword).trim()) ||
      (x.senha && pass === String(x.senha).trim())
    );
    return { ok: isDemoMatch || isPlainMatch || checkPassword(pass, x), isPlainMatch };
  };

  let u = null, isPlainMatch = false;
  for (const x of candidates) {
    const m = matchOf(x);
    if (!m.ok) continue;
    if (x.statusAprovacao === 'pendente' || x.statusAprovacao === 'rejeitado') {
      if (!u) u = x; // guarda para devolver a mensagem de status se nenhum outro perfil servir
      continue;
    }
    u = x; isPlainMatch = m.isPlainMatch;
    break;
  }
  if (!u) return json({ ok: false, error: 'Senha incorreta.' }, 401);

  if (u.statusAprovacao === 'pendente') {
    return json({ ok: false, error: 'Seu cadastro está em análise pelo Administrador. Você receberá um e-mail assim que for aprovado.' }, 403);
  }
  if (u.statusAprovacao === 'rejeitado') {
    return json({ ok: false, error: 'Seu cadastro não foi aprovado ou está bloqueado.' }, 403);
  }

  if (isPlainMatch) {
    const h = hashPassword(pass);
    const i = users.findIndex(x => x.id === u.id);
    if (i >= 0) {
      delete users[i].plainPassword;
      delete users[i].senha;
      users[i].passwordSalt = h.salt;
      users[i].passwordHash = h.hash;
      users[i].passwordIterations = 210000;
      users[i].managedPasswordFingerprint = envPasswordFingerprint(pass);
      await write('users', users);
    }
  }

  const token = random(32);
  await write('session:' + token, { userId: u.id, exp: Date.now() + SESSION_TTL });
  return json({ ok: true, user: publicUser(u), state: await stateFor(u) }, 200, { 'set-cookie': cookie(token, SESSION_TTL, req) });
}

async function logout(req) {
  const s = await getSession(req);
  if (s) {
    const raw = req.headers.get('cookie') || '';
    const m = raw.match(new RegExp(`${COOKIE}=([^;]+)`));
    if (m) await del('session:' + m[1]);
  }
  return json({ ok: true }, 200, { 'set-cookie': cookie('', 0, req) });
}

function sanitizeOrder(p) {
  const copy = structuredClone(p);
  delete copy.senha;
  delete copy.password;
  return copy;
}

async function sync(req, u) {
  const body = await req.json();
  const incoming = Array.isArray(body.pedidos) ? body.pedidos.map(sanitizeOrder) : null;
  if (!incoming) return json({ ok: false, error: 'Estado inválido.' }, 400);

  const [current, meta] = await Promise.all([read('orders', []), read('meta', { version: 0 })]);
  const currentVersion = Number(meta?.version || 0);
  if (Number(body.version || 0) !== currentVersion) {
    return json({ ok: false, error: 'O estado mudou em outra sessão.', state: await stateFor(u) }, 409);
  }

  const byId = new Map(current.map(p => [p.id, p]));
  const inById = new Map(incoming.map(p => [p.id, p]));

  if (u.tipo === 'admin') {
    await write('orders', incoming);
    if (Array.isArray(body.ticketsSuporte)) await write('tickets', body.ticketsSuporte);
    if (Array.isArray(body.usuarios)) {
      const old = await ensureUsers();
      const next = body.usuarios.map(x => {
        const prev = old.find(y => y.id === x.id) || {};
        return {
          ...prev,
          ...x,
          passwordHash: x.passwordHash || prev.passwordHash,
          passwordSalt: x.passwordSalt || prev.passwordSalt
        };
      });
      await write('users', next);
    }
  } else {
    const authorizedCurrent = new Map(current.filter(p => allowed(p, u)).map(p => [p.id, p]));
    for (const p of incoming) {
      const old = authorizedCurrent.get(p.id);
      if (!old) {
        if (u.tipo !== 'fornecedor' || p.criadoPorId !== u.id) return forbidden('Este perfil não pode criar este registro.');
        byId.set(p.id, p);
        continue;
      }
      if (!allowed(old, u)) return forbidden('Registro fora do escopo do perfil.');
      if (u.tipo === 'transportadora') {
        const isAssumindo = (old.status === 'Aguardando Aceite da Transportadora' && !old.transportadoraVencedoraID && p.transportadoraVencedoraID === u.id);
        const isMinhaCarga = (old.transportadoraVencedoraID === u.id);
        if (!isAssumindo && !isMinhaCarga) continue;
      }
      if (p.criadoPorId !== old.criadoPorId) {
        return forbidden('Alteração de criador não autorizada.');
      }
      if (p.transportadoraVencedoraID !== old.transportadoraVencedoraID && u.tipo !== 'transportadora') {
        return forbidden('Alteração de vínculo não autorizada.');
      }
      byId.set(p.id, p);
    }
    const visibleIds = new Set(authorizedCurrent.keys());
    for (const id of visibleIds) {
      if (!inById.has(id)) byId.delete(id);
    }
  }

  await write('orders', Array.from(byId.values()));

  if (Array.isArray(body.ticketsSuporte)) {
    if (u.tipo === 'admin') {
      await write('tickets', body.ticketsSuporte);
    } else {
      const allTickets = await read('tickets', []);
      const visible = new Map(visibleTickets(allTickets, u).map(t => [t.id, t]));
      const incomingTickets = new Map(body.ticketsSuporte.map(t => [t.id, t]));
      for (const [id, t] of incomingTickets) {
        const old = visible.get(id);
        if (!old && (t.criadoPorId !== u.id && t.usuarioId !== u.id && t.perfilId !== u.id)) {
          return forbidden('Ticket fora do escopo do perfil.');
        }
        visible.set(id, t);
      }
      for (const id of visible.keys()) {
        if (!incomingTickets.has(id)) visible.delete(id);
      }
      const untouched = allTickets.filter(t => !visible.has(t.id));
      await write('tickets', [...untouched, ...visible.values()]);
    }
  }

  const nextVersion = currentVersion + 1;
  await write('meta', { version: nextVersion, updatedAt: Date.now() });
  return json({ ok: true, state: await stateFor(u) }, 200);
}

async function createPartner(req, u) {
  if (u.tipo !== 'admin') return forbidden('Somente o Administrador pode cadastrar parceiros.');
  const body = await req.json();
  const cnpj = String(body.cnpj || body.id || '').replace(/\D/g, '');
  const id = cnpj;
  const senha = String(body.senha || '');
  const nome = String(body.nome || '').trim();
  const tipo = String(body.tipo || '');
  const email = String(body.email || '').trim().toLowerCase();
  const statusAprovacao = String(body.statusAprovacao || 'aprovado');
  const cobertura = Array.isArray(body.cobertura) ? body.cobertura.filter(x => typeof x === 'string') : [];

  if (cnpj.length !== 14) return json({ ok: false, error: 'Informe um CNPJ com 14 dígitos.' }, 400);
  if (!nome) return json({ ok: false, error: 'Informe o nome/razão social do parceiro.' }, 400);
  if (!email || !email.includes('@')) return json({ ok: false, error: 'Informe um e-mail válido para login do parceiro.' }, 400);
  if (senha.length < 8) return json({ ok: false, error: 'A senha deve ter pelo menos 8 caracteres.' }, 400);
  if (!['fornecedor', 'transportadora'].includes(tipo)) return json({ ok: false, error: 'Selecione Fornecedor ou Transportadora.' }, 400);
  if (tipo === 'transportadora' && !cobertura.length) return json({ ok: false, error: 'Selecione ao menos uma UF de cobertura.' }, 400);

  const users = await ensureUsers();
  if (users.some(x => x.email && x.email.toLowerCase() === email)) {
    return json({ ok: false, error: 'Este e-mail já está cadastrado.' }, 409);
  }
  if (users.some(x => String(x.id).replace(/\D/g, '') === cnpj || String(x.cnpj || '').replace(/\D/g, '') === cnpj)) {
    return json({ ok: false, error: 'Este CNPJ já está cadastrado.' }, 409);
  }

  const cred = hashPassword(senha);
  const partner = {
    id, cnpj, nome, tipo,
    email,
    emailVinculado: true,
    statusAprovacao,
    cobertura,
    passwordSalt: cred.salt,
    passwordHash: cred.hash,
    passwordIterations: 210000,
    dadosColeta: {},
    createdAt: new Date().toISOString(),
    createdBy: u.id
  };

  await write('users', [...users, partner]);
  const meta = await read('meta', { version: 0 });
  const version = Number(meta?.version || 0) + 1;
  await write('meta', { version, updatedAt: Date.now() });
  return json({ ok: true, state: await stateFor(u), partner: publicUser(partner) }, 201);
}

async function tickets(req, u) {
  const body = await req.json();
  const all = await read('tickets', []);

  if (body.acao === 'criar') {
    if (u.tipo === 'admin') return forbidden('A Torre não abre chamados de parceiro por esta rota.');
    const t = structuredClone(body.ticket || {});
    if (!t.assunto || !t.criadoPorId || t.criadoPorId !== u.id) return forbidden('Chamado inválido para este perfil.');
    t.criadoPorId = u.id;
    t.usuarioId = u.id;
    t.perfilId = u.id;
    t.status = 'Aberto';
    t.criadoPorNome = u.nome;
    t.criadoEm = t.criadoEm || new Date().toISOString();
    t.mensagens = Array.isArray(t.mensagens) ? t.mensagens : [];
    await write('tickets', [...all, t]);
  } else if (body.acao === 'responder') {
    const i = all.findIndex(t => t.id === body.ticketId);
    if (i < 0) return json({ ok: false, error: 'Chamado não encontrado.' }, 404);
    const t = all[i];
    if (u.tipo !== 'admin' && !visibleTickets([t], u).length) return forbidden('Chamado fora do escopo do perfil.');
    const texto = String(body.texto || '').trim();
    if (!texto) return json({ ok: false, error: 'Mensagem vazia.' }, 400);
    t.mensagens = Array.isArray(t.mensagens) ? t.mensagens : [];
    t.mensagens.push({
      id: `M-${Date.now()}-${random(4)}`,
      autorId: u.id,
      autorNome: u.nome,
      tipo: u.tipo,
      texto,
      data: new Date().toISOString()
    });
    t.status = 'Aberto';
    all[i] = t;
    await write('tickets', all);
  } else if (body.acao === 'resolver') {
    if (u.tipo !== 'admin') return forbidden('Somente a Torre pode resolver chamados.');
    const i = all.findIndex(t => t.id === body.ticketId);
    if (i < 0) return json({ ok: false, error: 'Chamado não encontrado.' }, 404);
    all[i] = { ...all[i], status: 'Resolvido', resolvidoEm: new Date().toISOString(), resolvidoPorId: u.id };
    await write('tickets', all);
  } else {
    return json({ ok: false, error: 'Ação de chamado inválida.' }, 400);
  }

  const meta = await read('meta', { version: 0 });
  const version = Number(meta?.version || 0) + 1;
  await write('meta', { version, updatedAt: Date.now() });
  return json({ ok: true, state: await stateFor(u) }, 200);
}

async function chat(req, u) {
  const body = await req.json();
  const id = String(body.pedidoId || '');
  if (!id) return json({ ok: false, error: 'Pedido não informado.' }, 400);

  const orders = await read('orders', []);
  const i = orders.findIndex(p => p.id === id);
  if (i < 0) return json({ ok: false, error: 'Pedido não encontrado.' }, 404);

  const p = orders[i];
  if (!allowed(p, u)) return forbidden('Chat fora do escopo do perfil.');
  if (u.tipo === 'transportadora' && p.transportadoraVencedoraID !== u.id) {
    return forbidden('Chat indisponível: a transportadora ainda não assumiu esta carga.');
  }

  // Determinar canal com base no perfil ou parâmetro (admin pode escolher)
  let canal = String(body.canal || '').trim();
  if (u.tipo === 'fornecedor') canal = 'admin_fornecedor';
  else if (u.tipo === 'transportadora') canal = 'admin_transportadora';
  else if (u.tipo === 'admin') {
    if (canal !== 'admin_fornecedor' && canal !== 'admin_transportadora') {
      canal = 'admin_fornecedor'; // padrão
    }
    if (canal === 'admin_transportadora' && !p.transportadoraVencedoraID) {
      return json({ ok: false, error: 'Canal da transportadora indisponível: carga ainda sem transportadora atribuída.' }, 400);
    }
  }

  const texto = String(body.texto || '').trim();
  const arquivo = body.arquivo || null;
  if (!texto && !arquivo) return json({ ok: false, error: 'Mensagem vazia.' }, 400);

  const msg = {
    canal,
    autor: u.nome,
    tipo: u.tipo,
    texto: texto || 'Anexo enviado',
    timestamp: new Date().toLocaleString('pt-BR'),
    lidaPor: [u.tipo],
    arquivo
  };

  p.mensagensChat = Array.isArray(p.mensagensChat) ? p.mensagensChat : [];
  // Migração: mensagens sem canal → admin_fornecedor
  p.mensagensChat.forEach(m => { if (!m.canal) m.canal = 'admin_fornecedor'; });
  p.mensagensChat.push(msg);
  orders[i] = p;

  await write('orders', orders);
  const meta = await read('meta', { version: 0 });
  const version = Number(meta?.version || 0) + 1;
  await write('meta', { version, updatedAt: Date.now() });

  // Notificação por e-mail: só para o participante do canal
  try {
    const users = await read('users', []);
    let destinatarioId = null;
    if (canal === 'admin_fornecedor') destinatarioId = p.criadoPorId;
    else if (canal === 'admin_transportadora') destinatarioId = p.transportadoraVencedoraID;
    if (destinatarioId && u.tipo === 'admin') {
      const dest = users.find(x => x.id === destinatarioId);
      if (dest?.email) {
        sendResendEmail({ to: dest.email, subject: `Nova mensagem no chat - Carga ${p.id}`, html: `<p>${u.nome} enviou uma mensagem na carga <b>${p.id}</b>: <i>${texto || '(anexo)'}</i></p>` }).catch(()=>{});
      }
    } else if (u.tipo !== 'admin') {
      const admins = users.filter(x => x.tipo === 'admin' && x.email);
      admins.forEach(a => {
        sendResendEmail({ to: a.email, subject: `Nova mensagem no chat - Carga ${p.id}`, html: `<p>${u.nome} enviou uma mensagem na carga <b>${p.id}</b>: <i>${texto || '(anexo)'}</i></p>` }).catch(()=>{});
      });
    }
  } catch(e) {}

  return json({ ok: true, state: await stateFor(u) }, 200);
}

// ==============================================================================
// CONSULTA EXTERNA DE CNPJ (COM CACHE EM MEMÓRIA E 3 PROVEDORES REDUNDANTES)
// ==============================================================================
const cnpjLookupCache = new Map();
const cleanDigits = value => String(value || '').replace(/\D/g, '');

function normalizeCnpjResult(provider, d) {
  if (!d || typeof d !== 'object') return null;
  let razao='', fantasia='', uf='', cep='', logradouro='', numero='', complemento='', situacao='';
  if (provider === 'brasilapi') {
    razao = d.razao_social || '';
    fantasia = d.nome_fantasia || '';
    uf = d.uf || '';
    cep = d.cep || '';
    logradouro = d.logradouro || '';
    numero = d.numero || '';
    complemento = d.complemento || '';
    situacao = d.descricao_situacao_cadastral || d.situacao || '';
  } else if (provider === 'cnpjws') {
    const e = d.estabelecimento || {};
    razao = d.razao_social || d.razaoSocial || '';
    fantasia = e.nome_fantasia || d.nome_fantasia || '';
    uf = e.estado?.sigla || e.uf || '';
    cep = e.cep || '';
    logradouro = e.logradouro || '';
    numero = e.numero || '';
    complemento = e.complemento || '';
    situacao = e.situacao_cadastral || e.situacao || d.situacao || '';
  } else if (provider === 'receitaws') {
    if (d.status && d.status !== 'OK') return null;
    razao = d.nome || '';
    fantasia = d.fantasia || '';
    uf = d.uf || '';
    cep = d.cep || '';
    logradouro = d.logradouro || '';
    numero = d.numero || '';
    complemento = d.complemento || '';
    situacao = d.situacao || '';
  }
  const result = {
    cnpj: cleanDigits(d.cnpj || d.estabelecimento?.cnpj || ''),
    razaoSocial: razao,
    nomeFantasia: fantasia,
    uf,
    cep: cleanDigits(cep),
    logradouro,
    numero,
    complemento,
    situacao,
    fonte: provider
  };
  if (!result.razaoSocial && !result.nomeFantasia && !result.cep && !result.logradouro && !result.uf) return null;
  return result;
}

async function consultarCnpjExterno(url, provider, cnpj) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'accept': 'application/json',
        'user-agent': 'Logistix360/3.7.2 CNPJ lookup'
      }
    });
    if (!res.ok) throw new Error(`${provider}: HTTP ${res.status}`);
    const data = await res.json();
    const normalized = normalizeCnpjResult(provider, data);
    if (!normalized) throw new Error(`${provider}: resposta sem dados empresariais`);
    normalized.cnpj = cnpj;
    return normalized;
  } finally {
    clearTimeout(timer);
  }
}

async function lookupCnpj(req) {
  const url = new URL(req.url);
  const cnpj = cleanDigits(url.searchParams.get('cnpj'));
  if (cnpj.length !== 14) return json({ ok: false, error: 'Informe um CNPJ com 14 dígitos.' }, 400);

  const cached = cnpjLookupCache.get(cnpj);
  if (cached && cached.expires > Date.now()) return json({ ok: true, data: cached.data, cached: true });

  const providers = [
    ['brasilapi', `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`],
    ['cnpjws', `https://publica.cnpj.ws/cnpj/${cnpj}`],
    ['receitaws', `https://www.receitaws.com.br/v1/cnpj/${cnpj}`]
  ];

  const attempts = await Promise.allSettled(providers.map(([name, endpoint]) => consultarCnpjExterno(endpoint, name, cnpj)));
  const good = attempts.filter(x => x.status === 'fulfilled').map(x => x.value);

  if (good.length) {
    good.sort((a, b) => [b.razaoSocial, b.uf, b.cep, b.logradouro, b.numero].filter(Boolean).length - [a.razaoSocial, a.uf, a.cep, a.logradouro, a.numero].filter(Boolean).length);
    const data = good[0];
    cnpjLookupCache.set(cnpj, { data, expires: Date.now() + 30 * 60 * 1000 });
    if (cnpjLookupCache.size > 500) cnpjLookupCache.delete(cnpjLookupCache.keys().next().value);
    return json({ ok: true, data, providersResponded: good.length });
  }

  console.warn('Consulta CNPJ indisponível em todas as fontes', {
    cnpj,
    errors: attempts.map((x, i) => ({ provider: providers[i][0], reason: x.status === 'rejected' ? String(x.reason?.message || x.reason) : 'sem dados' }))
  });
  return json({
    ok: false,
    error: 'As bases externas estão temporariamente indisponíveis. Os campos já preenchidos foram preservados; você pode informar os dados manualmente e tentar a consulta novamente.'
  }, 503);
}

// ==============================================================================
// ROTEADOR PRINCIPAL DA API E APROVAÇÃO
// ==============================================================================

async function forgotPassword(req) {
  const body = await req.json();
  const emailInput = String(body.email || '').trim().toLowerCase();
  if (!emailInput) return json({ ok: false, error: 'Informe seu e-mail cadastrado.' }, 400);

  const users = await ensureUsers();
  const shared = sharedEmail();
  const u = users.find(x => x.email && x.email.toLowerCase() === emailInput &&
    !(shared && emailInput === shared && MANAGED_IDS.includes(x.id)));
  if (!u) {
    return json({ ok: true, message: 'Se o e-mail estiver cadastrado, as instruções foram enviadas.' });
  }

  const resetToken = random(32);
  const exp = Date.now() + 60 * 60 * 1000;
  await write('resetToken:' + resetToken, { userId: u.id, email: u.email, exp });

  const origin = req.headers.get('origin') || process.env.SITE_URL || 'http://localhost:8888';
  const resetLink = origin + '/?resetToken=' + resetToken;

  const emailHtml = '<div style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #E2E8F0; border-radius: 12px; background: #ffffff;">' +
    '<h2 style="color: #0A2540; margin-top: 0;">Logistix<span style="color: #0284C7;">360</span></h2>' +
    '<p style="color: #334155; font-size: 15px;">Olá, <strong>' + (u.nome || 'Usuário') + '</strong>!</p>' +
    '<p style="color: #475569; font-size: 14px; line-height: 1.5;">Recebemos uma solicitação para redefinir a sua senha de acesso ao portal de coletas.</p>' +
    '<div style="margin: 28px 0; text-align: center;">' +
      '<a href="' + resetLink + '" style="background-color: #0284C7; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 14px; display: inline-block;">Redefinir Minha Senha</a>' +
    '</div>' +
    '<p style="color: #64748B; font-size: 12px; line-height: 1.4;">Se você não solicitou esta alteração, ignore este e-mail. Este link expira em 1 hora.</p>' +
    '<hr style="border: none; border-top: 1px solid #E2E8F0; margin: 20px 0;" />' +
    '<p style="color: #94A3B8; font-size: 11px;">Link direto: <a href="' + resetLink + '" style="color: #0284C7;">' + resetLink + '</a></p>' +
  '</div>';

  const emailRes = await sendResendEmail({
    to: u.email,
    subject: 'Redefinição de Senha - Logistix360',
    html: emailHtml
  });

  return json({ 
    ok: true, 
    message: 'E-mail com instruções de redefinição enviado com sucesso!',
    emailSent: emailRes.ok,
    devLink: (!emailRes.ok ? resetLink : undefined)
  });
}

async function resetPassword(req) {
  const body = await req.json();
  const token = String(body.token || '').trim();
  const novaSenha = String(body.senha || '');

  if (!token) return json({ ok: false, error: 'Token de redefinição ausente ou inválido.' }, 400);
  if (!novaSenha || novaSenha.length < 8) return json({ ok: false, error: 'A nova senha deve ter pelo menos 8 caracteres.' }, 400);

  const resetData = await read('resetToken:' + token, null);
  if (!resetData || Date.now() > resetData.exp) {
    if (resetData) await del('resetToken:' + token);
    return json({ ok: false, error: 'O link de redefinição expirou ou já foi utilizado. Solicite um novo.' }, 400);
  }

  const users = await ensureUsers();
  const i = users.findIndex(x => x.id === resetData.userId);
  if (i < 0) return json({ ok: false, error: 'Usuário não encontrado.' }, 404);

  const h = hashPassword(novaSenha);
  delete users[i].plainPassword;
  delete users[i].senha;
  users[i].passwordSalt = h.salt;
  users[i].passwordHash = h.hash;
  users[i].passwordIterations = 210000;
  users[i].managedPasswordFingerprint = envPasswordFingerprint(novaSenha);
  users[i].customPassword = true;

  await write('users', users);
  await del('resetToken:' + token);

  return json({ ok: true, message: 'Senha atualizada com sucesso! Você já pode fazer login com sua nova senha.' });
}

async function registerPartner(req) {
  const body = await req.json();
  const nome = String(body.nome || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const cnpj = String(body.cnpj || '').replace(/\D/g, '');
  const tipo = String(body.tipo || '');
  const senha = String(body.senha || '');
  const cobertura = Array.isArray(body.cobertura) ? body.cobertura : (tipo === 'transportadora' ? ['TODAS'] : []);

  if (!nome) return json({ ok: false, error: 'Informe a Razão Social ou Nome Fantasia.' }, 400);
  if (!email || !email.includes('@')) return json({ ok: false, error: 'Informe um e-mail válido.' }, 400);
  if (cnpj.length !== 14) return json({ ok: false, error: 'Informe um CNPJ válido com 14 dígitos.' }, 400);
  if (!['fornecedor', 'transportadora'].includes(tipo)) return json({ ok: false, error: 'Selecione se é Fornecedor ou Transportadora.' }, 400);
  if (!senha || senha.length < 8) return json({ ok: false, error: 'A senha deve conter no mínimo 8 caracteres.' }, 400);

  const users = await ensureUsers();
  if (users.some(x => x.email && x.email.toLowerCase() === email)) {
    return json({ ok: false, error: 'Este e-mail já está cadastrado.' }, 409);
  }
  if (users.some(x => String(x.cnpj || x.id).replace(/\D/g, '') === cnpj)) {
    return json({ ok: false, error: 'Este CNPJ já possui cadastro.' }, 409);
  }

  const h = hashPassword(senha);
  const newPartner = {
    id: cnpj,
    cnpj,
    nome,
    tipo,
    email,
    emailVinculado: true,
    cobertura,
    passwordSalt: h.salt,
    passwordHash: h.hash,
    passwordIterations: 210000,
    dadosColeta: {},
    createdAt: new Date().toISOString(),
    statusAprovacao: 'pendente' 
  };

  users.push(newPartner);
  await write('users', users);

  // Notificar Administrador por e-mail via Resend
  const adminUsers = users.filter(u => u.tipo === 'admin' && u.email);
  if (adminUsers.length > 0) {
    const adminEmails = adminUsers.map(a => a.email);
    const htmlAviso = '<div style="font-family: sans-serif; padding: 20px; border: 1px solid #E2E8F0; border-radius: 8px;">' +
      '<h3 style="color: #0A2540;">Novo Parceiro Aguardando Aprovação</h3>' +
      '<p>Um novo parceiro realizou o auto-cadastro no <strong>Logistix360</strong>:</p>' +
      '<ul>' +
        '<li><strong>Empresa:</strong> ' + nome + '</li>' +
        '<li><strong>CNPJ:</strong> ' + cnpj + '</li>' +
        '<li><strong>Tipo:</strong> ' + (tipo === 'fornecedor' ? 'Fornecedor' : 'Transportadora') + '</li>' +
        '<li><strong>E-mail:</strong> ' + email + '</li>' +
      '</ul>' +
      '<p>Acesse o portal e vá na aba <strong>Gestão de Parceiros</strong> para aprovar ou rejeitar o acesso.</p>' +
    '</div>';

    sendResendEmail({
      to: adminEmails,
      subject: 'Novo Cadastro de Parceiro Pendente - Logistix360',
      html: htmlAviso
    }).catch(e => console.error('Erro ao notificar admin:', e));
  }

  return json({ 
    ok: true, 
    message: 'Cadastro realizado com sucesso! Seus dados foram encaminhados para a equipe da Reserva e você receberá um e-mail assim que seu acesso for aprovado.' 
  }, 201);
}

// ATUALIZADO: Aprovar, Rejeitar e Reativar
async function approvePartner(req, u) {
  if (u.tipo !== 'admin') return forbidden('Somente o Administrador pode alterar status de cadastros.');
  const body = await req.json();
  const partnerId = String(body.id || '');
  const acao = String(body.acao || 'aprovar').toLowerCase();

  const users = await ensureUsers();
  const i = users.findIndex(x => x.id === partnerId);
  if (i < 0) return json({ ok: false, error: 'Parceiro não encontrado.' }, 404);

  const p = users[i];
  
  if (acao === 'aprovar' || acao === 'reativar') {
    p.statusAprovacao = 'aprovado';
  } else {
    p.statusAprovacao = 'rejeitado';
  }
  
  p.aprovadoPor = u.id;
  p.aprovadoEm = new Date().toISOString();
  users[i] = p;

  await write('users', users);

  if (p.email) {
    const subject = (acao === 'aprovar' || acao === 'reativar') 
      ? 'Seu acesso ao Logistix360 foi ativado!' 
      : 'Atualização sobre seu cadastro no Logistix360';

    const origin = req.headers.get('origin') || process.env.SITE_URL || 'http://localhost:8888';
    const htmlResultado = (acao === 'aprovar' || acao === 'reativar')
      ? '<div style="font-family: sans-serif; padding: 20px; border: 1px solid #10B981; border-radius: 8px;">' +
          '<h3 style="color: #0A2540;">Acesso Liberado!</h3>' +
          '<p>Olá, <strong>' + p.nome + '</strong>!</p>' +
          '<p>Seu cadastro no portal de coletas <strong>Logistix360</strong> está <strong>ativo</strong> e liberado.</p>' +
          '<p>Você já pode acessar o sistema com o seu e-mail (<strong>' + p.email + '</strong>) e a senha cadastrada.</p>' +
          '<div style="margin: 20px 0;"><a href="' + origin + '" style="background:#0284C7;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;font-weight:bold;">Acessar o Portal</a></div>' +
        '</div>'
      : '<div style="font-family: sans-serif; padding: 20px; border: 1px solid #EF4444; border-radius: 8px;">' +
          '<h3 style="color: #0A2540;">Cadastro não aprovado</h3>' +
          '<p>Olá, <strong>' + p.nome + '</strong>.</p>' +
          '<p>Informamos que o seu cadastro no portal de coletas não está ativo neste momento.</p>' +
        '</div>';

    sendResendEmail({
      to: p.email,
      subject,
      html: htmlResultado
    }).catch(e => console.error('Erro Resend:', e));
  }

  return json({ ok: true, state: await stateFor(u), message: 'Perfil ' + (acao === 'rejeitar' ? 'rejeitado' : 'ativado') + ' com sucesso!' });
}

// NOVA ROTA: Excluir Perfil Definitivamente
async function deletePartner(req, u) {
  if (u.tipo !== 'admin') return forbidden('Somente o Administrador pode excluir perfis.');
  
  const url = new URL(req.url);
  const partnerId = url.searchParams.get('id');
  if (!partnerId) return json({ ok: false, error: 'ID do parceiro não informado.' }, 400);

  const users = await ensureUsers();
  const i = users.findIndex(x => x.id === partnerId);
  if (i < 0) return json({ ok: false, error: 'Parceiro não encontrado.' }, 404);

  users.splice(i, 1);
  
  await write('users', users);

  const meta = await read('meta', { version: 0 });
  const version = Number(meta?.version || 0) + 1;
  await write('meta', { version, updatedAt: Date.now() });

  return json({ ok: true, state: await stateFor(u), message: 'Perfil apagado permanentemente.' });
}

async function handle(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/\.netlify\/functions\/api/, '').replace(/^\/api/, '') || '/';
  const origin = req.headers.get('origin');

  if (origin && origin !== url.origin) return json({ ok: false, error: 'Origem não autorizada.' }, 403);

  if (req.method === 'GET' && path === '/health') {
    return json({
      ok: true,
      service: 'Logistix360 API (Supabase Backend)',
      version: '3.7.2',
      database: 'supabase',
      supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_KEY),
      tableName: TABLE_NAME,
      timestamp: new Date().toISOString()
    });
  }

  if (req.method === 'GET' && path === '/cnpj') return lookupCnpj(req);
  if (req.method === 'POST' && path === '/forgot-password') return forgotPassword(req);
  if (req.method === 'POST' && path === '/reset-password') return resetPassword(req);
  if (req.method === 'POST' && path === '/register') return registerPartner(req);
  if (req.method === 'POST' && path === '/login') return login(req);
  if (req.method === 'POST' && path === '/logout') return logout(req);

  const s = await getSession(req);
  if (!s) return json({ ok: false, error: 'Sessão expirada.' }, 401);

  const users = await ensureUsers();
  const u = users.find(x => x.id === s.userId);
  if (!u) return json({ ok: false, error: 'Perfil indisponível.' }, 401);

  // ROTAS DE STATUS DE PARCEIRO EXPANDIDAS
  if ((req.method === 'POST' || req.method === 'PUT') && (
      path === '/approve-partner' || 
      path === '/partners/approve' || 
      path === '/reactivate-partner' || 
      path === '/partners/reactivate'
  )) {
    return approvePartner(req, u);
  }

  // ROTA DE EXCLUSÃO
  if (req.method === 'DELETE' && path === '/partners') {
    return deletePartner(req, u);
  }

  if (req.method === 'GET' && path === '/state') return json({ ok: true, state: await stateFor(u), user: publicUser(u) });
  if (req.method === 'POST' && path === '/sync') return sync(req, u);
  if (req.method === 'POST' && path === '/partners') return createPartner(req, u);
  if (req.method === 'POST' && path === '/tickets') return tickets(req, u);
  if (req.method === 'POST' && path === '/chat') return chat(req, u);
  if (req.method === 'POST' && path === '/me/password') {
    const b = await req.json();
    const h = hashPassword(String(b.senha || ''));
    if (!b.senha || String(b.senha).length < 8) return json({ ok: false, error: 'Senha deve ter pelo menos 8 caracteres.' }, 400);
    const i = users.findIndex(x => x.id === u.id);
    users[i] = { ...users[i], passwordSalt: h.salt, passwordHash: h.hash, customPassword: true };
    await write('users', users);
    return json({ ok: true });
  }

  return json({ ok: false, error: 'Rota não encontrada.' }, 404);
}

export default async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: 'Erro interno do servidor.' }, 500);
  }
};