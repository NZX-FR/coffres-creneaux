// Faux Netlify Blobs en mémoire, pour tester le serveur sans Netlify
export function memStore() {
  const m = new Map(); let v = 0;
  return {
    async get(k, o) { const e = m.get(k); return e ? (o && o.type === 'json' ? JSON.parse(e.s) : e.s) : null; },
    async getWithMetadata(k, o) { const e = m.get(k); return e ? { data: o && o.type === 'json' ? JSON.parse(e.s) : e.s, etag: e.etag, metadata: {} } : null; },
    async setJSON(k, val, o = {}) { const e = m.get(k); if (o.onlyIfMatch && (!e || e.etag !== o.onlyIfMatch)) return { modified: false }; if (o.onlyIfNew && e) return { modified: false }; m.set(k, { s: JSON.stringify(val), etag: 'e' + (++v) }); return { modified: true, etag: 'e' + v }; },
    async delete(k) { m.delete(k); },
    _map: m,
  };
}
