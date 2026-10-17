// Faux stockage Netlify Blobs en mémoire (pour les tests)
export function memStore() {
  const m = new Map(); let n = 0;
  return {
    async get(k) { return m.has(k) ? JSON.parse(m.get(k).v) : null; },
    async getWithMetadata(k) { if (!m.has(k)) return null; const e = m.get(k); return { data: JSON.parse(e.v), etag: e.etag }; },
    async setJSON(k, v, o = {}) {
      const cur = m.get(k);
      if (o.onlyIfNew && cur) return { modified: false };
      if (o.onlyIfMatch && (!cur || cur.etag !== o.onlyIfMatch)) return { modified: false };
      m.set(k, { v: JSON.stringify(v), etag: 'e' + (++n) }); return { modified: true };
    },
    async delete(k) { m.delete(k); },
    _m: m,
  };
}
