/* Valve VPK v1/v2 directory reader: get(path) → Buffer (archive files read lazily). */
import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
export function openVpk(dirPath) {
  const d = readFileSync(dirPath); let p = 0;
  const u32 = () => { const v = d.readUInt32LE(p); p += 4; return v; }, u16 = () => { const v = d.readUInt16LE(p); p += 2; return v; };
  const rs = () => { const s = p; while (d[p] !== 0) p++; const v = d.toString('latin1', s, p); p++; return v; };
  const sig = u32(), ver = u32(), tree = u32(); if (sig !== 0x55aa1234) throw new Error('not a vpk');
  if (ver === 2) p += 16;
  const hdr = p, ents = new Map();
  for (;;) { const ext = rs(); if (!ext) break;
    for (;;) { const path = rs(); if (!path) break;
      for (;;) { const name = rs(); if (!name) break;
        u32(); const pre = u16(), ai = u16(), eo = u32(), el = u32(); u16(); const pd = d.subarray(p, p + pre); p += pre;
        ents.set(((path === ' ' ? '' : path + '/') + name + '.' + ext).toLowerCase(), { ai, eo, el, pd }); } } }
  const base = dirPath.replace(/_dir\.vpk$/i, ''), fds = new Map();
  const fd = ai => { if (!fds.has(ai)) fds.set(ai, openSync(`${base}_${String(ai).padStart(3, '0')}.vpk`, 'r')); return fds.get(ai); };
  return {
    size: ents.size,
    has: k => ents.has(k.toLowerCase().replace(/\\/g, '/')),
    get(k) { const e = ents.get(k.toLowerCase().replace(/\\/g, '/')); if (!e) return null;
      let body; if (e.ai === 0x7fff) body = d.subarray(hdr + tree + e.eo, hdr + tree + e.eo + e.el); else { body = Buffer.alloc(e.el); readSync(fd(e.ai), body, 0, e.el, e.eo); }
      return e.pd.length ? Buffer.concat([e.pd, body]) : body; },
    close() { for (const f of fds.values()) closeSync(f); },
  };
}
