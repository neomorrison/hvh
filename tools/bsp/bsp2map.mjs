#!/usr/bin/env node
/* ============================== [BSP → MAP] ==============================
   A Source-1 .bsp (CS:S / CS:GO era, v19–21) → everything the game loads for a real map:
     <name>.glb          collision: node 'world' (brush hulls + displacements + solid prop hulls),
                         'windows' (CONTENTS_WINDOW glass), 'clip' (player clip + grates)
     <name>.tex.glb      the look: lit faces + props with their real textures (metres, like a VRF export)
     <name>.spawns.json  CT/T spawns, hostages, rescue zones straight from the entity lump
     <name>.nav.json     the game's OWN bot mesh (.nav) as a node graph, if a .nav is given
   Brushes are watertight convex volumes, so unlike a decompiled render mesh there are no missing
   polygons for bullets and eyes to slip through.
     node tools/bsp/bsp2map.mjs <map.bsp> <game_pak_dir.vpk|-> <outDir> [name] [map.nav]
   Built on the .bsp / .vtf / .mdl / .phy readers from neomorrison/surf (same author, same licence). */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readBsp, CONTENTS } from './bsp.js';
import { resolveTexture, parseVtf } from './vtfread.js';
import { unpackEntry } from './pakdecode.mjs';
import { readProps } from './propgeom.mjs';
import { openVpk } from './vpk.mjs';
import { decodeVtf } from './dxt.mjs';
import { encodePNG } from './png.mjs';
import { GLB } from './glb.mjs';
import { brushTriangles } from './hull.mjs';
import { parseNav, navToGraph } from './nav.mjs';

