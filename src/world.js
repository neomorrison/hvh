/* ============================== [WORLD] ==============================
   Materials, the re-buildable map mesh group, collision/line-of-sight,
   bullet penetration (autowall) and the waypoint nav graph.  Map *layouts*
   live in map.js; this module owns the primitives they build with.        */
import * as THREE from 'three';
import { scene } from './core.js';
import { WEAPONS, PEN } from './data.js';
import { smokes } from './effects.js';

/* ---- materials ---- */
export const matFloor    = new THREE.MeshStandardMaterial({ color: 0x4a4742, roughness: .95 });
export const matSnow     = new THREE.MeshStandardMaterial({ color: 0xdfe7f0, roughness: 1 });
export const matWall     = new THREE.MeshStandardMaterial({ color: 0x6f6a62, roughness: .9 });
export const matWall2    = new THREE.MeshStandardMaterial({ color: 0x534f49, roughness: .9 });
export const matGlass    = new THREE.MeshStandardMaterial({ color: 0x9fd2e8, transparent: true, opacity: .22, roughness: .1, metalness: .1 });
export const matWood     = new THREE.MeshStandardMaterial({ color: 0x8a5a32, roughness: .8 });
export const matMetal    = new THREE.MeshStandardMaterial({ color: 0x707984, roughness: .4, metalness: .6 });
export const matRescue   = new THREE.MeshStandardMaterial({ color: 0x2f7d3a, roughness: .9, transparent: true, opacity: .5, emissive: 0x143d1a });
export const matCarpet   = new THREE.MeshStandardMaterial({ color: 0x39414f, roughness: .97 });
export const matDesk     = new THREE.MeshStandardMaterial({ color: 0x9c6a3c, roughness: .7 });
export const matPartition= new THREE.MeshStandardMaterial({ color: 0x6f7785, roughness: .85 });
export const matBlack    = new THREE.MeshStandardMaterial({ color: 0x121417, roughness: .5 });
export const matScreen   = new THREE.MeshStandardMaterial({ color: 0xf3f1e6, roughness: .6, emissive: 0x46463a, emissiveIntensity: .5 });
export const matVanCol   = new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: .5, metalness: .4 });
export const matConcrete = new THREE.MeshStandardMaterial({ color: 0x55595f, roughness: 1 });
export const matCounter  = new THREE.MeshStandardMaterial({ color: 0xb9bcc2, roughness: .5 });
export const matCeil     = new THREE.MeshStandardMaterial({ color: 0x20232a, roughness: 1 });

/* ---- the re-buildable map: every structural/prop mesh lives under mapGroup
        so a map switch can wipe & rebuild without leaking geometry ---- */
export const mapGroup = new THREE.Group(); scene.add(mapGroup);
export function addMapObject(o) { mapGroup.add(o); return o; }

/* ---- collision / LoS world model ---- */
export const WALLS = [];   // {minX,maxX,minZ,maxZ,top,bottom,mat,block}  block=blocks movement
export const COVERS = [];  // visual + LoS, lower height
export function aabb(minX, maxX, minZ, maxZ, top = 200, bottom = 0, mat = 0.45, block = true) {
  const w = { minX, maxX, minZ, maxZ, top, bottom, mat, block }; WALLS.push(w); return w;
}

export function addBox(x, z, w, d, h, y, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y + h / 2, z); m.castShadow = true; m.receiveShadow = true; mapGroup.add(m); return m;
}
export function floorTile(minX, maxX, minZ, maxZ, mat) {
  const g = new THREE.Mesh(new THREE.BoxGeometry(maxX - minX, 8, maxZ - minZ), mat);
  g.position.set((minX + maxX) / 2, -4, (minZ + maxZ) / 2); g.receiveShadow = true; mapGroup.add(g);
}

/* ---- walls & covers are COLLECTED as specs, then carved + built in buildGeometry().
        (doorways are auto-punched wherever a bot-nav corridor crosses a wall, so the
         geometry always stays connected to the waypoint graph). ---- */
export const wallSpecs = [];
export function wall(minX, maxX, minZ, maxZ, h = 210, mat = matWall) { wallSpecs.push({ minX, maxX, minZ, maxZ, h, mat, matVal: 0.45, kind: 'wall' }); }
export function cover(minX, maxX, minZ, maxZ, h, mat, matVal = 0.45) { wallSpecs.push({ minX, maxX, minZ, maxZ, h, mat, matVal, kind: 'cover' }); }
export function emitWall(minX, maxX, minZ, maxZ, h, mat, matVal) { addBox((minX + maxX) / 2, (minZ + maxZ) / 2, maxX - minX, maxZ - minZ, h, 0, mat); aabb(minX, maxX, minZ, maxZ, h, 0, matVal, true); }

