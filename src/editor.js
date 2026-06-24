/* ============================== [BRUSH EDITOR] ==============================
   A lightweight in-game 3D brush editor (Hammer-style) over the deployed map. Make axis-aligned
   brushes (walls/blocks), push/pull their faces to stretch them exactly into gaps, paint per-face
   materials, and drop invisible clip brushes as boundaries. Brushes are both VISIBLE geometry and
   collision; they save to localStorage (per map) and export as JSON to bake in. Hide tool removes
   glitchy source surfaces. It does not replace cs_office — it patches/extends it.                */
import * as THREE from 'three';
import { scene, camera, renderer } from './core.js';
import { GAME, keys } from './state.js';
import { meshBackend } from './sourcemap.js';
import { showHint } from './hud.js';

const SKEY = name => 'hvh_patches_' + (name || 'cs_office');
let GRID = 8;
const snap = v => Math.round(v / GRID) * GRID;

/* ---- material palette ---- */
const MAT_KEYS = ['concrete', 'brick', 'metal', 'wood', 'white', 'dark', 'nodraw'];
const MAT_DEF = { concrete: [0x9a9a92, .95, 0], brick: [0x8a4a38, .9, 0], metal: [0x6a6e74, .5, .65], wood: [0x7a5636, .85, 0], white: [0xd8d8d4, .9, 0], dark: [0x2a2d33, .8, .2] };
const matCache = {};
function getMat(key) {
  if (matCache[key]) return matCache[key];
  let m;
  if (key === 'nodraw') m = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  else { const [c, r, me] = MAT_DEF[key] || MAT_DEF.concrete; m = new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: me, side: THREE.DoubleSide }); }
  return matCache[key] = m;
}

const ed = {
  on: false, brushes: [], hides: [], meshMap: new Map(), texturedScene: null,
  cam: new THREE.Vector3(), yaw: 0, pitch: 0,
  sel: null, paint: 'concrete', group: null, preview: null, hi: null, _undo: [],
};
export function isEditorOpen() { return ed.on; }

/* ---- brush ⇄ mesh + collision ---- */
function newBrush(cx, cy, cz) {
  const s = 64;
  return { min: [snap(cx - s), snap(cy), snap(cz - s)], max: [snap(cx + s), snap(cy + 128), snap(cz + s)], mats: Array(6).fill(ed.paint), type: 'solid' };
}
function brushMesh(b) {
  const w = Math.max(1, b.max[0] - b.min[0]), h = Math.max(1, b.max[1] - b.min[1]), d = Math.max(1, b.max[2] - b.min[2]);
  const g = new THREE.BoxGeometry(w, h, d);
  const mats = b.type === 'clip' ? getMat('nodraw') : b.mats.map(getMat);
  const m = new THREE.Mesh(g, mats);
  m.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  m.castShadow = b.type !== 'clip'; m.receiveShadow = true; m.renderOrder = b.type === 'clip' ? 997 : 0;
  return m;
}
function rebuild() {
  // collision
  meshBackend.setPatches(ed.brushes.map(b => ({ x: (b.min[0] + b.max[0]) / 2, y: (b.min[1] + b.max[1]) / 2, z: (b.min[2] + b.max[2]) / 2, w: b.max[0] - b.min[0], h: b.max[1] - b.min[1], d: b.max[2] - b.min[2], type: b.type })));
  // meshes
  if (!ed.group) { ed.group = new THREE.Group(); scene.add(ed.group); }
  for (const m of ed.meshMap.values()) { ed.group.remove(m); m.geometry.dispose(); }
  ed.meshMap.clear();
  for (const b of ed.brushes) { const m = brushMesh(b); ed.group.add(m); ed.meshMap.set(b, m); }
}
function pushUndo() { ed._undo.push(JSON.stringify(ed.brushes)); if (ed._undo.length > 40) ed._undo.shift(); }

