/* ============================== [MAP] ==============================
   Two map sources, both feeding the same WALLS/nav/spawns the game reads:
     • buildDefaultMap()  — the procedural cs_office layout (auto-carved doors,
       hand-authored waypoint graph).
     • buildCustomMap(d)  — a data-driven layout from the Map Builder, with an
       auto-generated grid nav graph so bots can path on any level.          */
import * as THREE from 'three';
import { PLAYER_RADIUS } from './data.js';
import {
  floorTile, addBox, addMapObject, emitWall, wallRun, buildGeometry, flushSpecs,
  fdesk, fpod, ftable, fcabinet, fcouch, fcounter, fscreen, fvan, fcar, fstall, fcrate, fsnow,
  matSnow, matCarpet, matConcrete, matCeil, matGlass, matRescue, matWall, matMetal, matWood,
  NODES, EDGES, CT_SPAWNS, T_SPAWNS, HOSTAGE_SPAWNS, RESCUE_ZONES, MAP_BOUNDS,
  WALLS, clearWorld, losClear,
} from './world.js';

/* wall material palette for custom maps: name -> {mat, matVal (density/opacity)} */
export const WALL_MATERIALS = {
  wall:     { label: "Drywall",  mat: matWall,     matVal: 0.45 },
  concrete: { label: "Concrete", mat: matConcrete, matVal: 0.70 },
  metal:    { label: "Metal",    mat: matMetal,    matVal: 0.85 },
  wood:     { label: "Wood",     mat: matWood,     matVal: 0.42 },
  glass:    { label: "Glass",    mat: matGlass,    matVal: 0.30 },   // <0.4 = see/shoot-through
};

/* prop palette for custom maps: name -> {label, build(x,z,opt)} */
export const PROP_TYPES = {
  desk:    { label: "Desk",     build: (x, z) => fdesk(x, z, true) },
  cabinet: { label: "Cabinet",  build: (x, z) => fcabinet(x, z) },
  couch:   { label: "Couch",    build: (x, z) => fcouch(x, z, true) },
  table:   { label: "Table",    build: (x, z) => ftable(x - 60, x + 60, z - 100, z + 100) },
  counter: { label: "Counter",  build: (x, z) => fcounter(x - 90, x + 90, z - 30, z + 30) },
  pod:     { label: "Cubicle",  build: (x, z) => fpod(x, z) },
  crate:   { label: "Crate",    build: (x, z) => fcrate(x, z, 64) },
  stall:   { label: "Stall",    build: (x, z) => fstall(x, z) },
  car:     { label: "Car",      build: (x, z, o) => fcar(x, z, (o && o.color) || 0x394b6a) },
  van:     { label: "Van",      build: (x, z) => fvan(x, z) },
  screen:  { label: "Screen",   build: (x, z) => fscreen(x, z) },
  snow:    { label: "Snowpile", build: (x, z) => fsnow(x, z, 60) },
};

function setBounds(b) { MAP_BOUNDS.minX = b.minX; MAP_BOUNDS.maxX = b.maxX; MAP_BOUNDS.minZ = b.minZ; MAP_BOUNDS.maxZ = b.maxZ; }