// emit every pending wall/cover spec as real geometry+collision (no door-carving).
// used by data-driven custom maps where walls & props are placed explicitly.
export function flushSpecs() {
  for (const w of wallSpecs) emitWall(w.minX, w.maxX, w.minZ, w.maxZ, w.h, w.mat, w.matVal);
  wallSpecs.length = 0;
}

export function buildGeometry() {
  const GAP = 80;
  const navEdges = [], seen = new Set();
  for (const a in EDGES) for (const b of EDGES[a]) { const k = Math.min(+a, +b) + '-' + Math.max(+a, +b); if (seen.has(k)) continue; seen.add(k); navEdges.push([NODES[+a].p, NODES[+b].p]); }
  for (const w of wallSpecs) {
    const box = { minX: w.minX, maxX: w.maxX, minZ: w.minZ, maxZ: w.maxZ, bottom: 0, top: w.h };
    const longX = (w.maxX - w.minX) >= (w.maxZ - w.minZ);
    const cuts = [];
    for (const [pa, pb] of navEdges) {
      const o = new THREE.Vector3(pa.x, 20, pa.z), d = new THREE.Vector3(pb.x - pa.x, 0, pb.z - pa.z); const len = d.length(); if (len < 1) continue; d.normalize();
      const r = segAABB(o, d, len, box);
      if (r && r.thick > 0) { const mid = (Math.max(0, r.enter) + Math.min(len, r.exit)) / 2; const p = o.clone().add(d.clone().multiplyScalar(mid)); cuts.push(longX ? p.x : p.z); }
    }
    if (!cuts.length) { emitWall(w.minX, w.maxX, w.minZ, w.maxZ, w.h, w.mat, w.matVal); continue; }
    if (w.kind === 'cover') continue;                       // cover on a route → drop it
    cuts.sort((a, b) => a - b);
    const merged = []; for (const c of cuts) { const g = [c - GAP, c + GAP]; if (merged.length && g[0] <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], g[1]); else merged.push(g); }
    let lo = longX ? w.minX : w.minZ, hi = longX ? w.maxX : w.maxZ, cur = lo;
    for (const g of merged) { const e = Math.min(hi, g[0]); if (e - cur > 16) { if (longX) emitWall(cur, e, w.minZ, w.maxZ, w.h, w.mat, w.matVal); else emitWall(w.minX, w.maxX, cur, e, w.h, w.mat, w.matVal); } cur = Math.max(cur, g[1]); }
    if (hi - cur > 16) { if (longX) emitWall(cur, hi, w.minZ, w.maxZ, w.h, w.mat, w.matVal); else emitWall(w.minX, w.maxX, cur, hi, w.h, w.mat, w.matVal); }
  }
}

