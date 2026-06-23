/* ============================== [SOURCE MAP IMPORT] ==============================
   Offline import of a real Source 2 / CS2 map.  You decompile the map's
   geometry to glTF (.glb) with Source2Viewer/VRF and dump its spawn entities;
   this module parses the .glb into a triangle mesh, builds a BVH, and provides
   mesh-based line-of-sight, bullet penetration, floor-following and collision so
   the imported layout is used 1:1 (the game already runs in Source units).

   Self-contained: a tiny glTF/GLB reader + BVH, no extra libraries, so it works
   offline.  All the geometry math is three.js-free and unit-tested under Node;
   only activate()/the visual mesh use THREE.                                     */
import { WEAPONS, PEN } from './data.js';

/* ---------------- small mat4 / vec helpers (column-major, glTF convention) ---------------- */
const IDENT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul4(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function composeTRS(t, q, s) {
  const [x, y, z, w] = q, x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
function tp(m, x, y, z) { return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]; }

/* ---------------- glTF / GLB → world-space triangle soup (positions only) ---------------- */
const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NUM_COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function readComp(dv, p, ct) {
  switch (ct) { case 5120: return dv.getInt8(p); case 5121: return dv.getUint8(p); case 5122: return dv.getInt16(p, true); case 5123: return dv.getUint16(p, true); case 5125: return dv.getUint32(p, true); default: return dv.getFloat32(p, true); }
}
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

export function parseGLB(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const ab = u8.buffer; const dv = new DataView(ab, u8.byteOffset, u8.byteLength);
  let json = null, bin = null;
  if (dv.getUint32(0, true) === 0x46546C67) {           // "glTF" → GLB container
    const total = dv.getUint32(8, true); let off = 12;
    while (off < total) {
      const clen = dv.getUint32(off, true), ctype = dv.getUint32(off + 4, true); off += 8;
      const chunk = new Uint8Array(ab, u8.byteOffset + off, clen);
      if (ctype === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(chunk));
      else if (ctype === 0x004E4942) bin = chunk;
      off += clen;
    }
  } else {
    json = JSON.parse(new TextDecoder().decode(u8));      // plain .gltf text
  }
  const buffers = (json.buffers || []).map(b => {
    if (b.uri) { if (b.uri.startsWith('data:')) return b64ToBytes(b.uri.slice(b.uri.indexOf('base64,') + 7)); throw new Error('External .bin not supported — export a single .glb'); }
    return bin;
  });
  const readAcc = (idx) => {
    const acc = json.accessors[idx], bv = json.bufferViews[acc.bufferView], buf = buffers[bv.buffer];
    const cs = COMP_SIZE[acc.componentType], nc = NUM_COMP[acc.type];
    const base = (bv.byteOffset || 0) + (acc.byteOffset || 0), stride = bv.byteStride || cs * nc;
    const dvb = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const out = new Float64Array(acc.count * nc);
    for (let i = 0; i < acc.count; i++) for (let c = 0; c < nc; c++) out[i * nc + c] = readComp(dvb, base + i * stride + c * cs, acc.componentType);
    return { data: out, count: acc.count };
  };
  const nodes = json.nodes || [];
  const localMat = n => n.matrix ? n.matrix.slice() : composeTRS(n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1]);
  const tris = [];
  const visit = (ni, parent) => {
    const n = nodes[ni]; const m = mul4(parent, localMat(n));
    if (n.mesh != null && json.meshes) {
      for (const prim of json.meshes[n.mesh].primitives) {
        if (prim.attributes.POSITION == null) continue;
        if (prim.mode != null && prim.mode !== 4) continue;   // triangles only
        const pos = readAcc(prim.attributes.POSITION);
        const idx = prim.indices != null ? readAcc(prim.indices).data : null;
        const triCount = idx ? idx.length / 3 : pos.count / 3;
        for (let t = 0; t < triCount; t++) for (let k = 0; k < 3; k++) {
          const vi = idx ? idx[t * 3 + k] : t * 3 + k;
          const w = tp(m, pos.data[vi * 3], pos.data[vi * 3 + 1], pos.data[vi * 3 + 2]);
          tris.push(w[0], w[1], w[2]);
        }
      }
    }
    for (const c of (n.children || [])) visit(c, m);
  };
  const scn = json.scenes[json.scene || 0];
  for (const ni of scn.nodes) visit(ni, IDENT4);
  return new Float32Array(tris);                          // 9 floats per triangle, world space
}