/* ===================== default cs_office ===================== */
export function buildDefaultMap() {
  clearWorld();
  setBounds({ minX: -200, maxX: 3700, minZ: -1050, maxZ: 1050 });

  // ---- floors ----
  floorTile(-200, 720, -980, 980, matSnow);            // exterior snow (CT)
  floorTile(720, 3540, -980, 980, matCarpet);          // office carpet
  floorTile(720, 1180, -980, -450, matConcrete);       // garage concrete

  // ---- ceiling + lights ----
  const ceil = addBox(2130, 0, 2820, 1960, 12, 242, matCeil); ceil.castShadow = false; ceil.receiveShadow = false;
  const flight = (x, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(150, 3, 46), new THREE.MeshBasicMaterial({ color: 0xfff4d6 })); m.position.set(x, 235, z); addMapObject(m); };
  for (let gx = 900; gx < 3450; gx += 520) for (let gz = -700; gz < 900; gz += 540) flight(gx, gz);
  for (const [lx, lz] of [[950, -250], [1500, -650], [1950, -220], [1450, 150], [2850, -300], [2850, 420], [3300, 0], [1000, 520]]) { const pl = new THREE.PointLight(0xffe9c4, 0.6, 1600, 1.6); pl.position.set(lx, 205, lz); addMapObject(pl); }

  // ---- outer boundary ----
  wallRun('x', 980, -200, 3540, 290);
  wallRun('x', -980, -200, 3540, 290);
  wallRun('z', -200, -980, 980, 290);
  wallRun('z', 3540, -980, 980, 290);

  // facade between snow and offices (garage door south + front windows north)
  wallRun('z', 720, -950, 950, 240, [[-660, 240], [455, 220]]);
  addBox(720, 455, 10, 220, 150, 90, matGlass);                 // front window panes
  addBox(720, 690, 10, 180, 150, 90, matGlass);

  // west block: garage / connector / lobby (doors at x=950)
  wallRun('x', -450, 720, 1180, 230, [[950, 180]]);
  wallRun('x', 250, 720, 1180, 230, [[950, 180]]);
  // office (bullpen) walls
  wallRun('z', 1180, -950, 950, 230, [[-700, 170], [-75, 170], [480, 200]]);   // west wall
  wallRun('x', 250, 1180, 2640, 230, [[1375, 180], [1920, 210], [2400, 190]]); // north wall
  wallRun('z', 2640, -950, 250, 230, [[-620, 180], [-100, 190]]);              // east wall
  // conference (west door) / bathrooms east wall
  wallRun('z', 1640, 250, 950, 230, [[520, 170]]);
  wallRun('z', 2200, 250, 950, 230);
  wallRun('z', 2640, 250, 950, 230, [[640, 190]]);
  // east back wall (doors to back offices / T spawn)
  wallRun('z', 3060, -950, 950, 230, [[-560, 180], [-100, 190], [600, 190]]);

  // rescue zone markers (green)
  addBox(280, -350, 320, 320, 3, 0, matRescue);
  addBox(950, -720, 260, 260, 3, 0, matRescue);

  // ---- furniture ----
  fvan(300, -680); fcar(470, -820, 0x394b6a);
  fsnow(150, 250, 70); fsnow(540, 120, 58); fsnow(250, 650, 54); fsnow(600, -180, 48); fsnow(60, -560, 52);
  fcar(1050, -850, 0x6a2f2f); fcabinet(790, -520); fcabinet(790, -620); fcabinet(1120, -520);
  fcounter(820, 1120, 720, 790); fcouch(900, 360, true); fcabinet(1120, 300);
  fpod(1640, -820); fpod(2200, -820); fpod(2440, -460); fpod(1660, -380); fpod(2160, -360); fpod(1430, 40);
  fcabinet(1240, -900); fcabinet(2600, -900); fcabinet(2600, 180);
  ftable(1360, 1480, 420, 640);
  ftable(1820, 2020, 380, 840); fscreen(1920, 944);
  fstall(2300, 540); fstall(2300, 660); fstall(2300, 780); fcounter(2540, 2620, 300, 520);
  fcabinet(2700, -300); fcabinet(2700, 120); fcabinet(3000, -400); fcabinet(3000, 300);
  fcounter(2680, 3020, 860, 940); ftable(2860, 2980, 640, 760);
  fdesk(3200, -780, true); fdesk(3420, -780, true); fcouch(3470, -280, false);
  fdesk(3200, 780, true); fdesk(3420, 780, true); fcouch(3470, 280, false);
  fcabinet(3120, -120); fcabinet(3120, 140);

  // hostages (4) — held in the back offices (T side)
  HOSTAGE_SPAWNS.push(
    new THREE.Vector3(3240, 0, -560), new THREE.Vector3(3440, 0, -440),
    new THREE.Vector3(3240, 0, 560), new THREE.Vector3(3440, 0, 440),
  );
  RESCUE_ZONES.push({ x: 280, z: -350, r: 200 }, { x: 950, z: -720, r: 170 });

  // spawns
  CT_SPAWNS.push(new THREE.Vector3(200, 0, -300), new THREE.Vector3(340, 0, -240), new THREE.Vector3(200, 0, -120), new THREE.Vector3(380, 0, -360), new THREE.Vector3(300, 0, 0));
  T_SPAWNS.push(new THREE.Vector3(3420, 0, -80), new THREE.Vector3(3460, 0, 80), new THREE.Vector3(3380, 0, -200), new THREE.Vector3(3460, 0, 200), new THREE.Vector3(3400, 0, 0));

  // ---- waypoint graph (nodes at room centres + doorways) ----
  const nodes = [
    [280, -350], [430, 300], [660, -660], [950, -720], [660, 455], [950, 500], [950, -100],
    [1430, -680], [1950, -680], [1950, -180], [1380, -180], [1380, 120], [1280, 500], [1920, 290],
    [2400, -60], [2420, 640], [2850, -620], [2850, -100], [2780, 600], [3280, -520], [3280, 520], [3400, 0],
  ];
  nodes.forEach((p, i) => NODES.push({ id: i, p: new THREE.Vector3(p[0], 0, p[1]) }));
  Object.assign(EDGES, { 0: [1, 2], 1: [0, 4], 2: [0, 3], 3: [2, 6, 7], 4: [1, 5], 5: [4, 6, 12], 6: [3, 5, 10], 7: [3, 8, 10], 8: [7, 9, 16], 9: [8, 10, 13, 14], 10: [6, 7, 9, 11], 11: [10, 12], 12: [5, 11], 13: [9], 14: [9, 15, 17], 15: [14, 18], 16: [8, 17, 19], 17: [14, 16, 18, 21], 18: [15, 17, 20], 19: [16, 21], 20: [18, 21], 21: [17, 19, 20] });

  // build the carved geometry now that the nav graph exists
  buildGeometry();
}

