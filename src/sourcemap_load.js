/* ============================== [SOURCE MAP LOADER] ==============================
   Turns a parsed .glb + spawns into a live level: builds the visual mesh, sets
   the BVH-backed mesh collision active, fills spawns/hostages/rescue, and
   auto-generates a floor-following nav graph so bots can path the real layout.  */
import * as THREE from 'three';
import { addMapObject, clearWorld, NODES, EDGES, CT_SPAWNS, T_SPAWNS, HOSTAGE_SPAWNS, RESCUE_ZONES, MAP_BOUNDS } from './world.js';
import { parseGLB, TriBVH, meshBackend } from './sourcemap.js';

export function loadSourceMap(glbBuffer, spawns) {
  clearWorld();                                            // also deactivates any prior mesh backend
  const tris = parseGLB(glbBuffer);
  if (!tris.length) throw new Error('No triangles found in the .glb (is it a map export?)');
  const bvh = new TriBVH(tris);
  meshBackend.bvh = bvh; meshBackend.bounds = bvh.bounds; meshBackend.active = true;

  // visual mesh: per-vertex tint by surface orientation/height so floors, walls and
  // ceilings read distinctly — no textures bundled, keeping the .glb small.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(tris, 3)); geo.computeVertexNormals();
  geo.setAttribute('color', new THREE.BufferAttribute(vertexColors(tris, bvh.bounds), 3));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .95, metalness: .03, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat); mesh.receiveShadow = true; mesh.castShadow = true; addMapObject(mesh);

  spawns = spawns || {};
  const pushSpawn = (arr, s) => { const v = new THREE.Vector3(s.x, s.y || 0, s.z); v.yaw = s.yaw; arr.push(v); };
  (spawns.ctSpawns || []).forEach(s => pushSpawn(CT_SPAWNS, s));
  (spawns.tSpawns || []).forEach(s => pushSpawn(T_SPAWNS, s));
  (spawns.hostages || []).forEach(h => HOSTAGE_SPAWNS.push(new THREE.Vector3(h.x, h.y || 0, h.z)));
  (spawns.rescueZones || []).forEach(rz => RESCUE_ZONES.push({ x: rz.x, z: rz.z, r: rz.r || 200 }));
  if (!CT_SPAWNS.length || !T_SPAWNS.length) throw new Error('Spawns JSON needs at least one ctSpawns and one tSpawns entry');

  // playable bounds = spawn/hostage/rescue footprint + margin, clamped to the mesh — tight
  // enough that the out-of-bounds clamp in moveAgent keeps players inside the real map.
  const b = bvh.bounds, MARGIN = 600;
  let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
  for (const p of [...CT_SPAWNS, ...T_SPAWNS, ...HOSTAGE_SPAWNS, ...RESCUE_ZONES.map(r => ({ x: r.x, z: r.z }))]) {
    if (p.x < mnX) mnX = p.x; if (p.x > mxX) mxX = p.x; if (p.z < mnZ) mnZ = p.z; if (p.z > mxZ) mxZ = p.z;
  }
  MAP_BOUNDS.minX = Math.max(b.min[0], mnX - MARGIN); MAP_BOUNDS.maxX = Math.min(b.max[0], mxX + MARGIN);
  MAP_BOUNDS.minZ = Math.max(b.min[2], mnZ - MARGIN); MAP_BOUNDS.maxZ = Math.min(b.max[2], mxZ + MARGIN);

  generateMeshNav();
  return { triangles: tris.length / 3 / 3, bounds: b, ctSpawns: CT_SPAWNS.length, tSpawns: T_SPAWNS.length, navNodes: NODES.length };
}

// per-vertex colours: floor / wall / ceiling tint (by each triangle's face normal),
// walls lerped a little by height for variety.  Normals are derived from the geometry
// directly so this works without a computed normal attribute.
function vertexColors(tris, bounds) {
  const ntri = tris.length / 9, col = new Float32Array(tris.length);
  const minY = bounds.min[1], spanY = Math.max(1, bounds.max[1] - bounds.min[1]);
  const floor = [0.27, 0.30, 0.36], wall = [0.46, 0.44, 0.40], wallHi = [0.55, 0.53, 0.49], ceil = [0.14, 0.15, 0.18];
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
  const cands = [], D2 = 460 * 460;
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