/* ---------------- triangle BVH (median split) ---------------- */
export class TriBVH {
  constructor(tris) {
    this.tris = tris; const n = tris.length / 9;
    this.idx = new Int32Array(n); for (let i = 0; i < n; i++) this.idx[i] = i;
    this.cx = new Float32Array(n); this.cy = new Float32Array(n); this.cz = new Float32Array(n);
    for (let i = 0; i < n; i++) { const b = i * 9; this.cx[i] = (tris[b] + tris[b + 3] + tris[b + 6]) / 3; this.cy[i] = (tris[b + 1] + tris[b + 4] + tris[b + 7]) / 3; this.cz[i] = (tris[b + 2] + tris[b + 5] + tris[b + 8]) / 3; }
    this.nodes = []; this.root = n ? this._build(0, n) : -1;
    this.bounds = this.root >= 0 ? { min: this.nodes[this.root].min.slice(), max: this.nodes[this.root].max.slice() } : null;
  }
  _build(start, end) {
    const node = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], l: -1, r: -1, s: start, e: end };
    const T = this.tris;
    for (let i = start; i < end; i++) { const b = this.idx[i] * 9; for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) { const val = T[b + v * 3 + a]; if (val < node.min[a]) node.min[a] = val; if (val > node.max[a]) node.max[a] = val; } }
    const id = this.nodes.length; this.nodes.push(node);
    const count = end - start;
    if (count <= 6) return id;
    const ext = [node.max[0] - node.min[0], node.max[1] - node.min[1], node.max[2] - node.min[2]];
    const axis = ext[0] > ext[1] ? (ext[0] > ext[2] ? 0 : 2) : (ext[1] > ext[2] ? 1 : 2);
    const C = axis === 0 ? this.cx : axis === 1 ? this.cy : this.cz;
    const sub = Array.from(this.idx.subarray(start, end)).sort((a, b) => C[a] - C[b]);
    for (let i = 0; i < sub.length; i++) this.idx[start + i] = sub[i];
    const mid = (start + end) >> 1;
    node.l = this._build(start, mid); node.r = this._build(mid, end); node.s = -1;
    return id;
  }
  _rayBox(node, ox, oy, oz, idx, idy, idz) {
    let t1 = (node.min[0] - ox) * idx, t2 = (node.max[0] - ox) * idx; let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
    t1 = (node.min[1] - oy) * idy; t2 = (node.max[1] - oy) * idy; tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
    t1 = (node.min[2] - oz) * idz; t2 = (node.max[2] - oz) * idz; tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
    return tmax >= Math.max(tmin, 0) ? tmin : Infinity;
  }
  // nearest hit within [0,maxT]; returns {t,nx,ny,nz} or null
  raycast(ox, oy, oz, dx, dy, dz, maxT) {
    if (this.root < 0) return null;
    const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz, T = this.tris;
    let best = maxT, bn = null; const stack = [this.root];
    while (stack.length) {
      const node = this.nodes[stack.pop()];
      if (this._rayBox(node, ox, oy, oz, idx, idy, idz) > best) continue;
      if (node.s < 0) { stack.push(node.l, node.r); continue; }
      for (let i = node.s; i < node.e; i++) {
        const b = this.idx[i] * 9;
        const h = rayTri(ox, oy, oz, dx, dy, dz, T, b, best);
        if (h && h.t < best) { best = h.t; bn = h; }
      }
    }
    return bn ? { t: best, nx: bn.nx, ny: bn.ny, nz: bn.nz } : null;
  }
  anyHit(ox, oy, oz, dx, dy, dz, maxT) {
    if (this.root < 0) return false;
    const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz, T = this.tris; const stack = [this.root];
    while (stack.length) {
      const node = this.nodes[stack.pop()];
      if (this._rayBox(node, ox, oy, oz, idx, idy, idz) > maxT) continue;
      if (node.s < 0) { stack.push(node.l, node.r); continue; }
      for (let i = node.s; i < node.e; i++) { const b = this.idx[i] * 9; const h = rayTri(ox, oy, oz, dx, dy, dz, T, b, maxT); if (h && h.t > 1e-3 && h.t < maxT) return true; }
    }
    return false;
  }
  collect(ox, oy, oz, dx, dy, dz, maxT) {     // all surface crossings along [0,maxT], sorted
    if (this.root < 0) return [];
    const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz, T = this.tris, hits = []; const stack = [this.root];
    while (stack.length) {
      const node = this.nodes[stack.pop()];
      if (this._rayBox(node, ox, oy, oz, idx, idy, idz) > maxT) continue;
      if (node.s < 0) { stack.push(node.l, node.r); continue; }
      for (let i = node.s; i < node.e; i++) { const b = this.idx[i] * 9; const h = rayTri(ox, oy, oz, dx, dy, dz, T, b, maxT); if (h && h.t > 1e-3) hits.push(h); }
    }
    hits.sort((a, b) => a.t - b.t); return hits;
  }
}
function rayTri(ox, oy, oz, dx, dy, dz, T, b, maxT) {
  const ax = T[b], ay = T[b + 1], az = T[b + 2], bx = T[b + 3], by = T[b + 4], bz = T[b + 5], cx = T[b + 6], cy = T[b + 7], cz = T[b + 8];
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-9 && det < 1e-9) return null;             // parallel (double-sided: no backface cull)
  const inv = 1 / det, tx = ox - ax, ty = oy - ay, tz = oz - az;
  const uu = (tx * px + ty * py + tz * pz) * inv; if (uu < -1e-5 || uu > 1 + 1e-5) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const vv = (dx * qx + dy * qy + dz * qz) * inv; if (vv < -1e-5 || uu + vv > 1 + 1e-5) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv; if (t < 1e-4 || t > maxT) return null;
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
  return { t, nx, ny, nz };
}