/* ---- persistence ---- */
export function loadPatches(mapName, texturedScene) {
  ed.texturedScene = texturedScene || ed.texturedScene;
  let data = null; try { data = JSON.parse(localStorage.getItem(SKEY(mapName)) || 'null'); } catch (e) {}
  ed.brushes = (data && data.brushes) || (data && data.patches || []).map(boxToBrush);   // migrate old box patches
  ed.hides = (data && data.hides) || [];
  rebuild(); if (!ed.on) for (const m of ed.meshMap.values()) m.visible = true;   // brushes always render (they're real geometry)
  applyHides();
}
function boxToBrush(p) { return { min: [p.x - p.w / 2, p.y - p.h / 2, p.z - p.d / 2], max: [p.x + p.w / 2, p.y + p.h / 2, p.z + p.d / 2], mats: Array(6).fill('concrete'), type: p.type || 'solid' }; }
function save() { try { localStorage.setItem(SKEY(GAME.sourceMap), JSON.stringify({ brushes: ed.brushes, hides: ed.hides })); showHint('Saved ' + ed.brushes.length + ' brushes, ' + ed.hides.length + ' hidden'); } catch (e) { showHint('Save failed: ' + e.message); } }
function exportJSON() {
  const json = JSON.stringify({ brushes: ed.brushes, hides: ed.hides });
  console.log('=== MAP PATCHES (' + GAME.sourceMap + ') ===\n' + json);
  if (navigator.clipboard) navigator.clipboard.writeText(json).then(() => showHint('Brush JSON copied + logged')).catch(() => showHint('Brush JSON logged to console'));
  else showHint('Brush JSON logged to console');
}
function applyHides() { if (!ed.texturedScene) return; const set = new Set(ed.hides); ed.texturedScene.traverse(o => { if (o.isMesh && o.name && set.has(o.name)) o.visible = false; }); }

/* ---- aim ray ---- */
const _ro = new THREE.Vector3(), _rd = new THREE.Vector3(), _rc = new THREE.Raycaster();
function rayBrush(b) {   // ray vs this brush's AABB → { t, axis, sign } of the entry face, or null
  let tmin = -1e9, tmax = 1e9, axis = 0, sign = 1;
  for (let i = 0; i < 3; i++) {
    const o = i === 0 ? _ro.x : i === 1 ? _ro.y : _ro.z, d = i === 0 ? _rd.x : i === 1 ? _rd.y : _rd.z;
    if (Math.abs(d) < 1e-8) { if (o < b.min[i] || o > b.max[i]) return null; continue; }
    let t1 = (b.min[i] - o) / d, t2 = (b.max[i] - o) / d, s = -1; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    tmax = Math.min(tmax, t2); if (tmin > tmax) return null;
  }
  return tmin > 0 ? { t: tmin, axis, sign } : null;
}
function aim() {   // nearest brush face under the crosshair, else the world surface point
  camera.getWorldPosition(_ro); camera.getWorldDirection(_rd);
  let bestB = null, bestF = null, bt = 1e9;
  for (const b of ed.brushes) { const r = rayBrush(b); if (r && r.t < bt) { bt = r.t; bestB = b; bestF = r; } }
  let wt = 1e9;
  if (meshBackend.bvh) { const h = meshBackend.bvh.raycast(_ro.x, _ro.y, _ro.z, _rd.x, _rd.y, _rd.z, 6000); if (h) wt = h.t; }
  const point = _ro.clone().add(_rd.clone().multiplyScalar(Math.min(bt, wt, 6000)));
  return { brush: bt <= wt ? bestB : null, face: bt <= wt ? bestF : null, point };
}

/* ---- enter / exit ---- */
export function toggleEditor() { ed.on ? exit() : enter(); }
function enter() {
  if (!meshBackend.active) { showHint('Deploy cs_office first'); return; }
  ed.on = true; ed._prevPhase = GAME.phase; GAME.phase = 'editor';
  if (!ed.group) { ed.group = new THREE.Group(); scene.add(ed.group); }
  if (!ed.hi) { ed.hi = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffd54a, wireframe: true })); ed.hi.renderOrder = 999; scene.add(ed.hi); }
  if (!ed.preview) { ed.preview = new THREE.Mesh(new THREE.SphereGeometry(4, 8, 8), new THREE.MeshBasicMaterial({ color: 0x44ff88 })); ed.preview.renderOrder = 999; scene.add(ed.preview); }
  ed.hi.visible = ed.preview.visible = true;
  ed.cam.copy(camera.position); camera.getWorldDirection(_rd); ed.yaw = Math.atan2(-_rd.x, -_rd.z); ed.pitch = Math.asin(THREE.MathUtils.clamp(_rd.y, -1, 1));
  rebuild(); document.exitPointerLock(); renderer.domElement.requestPointerLock(); hud(true);
}
function exit() { ed.on = false; GAME.phase = ed._prevPhase || 'live'; if (ed.hi) ed.hi.visible = false; if (ed.preview) ed.preview.visible = false; ed.sel = null; hud(false); }