/* ---- wall + furniture helpers ---- */
export function wallRun(axis, fixed, from, to, h, doors = []) {
  const T = 14; let segs = [[Math.min(from, to), Math.max(from, to)]];
  for (const [c, w] of doors) { const a = c - w / 2, b = c + w / 2, ns = []; for (const [s, e] of segs) { if (b <= s || a >= e) { ns.push([s, e]); continue; } if (s < a - 1) ns.push([s, a]); if (b < e - 1) ns.push([b, e]); } segs = ns; }
  for (const [s, e] of segs) { if (e - s < 6) continue; if (axis === 'x') wall(s, e, fixed - T / 2, fixed + T / 2, h, matWall); else wall(fixed - T / 2, fixed + T / 2, s, e, h, matWall); }
}
export function fchair(x, z) { addBox(x, z, 20, 20, 4, 16, matBlack); addBox(x, z + 8, 20, 4, 20, 18, matBlack); }
export function fdesk(x, z, horiz) { const w = horiz ? 104 : 60, d = horiz ? 60 : 104; cover(x - w / 2, x + w / 2, z - d / 2, z + d / 2, 28, matDesk, 0.6); addBox(x, z, 24, 15, 16, 28, matBlack); }
export function fpod(cx, cz) {
  cover(cx - 5, cx + 5, cz - 92, cz + 92, 74, matPartition, 0.6); cover(cx - 92, cx + 92, cz - 5, cz + 5, 74, matPartition, 0.6);
  fdesk(cx - 50, cz - 52, true); fdesk(cx + 50, cz - 52, true); fdesk(cx - 50, cz + 52, true); fdesk(cx + 50, cz + 52, true);
  fchair(cx - 50, cz - 26); fchair(cx + 50, cz - 26); fchair(cx - 50, cz + 26); fchair(cx + 50, cz + 26);
}
export function ftable(x1, x2, z1, z2) { cover(x1, x2, z1, z2, 42, matDesk, 0.6); for (let z = z1 + 34; z < z2 - 10; z += 72) { fchair(x1 - 16, z); fchair(x2 + 16, z); } }
export function fcabinet(x, z) { cover(x - 26, x + 26, z - 22, z + 22, 110, matMetal, 0.5); }
export function fcouch(x, z, horiz) { const w = horiz ? 150 : 60, d = horiz ? 60 : 150; cover(x - w / 2, x + w / 2, z - d / 2, z + d / 2, 40, new THREE.MeshStandardMaterial({ color: 0x4a5160, roughness: .9 }), 0.6); }
export function fcounter(x1, x2, z1, z2) { cover(x1, x2, z1, z2, 55, matCounter, 0.5); }
export function fscreen(x, z) { addBox(x, z, 260, 4, 150, 90, matScreen); }
export function fvan(x, z) { cover(x - 58, x + 58, z - 140, z + 140, 118, matVanCol, 0.5); addBox(x, z + 185, 116, 70, 86, 0, matVanCol); addBox(x, z - 30, 118, 40, 4, 118, matBlack); }
export function fcar(x, z, c) { cover(x - 50, x + 50, z - 100, z + 100, 55, new THREE.MeshStandardMaterial({ color: c, roughness: .5, metalness: .3 }), 0.5); addBox(x, z, 84, 42, 38, 55, new THREE.MeshStandardMaterial({ color: 0x223044, transparent: true, opacity: .5 })); }
export function fstall(x, z) { cover(x - 3, x + 3, z - 40, z + 40, 90, matPartition, 0.6); }
export function fcrate(x, z, s = 60) { cover(x - s / 2, x + s / 2, z - s / 2, z + s / 2, s, matWood, 0.55); }
export function fsnow(x, z, r) { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), matSnow); m.position.set(x, r * 0.35, z); m.scale.y = 0.5; m.receiveShadow = true; mapGroup.add(m); aabb(x - r * .9, x + r * .9, z - r * .9, z + r * .9, r * 0.5, 0, 0.4, true); }

/* ---- nav graph (filled by whichever map is built) ---- */
export const NODES = [];
export const EDGES = {};
export const CT_SPAWNS = [], T_SPAWNS = [], HOSTAGE_SPAWNS = [], RESCUE_ZONES = [];
export const MAP_BOUNDS = { minX: -200, maxX: 3700, minZ: -1050, maxZ: 1050 };

export function nodeDist(a, b) { return NODES[a].p.distanceTo(NODES[b].p); }
export function nearestNode(pos) { let best = 0, bd = 1e9; for (const n of NODES) { const d = n.p.distanceToSquared(pos); if (d < bd) { bd = d; best = n.id; } } return best; }
export function astar(start, goal) {
  if (!NODES.length) return [start];
  const open = new Set([start]), came = {}, g = { [start]: 0 }, f = { [start]: nodeDist(start, goal) };
  while (open.size) {
    let cur = -1, cf = 1e9; for (const n of open) if (f[n] < cf) { cf = f[n]; cur = n; }
    if (cur === goal) { const path = [cur]; while (came[cur] !== undefined) { cur = came[cur]; path.unshift(cur); } return path; }
    open.delete(cur);
    for (const nb of (EDGES[cur] || [])) { const t = g[cur] + nodeDist(cur, nb); if (t < (g[nb] ?? 1e9)) { came[nb] = cur; g[nb] = t; f[nb] = t + nodeDist(nb, goal); open.add(nb); } }
  }
  return [start];
}

/* reset everything the active map owns, ready for a fresh build */
export function clearWorld() {
  for (const o of [...mapGroup.children]) {
    mapGroup.remove(o);
    if (o.traverse) o.traverse(n => { if (n.geometry && n.geometry.dispose) n.geometry.dispose(); if (n.material && n.material.dispose) n.material.dispose(); });
  }
  WALLS.length = 0; COVERS.length = 0; wallSpecs.length = 0;
  NODES.length = 0; for (const k in EDGES) delete EDGES[k];
  CT_SPAWNS.length = 0; T_SPAWNS.length = 0; HOSTAGE_SPAWNS.length = 0; RESCUE_ZONES.length = 0;
}