/* ---------------- the mesh backend the engine queries when a source map is active ---------------- */
export const meshBackend = {
  active: false, bvh: null, bounds: null,
  losClear(a, b) {
    if (!this.bvh) return true;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z; const len = Math.hypot(dx, dy, dz); if (len < 1) return true;
    return !this.bvh.anyHit(a.x, a.y, a.z, dx / len, dy / len, dz / len, len - 1);
  },
  // residual damage multiplier through walls.  Winding-independent: the ray starts
  // in open air, so consecutive surface crossings alternate solid/air — each pair is
  // one solid span whose thickness is the gap between the crossings (a lone trailing
  // crossing = a single-sided wall, given a small default thickness).
  penetrate(o, target, wepKey) {
    if (!this.bvh) return { factor: 1, surfaces: 0, blocked: false };
    const dx = target.x - o.x, dy = target.y - o.y, dz = target.z - o.z; const len = Math.hypot(dx, dy, dz);
    if (len < 1) return { factor: 1, surfaces: 0, blocked: false };
    const ux = dx / len, uy = dy / len, uz = dz / len;
    const hits = this.bvh.collect(o.x, o.y, o.z, ux, uy, uz, len - 0.5);
    if (!hits.length) return { factor: 1, surfaces: 0, blocked: false };
    const ts = [];                                         // merge coincident faces (shared edges / flush walls)
    for (const h of hits) if (!ts.length || h.t - ts[ts.length - 1] > 1.0) ts.push(h.t);
    const power = (WEAPONS[wepKey] ? WEAPONS[wepKey].penPct : 50) / 100;
    const maxThick = Math.max(8, power * PEN.unitsPerPower);
    let factor = 1, surfaces = 0;
    for (let i = 0; i < ts.length; i += 2) {
      const enterT = ts[i], exitT = (i + 1 < ts.length) ? ts[i + 1] : enterT + 8;   // single-sided → 8u default
      const effThick = Math.max(2, exitT - enterT) * 0.9;  // mesh walls ~ concrete-ish density
      surfaces++; if (surfaces > PEN.maxSurfaces) return { factor: 0, surfaces, blocked: true };
      if (effThick > maxThick) return { factor: 0, surfaces, blocked: true };        // too thick to punch through
      factor *= (1 - PEN.perSurfaceLoss) * (1 - (effThick / maxThick) * PEN.thickLossK);
    }
    return { factor: Math.max(0, factor), surfaces, blocked: false };
  },
  // floor Y under (x,z) at/below (fromY); -Infinity if nothing
  groundHeight(x, z, fromY) {
    if (!this.bvh) return -Infinity;
    const top = fromY + 48;                               // allow small step-up
    const h = this.bvh.raycast(x, top, z, 0, -1, 0, 4000);
    return h ? top - h.t : -Infinity;
  },
  // horizontal collide+slide from (px,pz)→(nx,nz) at body height y, keeping `radius` off walls
  slideXZ(px, pz, nx, nz, y, radius) {
    if (!this.bvh) return [nx, nz];
    let cx = px, cz = pz;
    const step = (sx, sz, tx, tz) => {
      const dx = tx - sx, dz = tz - sz; const d = Math.hypot(dx, dz); if (d < 1e-4) return [tx, tz, null];
      const ux = dx / d, uz = dz / d;
      const h = this.bvh.raycast(sx, y, sz, ux, 0, uz, d + radius);
      if (!h || h.t > d + radius) return [tx, tz, null];
      const allow = Math.max(0, h.t - radius);
      return [sx + ux * allow, sz + uz * allow, h];
    };
    let [ax, az, h1] = step(cx, cz, nx, nz);
    if (h1) {                                             // slide the remaining motion along the wall
      const rx = nx - ax, rz = nz - az; const dot = rx * h1.nx + rz * h1.nz;
      const sxv = rx - h1.nx * dot, szv = rz - h1.nz * dot;
      const [bx, bz] = step(ax, az, ax + sxv, az + szv); ax = bx; az = bz;
    }
    return [ax, az];
  },
  clear() { this.active = false; this.bvh = null; this.bounds = null; },
};

