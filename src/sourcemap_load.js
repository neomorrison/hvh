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

export function loadSourceMap(glbBuffer, spawns, texturedScene) {
  clearWorld();                                            // also deactivates any prior mesh backend
  // 'windows' = reflective glass (visual+collision); 'clip' = invisible playable-boundary hull
  // (collision only, keeps players inside the real map); everything else is the world.
  const groups = parseGLBMeshes(glbBuffer);
  const worldTris = concat(groups.filter(g => g.name !== 'windows' && g.name !== 'clip').map(g => g.tris));
  const windowTris = (groups.find(g => g.name === 'windows') || {}).tris || new Float32Array(0);
  const clipTris = (groups.find(g => g.name === 'clip') || {}).tris || new Float32Array(0);
  if (!worldTris.length) throw new Error('No triangles found in the .glb (is it a map export?)');
  // floors / LOS / bullets / nav use the WORLD only. The clip hull and the window glass are
  // MOVEMENT-only (Source player_clip / breakable-glass semantics): they block walking but you
  // see and shoot through them, and shooting glass shatters it.
  const bvh = new TriBVH(worldTris);
  meshBackend.bvh = bvh; meshBackend.bounds = bvh.bounds; meshBackend.active = true;
  meshBackend.clipBvh = clipTris.length ? new TriBVH(clipTris) : null;
  meshBackend.windowBvh = null; meshBackend.windowPanes = []; meshBackend.windowTriPane = null;
  const b = bvh.bounds;

  // world visual: the user's own real textured map (loaded at runtime, never bundled) if
  // supplied, otherwise a procedural floor/wall/ceiling tint × box-unwrapped detail texture.
  if (texturedScene) {
    texturedScene.scale.setScalar(39.3701);                   // VRF metres → source units; aligns with collision/spawns
    texturedScene.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = false; o.receiveShadow = true; if (o.material) o.material.side = THREE.DoubleSide;   // map is pre-lit + static → only agents cast dynamic shadows (cheap shadow pass)
      if (/rolling_gate/i.test(o.name || '')) o.visible = false;   // CT-spawn garage is walk-through now → hide its door so it reads as open
    });
    addMapObject(texturedScene);
  } else {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(worldTris, 3)); geo.computeVertexNormals();
    geo.setAttribute('color', new THREE.BufferAttribute(vertexColors(worldTris, b), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(boxUVs(worldTris, 160), 2));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .94, metalness: .04, side: THREE.DoubleSide });
    const detail = makeDetailTexture(); if (detail) { mat.map = detail; mat.needsUpdate = true; }
    const mesh = new THREE.Mesh(geo, mat); mesh.receiveShadow = true; mesh.castShadow = true; addMapObject(mesh);
  }

  // breakable window glass: a movement-only BVH (shoot/see through) split into panes, each its
  // own reflective mesh; shooting a pane drops its collision and hides it so you can step through.
  if (windowTris.length) {
    const wbvh = new TriBVH(windowTris); wbvh.alive = new Uint8Array(windowTris.length / 9).fill(1);
    meshBackend.windowBvh = wbvh;
    const triPane = new Int32Array(windowTris.length / 9);
    clusterWindowPanes(windowTris).forEach((tl, pi) => {
      const pp = new Float32Array(tl.length * 9);
      tl.forEach((t, j) => { for (let c = 0; c < 9; c++) pp[j * 9 + c] = windowTris[t * 9 + c]; triPane[t] = pi; });
      let cx = 0, cy = 0, cz = 0; for (let k = 0; k < pp.length; k += 3) { cx += pp[k]; cy += pp[k + 1]; cz += pp[k + 2]; } const nn = pp.length / 3;
      const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pp, 3)); pg.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: 0x2b3a52, metalness: .85, roughness: .07, transparent: true, opacity: .5, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(pg, mat); addMapObject(mesh);
      meshBackend.windowPanes.push({ tris: tl, mesh, broken: false, center: { x: cx / nn, y: cy / nn, z: cz / nn } });
    });
    meshBackend.windowTriPane = triPane;
    // hide ONLY the textured visual glass that a breakable pane actually replaces (by spatial
    // overlap). A blanket /window|glass/ match would also erase decorative/vehicle glass (truck,
    // banker, police cab) that has no pane, leaving invisible holes.
    if (texturedScene && typeof THREE.Box3 === 'function') {
      texturedScene.updateMatrixWorld(true);
      const centers = meshBackend.windowPanes.map(p => p.center), box = new THREE.Box3(), c = new THREE.Vector3();
      texturedScene.traverse(o => {
        if (o.isMesh && /window|glass/i.test(o.name || '')) {
          box.setFromObject(o); box.getCenter(c);
          if (centers.some(p => Math.abs(p.x - c.x) < 240 && Math.abs(p.y - c.y) < 240 && Math.abs(p.z - c.z) < 240)) o.visible = false;
        }
      });
    }
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
  return { triangles: (worldTris.length + windowTris.length) / 9, bounds: b, ctSpawns: CT_SPAWNS.length, tSpawns: T_SPAWNS.length, navNodes: NODES.length };
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