/* ---- per-frame ---- */
export function editorUpdate() {
  if (!ed.on) return;
  const sp = (keys['ShiftLeft'] ? 30 : 12), cp = Math.cos(ed.pitch);
  const fwd = new THREE.Vector3(-Math.sin(ed.yaw) * cp, Math.sin(ed.pitch), -Math.cos(ed.yaw) * cp);
  const right = new THREE.Vector3(Math.cos(ed.yaw), 0, -Math.sin(ed.yaw));
  if (keys['KeyW']) ed.cam.addScaledVector(fwd, sp);
  if (keys['KeyS']) ed.cam.addScaledVector(fwd, -sp);
  if (keys['KeyA']) ed.cam.addScaledVector(right, -sp);
  if (keys['KeyD']) ed.cam.addScaledVector(right, sp);
  if (keys['KeyR']) ed.cam.y += sp; if (keys['KeyF']) ed.cam.y -= sp;
  camera.position.copy(ed.cam); camera.rotation.set(ed.pitch, ed.yaw, 0, 'YXZ');
  const a = aim();
  if (ed.preview) ed.preview.position.copy(a.point);
  // highlight: the selected brush (or the one under the crosshair)
  const b = ed.sel || a.brush;
  if (b && ed.hi) { ed.hi.visible = true; ed.hi.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2); ed.hi.scale.set(Math.max(2, b.max[0] - b.min[0]) + 2, Math.max(2, b.max[1] - b.min[1]) + 2, Math.max(2, b.max[2] - b.min[2]) + 2); ed.hi.material.color.setHex(ed.sel === b ? 0xffd54a : 0x55ccff); }
  else if (ed.hi) ed.hi.visible = false;
  ed._aim = a;
}
export function editorMouse(dx, dy) { if (!ed.on) return; const s = 0.0022; ed.yaw -= dx * s; ed.pitch = THREE.MathUtils.clamp(ed.pitch - dy * s, -1.5, 1.5); }

// wheel = push/pull the active face of the selected brush (Shift = move whole brush along that axis)
export function editorWheel(delta) {
  if (!ed.on) return;
  const b = ed.sel, f = ed._aim && ed._aim.face; if (!b || !f) return;
  pushUndo();
  const step = (delta < 0 ? 1 : -1) * GRID, ax = f.axis;
  if (keys['ShiftLeft']) { b.min[ax] += step; b.max[ax] += step; }    // slide whole brush
  else if (f.sign > 0) b.max[ax] = Math.max(b.min[ax] + GRID, b.max[ax] + step);   // pull the +face
  else b.min[ax] = Math.min(b.max[ax] - GRID, b.min[ax] - step);                    // pull the −face
  rebuild(); hud(true);
}
export function editorClick() {
  if (!ed.on) return;
  const a = ed._aim || aim();
  ed.sel = a.brush || null;   // select the brush under the crosshair (or deselect)
  hud(true);
}
function move(dx, dy, dz) { const b = ed.sel; if (!b) return; pushUndo(); for (let i = 0; i < 3; i++) { const d = [dx, dy, dz][i]; b.min[i] += d; b.max[i] += d; } rebuild(); }
function hideSurface() {
  if (!ed.texturedScene) { showHint('No textured surfaces'); return; }
  camera.getWorldPosition(_ro); camera.getWorldDirection(_rd); _rc.set(_ro, _rd); _rc.far = 6000;
  const hits = _rc.intersectObject(ed.texturedScene, true).filter(h => h.object.visible && h.object.name);
  if (!hits.length) { showHint('No surface under crosshair'); return; }
  const o = hits[0].object; o.visible = false; if (!ed.hides.includes(o.name)) ed.hides.push(o.name); showHint('Hid ' + o.name);
}

