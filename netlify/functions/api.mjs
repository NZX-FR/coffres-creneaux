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
const MAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i;
const maskMail = (m) => { if (!m) return null; const [u, d] = m.split('@'); return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***' + u.slice(-1)) + '@' + d; };
async function sendMail(env, to, subject, html) {
  if (!env.BREVO_KEY || !env.MAIL_FROM) throw new Error("L'envoi de mails n'est pas encore configuré sur le serveur (BREVO_KEY / MAIL_FROM)");
  const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': env.BREVO_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: env.MAIL_NAME || 'Coffres & Créneaux', email: env.MAIL_FROM }, to: [{ email: to }], subject, htmlContent: html }) });
  if (!r.ok) throw new Error("Le mail n'a pas pu être envoyé (" + r.status + ')');
}
const GOOGLE_CLIENT_ID_DEFAULT = '537392142556-oop0091rr535fefi5cst6khklmpcd9ql.apps.googleusercontent.com';
// vérifie le jeton « Se connecter avec Google » auprès de Google (signature, destinataire, expiration)
async function googleVerify(env, credential) {
  const tok = String(credential || '');
  if (!/^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(tok)) throw new Error('Jeton Google invalide');
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(tok));
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.sub) throw new Error('Connexion Google refusée');
  if (d.aud !== (env.GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID_DEFAULT)) throw new Error('Jeton Google destiné à un autre site');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(d.iss)) throw new Error('Émetteur Google inconnu');
  if (+d.exp * 1000 < Date.now()) throw new Error('Connexion Google expirée, réessaie');
  return { sub: String(d.sub), email: d.email_verified === true || d.email_verified === 'true' ? String(d.email || '').toLowerCase() : '' };
}
async function findPlayer(store, login) {
  login = String(login || '').trim();
  if (login.includes('@')) { const e = await store.get('email/' + (await sha(login.toLowerCase())), { type: 'json' }); return e ? store.get('player/' + e.id, { type: 'json' }) : null; }
  const n = await store.get('name/' + login.toLowerCase(), { type: 'json' }); return n ? store.get('player/' + n.id, { type: 'json' }) : null;
}
const INBOX_MAX = 40, HIST_MAX = 30;
// mines d'or (v114) : production par heure et stock maximum selon le niveau, part volée par un pillard
const MINE_L = [null, { r: 40, cap: 400 }, { r: 90, cap: 1080 }, { r: 160, cap: 2240 }, { r: 260, cap: 4160 }], MINE_STEAL = 0.5;
function cleanMines(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 4).map((m) => {
    if (!m || typeof m !== 'object') m = {};
    const l = clamp(m.l | 0, 1, 4);
    return { r: clamp(m.r | 0, 0, 4), u: clamp(+m.u || 0, 0, 1), v: clamp(+m.v || 0, 0, 1), l, s: clamp(Math.floor(+m.s || 0), 0, MINE_L[l].cap), t: clamp(Math.floor(+m.t || 0), 0, Date.now()) };
  });
}
function mineLootMax(mines, at) {
  let g = 0;
  for (const m of mines || []) { const d = MINE_L[m.l] || MINE_L[1]; g += Math.floor(Math.min(d.cap, (m.s || 0) + Math.max(0, at - (m.t || at)) / 3600e3 * d.r) * MINE_STEAL); }
  return g;
}

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
      mobs: keys(r.mobs, 60), traps: keys(r.traps, 60),
      lay: typeof r.lay === 'string' && /^[a-zA-Z0-9]{1,20}$/.test(r.lay) ? r.lay : null,
      pos: (Array.isArray(r.pos) ? r.pos : []).slice(0, 130).map((q) => ({ k: typeof q.k === 'string' && KEY_RE.test(q.k) ? q.k : '', u: clamp(+q.u || 0, 0, 1), v: clamp(+q.v || 0, 0, 1), t: q.t ? 1 : 0, b: q.b ? 1 : 0, n: Array.isArray(q.n) ? q.n.slice(0, 2).map((x) => clamp(+x || 0, -1, 1)) : undefined, inner: q.inner ? 1 : 0 })).filter((q) => q.k),
    })),
    mlv: {}, tUp: {},
    mines: cleanMines(c.mines),
  };
  for (const k in c.mlv || {}) if (KEY_RE.test(k)) out.mlv[k] = clamp(c.mlv[k] | 0, 1, 20);
  for (const k in c.tUp || {}) if (KEY_RE.test(k)) { const u = c.tUp[k] || {}; out.tUp[k] = { b: u.b === 'a' || u.b === 'b' ? u.b : '', l: clamp(u.l | 0, 0, 3) }; }
  if (JSON.stringify(out).length > 300000) throw new Error('château trop gros');
  return out;
}
function cleanHero(h) {
  if (!h || typeof h !== 'object') return null;
  return { cls: KEY_RE.test(h.cls || '') ? h.cls : 'chevalier', lvl: clamp(h.lvl | 0, 1, 99), power: clamp(+h.power || 0, 0, 1e7) };
}