const [bspPath, vpkPath, outDir, nameArg, navPath] = process.argv.slice(2);
if (!bspPath || !outDir) { console.error('usage: bsp2map.mjs <map.bsp> <pak_dir.vpk|-> <outDir> [name] [map.nav]'); process.exit(1); }
const name = nameArg || basename(bspPath, '.bsp');
mkdirSync(outDir, { recursive: true });
const raw = readFileSync(bspPath);
const bsp = readBsp(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const own = bsp.pakfile(unpackEntry);
const vpks = vpkPath && vpkPath !== '-' ? vpkPath.split(',').map(openVpk) : [];   // comma-separated: the game's pak plus anything it mounts (CS:S mounts hl2)
const pak = { get: k => { const kk = k.toLowerCase().replace(/\\/g, '/'); let v = own.get(kk); for (const p of vpks) { if (v) break; v = p.get(kk); } return v || null; } };
const METRE = 1 / 39.3701;
const TEX_CAP = +(process.env.TEX_CAP || 512);   // largest texture side shipped (the .glb is served, not installed)   // the game scales the textured scene by 39.3701 (VRF exports are in metres)

/* ---------------- textures ----------------
   Shipped as JPEG (opaque) / PNG (alpha) via Pillow — a 512² PNG is ~600 KB, the JPEG ~45 KB, and
   this file is downloaded on every visit, so the image encoding IS the file size. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ENC = fileURLToPath(new URL('./encode_img.py', import.meta.url)), JPEG_Q = +(process.env.JPEG_Q || 82);
function encodeImage(rgba, w, h, alpha) {
  try { const buf = execFileSync('python', [ENC, String(w), String(h), alpha ? '1' : '0', String(JPEG_Q)], { input: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), maxBuffer: 64 << 20 }); return { buf, mime: alpha ? 'image/png' : 'image/jpeg' }; }
  catch (e) { return { buf: encodePNG(rgba, w, h), mime: 'image/png' }; }   // no Pillow → PNG
}
const texCache = new Map(), imgByPath = new Map();   // one image per .vtf however many materials point at it
function texInfo(mat, cap) {
  const key = mat.toLowerCase(); if (texCache.has(key)) return texCache.get(key);
  let info = null;
  const res = resolveTexture(pak, mat);
  if (res) {
    const vtf = pak.get(res.path);
    if (vtf && vtf.length > 64) {
      const w = vtf.readUInt16LE(16), h = vtf.readUInt16LE(18);
      try {
        const v = parseVtf(vtf, cap || TEX_CAP);
        const rgba = v && decodeVtf(v.format, v.data, v.width, v.height);
        info = { w, h, path: res.path, translucent: !!res.translucent, png: rgba ? encodeImage(rgba, v.width, v.height, !!res.translucent) : null, fmt: v && v.format };
      } catch (e) { info = { w, h, translucent: false, png: null, fmt: 'ERR' }; }
    }
  }
  texCache.set(key, info); return info;
}
const sizeOf = (m, cap) => { const t = texInfo(m, cap); return t ? { w: t.w, h: t.h } : { w: 512, h: 512 }; };

/* ---------------- collision ---------------- */
const world = [], windows = [], clip = [];
const brushes = bsp.brushes(CONTENTS.SOLID | CONTENTS.PLAYERCLIP | CONTENTS.WINDOW | CONTENTS.GRATE);
let nb = { world: 0, windows: 0, clip: 0 };
for (const b of brushes) {
  const c = b.contents;
  const dst = (c & CONTENTS.WINDOW) ? windows : ((c & (CONTENTS.PLAYERCLIP | CONTENTS.GRATE)) && !(c & CONTENTS.SOLID)) ? clip : world;
  const n = brushTriangles(b.planes, dst);
  if (n) nb[dst === world ? 'world' : dst === windows ? 'windows' : 'clip']++;
}
const faces = bsp.faces(sizeOf), disps = bsp.displacements(sizeOf);
for (const g of disps.groups) for (let i = 0; i < g.pos.length; i++) world.push(g.pos[i]);
const props = readProps(bsp, pak);
let propHullTris = 0;
if (props) for (const planes of props.hulls) propHullTris += brushTriangles(planes, world);

const col = new GLB();
for (const [nm, arr] of [['world', world], ['windows', windows], ['clip', clip]]) {
  if (!arr.length) continue;
  const pos = new Float32Array(arr);
  col.root(col.node({ name: nm, mesh: col.mesh([{ attributes: { POSITION: col.accessor(pos, 'VEC3', 5126, true) } }]) }));
}
writeFileSync(join(outDir, name + '.glb'), col.build());

/* ---------------- the look ---------------- */
const tex = new GLB(); const matIndex = new Map(); let nGlass = 0, nSurf = 0;
function materialFor(mat, cap) {
  if (matIndex.has(mat)) return matIndex.get(mat);
  const t = texInfo(mat, cap); let mi;
  if (t && t.png && !imgByPath.has(t.path)) imgByPath.set(t.path, tex.image(t.png.buf, t.png.mime));
  if (t && t.png) mi = tex.material({ name: mat, pbrMetallicRoughness: { baseColorTexture: { index: imgByPath.get(t.path) }, metallicFactor: 0, roughnessFactor: 0.92 }, alphaMode: t.translucent ? 'BLEND' : 'OPAQUE', doubleSided: true });
  else mi = tex.material({ name: mat, pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.52, 1], metallicFactor: 0, roughnessFactor: 0.92 }, doubleSided: true });
  matIndex.set(mat, mi); return mi;
}
function addSurface(g, cap) {
  if (!g.pos.length) return;
  const pos = new Float32Array(g.pos.length); for (let i = 0; i < pos.length; i++) pos[i] = g.pos[i] * METRE;
  const colr = new Float32Array(g.light.length); for (let i = 0; i < colr.length; i++) colr[i] = Math.min(2.5, g.light[i]);
  const glass = /glass|window/i.test(g.material);
  const prim = { attributes: { POSITION: tex.accessor(pos, 'VEC3', 5126, true), TEXCOORD_0: tex.accessor(new Float32Array(g.uv), 'VEC2'), COLOR_0: tex.accessor(colr, 'VEC3') }, material: materialFor(g.material, cap) };
  tex.root(tex.node({ name: glass ? 'glass_' + (nGlass++) : 'surf_' + (nSurf++), mesh: tex.mesh([prim]) }));
}
for (const g of faces.groups) addSurface(g);
for (const g of disps.groups) addSurface(g);
let propNodes = 0;
if (props) {
  const meshIdx = props.models.map(m => {
    const prims = [];
    for (const mesh of m.meshes) {
      const pos = new Float32Array(mesh.positions.length); for (let i = 0; i < pos.length; i++) pos[i] = mesh.positions[i] * METRE;
      const colr = new Float32Array(pos.length).fill(0.6);
      prims.push({ attributes: { POSITION: tex.accessor(pos, 'VEC3', 5126, true), TEXCOORD_0: tex.accessor(new Float32Array(mesh.uvs), 'VEC2'), COLOR_0: tex.accessor(colr, 'VEC3') }, material: materialFor(mesh.material, 256) });   // props are seen at a distance; 256 is plenty and keeps the download small
    }
    return prims.length ? tex.mesh(prims) : -1;
  });
  for (const inst of props.instances) {
    const mi = meshIdx[inst.model]; if (mi < 0) continue;
    const R = inst.m;   // row-major 3x3 + translation, Y-up
    const matrix = [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, R[9] * METRE, R[10] * METRE, R[11] * METRE, 1];
    tex.root(tex.node({ name: 'prop_' + (propNodes++), mesh: mi, matrix }));
  }
}
writeFileSync(join(outDir, name + '.tex.glb'), tex.build());

