/* Servidor de "Repuestos Pedido"
   1) Sirve la app                     -> /
   2) Puente al API de SAP (sin CORS)   -> /sap/*   ->  https://sap-api.eugeniachat.ai/*
   3) Almacén COMPARTIDO de datos       -> /api/*   (solicitudes, pedidos, catálogo, cfg)

   Almacenamiento:
   - En la nube: si existe la variable DATABASE_URL, usa PostgreSQL (datos durables, gratis con Neon).
   - Local: si no hay DATABASE_URL, guarda en datos.json (para usarlo en tu PC con el .bat).
*/
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const PORT = process.env.PORT || 8723;
const SAP = 'https://sap-api.eugeniachat.ai';
const DATABASE_URL = process.env.DATABASE_URL || '';
const DATA_FILE = path.join(process.env.DATA_DIR || ROOT, 'datos.json');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const COLS = ['solicitudes','pedidos','catalogo','analisis','cfg'];

// ---------- control de acceso (clave de la app) ----------
const APP_PASSWORD = process.env.APP_PASSWORD || '';   // vacío = app abierta (uso local). En la nube se define en Render.
const SESSION_TOKEN = APP_PASSWORD ? crypto.createHash('sha256').update('rp::'+APP_PASSWORD).digest('hex') : '';
function parseCookies(req){ const o={}; (req.headers.cookie||'').split(';').forEach(p=>{ const i=p.indexOf('='); if(i>0)o[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim()); }); return o; }
function autorizado(req){ return !APP_PASSWORD || parseCookies(req).rp_sess === SESSION_TOKEN; }
const LOGIN_HTML = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Repuestos Pedido — Acceso</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:"Segoe UI",system-ui,Arial,sans-serif;background:radial-gradient(1000px 500px at 100% -10%,#e7ecff,transparent 60%),#f1f5f9}
.card{background:#fff;border-radius:18px;box-shadow:0 18px 50px rgba(16,24,40,.18);width:100%;max-width:360px;overflow:hidden}
.top{background:linear-gradient(135deg,#4f46e5,#2563eb 55%,#0ea5e9);color:#fff;padding:26px;text-align:center}
.top .ic{font-size:34px}.top h1{margin:8px 0 2px;font-size:19px}.top p{margin:0;opacity:.9;font-size:12px}
.bd{padding:22px}label{font-size:12px;font-weight:600;color:#64748b}
input{width:100%;padding:11px 12px;border:1px solid #e2e8f0;border-radius:10px;font-size:14px;margin-top:6px}
input:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15)}
button{width:100%;margin-top:14px;padding:12px;border:none;border-radius:10px;background:#2563eb;color:#fff;font-weight:700;font-size:14px;cursor:pointer}
button:hover{background:#1d4ed8}.msg{color:#ef4444;font-size:12.5px;margin-top:10px;min-height:16px}</style></head>
<body><div class="card"><div class="top"><div class="ic">🔧</div><h1>Repuestos Pedido</h1><p>Acceso restringido</p></div>
<div class="bd"><label>Contraseña de acceso</label><input id="p" type="password" autofocus onkeydown="if(event.key==='Enter')entrar()">
<button onclick="entrar()">Entrar</button><div class="msg" id="m"></div></div></div>
<script>async function entrar(){var p=document.getElementById('p').value;var m=document.getElementById('m');m.textContent='Entrando…';
try{var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});
if(r.ok){location.reload()}else{m.textContent='Contraseña incorrecta'}}catch(e){m.textContent='Error de conexión'}}</script></body></html>`;

// ---------- almacén en memoria ----------
let store = { solicitudes:[], pedidos:[], catalogo:[], analisis:[], cfg:{} };
const keyField = coll => coll==='catalogo' ? 'parte' : (coll==='analisis' ? 'sap' : 'id');

// ---------- persistencia (PostgreSQL o archivo) ----------
let pool = null;
async function initDB(){
  if(!DATABASE_URL) {           // modo archivo (local)
    try { if (fs.existsSync(DATA_FILE)) store = JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch(e){ console.error('No pude leer datos.json:', e.message); }
  } else {                      // modo PostgreSQL (nube)
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized:false } });
    await pool.query('CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb)');
    const r = await pool.query('SELECT k, v FROM kv');
    const map = {}; r.rows.forEach(row => map[row.k] = row.v);
    store.solicitudes = map.solicitudes || [];
    store.pedidos     = map.pedidos     || [];
    store.catalogo    = map.catalogo    || [];
    store.analisis    = map.analisis    || [];
    store.cfg         = map.cfg         || {};
  }
  COLS.forEach(k => { if(k!=='cfg' && !Array.isArray(store[k])) store[k]=[]; });
  if(!store.cfg || typeof store.cfg!=='object') store.cfg={};
}
const dirty = new Set();
let _saveT = null;
function persist(coll){
  if(coll) dirty.add(coll); else COLS.forEach(c=>dirty.add(c));
  clearTimeout(_saveT);
  _saveT = setTimeout(flush, 350);
}
async function flush(){
  const cols = [...dirty]; dirty.clear();
  if(pool){
    for(const c of cols){
      try{ await pool.query('INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=$2', [c, JSON.stringify(store[c])]); }
      catch(e){ console.error('persist PG '+c+':', e.message); }
    }
  } else {
    try{ fs.writeFileSync(DATA_FILE, JSON.stringify(store)); }
    catch(e){ console.error('persist archivo:', e.message); }
  }
}

// ---------- helpers ----------
function readBody(req){ return new Promise(res=>{ let b=''; req.on('data',c=>{ b+=c; if(b.length>20e6) req.destroy(); }); req.on('end',()=>{ try{ res(JSON.parse(b||'{}')); }catch(e){ res({}); } }); req.on('error',()=>res({})); }); }
function sendJSON(res, obj, code){ const s=JSON.stringify(obj); res.writeHead(code||200,{'Content-Type':'application/json; charset=utf-8'}); res.end(s); }

async function handleAuth(req, res, u){
  if(u.pathname==='/api/logout'){ res.writeHead(200,{'Set-Cookie':'rp_sess=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax','Content-Type':'application/json'}); res.end('{"ok":true}'); return; }
  if(req.method!=='POST') return sendJSON(res,{error:'método'},405);
  const body=await readBody(req);
  if(!APP_PASSWORD || String(body.password)===APP_PASSWORD){
    res.writeHead(200,{'Set-Cookie':'rp_sess='+SESSION_TOKEN+'; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax','Content-Type':'application/json'});
    res.end('{"ok":true}'); return;
  }
  sendJSON(res,{error:'Contraseña incorrecta'},401);
}
async function handleApi(req, res, u){
  const p = u.pathname;
  if (req.method==='GET' && p==='/api/store'){ return sendJSON(res, store); }
  if (req.method==='POST'){
    const body = await readBody(req);
    if (p==='/api/upsert'){
      const {coll, item} = body; if(!store[coll]||!item) return sendJSON(res,{error:'bad'},400);
      const k=keyField(coll), arr=store[coll], i=arr.findIndex(x=>String(x[k])===String(item[k]));
      if(i>=0) arr[i]=item; else arr.push(item); persist(coll); return sendJSON(res,{ok:true});
    }
    if (p==='/api/delete'){
      const {coll, key} = body; if(!store[coll]) return sendJSON(res,{error:'bad'},400);
      const k=keyField(coll); store[coll]=store[coll].filter(x=>String(x[k])!==String(key)); persist(coll); return sendJSON(res,{ok:true});
    }
    if (p==='/api/bulk'){
      const {coll, items, mode} = body; if(!store[coll]||!Array.isArray(items)) return sendJSON(res,{error:'bad'},400);
      const k=keyField(coll);
      if(mode==='replace'){ store[coll]=items; }
      else {
        const idx=new Map(store[coll].map(x=>[String(x[k]),x]));
        items.forEach(it=>{ const id=String(it[k]); if(idx.has(id)){ if(mode!=='mergeNew') Object.assign(idx.get(id),it); } else { store[coll].push(it); idx.set(id,it); } });
      }
      persist(coll); return sendJSON(res,{ok:true, count:store[coll].length});
    }
    if (p==='/api/cfg'){ if(body.cfg) store.cfg=body.cfg; persist('cfg'); return sendJSON(res,{ok:true}); }
  }
  return sendJSON(res,{error:'no encontrado'},404);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost:' + PORT);

  // ---- control de acceso (solo si hay APP_PASSWORD definido) ----
  if (u.pathname==='/api/login' || u.pathname==='/api/logout') { handleAuth(req,res,u).catch(e=>sendJSON(res,{error:e.message},500)); return; }
  if (!autorizado(req)) {
    if (req.method==='GET' && String(req.headers.accept||'').includes('text/html')) { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(LOGIN_HTML); return; }
    res.writeHead(401,{'Content-Type':'application/json; charset=utf-8'}); res.end('{"error":"No autorizado"}'); return;
  }

  if (u.pathname.startsWith('/api/')) { handleApi(req,res,u).catch(e=>sendJSON(res,{error:e.message},500)); return; }

  if (u.pathname.startsWith('/sap/')) {
    const target = new URL(SAP + u.pathname.replace(/^\/sap/, '') + u.search);
    const headers = { ...req.headers }; delete headers.host; delete headers['accept-encoding'];
    const preq = https.request({ hostname: target.hostname, port: 443, path: target.pathname + target.search, method: req.method, headers },
      pres => { res.writeHead(pres.statusCode, pres.headers); pres.pipe(res); });
    preq.on('error', e => { res.writeHead(502, {'Content-Type':'application/json'}); res.end(JSON.stringify({ error: 'No se pudo conectar con SAP: ' + e.message })); });
    req.pipe(preq);
    return;
  }

  let pth = decodeURIComponent(u.pathname);
  if (pth === '/' || pth === '') pth = '/Repuestos-Pedido.html';
  const fp = path.join(ROOT, pth);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end('Prohibido'); return; }
  fs.readFile(fp, (e, data) => {
    if (e) { res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); res.end('No encontrado: ' + pth); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error('\n⚠️  El puerto ' + PORT + ' ya está en uso. ¿Ya tienes el servidor abierto? Abre http://localhost:' + PORT + '\n');
  else console.error('Error del servidor:', e.message);
});

(async () => {
  try { await initDB(); } catch(e){ console.error('⚠️  Error iniciando la base de datos:', e.message); }
  server.listen(PORT, () => {
    console.log('\n  ✅  Repuestos Pedido está corriendo.');
    console.log('  🌐  Abre:  http://localhost:' + PORT);
    console.log('  🔌  Puente SAP activo en /sap');
    console.log('  💾  Almacén: ' + (pool ? 'PostgreSQL (nube)' : 'archivo ' + DATA_FILE) +
      '  (solicitudes:'+store.solicitudes.length+' pedidos:'+store.pedidos.length+' catálogo:'+store.catalogo.length+')');
    console.log('\n  (Deja esta ventana abierta mientras usas la app.)\n');
  });
})();