/* ---------------- spawn / entity conversion (Source Z-up → game Y-up) ---------------- */
// VRF exports glTF already rotated Z-up→Y-up as (x, z, -y); apply the SAME to raw entity origins.
export function convSource(x, y, z) { return { x: x, y: z, z: -y }; }
export function convYaw(srcYawDeg) { return (-(srcYawDeg || 0) - 90) * Math.PI / 180; }
const CT_CLASSES = ['info_player_counterterrorist'];
const T_CLASSES = ['info_player_terrorist'];
export function spawnsFromEntities(ents) {
  const out = { name: 'imported', ctSpawns: [], tSpawns: [], hostages: [], rescueZones: [] };
  for (const e of ents) {
    const cls = (e.classname || e.class || '').toLowerCase();
    const o = e.origin || e.position; if (!o) continue;
    const [sx, sy, sz] = Array.isArray(o) ? o : String(o).trim().split(/\s+/).map(Number);
    const p = convSource(sx, sy, sz);
    const yaw = convYaw(Array.isArray(e.angles) ? e.angles[1] : (e.angles ? +String(e.angles).trim().split(/\s+/)[1] : 0));
    if (CT_CLASSES.includes(cls)) out.ctSpawns.push({ x: p.x, y: p.y, z: p.z, yaw });
    else if (T_CLASSES.includes(cls)) out.tSpawns.push({ x: p.x, y: p.y, z: p.z, yaw });
    else if (cls.includes('hostage') && cls.includes('spawn')) out.hostages.push({ x: p.x, y: p.y, z: p.z });
    else if (cls.includes('hostage_rescue') || cls.includes('rescue_zone')) out.rescueZones.push({ x: p.x, y: p.y, z: p.z, r: 200 });
  }
  return out;
}
