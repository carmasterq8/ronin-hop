// Ronin Hop contest score server. Stores one entry per phone number and keeps that player's best score.
// The public board returns names and scores only; phone numbers are shown only on /admin with ADMIN_KEY.
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 10000;
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://carmasterq8.github.io').split(',').map(s => s.trim());
const ENDS_AT = new Date(process.env.CONTEST_END || '2026-11-30T23:59:59+03:00');
const SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const TOP_N = 10;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

async function migrate() {
  await pool.query(`create table if not exists players (
    phone text primary key, name text not null, best integer not null default 0, best_hops integer not null default 0,
    games integer not null default 0, best_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
  await pool.query(`create table if not exists used_runs (nonce text primary key, at timestamptz not null default now())`);
  await pool.query(`create index if not exists players_rank on players (best desc, best_at asc)`);
}

const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex').slice(0, 32);
const newToken = () => { const p = Date.now() + '.' + crypto.randomBytes(9).toString('hex'); return p + '.' + sign(p); };
function readToken(t) {
  const m = /^(\d{13})\.([0-9a-f]{18})\.([0-9a-f]{32})$/.exec(String(t || ''));
  if (!m) return null;
  const want = sign(m[1] + '.' + m[2]);
  if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[3]))) return null;
  return { started: +m[1], nonce: m[2] };
}

const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
function cleanPhone(s) {
  let d = String(s || '').replace(/[٠-٩]/g, c => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace(/\D/g, '').replace(/^00/, '');
  if (d.length === 8) d = '965' + d;               // local Kuwait number
  return d.length >= 10 && d.length <= 15 ? d : '';
}
// A score no real run can reach for that many hops is refused.
const plausible = (score, hops, secs) => Number.isInteger(score) && Number.isInteger(hops) && score >= 0 && hops >= 0 && hops <= 5000
  && score <= hops * (hops + 1) + hops * 20 + 40 && secs >= hops * 0.4;

const hits = new Map();   // tiny per-IP rate limit
function limited(ip, max = 40) {
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 60000);
  h.push(now); hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return h.length > max;
}

async function board() {
  const [top, n] = await Promise.all([
    pool.query('select name, best from players where best > 0 order by best desc, best_at asc limit $1', [TOP_N]),
    pool.query('select count(*)::int as n from players where best > 0')]);
  return { open: Date.now() < ENDS_AT.getTime(), endsAt: ENDS_AT.toISOString(), players: n.rows[0].n, top: top.rows.map(r => ({ name: r.name, score: r.best })) };
}

async function submit(body) {
  if (Date.now() >= ENDS_AT.getTime()) return [403, { error: 'closed' }];
  const name = cleanName(body.name), phone = cleanPhone(body.phone);
  const score = Number(body.score), hops = Number(body.hops);
  if (name.length < 2) return [400, { error: 'name' }];
  if (!phone) return [400, { error: 'phone' }];
  const tok = readToken(body.token);
  if (!tok || Date.now() - tok.started > 3 * 3600e3) return [400, { error: 'token' }];
  if (!plausible(score, hops, (Date.now() - tok.started) / 1000)) return [400, { error: 'score' }];
  const used = await pool.query('insert into used_runs (nonce) values ($1) on conflict do nothing', [tok.nonce]);
  if (!used.rowCount) return [409, { error: 'used' }];
  const r = await pool.query(`insert into players (phone, name, best, best_hops, games, best_at) values ($1,$2,$3,$4,1,now())
    on conflict (phone) do update set name = excluded.name, games = players.games + 1, updated_at = now(),
      best_hops = case when excluded.best > players.best then excluded.best_hops else players.best_hops end,
      best_at = case when excluded.best > players.best then now() else players.best_at end,
      best = greatest(players.best, excluded.best)
    returning best, best_at`, [phone, name, score, hops]);
  const me = r.rows[0];
  const rank = await pool.query('select count(*)::int + 1 as rank from players where best > $1 or (best = $1 and best_at < $2)', [me.best, me.best_at]);
  return [200, Object.assign({ best: me.best, rank: rank.rows[0].rank }, await board())];
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function adminPage() {
  const r = await pool.query('select name, phone, best, best_hops, games, best_at from players order by best desc, best_at asc limit 500');
  const rows = r.rows.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>+${esc(p.phone)}</td><td><b>${p.best}</b></td><td>${p.best_hops}</td><td>${p.games}</td><td>${p.best_at ? new Date(p.best_at).toLocaleString('en-GB', { timeZone: 'Asia/Kuwait' }) : ''}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Ronin Hop contest</title>
<style>body{font:15px system-ui,sans-serif;margin:16px;color:#16181d}table{border-collapse:collapse;width:100%}td,th{padding:8px 6px;border-bottom:1px solid #ddd;text-align:left}th{font-size:12px;text-transform:uppercase;letter-spacing:.06em}</style>
<h1>Ronin Hop contest</h1><p>${r.rows.length} players · closes ${ENDS_AT.toLocaleString('en-GB', { timeZone: 'Asia/Kuwait' })} (Kuwait time)</p>
<div style="overflow-x:auto"><table><tr><th>#</th><th>Name</th><th>Phone</th><th>Best</th><th>Hops</th><th>Games</th><th>Record set</th></tr>${rows}</table></div>`;
}

function readBody(req) {
  return new Promise((res, rej) => { let b = ''; req.on('data', c => { b += c; if (b.length > 4000) { rej(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } }); req.on('error', rej); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), origin = req.headers.origin;
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (origin && ORIGINS.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/health') return json(200, { ok: true });
    if (limited(ip)) return json(429, { error: 'slow' });
    if (req.method === 'GET' && url.pathname === '/api/board') return json(200, await board());
    if (req.method === 'POST' && url.pathname === '/api/start') return json(200, { token: newToken(), open: Date.now() < ENDS_AT.getTime() });
    if (req.method === 'POST' && url.pathname === '/api/score') { const [c, o] = await submit(await readBody(req)); return json(c, o); }
    if (req.method === 'GET' && url.pathname === '/admin') {
      const k = url.searchParams.get('key') || '';
      if (!ADMIN_KEY || k.length !== ADMIN_KEY.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY))) return json(403, { error: 'forbidden' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(await adminPage());
    }
    json(404, { error: 'not found' });
  } catch (e) { console.error(req.method, url.pathname, e.message); json(500, { error: 'server' }); }
});

migrate().then(() => server.listen(PORT, () => console.log('contest server on', PORT, 'ends', ENDS_AT.toISOString())))
  .catch(e => { console.error('startup failed', e.message); process.exit(1); });
