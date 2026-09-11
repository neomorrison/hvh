/* Source-1 .nav (v5–v16; tested on CS:S v9) → the game's node graph.
   Output: { nodes: [{ id, p: [x, y, z] }], edges: { id: [ids] } } in the game's Y-up frame (x, z, -y). */
export function parseNav(buf) {
  let p = 0;
  const u32 = () => { const v = buf.readUInt32LE(p); p += 4; return v; }, u16 = () => { const v = buf.readUInt16LE(p); p += 2; return v; };
  const u8 = () => buf[p++], f32 = () => { const v = buf.readFloatLE(p); p += 4; return v; };
  if (u32() !== 0xfeedface) throw new Error('not a nav'); const ver = u32(); if (ver >= 10) u32(); if (ver >= 4) u32(); if (ver >= 14) u8();
  if (ver >= 5) { const n = u16(); for (let i = 0; i < n; i++) { const L = u16(); p += L; } if (ver > 12) u8(); }
  const areas = new Map(), n = u32();
  for (let i = 0; i < n; i++) {
    const id = u32(); if (ver <= 8) u8(); else if (ver < 13) u16(); else u32();
    const nw = [f32(), f32(), f32()], se = [f32(), f32(), f32()], neZ = f32(), swZ = f32(), conns = [];
    for (let d = 0; d < 4; d++) { const c = u32(); for (let k = 0; k < c; k++) conns.push(u32()); }
    const hs = u8(); p += hs * 17;
    if (ver < 15) { const ap = u8(); p += ap * 14; }
    const ep = u32(); for (let k = 0; k < ep; k++) { p += 10; const sc = u8(); p += sc * 5; }
    if (ver >= 5) u16();
    if (ver >= 7) for (let d = 0; d < 2; d++) { const c = u32(); p += c * 4; }
    if (ver >= 8) p += 8;
    if (ver >= 11) p += 16;
    if (ver >= 16) for (let d = 0; d < 2; d++) { const c = u32(); p += c * 8; }
    areas.set(id, { nw, se, neZ, swZ, conns });
  }
  return { version: ver, areas };
}
export function navToGraph(nav, cell = 110) {
  const nodes = [], edges = {}, byArea = new Map();
  const zAt = (a, x, y) => { const w = a.se[0] - a.nw[0] || 1, h = a.se[1] - a.nw[1] || 1, u = (x - a.nw[0]) / w, v = (y - a.nw[1]) / h; return (a.nw[2] * (1 - u) + a.neZ * u) * (1 - v) + (a.swZ * (1 - u) + a.se[2] * u) * v; };
  for (const [id, a] of nav.areas) {
    const w = a.se[0] - a.nw[0], h = a.se[1] - a.nw[1], nx = Math.max(1, Math.round(w / cell)), ny = Math.max(1, Math.round(h / cell)), list = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const x = a.nw[0] + w * (i + 0.5) / nx, y = a.nw[1] + h * (j + 0.5) / ny, z = zAt(a, x, y);
      const n = { id: nodes.length, p: [x, z, -y], i, j }; nodes.push(n); edges[n.id] = []; list.push(n);
    }
    for (const n of list) for (const m of list) if (n !== m && Math.abs(n.i - m.i) + Math.abs(n.j - m.j) === 1) edges[n.id].push(m.id);
    byArea.set(id, list);
  }
  const d2 = (n, m) => (n.p[0] - m.p[0]) ** 2 + (n.p[2] - m.p[2]) ** 2;
  for (const [id, a] of nav.areas) for (const cid of a.conns) {
    const A = byArea.get(id), B = byArea.get(cid); if (!A || !B) continue;
    for (const n of A) { let best = null, bd = Infinity; for (const m of B) { const d = d2(n, m); if (d < bd) { bd = d; best = m; } } if (best && bd < (cell * 2.2) ** 2 && !edges[n.id].includes(best.id)) edges[n.id].push(best.id); }
  }
  return { nodes: nodes.map(n => ({ id: n.id, p: n.p })), edges };
}