/* ---- collision + LoS helpers ---- */
export function collideMove(pos, radius, feetY, height) {
  for (const dim of ['x', 'z']) {
    for (const w of WALLS) {
      if (!w.block) continue;
      if (feetY + height < w.bottom || feetY > w.top) continue;
      const nx = Math.max(w.minX, Math.min(pos.x, w.maxX));
      const nz = Math.max(w.minZ, Math.min(pos.z, w.maxZ));
      const dx = pos.x - nx, dz = pos.z - nz, d2 = dx * dx + dz * dz;
      if (d2 < radius * radius) {
        const d = Math.sqrt(d2) || 0.0001;
        const push = (radius - d);
        if (d2 > 0.0001) { pos.x += (dx / d) * push; pos.z += (dz / d) * push; }
        else {
          const pl = pos.x - w.minX, pr = w.maxX - pos.x, pb = pos.z - w.minZ, pt = w.maxZ - pos.z;
          const m = Math.min(pl, pr, pb, pt);
          if (m === pl) pos.x = w.minX - radius; else if (m === pr) pos.x = w.maxX + radius; else if (m === pb) pos.z = w.minZ - radius; else pos.z = w.maxZ + radius;
        }
      }
    }
  }
}
// 3D segment vs AABB (slab); returns {enter,exit,thick} if hit (within [0,len]), else null.
export function segAABB(o, dir, len, w) {
  let tmin = 0, tmax = len;
  for (const [oc, dc, mn, mx] of [[o.x, dir.x, w.minX, w.maxX], [o.y, dir.y, w.bottom, w.top], [o.z, dir.z, w.minZ, w.maxZ]]) {
    if (Math.abs(dc) < 1e-8) { if (oc < mn || oc > mx) return null; }
    else { let t1 = (mn - oc) / dc, t2 = (mx - oc) / dc; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return null; }
  }
  return { enter: tmin, exit: tmax, thick: Math.max(0, tmax - tmin) };
}
export function rayAABB(o, d, b) {
  let tmin = 0, tmax = 9000;
  for (const [oc, dc, mn, mx] of [[o.x, d.x, b.minX, b.maxX], [o.y, d.y, b.minY, b.maxY], [o.z, d.z, b.minZ, b.maxZ]]) {
    if (Math.abs(dc) < 1e-8) { if (oc < mn || oc > mx) return null; }
    else { let t1 = (mn - oc) / dc, t2 = (mx - oc) / dc; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return null; }
  }
  return tmin > 0 ? tmin : null;
}
export function losClear(a, b, smokesBlock = true) {
  const o = a.clone(), d = b.clone().sub(a); const len = d.length(); if (len < 1) return true; d.normalize();
  for (const w of WALLS) { const r = segAABB(o, d, len, w); if (r && r.thick > 0 && w.mat >= 0.4 && w.block) { return false; } }
  if (smokesBlock) for (const s of smokes) { if (s.alive) { const oc = s.pos.clone().sub(o); const proj = Math.max(0, Math.min(len, oc.dot(d))); const closest = o.clone().add(d.clone().multiplyScalar(proj)); if (closest.distanceTo(s.pos) < s.r) return false; } }
  return true;
}

/* autowall / penetration — residual damage multiplier from o..target.
   A weapon's penPct doubles as its penetration power: it can pass surfaces up
   to a thickness cap; denser (higher-mat) and thicker surfaces cost more, and a
   surface too thick for the weapon (or the 4-surface cap) stops the bullet. */
export function penetrate(o, target, wepKey) {
  const d = target.clone().sub(o); const len = d.length();
  if (len < 1) return { factor: 1, surfaces: 0, blocked: false };
  d.normalize();
  const power = (WEAPONS[wepKey] ? WEAPONS[wepKey].penPct : 50) / 100;      // 0..0.93
  const maxThick = Math.max(8, power * PEN.unitsPerPower);                   // per-surface effective-thickness cap
  const hits = [];
  for (const w of WALLS) {
    if (!w.block) continue;
    const r = segAABB(o, d, len, w);
    if (r && r.thick > 0.5 && r.enter > 0.5 && r.enter < len - 0.5) hits.push({ w, r });
  }
  hits.sort((a, b) => a.r.enter - b.r.enter);
  let factor = 1, surfaces = 0;
  for (const { w, r } of hits) {
    surfaces++;
    if (surfaces > PEN.maxSurfaces) return { factor: 0, surfaces, blocked: true };
    const density = Math.max(0.35, w.mat);            // harder material = denser
    const effThick = r.thick * density;               // effective thickness to traverse
    if (effThick > maxThick) return { factor: 0, surfaces, blocked: true };  // too thick → bullet stops
    factor *= (1 - PEN.perSurfaceLoss) * (1 - (effThick / maxThick) * PEN.thickLossK);
  }
  return { factor: Math.max(0, factor), surfaces, blocked: false };
}
