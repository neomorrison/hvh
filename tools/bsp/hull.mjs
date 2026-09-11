/* Convex hull → triangles. Planes are outward-facing {x,y,z,d} (n·p <= d inside), Y-up frame. */
function triplePoint(a, b, c) {
  const det = a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x);
  if (Math.abs(det) < 1e-9) return null;
  const inv = 1 / det;
  return {
    x: inv * (a.d * (b.y * c.z - b.z * c.y) - a.y * (b.d * c.z - b.z * c.d) + a.z * (b.d * c.y - b.y * c.d)),
    y: inv * (a.x * (b.d * c.z - b.z * c.d) - a.d * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.d - b.d * c.x)),
    z: inv * (a.x * (b.y * c.d - b.d * c.y) - a.y * (b.x * c.d - b.d * c.x) + a.d * (b.x * c.y - b.y * c.x)),
  };
}
export function brushVertices(planes, eps = 0.06) {
  const out = [];
  for (let i = 0; i < planes.length; i++) for (let j = i + 1; j < planes.length; j++) for (let k = j + 1; k < planes.length; k++) {
    const v = triplePoint(planes[i], planes[j], planes[k]); if (!v) continue;
    let inside = true; for (const p of planes) if (p.x * v.x + p.y * v.y + p.z * v.z - p.d > eps) { inside = false; break; }
    if (!inside) continue;
    if (!out.some(o => Math.abs(o.x - v.x) < 0.05 && Math.abs(o.y - v.y) < 0.05 && Math.abs(o.z - v.z) < 0.05)) out.push(v);
  }
  return out;
}
/* every face polygon of the brush, fan-triangulated, wound so the normal points OUT (along the plane normal) */
export function brushTriangles(planes, out) {
  const verts = brushVertices(planes); if (verts.length < 4) return 0;
  let n = 0;
  for (const p of planes) {
    const on = verts.filter(v => Math.abs(p.x * v.x + p.y * v.y + p.z * v.z - p.d) < 0.1);
    if (on.length < 3) continue;
    const c = { x: 0, y: 0, z: 0 }; for (const v of on) { c.x += v.x; c.y += v.y; c.z += v.z; } c.x /= on.length; c.y /= on.length; c.z /= on.length;
    const ax = Math.abs(p.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const u = { x: ax.y * p.z - ax.z * p.y, y: ax.z * p.x - ax.x * p.z, z: ax.x * p.y - ax.y * p.x };
    const ul = Math.hypot(u.x, u.y, u.z) || 1; u.x /= ul; u.y /= ul; u.z /= ul;
    const w = { x: p.y * u.z - p.z * u.y, y: p.z * u.x - p.x * u.z, z: p.x * u.y - p.y * u.x };
    const ang = v => Math.atan2((v.x - c.x) * w.x + (v.y - c.y) * w.y + (v.z - c.z) * w.z, (v.x - c.x) * u.x + (v.y - c.y) * u.y + (v.z - c.z) * u.z);
    on.sort((a, b) => ang(a) - ang(b));
    for (let k = 1; k < on.length - 1; k++) {
      const a = on[0], b = on[k], d = on[k + 1];
      const nx = (b.y - a.y) * (d.z - a.z) - (b.z - a.z) * (d.y - a.y), ny = (b.z - a.z) * (d.x - a.x) - (b.x - a.x) * (d.z - a.z), nz = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
      if (nx * p.x + ny * p.y + nz * p.z >= 0) out.push(a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z); else out.push(a.x, a.y, a.z, d.x, d.y, d.z, b.x, b.y, b.z);
      n++;
    }
  }
  return n;
}
