import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

// Resolve the Blobs store inside the active Netlify Function request context.
// Keep the existing store name so current production data remains untouched.
const blobStore = () => getStore(process.env.LOGISTIX_BLOBS_STORE || 'logistix360-prod');
const SESSION_TTL = 8 * 60 * 60 * 1000;
const COOKIE = 'logi_session';

const json = (data, status=200, headers={}) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', ...headers}});
const b64u = b => Buffer.from(b).toString('base64url');
const random = n => crypto.randomBytes(n).toString('base64url');
const hashPassword = (password, salt=random(16)) => ({salt, hash:crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('base64url')});
const checkPassword = (password, u) => {
  if(!u?.passwordHash || !u?.passwordSalt) return false;
  for(const iterations of [Number(u.passwordIterations)||210000, 120000]) {
    const h=crypto.pbkdf2Sync(password,u.passwordSalt,iterations,32,'sha256').toString('base64url');
    const a=Buffer.from(h), b=Buffer.from(u.passwordHash);
    if(a.length===b.length && crypto.timingSafeEqual(a,b)) return true;
  }
  return false;
};
const cookie = (token,maxAge=SESSION_TTL) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(maxAge/1000)}`;

async function read(key, fallback){ const x=await blobStore().get(key,{type:'json', consistency:'strong'}); return x ?? fallback; }
async function write(key,value){ await blobStore().setJSON(key,value); }

const envPasswordFingerprint = password => password ? crypto.createHash('sha256').update(String(password)).digest('base64url') : null;

async function ensureUsers(){
  let users=await read('users',null);
  const adminPass=process.env.LOGISTIX_ADMIN_PASSWORD || '';
  const fornPass=process.env.LOGISTIX_FORNECEDOR_PASSWORD || '';
  const transpPass=process.env.LOGISTIX_TRANSPORTADORA_PASSWORD || '';
  const make=(id,nome,tipo,email,pass,cobertura=[])=>{
    const h=hashPassword(pass);
    return {id,nome,tipo,email,cobertura,passwordSalt:h.salt,passwordHash:h.hash,passwordIterations:210000,emailVinculado:true,dadosColeta:{},createdAt:new Date().toISOString(),managedPasswordFingerprint:envPasswordFingerprint(pass)};
  };

  if(!Array.isArray(users)||!users.length){
    // The three bootstrap passwords are intentionally required for a real deployment.
    // Demo fallbacks are kept only when no environment variable exists at all, so an older
    // installation can still be migrated safely; once the variables are configured, they
    // become authoritative for the three built-in profiles.
    const a=adminPass || 'Admin@123', f=fornPass || 'Forn@123', t=transpPass || 'Brass@123';
    users=[make('admin01','Administrador Master','admin','admin@logistix.com',a,['TODAS']),make('forn01','Indústria ABC','fornecedor','fornecedor@empresa.com',f,[]),make('brasspress01','Brasspress','transportadora','brasspress@logistix.com',t,['SP','RJ','MG','ES'])];
    await write('users',users);
    return users;
  }

  // IMPORTANT: environment variables are authoritative for the three built-in accounts.
  // This also migrates an existing v3.0 database that was created with the old demo passwords.
  const configured=[
    ['admin01',adminPass],
    ['forn01',fornPass],
    ['brasspress01',transpPass]
  ];
  let changed=false;
  for(const [id,pass] of configured){
    if(!pass) continue;
    const i=users.findIndex(x=>x.id===id);
    if(i<0) continue;
    const fp=envPasswordFingerprint(pass);
    if(users[i].managedPasswordFingerprint!==fp){
      const h=hashPassword(pass);
      users[i]={...users[i],passwordSalt:h.salt,passwordHash:h.hash,passwordIterations:210000,managedPasswordFingerprint:fp};
      changed=true;
    }
  }
  if(changed) await write('users',users);
  return users;
}
async function getSession(req){
  const raw=req.headers.get('cookie')||''; const m=raw.match(new RegExp(`${COOKIE}=([^;]+)`)); if(!m) return null;
  const s=await read('session:'+m[1],null); if(!s||Date.now()>s.exp) { if(s) await blobStore().delete('session:'+m[1]); return null; }
  return s;
}
function publicUser(u){ const {passwordHash,passwordSalt,...safe}=u; return safe; }
function cobreUF(u, ufOrigem){
  const cobertura=Array.isArray(u?.cobertura)?u.cobertura:[];
  if(cobertura.some(x=>String(x).trim().toUpperCase()==='TODAS' || String(x).trim().toUpperCase()==='NACIONAL' || String(x).trim().toUpperCase()==='NATIONAL')) return true;
  const uf=String(ufOrigem||'').trim().toUpperCase();
  return Boolean(uf) && cobertura.some(x=>String(x).trim().toUpperCase()===uf);
}
function allowed(p,u){
  if(!p||!u) return false;
  if(u.tipo==='admin') return true;
  if(u.tipo==='fornecedor') return p.criadoPorId===u.id;
  if(u.tipo==='transportadora') return p.transportadoraVencedoraID===u.id || (p.status==='Aguardando Aceite da Transportadora' && cobreUF(u,p.ufOrigem));
  return false;
}
function visibleOrders(orders,u){
  return (orders||[]).filter(p=>allowed(p,u)).map(p=>{
    // Cargas no mural são visíveis para candidatura, mas o histórico do chat é privado
    // até a transportadora ser efetivamente vinculada/aceitar a carga.
    if(u.tipo==='transportadora' && p.transportadoraVencedoraID!==u.id) { const safe={...p}; delete safe.mensagensChat; return safe; }
    return p;
  });
}
function visibleTickets(tickets,u){
  if(u.tipo==='admin') return tickets||[];
  return (tickets||[]).filter(t=>t.criadoPorId===u.id || t.usuarioId===u.id || t.perfilId===u.id || t.pedido?.criadoPorId===u.id || t.pedido?.transportadoraVencedoraID===u.id);
}
async function stateFor(u){
  const [orders,tickets,users,meta]=await Promise.all([read('orders',[]),read('tickets',[]),ensureUsers(),read('meta',{version:0})]);
  return {pedidos:visibleOrders(orders,u),usuarios:u.tipo==='admin'?users.map(publicUser):[publicUser(users.find(x=>x.id===u.id))].filter(Boolean),ticketsSuporte:visibleTickets(tickets,u),version:Number(meta?.version||0),timestamp:Date.now()};
}
function forbidden(msg='Acesso negado'){return json({ok:false,error:msg},403)}

async function login(req){
  const body=await req.json(); const id=String(body.perfil||'').trim().toLowerCase(); const pass=String(body.senha||'');
  if(!id||!pass) return json({ok:false,error:'Informe perfil e senha.'},400);
  const users=await ensureUsers(); const u=users.find(x=>x.id.toLowerCase()===id);
  if(!u || !checkPassword(pass,u)) return json({ok:false,error:'Perfil ou senha inválidos.'},401);
  const token=random(32); await write('session:'+token,{userId:u.id,exp:Date.now()+SESSION_TTL});
  return json({ok:true,user:publicUser(u),state:await stateFor(u)},200,{'set-cookie':cookie(token)});
}

async function logout(req){ const s=await getSession(req); if(s) { const raw=req.headers.get('cookie')||''; const m=raw.match(new RegExp(`${COOKIE}=([^;]+)`)); if(m) await blobStore().delete('session:'+m[1]); } return json({ok:true},200,{'set-cookie':cookie('',0)}); }

function sanitizeOrder(p){
  const copy=structuredClone(p); delete copy.senha; delete copy.password; return copy;
}
function changedKeys(a,b){ const keys=new Set([...Object.keys(a||{}),...Object.keys(b||{})]); const out=[]; for(const k of keys) if(JSON.stringify(a?.[k])!==JSON.stringify(b?.[k])) out.push(k); return out; }

async function sync(req,u){
  const body=await req.json(); const incoming=Array.isArray(body.pedidos)?body.pedidos.map(sanitizeOrder):null;
  if(!incoming) return json({ok:false,error:'Estado inválido.'},400);
  const [current, meta] = await Promise.all([read('orders',[]), read('meta',{version:0})]);
  const currentVersion=Number(meta?.version||0);
  if(Number(body.version||0)!==currentVersion) return json({ok:false,error:'O estado mudou em outra sessão.',state:await stateFor(u)},409);
  const byId=new Map(current.map(p=>[p.id,p])); const inById=new Map(incoming.map(p=>[p.id,p]));
  if(u.tipo==='admin'){
    await write('orders',incoming); if(Array.isArray(body.ticketsSuporte)) await write('tickets',body.ticketsSuporte); if(Array.isArray(body.usuarios)){
      const old=await ensureUsers(); const next=body.usuarios.map(x=>{const prev=old.find(y=>y.id===x.id)||{}; return {...prev,...x,passwordHash:x.passwordHash||prev.passwordHash,passwordSalt:x.passwordSalt||prev.passwordSalt};}); await write('users',next);
    }
  } else {
    const authorizedCurrent=new Map(current.filter(p=>allowed(p,u)).map(p=>[p.id,p]));
    for(const p of incoming){
      const old=authorizedCurrent.get(p.id);
      if(!old){
        if(u.tipo!=='fornecedor' || p.criadoPorId!==u.id) return forbidden('Este perfil não pode criar este registro.');
        byId.set(p.id,p); continue;
      }
      if(!allowed(old,u)) return forbidden('Registro fora do escopo do perfil.');
      // Uma transportadora só pode sincronizar alterações de cargas que assumiu.
      // Cargas pendentes continuam visíveis apenas para consulta no mural.
      if(u.tipo==='transportadora' && old.transportadoraVencedoraID!==u.id) continue;
      // Never allow ownership transfer from a non-admin client.
      if(p.criadoPorId!==old.criadoPorId || p.transportadoraVencedoraID!==old.transportadoraVencedoraID && u.tipo!=='transportadora') return forbidden('Alteração de vínculo não autorizada.');
      byId.set(p.id,p);
    }
    const visibleIds=new Set(authorizedCurrent.keys());
    for(const id of visibleIds) if(!inById.has(id)) byId.delete(id);
  }
  await write('orders',Array.from(byId.values()));
  if(Array.isArray(body.ticketsSuporte)) {
    if(u.tipo==='admin') await write('tickets',body.ticketsSuporte);
    else {
      const allTickets=await read('tickets',[]); const visible=new Map(visibleTickets(allTickets,u).map(t=>[t.id,t])); const incomingTickets=new Map(body.ticketsSuporte.map(t=>[t.id,t]));
      for(const [id,t] of incomingTickets){ const old=visible.get(id); if(!old){ if(t.criadoPorId!==u.id && t.usuarioId!==u.id && t.perfilId!==u.id) return forbidden('Ticket fora do escopo do perfil.'); } visible.set(id,t); }
      for(const id of visible.keys()) if(!incomingTickets.has(id)) visible.delete(id);
      const untouched=allTickets.filter(t=>!visible.has(t.id)); await write('tickets',[...untouched,...visible.values()]);
    }
  }
  const nextVersion=currentVersion+1; await write('meta',{version:nextVersion,updatedAt:Date.now()});
  return json({ok:true,state:await stateFor(u)},200);
}


async function createPartner(req,u){
  if(u.tipo!=='admin') return forbidden('Somente o Administrador pode cadastrar parceiros.');
  const body=await req.json();
  const cnpj=String(body.cnpj||body.id||'').replace(/\D/g,'');
  const id=cnpj;
  const senha=String(body.senha||'');
  const nome=String(body.nome||'').trim();
  const tipo=String(body.tipo||'');
  const cobertura=Array.isArray(body.cobertura)?body.cobertura.filter(x=>typeof x==='string'):[];
  if(cnpj.length!==14) return json({ok:false,error:'Informe um CNPJ com 14 dígitos.'},400);
  if(!nome) return json({ok:false,error:'Informe o nome/razão social do parceiro.'},400);
  if(senha.length<8) return json({ok:false,error:'A senha deve ter pelo menos 8 caracteres.'},400);
  if(!['fornecedor','transportadora'].includes(tipo)) return json({ok:false,error:'Selecione Fornecedor ou Transportadora.'},400);
  if(tipo==='transportadora'&&!cobertura.length) return json({ok:false,error:'Selecione ao menos uma UF de cobertura.'},400);
  const users=await ensureUsers();
  if(users.some(x=>String(x.id).replace(/\D/g,'')===cnpj || String(x.cnpj||'').replace(/\D/g,'')===cnpj)) return json({ok:false,error:'Este CNPJ já está cadastrado.'},409);
  const cred=hashPassword(senha);
  const partner={id,cnpj,nome,tipo,email:'',emailVinculado:false,cobertura,passwordSalt:cred.salt,passwordHash:cred.hash,passwordIterations:210000,dadosColeta:{},createdAt:new Date().toISOString(),createdBy:u.id};
  await write('users',[...users,partner]);
  const meta=await read('meta',{version:0});
  const version=Number(meta?.version||0)+1;
  await write('meta',{version,updatedAt:Date.now()});
  return json({ok:true,state:await stateFor(u),partner:publicUser(partner)},201);
}

async function tickets(req,u){
  const body=await req.json();
  const all=await read('tickets',[]);
  if(body.acao==='criar'){
    if(u.tipo==='admin') return forbidden('A Torre não abre chamados de parceiro por esta rota.');
    const t=structuredClone(body.ticket||{});
    if(!t.assunto || !t.criadoPorId || t.criadoPorId!==u.id) return forbidden('Chamado inválido para este perfil.');
    t.criadoPorId=u.id; t.usuarioId=u.id; t.perfilId=u.id; t.status='Aberto';
    t.criadoPorNome=u.nome; t.criadoEm=t.criadoEm||new Date().toISOString();
    t.mensagens=Array.isArray(t.mensagens)?t.mensagens:[];
    await write('tickets',[...all,t]);
  } else if(body.acao==='responder'){
    const i=all.findIndex(t=>t.id===body.ticketId); if(i<0) return json({ok:false,error:'Chamado não encontrado.'},404);
    const t=all[i];
    if(u.tipo!=='admin' && !visibleTickets([t],u).length) return forbidden('Chamado fora do escopo do perfil.');
    const texto=String(body.texto||'').trim(); if(!texto) return json({ok:false,error:'Mensagem vazia.'},400);
    t.mensagens=Array.isArray(t.mensagens)?t.mensagens:[];
    t.mensagens.push({id:`M-${Date.now()}-${random(4)}`,autorId:u.id,autorNome:u.nome,tipo:u.tipo,texto,data:new Date().toISOString()});
    t.status='Aberto'; all[i]=t; await write('tickets',all);
  } else if(body.acao==='resolver'){
    if(u.tipo!=='admin') return forbidden('Somente a Torre pode resolver chamados.');
    const i=all.findIndex(t=>t.id===body.ticketId); if(i<0) return json({ok:false,error:'Chamado não encontrado.'},404);
    all[i]={...all[i],status:'Resolvido',resolvidoEm:new Date().toISOString(),resolvidoPorId:u.id}; await write('tickets',all);
  } else return json({ok:false,error:'Ação de chamado inválida.'},400);
  const meta=await read('meta',{version:0}); const version=Number(meta?.version||0)+1; await write('meta',{version,updatedAt:Date.now()});
  return json({ok:true,state:await stateFor(u)},200);
}

async function chat(req,u){
  const body=await req.json(); const id=String(body.pedidoId||'');
  if(!id) return json({ok:false,error:'Pedido não informado.'},400);
  const orders=await read('orders',[]); const i=orders.findIndex(p=>p.id===id); if(i<0) return json({ok:false,error:'Pedido não encontrado.'},404);
  const p=orders[i]; if(!allowed(p,u)) return forbidden('Chat fora do escopo do perfil.');
  if(u.tipo==='transportadora' && p.transportadoraVencedoraID!==u.id) return forbidden('Chat indisponível: a transportadora ainda não assumiu esta carga.');
  const texto=String(body.texto||'').trim(); const arquivo=body.arquivo||null;
  if(!texto && !arquivo) return json({ok:false,error:'Mensagem vazia.'},400);
  const msg={autor:u.nome,tipo:u.tipo,texto:texto||'Anexo enviado',timestamp:new Date().toLocaleString('pt-BR'),lidaPor:[u.tipo],arquivo};
  p.mensagensChat=Array.isArray(p.mensagensChat)?p.mensagensChat:[]; p.mensagensChat.push(msg); orders[i]=p;
  await write('orders',orders); const meta=await read('meta',{version:0}); const version=Number(meta?.version||0)+1; await write('meta',{version,updatedAt:Date.now()});
  return json({ok:true,state:await stateFor(u)},200);
}

const cnpjLookupCache = new Map();
const cleanDigits = value => String(value || '').replace(/\D/g, '');
function normalizeCnpjResult(provider, d) {
  if (!d || typeof d !== 'object') return null;
  let razao='', fantasia='', uf='', cep='', logradouro='', numero='', complemento='', situacao='';
  if (provider === 'brasilapi') {
    razao=d.razao_social||''; fantasia=d.nome_fantasia||''; uf=d.uf||''; cep=d.cep||'';
    logradouro=d.logradouro||''; numero=d.numero||''; complemento=d.complemento||'';
    situacao=d.descricao_situacao_cadastral||d.situacao||'';
  } else if (provider === 'cnpjws') {
    const e=d.estabelecimento||{};
    razao=d.razao_social||d.razaoSocial||''; fantasia=e.nome_fantasia||d.nome_fantasia||'';
    uf=e.estado?.sigla||e.uf||''; cep=e.cep||''; logradouro=e.logradouro||''; numero=e.numero||''; complemento=e.complemento||'';
    situacao=e.situacao_cadastral||e.situacao||d.situacao||'';
  } else if (provider === 'receitaws') {
    if (d.status && d.status !== 'OK') return null;
    razao=d.nome||''; fantasia=d.fantasia||''; uf=d.uf||''; cep=d.cep||'';
    logradouro=d.logradouro||''; numero=d.numero||''; complemento=d.complemento||''; situacao=d.situacao||'';
  }
  const result={cnpj:cleanDigits(d.cnpj||d.estabelecimento?.cnpj||''),razaoSocial:razao,nomeFantasia:fantasia,uf,cep:cleanDigits(cep),logradouro,numero,complemento,situacao,fonte:provider};
  if (!result.razaoSocial && !result.nomeFantasia && !result.cep && !result.logradouro && !result.uf) return null;
  return result;
}
async function consultarCnpjExterno(url, provider, cnpj) {
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),4500);
  try {
    const res=await fetch(url,{signal:controller.signal,headers:{'accept':'application/json','user-agent':'Logistix360/3.6.1 CNPJ lookup'}});
    if(!res.ok) throw new Error(`${provider}: HTTP ${res.status}`);
    const data=await res.json();
    const normalized=normalizeCnpjResult(provider,data);
    if(!normalized) throw new Error(`${provider}: resposta sem dados empresariais`);
    normalized.cnpj=cnpj;
    return normalized;
  } finally { clearTimeout(timer); }
}
async function lookupCnpj(req) {
  const url=new URL(req.url); const cnpj=cleanDigits(url.searchParams.get('cnpj'));
  if(cnpj.length!==14) return json({ok:false,error:'Informe um CNPJ com 14 dígitos.'},400);
  const cached=cnpjLookupCache.get(cnpj);
  if(cached && cached.expires>Date.now()) return json({ok:true,data:cached.data,cached:true});
  const providers=[
    ['brasilapi',`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`],
    ['cnpjws',`https://publica.cnpj.ws/cnpj/${cnpj}`],
    ['receitaws',`https://www.receitaws.com.br/v1/cnpj/${cnpj}`]
  ];
  const attempts=await Promise.allSettled(providers.map(([name,endpoint])=>consultarCnpjExterno(endpoint,name,cnpj)));
  const good=attempts.filter(x=>x.status==='fulfilled').map(x=>x.value);
  if(good.length){
    // Prefer the most complete response, while keeping provider order as a tie-breaker.
    good.sort((a,b)=>[b.razaoSocial,b.uf,b.cep,b.logradouro,b.numero].filter(Boolean).length-[a.razaoSocial,a.uf,a.cep,a.logradouro,a.numero].filter(Boolean).length);
    const data=good[0];
    cnpjLookupCache.set(cnpj,{data,expires:Date.now()+30*60*1000});
    if(cnpjLookupCache.size>500) cnpjLookupCache.delete(cnpjLookupCache.keys().next().value);
    return json({ok:true,data,providersResponded:good.length});
  }
  console.warn('Consulta CNPJ indisponível em todas as fontes', {cnpj,errors:attempts.map((x,i)=>({provider:providers[i][0],reason:x.status==='rejected'?String(x.reason?.message||x.reason):'sem dados'}))});
  return json({ok:false,error:'As bases externas estão temporariamente indisponíveis. Os campos já preenchidos foram preservados; você pode informar os dados manualmente e tentar a consulta novamente.'},503);
}

