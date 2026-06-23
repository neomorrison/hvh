/* ============================== [SOURCE MAP LOADER] ==============================
   Turns a parsed .glb + spawns into a live level: builds the visual mesh (tinted +
   box-unwrapped detail texture, reflective window glass), sky + interior lighting,
   the BVH-backed mesh collision, spawns/hostages/rescue, and an auto floor-following
   nav graph.  Detail textures are procedurally generated — no external art bundled. */
import * as THREE from 'three';
import { scene } from './core.js';
import { addMapObject, clearWorld, NODES, EDGES, CT_SPAWNS, T_SPAWNS, HOSTAGE_SPAWNS, RESCUE_ZONES, MAP_BOUNDS } from './world.js';
import { parseGLB, parseGLBMeshes, TriBVH, meshBackend } from './sourcemap.js';

function concat(arrays) { let n = 0; for (const a of arrays) n += a.length; const o = new Float32Array(n); let p = 0; for (const a of arrays) { o.set(a, p); p += a.length; } return o; }

export function loadSourceMap(glbBuffer, spawns) {
  clearWorld();                                            // also deactivates any prior mesh backend
  // 'windows' mesh renders as reflective glass; everything else is the world. Collide against both.
  const groups = parseGLBMeshes(glbBuffer);
  const worldTris = concat(groups.filter(g => g.name !== 'windows').map(g => g.tris));
  const windowTris = (groups.find(g => g.name === 'windows') || {}).tris || new Float32Array(0);
  if (!worldTris.length) throw new Error('No triangles found in the .glb (is it a map export?)');
  const allTris = windowTris.length ? concat([worldTris, windowTris]) : worldTris;
  const bvh = new TriBVH(allTris);
  meshBackend.bvh = bvh; meshBackend.bounds = bvh.bounds; meshBackend.active = true;
  const b = bvh.bounds;

  // world visual: vertex tint (floor/wall/ceiling) × a box-unwrapped procedural detail texture
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(worldTris, 3)); geo.computeVertexNormals();
  geo.setAttribute('color', new THREE.BufferAttribute(vertexColors(worldTris, b), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(boxUVs(worldTris, 160), 2));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .94, metalness: .04, side: THREE.DoubleSide });
  const detail = makeDetailTexture(); if (detail) { mat.map = detail; mat.needsUpdate = true; }
  const mesh = new THREE.Mesh(geo, mat); mesh.receiveShadow = true; mesh.castShadow = true; addMapObject(mesh);

  // window glass: flat semi-reflective panes (collide via the BVH above)
  if (windowTris.length) {
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(windowTris, 3)); wg.computeVertexNormals();
    const gmat = new THREE.MeshStandardMaterial({ color: 0x2b3a52, metalness: .85, roughness: .07, transparent: true, opacity: .5, side: THREE.DoubleSide });
    addMapObject(new THREE.Mesh(wg, gmat));
  }

  setupSky(b);                                             // night sky + sun + ambient fill

  spawns = spawns || {};
  const pushSpawn = (arr, s) => { const v = new THREE.Vector3(s.x, s.y || 0, s.z); v.yaw = s.yaw; arr.push(v); };
  (spawns.ctSpawns || []).forEach(s => pushSpawn(CT_SPAWNS, s));
  (spawns.tSpawns || []).forEach(s => pushSpawn(T_SPAWNS, s));
  (spawns.hostages || []).forEach(h => HOSTAGE_SPAWNS.push(new THREE.Vector3(h.x, h.y || 0, h.z)));
  (spawns.rescueZones || []).forEach(rz => RESCUE_ZONES.push({ x: rz.x, z: rz.z, r: rz.r || 200 }));
  if (!CT_SPAWNS.length || !T_SPAWNS.length) throw new Error('Spawns JSON needs at least one ctSpawns and one tSpawns entry');

  // playable bounds = spawn/hostage/rescue footprint + margin, clamped to the mesh — tight
  // enough that the out-of-bounds clamp in moveAgent keeps players inside the real map.
  const MARGIN = 600;
  let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
  for (const p of [...CT_SPAWNS, ...T_SPAWNS, ...HOSTAGE_SPAWNS, ...RESCUE_ZONES.map(r => ({ x: r.x, z: r.z }))]) {
    if (p.x < mnX) mnX = p.x; if (p.x > mxX) mxX = p.x; if (p.z < mnZ) mnZ = p.z; if (p.z > mxZ) mxZ = p.z;
  }
  MAP_BOUNDS.minX = Math.max(b.min[0], mnX - MARGIN); MAP_BOUNDS.maxX = Math.min(b.max[0], mxX + MARGIN);
  MAP_BOUNDS.minZ = Math.max(b.min[2], mnZ - MARGIN); MAP_BOUNDS.maxZ = Math.min(b.max[2], mxZ + MARGIN);

  generateMeshNav();
  addCeilingLights();                                      // warm point lights under the office ceilings (uses nav nodes)
  return { triangles: allTris.length / 9, bounds: b, ctSpawns: CT_SPAWNS.length, tSpawns: T_SPAWNS.length, navNodes: NODES.length };
}