/* ===================== custom (Map Builder) ===================== */
export function buildCustomMap(data) {
  clearWorld();
  const b = data.bounds || { minX: -1200, maxX: 1200, minZ: -1200, maxZ: 1200 };
  setBounds(b);

  // floor + a grid of fill lights (hemi+sun are always present from core)
  floorTile(b.minX, b.maxX, b.minZ, b.maxZ, matCarpet);
  for (let lx = b.minX + 350; lx < b.maxX; lx += 800) for (let lz = b.minZ + 350; lz < b.maxZ; lz += 800) {
    const pl = new THREE.PointLight(0xffe9c4, 0.45, 1500, 1.6); pl.position.set(lx, 205, lz); addMapObject(pl);
  }

  // structural walls (explicit — no auto door-carving)
  for (const w of (data.walls || [])) {
    const m = WALL_MATERIALS[w.mat] || WALL_MATERIALS.wall;
    emitWall(w.minX, w.maxX, w.minZ, w.maxZ, w.h || 230, m.mat, m.matVal);
  }
  // props (push covers/accents into specs, then flush to real geometry+collision)
  for (const p of (data.props || [])) { const t = PROP_TYPES[p.type]; if (t) t.build(p.x, p.z, p); }
  flushSpecs();

  // rescue-zone floor markers
  for (const rz of (data.rescueZones || [])) addBox(rz.x, rz.z, (rz.r || 180) * 2, (rz.r || 180) * 2, 3, 0, matRescue);

  // spawns / hostages / rescue zones
  (data.ctSpawns || []).forEach(s => CT_SPAWNS.push(new THREE.Vector3(s.x, 0, s.z)));
  (data.tSpawns || []).forEach(s => T_SPAWNS.push(new THREE.Vector3(s.x, 0, s.z)));
  (data.hostages || []).forEach(h => HOSTAGE_SPAWNS.push(new THREE.Vector3(h.x, 0, h.z)));
  (data.rescueZones || []).forEach(rz => RESCUE_ZONES.push({ x: rz.x, z: rz.z, r: rz.r || 180 }));
  // guarantee at least one spawn per side so a match can run
  if (!CT_SPAWNS.length) CT_SPAWNS.push(new THREE.Vector3(b.minX + 200, 0, 0));
  if (!T_SPAWNS.length) T_SPAWNS.push(new THREE.Vector3(b.maxX - 200, 0, 0));

  generateGridNav();
}