export function editorKey(code) {
  if (!ed.on) return false;
  const f = ed._aim && ed._aim.face, a = ed._aim;
  if (code === 'KeyB' || code === 'Enter') { pushUndo(); const nb = newBrush(a ? a.point.x : ed.cam.x, a ? a.point.y : ed.cam.y, a ? a.point.z : ed.cam.z); ed.brushes.push(nb); ed.sel = nb; rebuild(); hud(true); return true; }
  if (ed.sel) {
    if (code === 'KeyX' || code === 'Delete') { pushUndo(); const i = ed.brushes.indexOf(ed.sel); if (i >= 0) ed.brushes.splice(i, 1); ed.sel = null; rebuild(); hud(true); return true; }
    if (code === 'KeyC') { pushUndo(); const c = JSON.parse(JSON.stringify(ed.sel)); c.min[1] += 64; c.max[1] += 64; ed.brushes.push(c); ed.sel = c; rebuild(); return true; }
    if (code === 'KeyT') { pushUndo(); ed.sel.type = ed.sel.type === 'clip' ? 'solid' : 'clip'; rebuild(); hud(true); return true; }
    if (/^Digit[1-7]$/.test(code) && f) { pushUndo(); ed.sel.mats[f.axis * 2 + (f.sign > 0 ? 0 : 1)] = MAT_KEYS[+code.slice(5) - 1]; rebuild(); hud(true); return true; }
    if (code === 'KeyY') { pushUndo(); ed.sel.mats = Array(6).fill(ed.paint); rebuild(); hud(true); return true; }   // paint all faces
    if (code === 'KeyI') { move(0, 0, -GRID); return true; } if (code === 'KeyK') { move(0, 0, GRID); return true; }
    if (code === 'KeyJ') { move(-GRID, 0, 0); return true; } if (code === 'KeyL') { move(GRID, 0, 0); return true; }
    if (code === 'KeyU') { move(0, GRID, 0); return true; } if (code === 'KeyO') { move(0, -GRID, 0); return true; }
  }
  if (/^Digit[1-7]$/.test(code)) { ed.paint = MAT_KEYS[+code.slice(5) - 1]; hud(true); return true; }   // pick paint material (no face)
  if (code === 'KeyZ') { if (ed._undo.length) { ed.brushes = JSON.parse(ed._undo.pop()); ed.sel = null; rebuild(); hud(true); } return true; }
  if (code === 'KeyG') { GRID = GRID === 8 ? 16 : GRID === 16 ? 32 : 8; hud(true); return true; }   // cycle grid
  if (code === 'KeyH') { hideSurface(); return true; }
  if (code === 'KeyP') { save(); return true; }
  if (code === 'KeyM') { exportJSON(); return true; }
  return true;
}

/* ---- HUD ---- */
let _hud = null;
function hud(show) {
  if (!_hud) { _hud = document.createElement('div'); _hud.id = 'edHud'; _hud.style.cssText = 'position:fixed;top:54px;left:12px;z-index:60;background:rgba(12,16,22,.88);border:1px solid #2a3340;border-radius:8px;padding:10px 14px;font:12px "Trebuchet MS",sans-serif;color:#cfd6e2;line-height:1.65;pointer-events:none;max-width:340px;'; document.body.appendChild(_hud); }
  if (!ed.on) { _hud.style.display = 'none'; return; }
  _hud.style.display = 'block';
  const sw = (k) => '<span style="display:inline-block;width:9px;height:9px;border-radius:2px;vertical-align:middle;background:' + (k === 'nodraw' ? 'transparent;border:1px solid #889' : '#' + (MAT_DEF[k] ? MAT_DEF[k][0].toString(16).padStart(6, '0') : '888')) + '"></span>';
  _hud.innerHTML = '<b style="color:#ffd54a">🛠 BRUSH EDITOR</b> <span style="opacity:.6">~ exit · grid ' + GRID + 'u</span><br>'
    + '<span style="opacity:.8">WASD/RF</span> fly · <span style="opacity:.8">mouse</span> look · <span style="opacity:.8">B</span> new brush · <span style="opacity:.8">click</span> select<br>'
    + '<span style="opacity:.8">wheel</span> push/pull aimed face (Shift=slide) · <span style="opacity:.8">IJKL/UO</span> move<br>'
    + '<span style="opacity:.8">1-7</span> face material · <span style="opacity:.8">Y</span> paint all · <span style="opacity:.8">T</span> solid/clip · <span style="opacity:.8">C</span> dup · <span style="opacity:.8">X</span> del · <span style="opacity:.8">Z</span> undo<br>'
    + '<span style="opacity:.8">H</span> hide surface · <span style="opacity:.8">G</span> grid · <span style="opacity:.8">P</span> save · <span style="opacity:.8">M</span> export<br>'
    + 'Paint: ' + sw(ed.paint) + ' ' + ed.paint + ' &nbsp; Brushes: <b>' + ed.brushes.length + '</b>'
    + (ed.sel ? ' &nbsp; <span style="color:#ffd54a">selected ' + ed.sel.type + '</span>' : ' &nbsp;<span style="opacity:.5">none selected</span>');
}