// ---------- routes ----------
export async function handle(req, store, env = {}) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)/, '') || '/';
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const body = method === 'POST' ? await req.json().catch(() => ({})) : {};
  try {
    if (path === '/ping') return json({ ok: true, t: Date.now() });

    if (path === '/register' && method === 'POST') {
      const name = String(body.name || '').trim(), pin = String(body.pin || ''), email = String(body.email || '').trim().toLowerCase();
      if (!NAME_RE.test(name)) return err('Pseudo : 3 à 16 lettres, chiffres, espaces, - ou _');
      if (!PIN_RE.test(pin)) return err('Mot de passe : 4 à 8 chiffres');
      if (!MAIL_RE.test(email)) return err('Adresse mail invalide');
      const low = name.toLowerCase(), eh = await sha(email);
      if (await store.get('name/' + low, { type: 'json' })) return err('Ce pseudo est déjà pris', 409);
      if (await store.get('email/' + eh, { type: 'json' })) return err('Cette adresse mail est déjà utilisée par un autre compte', 409);
      const id = rnd(8), salt = rnd(8), token = rnd(24);
      const p = { id, name, salt, email, pinHash: await sha(salt + pin), tokenHash: await sha(token), created: Date.now(), trophies: 1000, wins: 0, losses: 0, defW: 0, defL: 0, castleAt: 0, castleMeta: null, hero: null };
      await store.setJSON('name/' + low, { id });
      await store.setJSON('email/' + eh, { id });
      await store.setJSON('player/' + id, p);
      await updateIndex(store, (ix) => { ix.players[id] = pubPlayer(p); });
      return json({ id, name, token: id + '.' + token, trophies: p.trophies, email: maskMail(email) });
    }

    // ----- mot de passe oublié : un code à 6 chiffres est envoyé par mail -----
    if (path === '/reset/request' && method === 'POST') {
      const p = await findPlayer(store, body.login);
      if (!p) return err('Compte introuvable', 404);
      if (!p.pinHash) return err('Ce compte se connecte avec Google : pas de mot de passe à réinitialiser', 400);
      if (!p.email) return err("Ce compte n'a pas d'adresse mail : impossible de réinitialiser le mot de passe", 400);
      if (p.reset && Date.now() - p.reset.at < 60000) return err('Un code vient déjà d\'être envoyé : patiente une minute');
      const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
      p.reset = { hash: await sha(p.salt + 'reset' + code), exp: Date.now() + 15 * 60000, at: Date.now(), tries: 0 };
      await sendMail(env, p.email, 'Coffres & Créneaux : ton code de réinitialisation', `<p>Bonjour ${p.name},</p><p>Voici ton code pour choisir un nouveau mot de passe :</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>Il est valable 15 minutes. Si tu n'as rien demandé, ignore ce mail.</p>`);
      await store.setJSON('player/' + p.id, p);
      return json({ ok: true, email: maskMail(p.email) });
    }
    if (path === '/reset/confirm' && method === 'POST') {
      const p = await findPlayer(store, body.login), code = String(body.code || '').trim(), pin = String(body.pin || '');
      if (!p || !p.reset || Date.now() > p.reset.exp) return err('Code expiré : redemande un code');
      if (p.reset.tries >= 5) return err('Trop d\'essais : redemande un code');
      if (!PIN_RE.test(pin)) return err('Mot de passe : 4 à 8 chiffres');
      if (p.reset.hash !== (await sha(p.salt + 'reset' + code))) { p.reset.tries++; await store.setJSON('player/' + p.id, p); return err('Code incorrect', 401); }
      const token = rnd(24); p.pinHash = await sha(p.salt + pin); p.tokenHash = await sha(token); delete p.reset;
      await store.setJSON('player/' + p.id, p);
      return json({ id: p.id, name: p.name, token: p.id + '.' + token, trophies: p.trophies, email: maskMail(p.email) });
    }

    // ----- connexion avec Google : retrouve (ou crée) le compte lié à ce compte Google -----
    if (path === '/google' && method === 'POST') {
      const g = await googleVerify(env, body.credential);
      const link = await store.get('google/' + g.sub, { type: 'json' });
      let p = link && (await store.get('player/' + link.id, { type: 'json' }));
      if (!p) {
        const name = String(body.name || '').trim();
        if (!name) return json({ need: 'name', suggest: (g.email.split('@')[0] || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 16) });
        if (!NAME_RE.test(name)) return err('Pseudo : 3 à 16 lettres, chiffres, espaces, - ou _');
        const low = name.toLowerCase();
        if (await store.get('name/' + low, { type: 'json' })) return err('Ce pseudo est déjà pris', 409);
        const id = rnd(8), salt = rnd(8);
        p = { id, name, salt, email: '', pinHash: null, google: g.sub, tokenHash: '', created: Date.now(), trophies: 1000, wins: 0, losses: 0, defW: 0, defL: 0, castleAt: 0, castleMeta: null, hero: null };
        if (g.email && !(await store.get('email/' + (await sha(g.email)), { type: 'json' }))) { p.email = g.email; await store.setJSON('email/' + (await sha(g.email)), { id }); }
        await store.setJSON('name/' + low, { id });
        await store.setJSON('google/' + g.sub, { id });
        p.isNew = 1;
      }
      const token = rnd(24); p.tokenHash = await sha(token); const isNew = !!p.isNew; delete p.isNew;
      await store.setJSON('player/' + p.id, p);
      if (isNew) await updateIndex(store, (ix) => { ix.players[p.id] = pubPlayer(p); });
      return json({ id: p.id, name: p.name, token: p.id + '.' + token, trophies: p.trophies, email: maskMail(p.email), google: true, created: isNew });
    }

    if (path === '/login' && method === 'POST') {
      const pin = String(body.pin || '');
      const p = await findPlayer(store, body.name);
      if (!p || !p.pinHash || p.pinHash !== (await sha(p.salt + pin))) return err(p && !p.pinHash ? 'Ce compte se connecte avec Google' : 'Pseudo ou mot de passe incorrect', 401);
      const token = rnd(24); p.tokenHash = await sha(token);
      await store.setJSON('player/' + p.id, p);
      return json({ id: p.id, name: p.name, token: p.id + '.' + token, trophies: p.trophies, email: maskMail(p.email) });
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

    if (path === '/me') return json({ me: pubPlayer(me), email: maskMail(me.email) });

    if (path === '/google/link' && method === 'POST') {
      const g = await googleVerify(env, body.credential);
      const ex = await store.get('google/' + g.sub, { type: 'json' });
      if (ex && ex.id !== me.id) return err('Ce compte Google est déjà lié à un autre compte du jeu', 409);
      if (me.google && me.google !== g.sub) await store.delete('google/' + me.google).catch(() => {});
      me.google = g.sub; await store.setJSON('google/' + g.sub, { id: me.id });
      if (!me.email && g.email && !(await store.get('email/' + (await sha(g.email)), { type: 'json' }))) { me.email = g.email; await store.setJSON('email/' + (await sha(g.email)), { id: me.id }); }
      await store.setJSON('player/' + me.id, me);
      return json({ ok: true, email: maskMail(me.email) });
    }

    if (path === '/account/email' && method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase(), pin = String(body.pin || '');
      if (me.pinHash && me.pinHash !== (await sha(me.salt + pin))) return err('Mot de passe incorrect', 401);
      if (!MAIL_RE.test(email)) return err('Adresse mail invalide');
      const eh = await sha(email), ex = await store.get('email/' + eh, { type: 'json' });
      if (ex && ex.id !== me.id) return err('Cette adresse mail est déjà utilisée par un autre compte', 409);
      if (me.email) await store.delete('email/' + (await sha(me.email))).catch(() => {});
      me.email = email; await store.setJSON('email/' + eh, { id: me.id }); await store.setJSON('player/' + me.id, me);
      return json({ ok: true, email: maskMail(email) });
    }

    // ----- synchronisation groupée : profil + attaques subies (or encaissé) + raids + classement, en UNE requête -----
    if (path === '/sync') {
      const wantTop = url.searchParams.get('top') !== '0';
      const [ib0, hist0, ix] = await Promise.all([store.get('inbox/' + me.id, { type: 'json' }), store.get('hist/' + me.id, { type: 'json' }), wantTop ? readIndex(store) : null]);
      const ib = ib0 || { events: [] }, hist = hist0 || { raids: [] };
      let gold = 0, mine = 0; const fresh = [];
      for (const e of ib.events) if (!e.claimed) { e.claimed = 1; gold += e.gold || 0; mine += e.mine || 0; fresh.push(e); }
      if (fresh.length) await store.setJSON('inbox/' + me.id, ib);
      const top = ix ? Object.values(ix.data.players).sort((a, b) => b.trophies - a.trophies).slice(0, 50) : undefined;
      const body = { me: pubPlayer(me), events: ib.events, raids: hist.raids, claimed: { gold, mine, n: fresh.length, lost: fresh.filter((e) => e.success).length }, top, save: me.saveMeta || null, email: maskMail(me.email), google: !!me.google };
      return json(body);
    }

    // ----- sauvegarde de la partie dans le cloud (compressée par le jeu) -----
    if (path === '/save' && method === 'POST') {
      const data = String(body.data || '');
      if (!data || data.length > 800000) return err('Sauvegarde vide ou trop grosse');
      if (!/^[A-Za-z0-9+/=]+$/.test(data)) return err('Sauvegarde invalide');
      const meta = { t: Date.now(), lvl: clamp(body.lvl | 0, 0, 999), cls: KEY_RE.test(body.cls || '') ? body.cls : '', pl: clamp(body.pl | 0, 0, 999), size: data.length };
      await store.setJSON('save/' + me.id, { ...meta, data });
      const old = me.saveMeta; me.saveMeta = meta; if (!old || meta.t - old.t > 300000) await store.setJSON('player/' + me.id, me);
      return json({ ok: true, save: meta });
    }
    if (path === '/save' && method === 'GET') {
      const sv = await store.get('save/' + me.id, { type: 'json' });
      return json({ save: sv || null });
    }

    if (path === '/dev') {
      const admins = String(env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean);
      return json({ dev: admins.includes(me.id), id: me.id });
    }

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
      // les 24 joueurs les plus proches en trophées : le jeu en choisit 5 (facile, équilibré, difficile), comme en matchmaking
      return json({ opponents: all.slice(0, 24), me: pubPlayer(me) });
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
      const gain = success ? Math.round(clamp(40 + 2 * diff, 10, 70)) : -Math.round(clamp(24 - diff, 8, 36));
      const dGain = success ? -Math.round(Math.abs(gain) * .6) : Math.round(clamp(30 - diff, 12, 50));
      me.trophies = Math.max(0, me.trophies + gain); def.trophies = Math.max(0, def.trophies + dGain);
      if (success) { me.wins++; def.defL++; } else { me.losses++; def.defW++; }
      const reward = success ? 0 : Math.round(40 * ((def.castleMeta || {}).lvl || 1) * (1 + (body.rooms | 0) * .1));
      // or arraché aux mines : jamais plus que ce que les mines publiées contenaient au début du raid
      let mine = 0;
      if ((body.mineGold | 0) > 0) { const cs = await store.get('castle/' + raid.target, { type: 'json' }); mine = clamp(body.mineGold | 0, 0, mineLootMax(cs && cs.mines, raid.t) + 4); }
      const ev = { t: Date.now(), by: me.name, byId: me.id, success, rooms: clamp(body.rooms | 0, 0, 5), kills: clamp(body.kills | 0, 0, 999), trophies: dGain, gold: reward, mine, cls: cleanHero(body.hero)?.cls || '' };
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
  const ge = (k) => (globalThis.Netlify && Netlify.env && Netlify.env.get(k)) || process.env[k] || '';
  const env = { ADMIN_IDS: ge('ADMIN_IDS'), BREVO_KEY: ge('BREVO_KEY'), MAIL_FROM: ge('MAIL_FROM'), MAIL_NAME: ge('MAIL_NAME'), GOOGLE_CLIENT_ID: ge('GOOGLE_CLIENT_ID') };
  return handle(req, getStore({ name: 'coffres-creneaux', consistency: 'strong' }), env);
};

export const config = { path: '/api/*' };