/* ---------------- spawns / hostages / rescue ---------------- */
const ents = bsp.entities(), models = bsp.models();
const yawOf = e => (-(+((e.angles || '0 0 0').trim().split(/\s+/)[1]) || 0) - 90) * Math.PI / 180;
const pt = e => ({ x: +e.pos.x.toFixed(1), y: +e.pos.y.toFixed(1), z: +e.pos.z.toFixed(1), yaw: +yawOf(e).toFixed(3) });
const spawns = {
  name,
  ctSpawns: ents.filter(e => e.classname === 'info_player_counterterrorist' && e.pos).map(pt),
  tSpawns: ents.filter(e => e.classname === 'info_player_terrorist' && e.pos).map(pt),
  hostages: ents.filter(e => (e.classname === 'hostage_entity' || e.classname === 'info_hostage_spawn') && e.pos).map(pt),
  rescueZones: ents.filter(e => e.classname === 'func_hostage_rescue' && /^\*\d+$/.test(e.model || '')).map(e => {
    const m = models[+e.model.slice(1)]; return m ? { x: +((m.minX + m.maxX) / 2).toFixed(1), y: +m.minY.toFixed(1), z: +((m.minZ + m.maxZ) / 2).toFixed(1), r: +(Math.max(m.maxX - m.minX, m.maxZ - m.minZ) / 2).toFixed(1) } : null;
  }).filter(Boolean),
};
writeFileSync(join(outDir, name + '.spawns.json'), JSON.stringify(spawns, null, 1));

/* ---------------- nav ---------------- */
let navStat = 'no nav';
if (navPath) { const nav = parseNav(readFileSync(navPath)); const g = navToGraph(nav); writeFileSync(join(outDir, name + '.nav.json'), JSON.stringify(g)); navStat = `nav v${nav.version}: ${nav.areas.size} areas → ${g.nodes.length} nodes, ${Object.values(g.edges).reduce((s, e) => s + e.length, 0)} edges`; }

const texOk = [...texCache.values()].filter(t => t && t.png).length, texMiss = [...texCache.values()].filter(t => !t || !t.png).length;
console.log(`${name}: brushes world ${nb.world} / windows ${nb.windows} / clip ${nb.clip} → collision tris ${world.length / 9 | 0} (+${propHullTris} prop hull tris) / win ${windows.length / 9 | 0} / clip ${clip.length / 9 | 0}`);
console.log(`faces drawn ${faces.drawn} skipped ${faces.skipped} displacements ${disps.count}; props: ${props ? `${props.stats.drawn}/${props.stats.placed} placed, ${props.stats.models} models, ${props.stats.missing} missing, ${props.stats.solidProps} solid` : 'none'}`);
console.log(`textures ${texOk} ok / ${texMiss} missing; spawns CT ${spawns.ctSpawns.length} T ${spawns.tSpawns.length} hostages ${spawns.hostages.length} rescue ${spawns.rescueZones.length}; ${navStat}`);
for (const p of vpks) p.close();