// night sky: dark gradient dome with procedural stars + a pale moon + a soft cool fill. cs_office
// is a snowy night map; the previous flat dark colour read as "no sky", and the warm dusk dome
// looked like a void. The key (shadow-casting) light is core.js `sun`.
function setupSky(b) {
  const horizon = 0x16273f;
  scene.background = new THREE.Color(horizon);
  scene.fog = new THREE.Fog(horizon, 2800, 12000);                  // distant buildings fade into night haze; dome stays visible
  addMapObject(new THREE.HemisphereLight(0x8aa0c8, 0x1a1f2a, 0.42)); // soft sky fill on top of the core sun

  // night dome (inverted sphere) with procedural stars. Guarded so the headless THREE stub skips it.
  if (typeof THREE.ShaderMaterial === 'function' && typeof THREE.SphereGeometry === 'function' && typeof THREE.Mesh === 'function') {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x070b18) }, mid: { value: new THREE.Color(horizon) }, bot: { value: new THREE.Color(0x05070c) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: [
        'varying vec3 vP; uniform vec3 top; uniform vec3 mid; uniform vec3 bot;',
        'float hash(vec3 p){ return fract(sin(dot(floor(p), vec3(127.1,311.7,74.7))) * 43758.5453); }',
        'void main(){',
        '  vec3 d = normalize(vP); float h = d.y;',
        '  vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.5)) : mix(mid, bot, pow(-h, 0.5));',
        '  if (h > 0.03) { float s = hash(d * 260.0); float star = smoothstep(0.9975, 1.0, s) * smoothstep(0.03, 0.35, h); c += vec3(0.72,0.8,0.95) * star; }',
        '  gl_FragColor = vec4(c, 1.0);',
        '}'
      ].join('\n')
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(8000, 48, 24), mat); dome.frustumCulled = false; dome.renderOrder = -10; addMapObject(dome);
  }

  // pale moon, aligned with the core key-light direction (core.js sun.position).
  if (typeof THREE.Sprite === 'function' && typeof THREE.CanvasTexture === 'function' && typeof document !== 'undefined') {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const ctx = cv.getContext('2d'); const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(240,246,255,1)'); g.addColorStop(0.18, 'rgba(220,232,255,0.95)'); g.addColorStop(0.42, 'rgba(150,175,222,0.22)'); g.addColorStop(1, 'rgba(120,150,210,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
    spr.position.copy(new THREE.Vector3(-1200, 2200, 800).normalize().multiplyScalar(7000)); spr.scale.setScalar(1400); addMapObject(spr);
  }
}