// box-unwrap UVs per vertex (project onto the plane of the face's dominant axis) so a
// tiling texture maps onto UV-less geometry. `tile` = source units per texture tile.
function boxUVs(tris, tile) {
  const ntri = tris.length / 9, uv = new Float32Array((tris.length / 3) * 2);
  for (let t = 0; t < ntri; t++) {
    const o = t * 9;
    const e1x = tris[o + 3] - tris[o], e1y = tris[o + 4] - tris[o + 1], e1z = tris[o + 5] - tris[o + 2];
    const e2x = tris[o + 6] - tris[o], e2y = tris[o + 7] - tris[o + 1], e2z = tris[o + 8] - tris[o + 2];
    const ax = Math.abs(e1y * e2z - e1z * e2y), ay = Math.abs(e1z * e2x - e1x * e2z), az = Math.abs(e1x * e2y - e1y * e2x);
    for (let k = 0; k < 3; k++) {
      const vx = tris[o + k * 3], vy = tris[o + k * 3 + 1], vz = tris[o + k * 3 + 2];
      let u, v;
      if (ay >= ax && ay >= az) { u = vx; v = vz; }        // floor / ceiling → XZ
      else if (ax >= az) { u = vz; v = vy; }               // wall facing X → ZY
      else { u = vx; v = vy; }                             // wall facing Z → XY
      const i = (t * 3 + k) * 2; uv[i] = u / tile; uv[i + 1] = v / tile;
    }
  }
  return uv;
}

// procedural greyscale detail (grain + faint tile seams) — generated, not from any game art
function makeDetailTexture() {
  if (typeof THREE.DataTexture !== 'function') return null;   // headless / stub: skip
  const S = 128, data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const x = i % S, y = (i / S) | 0;
    const n = ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1;
    const seam = (x % 64 < 1 || y % 64 < 1) ? -45 : 0;
    const val = Math.max(0, Math.min(255, (205 + n * 50 + seam) | 0));
    data[i * 4] = val; data[i * 4 + 1] = val; data[i * 4 + 2] = val; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.needsUpdate = true;
  return tex;
}

// night sky background + fog + moonlight sun + hemisphere fill
function setupSky(b) {
  scene.background = new THREE.Color(0x121821);
  scene.fog = new THREE.Fog(0x121821, 1400, 7000);
  addMapObject(new THREE.HemisphereLight(0x9fb4d6, 0x1a1d24, 0.6));
  const sun = new THREE.DirectionalLight(0xbcd0ff, 0.65); sun.position.set(b.max[0] + 800, b.max[1] + 1800, b.min[2] - 800); addMapObject(sun);
}

// warm point lights up near the office ceilings — placed on spaced nav nodes (guaranteed on
// standable interior floors), sitting at the ceiling above each (or a default height).
function addCeilingLights() {
  const placed = [];
  for (let i = 0; i < NODES.length && placed.length < 46; i += 3) {
    const n = NODES[i];
    if (placed.some(p => p.distanceToSquared(n.p) < 420 * 420)) continue;                   // keep them spread out
    const up = meshBackend.bvh.raycast(n.p.x, n.y + 24, n.p.z, 0, 1, 0, 600);
    const cy = (up && up.t < 600) ? n.y + 24 + up.t - 12 : n.y + 96;                        // just under the ceiling, else a default height
    const pl = new THREE.PointLight(0xffe2b0, 0.65, 720, 1.7);
    pl.position.set(n.p.x, cy, n.p.z); addMapObject(pl);
    placed.push(n.p.clone());
  }
}

