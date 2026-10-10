// Coffres & Créneaux — logique du serveur multijoueur asynchrone (indépendante de Netlify pour pouvoir être testée)
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const rnd = (n = 24) => hex(crypto.getRandomValues(new Uint8Array(n)));
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });
const err = (msg, status = 400) => json({ error: msg }, status);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const NAME_RE = /^[A-Za-zÀ-ÿ0-9 _\-]{3,16}$/;
const PIN_RE = /^\d{4,8}$/;
const KEY_RE = /^[a-z]{2,14}$/;
const INBOX_MAX = 40, HIST_MAX = 30;

// ---------- index des joueurs (un seul blob, écrit avec un verrou optimiste quand c'est possible) ----------
async function readIndex(store) {
  try {
    const r = await store.getWithMetadata('index', { type: 'json' });
    if (r && r.data) return { data: r.data, etag: r.etag };
  } catch (_) {}
  return { data: { players: {} }, etag: null };
}
async function updateIndex(store, fn) {
  for (let i = 0; i < 5; i++) {
    const { data, etag } = await readIndex(store);
    fn(data);
    try {
      const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
      const r = await store.setJSON('index', data, opts);
      if (!r || r.modified !== false) return data;
    } catch (_) {
      await store.setJSON('index', data); return data; // ancienne version de la bibliothèque : écriture simple
    }
    await new Promise((res) => setTimeout(res, 40 + Math.random() * 80));
  }
  throw new Error('index occupé, réessaie');
}

async function auth(store, req) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer ([a-f0-9]{8,64})\.([a-f0-9]{48})$/);
  if (!m) return null;
  const p = await store.get('player/' + m[1], { type: 'json' });
  if (!p || p.tokenHash !== (await sha(m[2]))) return null;
  return p;
}
const pubPlayer = (p) => ({ id: p.id, name: p.name, trophies: p.trophies, wins: p.wins, losses: p.losses, defW: p.defW, defL: p.defL, lvl: (p.castleMeta || {}).lvl || 0, power: (p.castleMeta || {}).power || 0, hero: p.hero || null, updated: p.castleAt || 0, hasCastle: !!p.castleAt });

// ---------- nettoyage du château envoyé par le client ----------
function cleanCastle(c) {
  if (!c || typeof c !== 'object') throw new Error('château invalide');
  const rooms = Array.isArray(c.rooms) ? c.rooms.slice(0, 5) : [];
  if (rooms.length < 1) throw new Error('château vide');
  const keys = (arr, n) => (Array.isArray(arr) ? arr : []).filter((k) => typeof k === 'string' && KEY_RE.test(k)).slice(0, n);
  const out = {
    name: String(c.name || 'Château').slice(0, 28),
    lvl: clamp(c.lvl | 0, 1, 10),
    style: typeof c.style === 'string' && KEY_RE.test(c.style) ? c.style : 'classique',
    power: clamp(+c.power || 0, 0, 1e7),
    rooms: rooms.map((r) => ({
      mobs: keys(r.mobs, 40), traps: keys(r.traps, 6),
      lay: typeof r.lay === 'string' && /^[a-zA-Z0-9]{1,20}$/.test(r.lay) ? r.lay : null,
      pos: (Array.isArray(r.pos) ? r.pos : []).slice(0, 60).map((q) => ({ k: typeof q.k === 'string' && KEY_RE.test(q.k) ? q.k : '', u: clamp(+q.u || 0, 0, 1), v: clamp(+q.v || 0, 0, 1), t: q.t ? 1 : 0, b: q.b ? 1 : 0, n: Array.isArray(q.n) ? q.n.slice(0, 2).map((x) => clamp(+x || 0, -1, 1)) : undefined, inner: q.inner ? 1 : 0 })).filter((q) => q.k),
    })),
    mlv: {}, tUp: {},
  };
  for (const k in c.mlv || {}) if (KEY_RE.test(k)) out.mlv[k] = clamp(c.mlv[k] | 0, 1, 20);
  for (const k in c.tUp || {}) if (KEY_RE.test(k)) { const u = c.tUp[k] || {}; out.tUp[k] = { b: u.b === 'a' || u.b === 'b' ? u.b : '', l: clamp(u.l | 0, 0, 3) }; }
  if (JSON.stringify(out).length > 150000) throw new Error('château trop gros');
  return out;
}
function cleanHero(h) {
  if (!h || typeof h !== 'object') return null;
  return { cls: KEY_RE.test(h.cls || '') ? h.cls : 'chevalier', lvl: clamp(h.lvl | 0, 1, 99), power: clamp(+h.power || 0, 0, 1e7) };
}