// warm point lights up near the office ceilings — placed on spaced nav nodes (guaranteed on
// standable interior floors), sitting at the ceiling above each (or a default height).
function addCeilingLights() {
  const placed = [];
  // FEW, widely-spaced fill lights — every extra light is shaded per-fragment on every material,
  // so 46 of them tanked the framerate (esp. at retina pixelRatio). The textures are already
  // pre-lit; ~10 wide point lights give moving agents some local warmth without the cost.
  for (let i = 0; i < NODES.length && placed.length < 10; i += 5) {
    const n = NODES[i];
    if (placed.some(p => p.distanceToSquared(n.p) < 760 * 760)) continue;                    // keep them spread out
    const up = meshBackend.bvh.raycast(n.p.x, n.y + 24, n.p.z, 0, 1, 0, 600);
    const cy = (up && up.t < 600) ? n.y + 24 + up.t - 12 : n.y + 96;                        // just under the ceiling, else a default height
    const pl = new THREE.PointLight(0xffe2b0, 0.85, 1300, 1.5);
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

// split the window triangle soup into panes = connected components (tris sharing a vertex),
// so each real window can be shattered independently.
function clusterWindowPanes(tris) {
  const ntri = tris.length / 9, parent = new Array(ntri);
  for (let i = 0; i < ntri; i++) parent[i] = i;
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const vmap = new Map(), key = (x, y, z) => ((x * 8 | 0) + ',' + (y * 8 | 0) + ',' + (z * 8 | 0));
  for (let t = 0; t < ntri; t++) for (let k = 0; k < 3; k++) {
    const o = t * 9 + k * 3, kk = key(tris[o], tris[o + 1], tris[o + 2]);
    const prev = vmap.get(kk); if (prev !== undefined) parent[find(t)] = find(prev); else vmap.set(kk, t);
  }
  const groups = new Map();
  for (let t = 0; t < ntri; t++) { const r = find(t); let a = groups.get(r); if (!a) { a = []; groups.set(r, a); } a.push(t); }
  return [...groups.values()];
}

/* sample a grid of standable floor points and connect walkable neighbours.
   The collision is now Valve's watertight physics hull, which INCLUDES ceilings/roofs — so a
   single top-down ray would seat nodes on the roof and miss interior floors under a ceiling.
   We therefore sample EVERY standable floor level per column (multi-storey), connect walkable
   neighbours, then PRUNE to what's actually reachable from the spawns — which deletes the roof
   and any out-of-bounds shelf the player can never stand on. */
export function generateMeshNav() {
  NODES.length = 0; for (const k in EDGES) delete EDGES[k];
  const { minX, maxX, minZ, maxZ } = MAP_BOUNDS; const top = meshBackend.bounds.max[1] + 60;
  const step = Math.max(56, Math.min(120, Math.round((maxX - minX) / 64)));   // dense enough for spawn clusters + doorways
  const cells = {}; let id = 0;                                               // "gx,gz" -> [nodes stacked by storey]
  const addNode = (x, z, y, gx, gz) => { const n = { id: id++, p: new THREE.Vector3(x, y, z), gx, gz, y }; NODES.push(n); EDGES[n.id] = []; (cells[gx + ',' + gz] || (cells[gx + ',' + gz] = [])).push(n); return n; };

  // all standable floors in a column: walk a down-ray, keep each UP-facing surface with headroom
  const sampleColumn = (x, z, gx, gz) => {
    let y = top, guard = 0, found = 0;
    while (guard++ < 12) {
      const h = meshBackend.bvh.raycast(x, y, z, 0, -1, 0, 9000);
      if (!h) break;
      const fy = y - h.t;
      if (h.ny > 0.35) {                                                      // up-facing -> a floor, not a wall/ceiling underside
        const upB = meshBackend.bvh.raycast(x, fy + 10, z, 0, 1, 0, 80);
        if (!(upB && upB.t < 52)) { addNode(x, z, fy, gx, gz); found++; }     // needs ~standing headroom
      }
      y = fy - 12;                                                            // continue beneath this surface
    }
    return found;
  };

  for (let x = minX + step / 2; x < maxX; x += step) for (let z = minZ + step / 2; z < maxZ; z += step) {
    const gx = Math.round((x - minX) / step), gz = Math.round((z - minZ) / step);
    if (sampleColumn(x, z, gx, gz)) continue;
    // decimation/convex-hull seam can drop a single sample — jitter before giving up so spawn floors stay dense
    for (const [ox, oz] of [[step * 0.3, 0], [-step * 0.3, 0], [0, step * 0.3], [0, -step * 0.3]]) {
      const h = meshBackend.bvh.raycast(x + ox, top, z + oz, 0, -1, 0, 9000);
      if (h) { addNode(x, z, top - h.t, gx, gz); break; }
    }
  }

  // connect to the nearest-storey node in each of 8 adjacent columns within step-up height
  for (const n of NODES) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const col = cells[(n.gx + dx) + ',' + (n.gz + dz)]; if (!col) continue;
    let m = null, best = 48;                                                  // step too tall to walk if >48
    for (const c of col) { const d = Math.abs(c.y - n.y); if (d < best) { best = d; m = c; } }
    if (!m || EDGES[n.id].includes(m.id)) continue;
    if (meshBackend.groundHeight((n.p.x + m.p.x) / 2, (n.p.z + m.p.z) / 2, Math.max(n.y, m.y) + 40, 60) <= -1e8) continue;  // genuine gap
    const hy = Math.min(n.y, m.y) + 100;                                      // only floor-to-ceiling walls sever an edge
    if (meshBackend.losClear({ x: n.p.x, y: hy, z: n.p.z }, { x: m.p.x, y: hy, z: m.p.z })) { EDGES[n.id].push(m.id); EDGES[m.id].push(n.id); }
  }

  // Stitch fragmented same-storey islands (the LOS edge test over-severs in cluttered rooms).
  // SHORT, LOS-checked, small Δy bridges only — so we reconnect a split room WITHOUT building a
  // bridge that clips a wall or climbs to the roof.
  const parent = NODES.map(n => n.id);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (i, j) => { parent[find(i)] = find(j); };
  for (const a in EDGES) for (const b of EDGES[a]) union(+a, b);
  const linkable = (i, j) => { const hy = Math.min(NODES[i].y, NODES[j].y) + 100; return meshBackend.losClear({ x: NODES[i].p.x, y: hy, z: NODES[i].p.z }, { x: NODES[j].p.x, y: hy, z: NODES[j].p.z }); };
  const bridge = (i, j) => { union(i, j); if (!EDGES[i].includes(j)) EDGES[i].push(j); if (!EDGES[j].includes(i)) EDGES[j].push(i); };
  const cands = [], D2 = (step * 4) * (step * 4);
  for (let i = 0; i < NODES.length; i++) for (let j = i + 1; j < NODES.length; j++) {
    if (Math.abs(NODES[i].y - NODES[j].y) > 56) continue;
    const dx = NODES[i].p.x - NODES[j].p.x, dz = NODES[i].p.z - NODES[j].p.z, d2 = dx * dx + dz * dz;
    if (d2 <= D2) cands.push([d2, i, j]);
  }
  cands.sort((a, b) => a[0] - b[0]);
  for (const [, i, j] of cands) { if (find(i) !== find(j) && linkable(i, j)) bridge(i, j); }

  // PRUNE to spawn-reachable: keeps the playable graph, drops the roof / out-of-bounds shelves.
  const nodeNear = p => { let bn = null, bd = 1e18; for (const n of NODES) { const dx = n.p.x - p.x, dy = n.y - (p.y || 0), dz = n.p.z - p.z; const d = dx * dx + dy * dy * 0.3 + dz * dz; if (d < bd) { bd = d; bn = n; } } return bn; };
  const ctSeeds = CT_SPAWNS.map(nodeNear).filter(Boolean), tSeeds = T_SPAWNS.map(nodeNear).filter(Boolean);
  // guarantee CT and T are mutually reachable (engagement depends on it): bridge their components,
  // preferring a LOS-clear link, else the shortest same-Δy pair as a last resort.
  if (ctSeeds.length && tSeeds.length && find(ctSeeds[0].id) !== find(tSeeds[0].id)) {
    let bestClear = null, bestAny = null;
    for (const a of NODES) for (const b of NODES) {
      if (find(a.id) === find(ctSeeds[0].id) && find(b.id) === find(tSeeds[0].id)) {
        if (Math.abs(a.y - b.y) > 80) continue;
        const dx = a.p.x - b.p.x, dz = a.p.z - b.p.z, d2 = dx * dx + dz * dz;
        if (!bestAny || d2 < bestAny[0]) bestAny = [d2, a.id, b.id];
        if (linkable(a.id, b.id) && (!bestClear || d2 < bestClear[0])) bestClear = [d2, a.id, b.id];
      }
    }
    const pick = bestClear || bestAny; if (pick) bridge(pick[1], pick[2]);
  }
  const seeds = [...ctSeeds, ...tSeeds];
  const keep = new Set(); const queue = seeds.map(n => n.id); for (const s of queue) keep.add(s);
  while (queue.length) { const u = queue.pop(); for (const v of EDGES[u]) if (!keep.has(v)) { keep.add(v); queue.push(v); } }

  // reindex NODES/EDGES to the kept set (ids must stay array indices for A*)
  const kept = NODES.filter(n => keep.has(n.id)); const remap = new Map(); kept.forEach((n, i) => remap.set(n.id, i));
  const newEdges = {}; kept.forEach((n, i) => { newEdges[i] = (EDGES[n.id] || []).filter(v => keep.has(v)).map(v => remap.get(v)); });
  kept.forEach((n, i) => { n.id = i; });
  NODES.length = 0; NODES.push(...kept);
  for (const k in EDGES) delete EDGES[k]; for (const k in newEdges) EDGES[k] = newEdges[k];
}
