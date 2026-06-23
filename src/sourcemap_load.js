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

  // visual mesh (untextured grey — geometry is what matters)
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(tris, 3)); geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x9aa1ac, roughness: .96, metalness: .02, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat); mesh.receiveShadow = true; mesh.castShadow = true; addMapObject(mesh);

  const b = bvh.bounds;
  MAP_BOUNDS.minX = b.min[0]; MAP_BOUNDS.maxX = b.max[0]; MAP_BOUNDS.minZ = b.min[2]; MAP_BOUNDS.maxZ = b.max[2];

  spawns = spawns || {};
  const pushSpawn = (arr, s) => { const v = new THREE.Vector3(s.x, s.y || 0, s.z); v.yaw = s.yaw; arr.push(v); };
  (spawns.ctSpawns || []).forEach(s => pushSpawn(CT_SPAWNS, s));
  (spawns.tSpawns || []).forEach(s => pushSpawn(T_SPAWNS, s));
  (spawns.hostages || []).forEach(h => HOSTAGE_SPAWNS.push(new THREE.Vector3(h.x, h.y || 0, h.z)));
  (spawns.rescueZones || []).forEach(rz => RESCUE_ZONES.push({ x: rz.x, z: rz.z, r: rz.r || 200 }));
  if (!CT_SPAWNS.length || !T_SPAWNS.length) throw new Error('Spawns JSON needs at least one ctSpawns and one tSpawns entry');

  generateMeshNav();
  return { triangles: tris.length / 3 / 3, bounds: b, ctSpawns: CT_SPAWNS.length, tSpawns: T_SPAWNS.length, navNodes: NODES.length };
}

/* sample a grid of standable floor points and connect walkable neighbours */
export function generateMeshNav() {
  NODES.length = 0; for (const k in EDGES) delete EDGES[k];
  const { minX, maxX, minZ, maxZ } = MAP_BOUNDS; const top = meshBackend.bounds.max[1] + 60;
  const step = Math.max(150, Math.min(300, Math.round((maxX - minX) / 26)));
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
    const a = { x: n.p.x, y: n.y + 36, z: n.p.z }, b = { x: m.p.x, y: m.y + 36, z: m.p.z };
    if (meshBackend.losClear(a, b) && !EDGES[n.id].includes(m.id)) EDGES[n.id].push(m.id);
  }
}
