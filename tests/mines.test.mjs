// node tests/mines.test.mjs : publication des mines, vol pendant un raid, remboursement à la synchro
import { handle } from '../netlify/functions/api.mjs';
import { memStore } from './memstore.mjs';
const store = memStore(); let ok = 0, ko = 0;
const t = (c, msg) => { if (c) ok++; else { ko++; console.error('ÉCHEC :', msg); } };
async function call(path, body, tok) {
  const r = await handle(new Request('http://x/api' + path, { method: body ? 'POST' : 'GET', headers: tok ? { authorization: 'Bearer ' + tok } : {}, body: body ? JSON.stringify(body) : undefined }), store, {});
  return { status: r.status, d: await r.json() };
}
const reg = async (name) => (await call('/register', { name, pin: '1234', email: name + '@test.fr' })).d;
const a = await reg('Pillard'), b = await reg('Mineur');
t(a.token && b.token, 'comptes créés');
const now = Date.now();
const castle = { name: 'Fort', lvl: 5, rooms: [{ mobs: ['gobelin'], traps: [] }, { mobs: ['boss'], traps: [] }],
  mines: [{ r: 0, u: .5, v: .5, l: 2, s: 500, t: now }, { r: 1, u: 2, v: -1, l: 9, s: 99999, t: now + 1e9 }, 'nimporte', { r: 0 }, { r: 1 }] };
let p = await call('/publish', { castle, hero: { cls: 'mage', lvl: 9 } }, b.token);
t(p.status === 200, 'publication ' + JSON.stringify(p.d));
const st = await store.get('castle/' + b.id);
t(st.mines.length === 4, '4 mines au plus');
t(st.mines[1].l === 4 && st.mines[1].u === 1 && st.mines[1].v === 0 && st.mines[1].s === 4160 && st.mines[1].t <= Date.now(), 'mine nettoyée ' + JSON.stringify(st.mines[1]));
t(st.mines[2].l === 1 && st.mines[2].s === 0, 'mine invalide neutralisée');
// raid : le pillard prétend avoir volé 1 000 000 d'or
let s = await call('/raid/start', { target: b.id }, a.token);
t(s.status === 200 && s.d.castle.mines.length === 4, 'le château envoyé au pillard contient les mines');
const raid = await store.get('raid/' + s.d.raid); raid.t -= 20000; await store.setJSON('raid/' + s.d.raid, raid);
let e = await call('/raid/end', { raid: s.d.raid, success: true, rooms: 2, kills: 3, mineGold: 1000000, hero: { cls: 'mage', lvl: 9 } }, a.token);
t(e.status === 200, 'fin de raid');
const ib = await store.get('inbox/' + b.id), ev = ib.events[0];
const max = Math.floor(500 * .5) + Math.floor(4160 * .5) + 0 + 0 + 4;
t(ev.mine > 0 && ev.mine <= max, 'vol plafonné : ' + ev.mine + ' ≤ ' + max);
// la victime voit le vol à la synchro, une seule fois
let y = await call('/sync', null, b.token);
t(y.d.claimed.mine === ev.mine && y.d.claimed.n === 1, 'synchro : vol signalé ' + JSON.stringify(y.d.claimed));
y = await call('/sync', null, b.token);
t(y.d.claimed.mine === 0, 'pas signalé deux fois');
// raid sans mine : rien de volé
s = await call('/raid/start', { target: b.id }, a.token);
e = await call('/raid/end', { raid: s.d.raid, success: false, rooms: 0 }, a.token);
t((await store.get('inbox/' + b.id)).events[0].mine === 0, 'raid sans mine');
console.log(`${ok} réussis, ${ko} échoués`); process.exit(ko ? 1 : 0);