// per-vertex colours: floor / wall / ceiling tint (by each triangle's face normal), walls lerped by height.
function vertexColors(tris, bounds) {
  const ntri = tris.length / 9, col = new Float32Array(tris.length);
  const minY = bounds.min[1], spanY = Math.max(1, bounds.max[1] - bounds.min[1]);
  const floor = [0.30, 0.27, 0.23], wall = [0.52, 0.50, 0.46], wallHi = [0.60, 0.58, 0.54], ceil = [0.16, 0.17, 0.20];
  for (let t = 0; t < ntri; t++) {
    const o = t * 9;
    const e1x = tris[o + 3] - tris[o], e1y = tris[o + 4] - tris[o + 1], e1z = tris[o + 5] - tris[o + 2];
    const e2x = tris[o + 6] - tris[o], e2y = tris[o + 7] - tris[o + 1], e2z = tris[o + 8] - tris[o + 2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz) || 1; ny /= nl;                 // only the up-component matters
    for (let k = 0; k < 3; k++) {
      const y = tris[o + k * 3 + 1];
      let c;
      if (ny > 0.7) c = floor;
      else if (ny < -0.7) c = ceil;
      else { const f = THREE.MathUtils.clamp((y - minY) / spanY, 0, 1); c = [wall[0] + (wallHi[0] - wall[0]) * f, wall[1] + (wallHi[1] - wall[1]) * f, wall[2] + (wallHi[2] - wall[2]) * f]; }
      col[o + k * 3] = c[0]; col[o + k * 3 + 1] = c[1]; col[o + k * 3 + 2] = c[2];
    }
  }
  return col;
}

/* sample a grid of standable floor points and connect walkable neighbours */
export function generateMeshNav() {
  NODES.length = 0; for (const k in EDGES) delete EDGES[k];
  const { minX, maxX, minZ, maxZ } = MAP_BOUNDS; const top = meshBackend.bounds.max[1] + 60;
  const step = Math.max(96, Math.min(180, Math.round((maxX - minX) / 40)));   // fine enough to seat nodes in doorways
  const cells = {}; let id = 0;
  for (let x = minX + step / 2; x < maxX; x += step) for (let z = minZ + step / 2; z < maxZ; z += step) {
    const g = meshBackend.groundHeight(x, z, top); if (g <= -1e8) continue;
    const up = meshBackend.bvh.raycast(x, g + 8, z, 0, 1, 0, 70); if (up && up.t < 56) continue;   // need headroom to stand
    const gx = Math.round((x - minX) / step), gz = Math.round((z - minZ) / step);
    const n = { id: id++, p: new THREE.Vector3(x, g, z), gx, gz, y: g }; NODES.push(n); EDGES[n.id] = []; cells[gx + ',' + gz] = n;
  }
  for (const n of NODES) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const m = cells[(n.gx + dx) + ',' + (n.gz + dz)]; if (!m) continue;
    if (Math.abs(m.y - n.y) > 48) continue;                // step too tall to walk
    // reject only a genuine hole/gap between the cells (a furniture-top read is fine — bots route around)
    if (meshBackend.groundHeight((n.p.x + m.p.x) / 2, (n.p.z + m.p.z) / 2, Math.max(n.y, m.y) + 40) <= -1e8) continue;
    // wall check at head-height-and-above: only floor-to-ceiling walls sever an edge — low
    // furniture (desks, cubicles) is walkable-around and must NOT fragment the graph.
    const hy = Math.min(n.y, m.y) + 100;
    if (meshBackend.losClear({ x: n.p.x, y: hy, z: n.p.z }, { x: m.p.x, y: hy, z: m.p.z }) && !EDGES[n.id].includes(m.id)) EDGES[n.id].push(m.id);
  }

  // Stitch disconnected components: the LOS edge test over-severs in cluttered rooms, so the
  // grid splits into islands (CT and T can end up unreachable from each other). Bridge the
  // nearest node-pairs across different components, shortest links first, until connected —
  // guarantees the whole playable area (and both spawns) is one graph. Bots' stuck-recovery
  // absorbs the rare bridge that clips a wall.
  const parent = NODES.map(n => n.id);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const a in EDGES) for (const b of EDGES[a]) parent[find(+a)] = find(b);
  const cands = [], D2 = 5000 * 5000;   // large enough to fully connect every region (spawns must always be reachable)
  for (let i = 0; i < NODES.length; i++) for (let j = i + 1; j < NODES.length; j++) {
    if (Math.abs(NODES[i].y - NODES[j].y) > 56) continue;
    const dx = NODES[i].p.x - NODES[j].p.x, dz = NODES[i].p.z - NODES[j].p.z, d2 = dx * dx + dz * dz;
    if (d2 <= D2) cands.push([d2, i, j]);
  }
  cands.sort((a, b) => a[0] - b[0]);
  for (const [, i, j] of cands) {
    if (find(i) === find(j)) continue;
    parent[find(i)] = find(j);
    if (!EDGES[i].includes(j)) EDGES[i].push(j);
    if (!EDGES[j].includes(i)) EDGES[j].push(i);
  }
}