// ---------- routes ----------
export async function handle(req, store) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)/, '') || '/';
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const body = method === 'POST' ? await req.json().catch(() => ({})) : {};
  try {
    if (path === '/ping') return json({ ok: true, t: Date.now() });

    if (path === '/register' && method === 'POST') {
      const name = String(body.name || '').trim(), pin = String(body.pin || '');
      if (!NAME_RE.test(name)) return err('Pseudo : 3 à 16 lettres, chiffres, espaces, - ou _');
      if (!PIN_RE.test(pin)) return err('Code secret : 4 à 8 chiffres');
      const low = name.toLowerCase();
      if (await store.get('name/' + low, { type: 'json' })) return err('Ce pseudo est déjà pris', 409);
      const id = rnd(8), salt = rnd(8), token = rnd(24);
      const p = { id, name, salt, pinHash: await sha(salt + pin), tokenHash: await sha(token), created: Date.now(), trophies: 1000, wins: 0, losses: 0, defW: 0, defL: 0, castleAt: 0, castleMeta: null, hero: null };
      await store.setJSON('name/' + low, { id });
      await store.setJSON('player/' + id, p);
      await updateIndex(store, (ix) => { ix.players[id] = pubPlayer(p); });
      return json({ id, name, token: id + '.' + token, trophies: p.trophies });
    }

    if (path === '/login' && method === 'POST') {
      const name = String(body.name || '').trim(), pin = String(body.pin || '');
      const n = await store.get('name/' + name.toLowerCase(), { type: 'json' });
      const p = n && (await store.get('player/' + n.id, { type: 'json' }));
      if (!p || p.pinHash !== (await sha(p.salt + pin))) return err('Pseudo ou code incorrect', 401);
      const token = rnd(24); p.tokenHash = await sha(token);
      await store.setJSON('player/' + p.id, p);
      return json({ id: p.id, name: p.name, token: p.id + '.' + token, trophies: p.trophies });
    }

    if (path === '/leaderboard') {
      const { data } = await readIndex(store);
      const top = Object.values(data.players).sort((a, b) => b.trophies - a.trophies).slice(0, 50);
      return json({ top });
    }

    if (path.startsWith('/castle/') && method === 'GET') {
      const id = path.slice(8).replace(/[^a-f0-9]/g, '');
      const c = await store.get('castle/' + id, { type: 'json' });
      if (!c) return err('Château introuvable', 404);
      const p = await store.get('player/' + id, { type: 'json' });
      return json({ castle: c, owner: p ? pubPlayer(p) : null });
    }

    // ----- routes qui demandent d'être connecté -----
    const me = await auth(store, req);
    if (!me) return err('Session expirée : reconnecte-toi', 401);

    if (path === '/me') return json({ me: pubPlayer(me) });

    if (path === '/publish' && method === 'POST') {
      const castle = cleanCastle(body.castle);
      me.castleAt = Date.now(); me.castleMeta = { lvl: castle.lvl, power: castle.power, name: castle.name }; me.hero = cleanHero(body.hero);
      await store.setJSON('castle/' + me.id, castle);
      await store.setJSON('player/' + me.id, me);
      await updateIndex(store, (ix) => { ix.players[me.id] = pubPlayer(me); });
      return json({ ok: true, at: me.castleAt });
    }

    if (path === '/opponents') {
      const { data } = await readIndex(store);
      const all = Object.values(data.players).filter((p) => p.hasCastle && p.id !== me.id);
      all.sort((a, b) => Math.abs(a.trophies - me.trophies) - Math.abs(b.trophies - me.trophies));
      const pool = all.slice(0, 16);
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      return json({ opponents: pool.slice(0, 8), me: pubPlayer(me) });
    }

    if (path === '/raid/start' && method === 'POST') {
      const target = String(body.target || '').replace(/[^a-f0-9]/g, '');
      if (!target || target === me.id) return err('Cible invalide');
      const c = await store.get('castle/' + target, { type: 'json' });
      if (!c) return err('Château introuvable', 404);
      const raid = { id: rnd(8), attacker: me.id, target, t: Date.now(), done: false };
      await store.setJSON('raid/' + raid.id, raid);
      const owner = await store.get('player/' + target, { type: 'json' });
      return json({ raid: raid.id, castle: c, owner: owner ? pubPlayer(owner) : null });
    }

    if (path === '/raid/end' && method === 'POST') {
      const rid = String(body.raid || '').replace(/[^a-f0-9]/g, '');
      const raid = rid && (await store.get('raid/' + rid, { type: 'json' }));
      if (!raid || raid.attacker !== me.id) return err('Raid inconnu', 404);
      if (raid.done) return err('Raid déjà terminé', 409);
      const dur = (Date.now() - raid.t) / 1000;
      const success = !!body.success && dur >= 15; // un raid réussi en moins de 15 s est refusé
      raid.done = true; raid.success = success; await store.setJSON('raid/' + rid, raid);
      const def = await store.get('player/' + raid.target, { type: 'json' });
      if (!def) return err('Défenseur introuvable', 404);
      const diff = clamp((def.trophies - me.trophies) / 25, -10, 10);
      const gain = success ? Math.round(clamp(20 + diff, 5, 35)) : -Math.round(clamp(12 - diff * .5, 4, 18));
      const dGain = success ? -Math.round(Math.abs(gain) * .6) : Math.round(clamp(15 + diff * -.5, 6, 25));
      me.trophies = Math.max(0, me.trophies + gain); def.trophies = Math.max(0, def.trophies + dGain);
      if (success) { me.wins++; def.defL++; } else { me.losses++; def.defW++; }
      const reward = success ? 0 : Math.round(40 * ((def.castleMeta || {}).lvl || 1) * (1 + (body.rooms | 0) * .1));
      const ev = { t: Date.now(), by: me.name, byId: me.id, success, rooms: clamp(body.rooms | 0, 0, 5), kills: clamp(body.kills | 0, 0, 999), trophies: dGain, gold: reward, cls: cleanHero(body.hero)?.cls || '' };
      const ib = (await store.get('inbox/' + def.id, { type: 'json' })) || { events: [] };
      ib.events.unshift(ev); ib.events = ib.events.slice(0, INBOX_MAX);
      const hist = (await store.get('hist/' + me.id, { type: 'json' })) || { raids: [] };
      hist.raids.unshift({ t: Date.now(), target: def.name, targetId: def.id, success, trophies: gain }); hist.raids = hist.raids.slice(0, HIST_MAX);
      await Promise.all([store.setJSON('player/' + me.id, me), store.setJSON('player/' + def.id, def), store.setJSON('inbox/' + def.id, ib), store.setJSON('hist/' + me.id, hist)]);
      await updateIndex(store, (ix) => { ix.players[me.id] = pubPlayer(me); ix.players[def.id] = pubPlayer(def); });
      return json({ ok: true, success, trophies: me.trophies, gain });
    }

    if (path === '/inbox') {
      const ib = (await store.get('inbox/' + me.id, { type: 'json' })) || { events: [] };
      const hist = (await store.get('hist/' + me.id, { type: 'json' })) || { raids: [] };
      return json({ events: ib.events, raids: hist.raids, me: pubPlayer(me) });
    }

    if (path === '/inbox/claim' && method === 'POST') {
      const ib = (await store.get('inbox/' + me.id, { type: 'json' })) || { events: [] };
      let gold = 0, n = 0; for (const e of ib.events) if (!e.claimed) { e.claimed = 1; gold += e.gold || 0; n++; }
      await store.setJSON('inbox/' + me.id, ib);
      return json({ gold, n });
    }

    return err('Route inconnue', 404);
  } catch (e) {
    return err(String((e && e.message) || e), 400);
  }
}

// ---------- point d'entrée Netlify ----------
export default async (req) => {
  const { getStore } = await import('@netlify/blobs');
  return handle(req, getStore({ name: 'coffres-creneaux', consistency: 'strong' }));
};

export const config = { path: '/api/*' };