/* auto nav: sample a grid of standable points, connect 8-neighbours with LoS */
export function generateGridNav() {
  NODES.length = 0; for (const k in EDGES) delete EDGES[k];
  const step = 150, { minX, maxX, minZ, maxZ } = MAP_BOUNDS;
  const walkable = (x, z) => {
    for (const w of WALLS) {
      if (!w.block || w.top < 40) continue;               // ignore low covers you can stand beside
      if (x > w.minX - PLAYER_RADIUS && x < w.maxX + PLAYER_RADIUS && z > w.minZ - PLAYER_RADIUS && z < w.maxZ + PLAYER_RADIUS) return false;
    }
    return true;
  };
  const cells = {}; let id = 0;
  for (let x = minX + step / 2; x < maxX; x += step) for (let z = minZ + step / 2; z < maxZ; z += step) {
    if (!walkable(x, z)) continue;
    const gx = Math.round((x - minX) / step), gz = Math.round((z - minZ) / step);
    const n = { id: id++, p: new THREE.Vector3(x, 0, z), gx, gz };
    NODES.push(n); EDGES[n.id] = []; cells[gx + ',' + gz] = n;
  }
  for (const n of NODES) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const m = cells[(n.gx + dx) + ',' + (n.gz + dz)]; if (!m) continue;
    const a = n.p.clone(); a.y = 40; const c = m.p.clone(); c.y = 40;
    if (losClear(a, c, false) && !EDGES[n.id].includes(m.id)) EDGES[n.id].push(m.id);
  }
}

/* ===================== map persistence (localStorage) ===================== */
const MAP_STORE_KEY = 'hvh_maps';
export function listMaps() { try { return JSON.parse(localStorage.getItem(MAP_STORE_KEY) || '{}'); } catch (e) { return {}; } }
export function saveCustomMap(name, data) { const all = listMaps(); all[name] = { ...data, name }; try { localStorage.setItem(MAP_STORE_KEY, JSON.stringify(all)); return true; } catch (e) { return false; } }
export function loadSavedMap(name) { return listMaps()[name] || null; }
export function deleteSavedMap(name) { const all = listMaps(); delete all[name]; try { localStorage.setItem(MAP_STORE_KEY, JSON.stringify(all)); } catch (e) {} }

/* a small starter level for "New" in the editor */
export function blankEditorMap() {
  return {
    name: "untitled",
    bounds: { minX: -1100, maxX: 1100, minZ: -900, maxZ: 900 },
    walls: [
      { minX: -1100, maxX: 1100, minZ: -900, maxZ: -886, h: 250, mat: "concrete" },
      { minX: -1100, maxX: 1100, minZ: 886, maxZ: 900, h: 250, mat: "concrete" },
      { minX: -1100, maxX: -1086, minZ: -900, maxZ: 900, h: 250, mat: "concrete" },
      { minX: 1086, maxX: 1100, minZ: -900, maxZ: 900, h: 250, mat: "concrete" },
      { minX: -120, maxX: 120, minZ: -260, maxZ: -246, h: 200, mat: "wall" },
      { minX: -120, maxX: 120, minZ: 246, maxZ: 260, h: 200, mat: "wall" },
    ],
    props: [
      { type: "crate", x: -300, z: 0 }, { type: "crate", x: 300, z: 0 },
      { type: "desk", x: 0, z: -400 }, { type: "cabinet", x: 0, z: 400 },
    ],
    ctSpawns: [{ x: -900, z: -600 }, { x: -820, z: -600 }, { x: -900, z: -520 }, { x: -820, z: -520 }, { x: -860, z: -440 }],
    tSpawns: [{ x: 900, z: 600 }, { x: 820, z: 600 }, { x: 900, z: 520 }, { x: 820, z: 520 }, { x: 860, z: 440 }],
    hostages: [{ x: 800, z: -700 }, { x: 880, z: -640 }],
    rescueZones: [{ x: -860, z: -600, r: 160 }],
  };
}