async function handle(req){
  const url=new URL(req.url); const path=url.pathname.replace(/^\/\.netlify\/functions\/api/,'').replace(/^\/api/,'')||'/';
  const origin=req.headers.get('origin');
  if(origin && origin!==url.origin) return json({ok:false,error:'Origem não autorizada.'},403);
  if(req.method==='GET'&&path==='/cnpj') return lookupCnpj(req);
  if(req.method==='POST'&&path==='/login') return login(req);
  if(req.method==='POST'&&path==='/logout') return logout(req);
  const s=await getSession(req); if(!s) return json({ok:false,error:'Sessão expirada.'},401);
  const users=await ensureUsers(); const u=users.find(x=>x.id===s.userId); if(!u) return json({ok:false,error:'Perfil indisponível.'},401);
  if(req.method==='GET'&&path==='/state') return json({ok:true,state:await stateFor(u),user:publicUser(u)});
  if(req.method==='POST'&&path==='/sync') return sync(req,u);
  if(req.method==='POST'&&path==='/partners') return createPartner(req,u);
  if(req.method==='POST'&&path==='/tickets') return tickets(req,u);
  if(req.method==='POST'&&path==='/chat') return chat(req,u);
  if(req.method==='POST'&&path==='/me/password'){
    const b=await req.json(); const h=hashPassword(String(b.senha||'')); if(!b.senha||String(b.senha).length<8) return json({ok:false,error:'Senha deve ter pelo menos 8 caracteres.'},400); const i=users.findIndex(x=>x.id===u.id); users[i]={...users[i],passwordSalt:h.salt,passwordHash:h.hash}; await write('users',users); return json({ok:true});
  }
  return json({ok:false,error:'Rota não encontrada.'},404);
}
export default async (req)=>{try{return await handle(req)}catch(e){console.error(e);return json({ok:false,error:'Erro interno do servidor.'},500)}};
