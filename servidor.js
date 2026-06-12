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
const { URL } = require('url');

const ROOT = __dirname;
const PORT = process.env.PORT || 8723;
const SAP = 'https://sap-api.eugeniachat.ai';
const DATABASE_URL = process.env.DATABASE_URL || '';
const DATA_FILE = path.join(process.env.DATA_DIR || ROOT, 'datos.json');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const COLS = ['solicitudes','pedidos','catalogo','cfg'];

// ---------- almacén en memoria ----------
let store = { solicitudes:[], pedidos:[], catalogo:[], cfg:{} };
const keyField = coll => coll==='catalogo' ? 'parte' : 'id';

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
