/* ============================== [PATCH EDITOR] ==============================
   An in-game tool to PATCH the imported map: drop solid collision boxes to fill holes / add
   walls, drop invisible "nodraw" clip boxes as out-of-bounds boundaries, and hide glitchy
   surfaces. Patches live in localStorage (per map) and re-apply on load; export the JSON to bake
   them in. It does NOT build maps — cs_office's geometry stays the source of truth.            */
import * as THREE from 'three';
import { scene, camera, renderer } from './core.js';
import { GAME, keys, refs } from './state.js';
import { meshBackend } from './sourcemap.js';
import { showHint } from './hud.js';

const $ = s => document.querySelector(s);
const KEY = name => 'hvh_patches_' + (name || 'cs_office');

const ed = {
  on: false, tool: 'solid',                 // solid | clip | hide
  size: { w: 120, h: 120, d: 120 },
  cam: new THREE.Vector3(), yaw: 0, pitch: 0,
  group: null, preview: null,               // scene objects
  patches: [], hides: [],                   // {x,y,z,w,h,d,type} ; mesh names
  meshMap: new Map(),                       // patch -> its scene mesh
  texturedScene: null,                      // for hide-surface raycasts
};
export function isEditorOpen() { return ed.on; }

const MAT = {
  solid: new THREE.MeshBasicMaterial({ color: 0x33dd55, transparent: true, opacity: 0.35, depthWrite: false }),
  clip: new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.28, depthWrite: false }),
};
function boxMesh(p) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, p.d), MAT[p.type] || MAT.solid);
  m.position.set(p.x, p.y, p.z); m.renderOrder = 998; return m;
}
function rebuild() {
  meshBackend.setPatches(ed.patches);
  if (ed.group) { for (const m of ed.meshMap.values()) ed.group.remove(m); }
  ed.meshMap.clear();
  for (const p of ed.patches) { const m = boxMesh(p); ed.group.add(m); ed.meshMap.set(p, m); }
}

/* ---- persistence ---- */
export function loadPatches(mapName, texturedScene) {
  ed.texturedScene = texturedScene || ed.texturedScene;
  let data = null; try { data = JSON.parse(localStorage.getItem(KEY(mapName)) || 'null'); } catch (e) {}
  ed.patches = (data && data.patches) || [];
  ed.hides = (data && data.hides) || [];
  meshBackend.setPatches(ed.patches);
  applyHides();
}
function save() {
  try { localStorage.setItem(KEY(GAME.sourceMap), JSON.stringify({ patches: ed.patches, hides: ed.hides })); showHint('Patches saved (' + ed.patches.length + ' boxes, ' + ed.hides.length + ' hidden)'); }
  catch (e) { showHint('Save failed: ' + e.message); }
}
function exportJSON() {
  const json = JSON.stringify({ patches: ed.patches, hides: ed.hides });
  console.log('=== MAP PATCHES (' + GAME.sourceMap + ') ===\n' + json);
  navigator.clipboard && navigator.clipboard.writeText(json).then(() => showHint('Patch JSON copied to clipboard + logged to console')).catch(() => showHint('Patch JSON logged to console'));
}
function applyHides() {
  if (!ed.texturedScene) return;
  const set = new Set(ed.hides);
  ed.texturedScene.traverse(o => { if (o.isMesh && o.name && set.has(o.name)) o.visible = false; });
}

/* ---- the aim ray (camera centre) against the collision hull ---- */
const _ro = new THREE.Vector3(), _rd = new THREE.Vector3(), _rc = new THREE.Raycaster();
function aimHit() {
  camera.getWorldPosition(_ro); camera.getWorldDirection(_rd);
  if (meshBackend.bvh) {
    let h = meshBackend.bvh.raycast(_ro.x, _ro.y, _ro.z, _rd.x, _rd.y, _rd.z, 6000);
    if (meshBackend.patchBvh) { const p = meshBackend.patchBvh.raycast(_ro.x, _ro.y, _ro.z, _rd.x, _rd.y, _rd.z, 6000); if (p && (!h || p.t < h.t)) h = p; }
    if (h) return new THREE.Vector3(_ro.x + _rd.x * h.t, _ro.y + _rd.y * h.t, _ro.z + _rd.z * h.t);
  }
  return _ro.clone().add(_rd.clone().multiplyScalar(300));   // nothing hit → 300u ahead
}

/* ---- enter / exit ---- */
export function toggleEditor() {
  ed.on ? exit() : enter();
}
function enter() {
  if (!meshBackend.active) { showHint('Editor needs the cs_office map deployed'); return; }
  ed.on = true; ed._prevPhase = GAME.phase; GAME.phase = 'editor';
  if (!ed.group) { ed.group = new THREE.Group(); scene.add(ed.group); }
  if (!ed.preview) { ed.preview = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffee44, wireframe: true })); ed.preview.renderOrder = 999; scene.add(ed.preview); }
  ed.preview.visible = true;
  for (const m of ed.meshMap.values()) m.visible = true;
  ed.cam.copy(camera.position); camera.getWorldDirection(_rd); ed.yaw = Math.atan2(-_rd.x, -_rd.z); ed.pitch = Math.asin(THREE.MathUtils.clamp(_rd.y, -1, 1));
  rebuild();
  document.exitPointerLock();
  renderer.domElement.requestPointerLock();
  hud(true);
}
function exit() {
  ed.on = false; GAME.phase = ed._prevPhase || 'live';
  if (ed.preview) ed.preview.visible = false;
  for (const m of ed.meshMap.values()) m.visible = false;   // boxes are editor-only visuals; collision stays
  hud(false);
}

/* ---- per-frame update (called from the main loop while editor is open) ---- */
export function editorUpdate() {
  if (!ed.on) return;
  const sp = (keys['ShiftLeft'] ? 26 : 11), cp = Math.cos(ed.pitch);
  const fwd = new THREE.Vector3(-Math.sin(ed.yaw) * cp, Math.sin(ed.pitch), -Math.cos(ed.yaw) * cp);
  const right = new THREE.Vector3(Math.cos(ed.yaw), 0, -Math.sin(ed.yaw));
  if (keys['KeyW']) ed.cam.addScaledVector(fwd, sp);
  if (keys['KeyS']) ed.cam.addScaledVector(fwd, -sp);
  if (keys['KeyA']) ed.cam.addScaledVector(right, -sp);
  if (keys['KeyD']) ed.cam.addScaledVector(right, sp);
  if (keys['KeyE']) ed.cam.y += sp; if (keys['KeyQ']) ed.cam.y -= sp;
  camera.position.copy(ed.cam); camera.rotation.set(ed.pitch, ed.yaw, 0, 'YXZ');
  if (ed.preview) {
    const p = aimHit();
    ed.preview.visible = ed.tool !== 'hide';
    ed.preview.position.copy(p); ed.preview.scale.set(ed.size.w, ed.size.h, ed.size.d);
    ed.preview.material.color.setHex(ed.tool === 'clip' ? 0x4488ff : 0xffee44);
  }
}
export function editorMouse(dx, dy) {
  if (!ed.on) return; const s = 0.0022;
  ed.yaw -= dx * s; ed.pitch = THREE.MathUtils.clamp(ed.pitch - dy * s, -1.5, 1.5);
}
export function editorWheel(delta) {
  if (!ed.on) return; const f = delta < 0 ? 1.12 : 1 / 1.12;
  if (keys['ShiftLeft']) ed.size.h = Math.max(8, ed.size.h * f);
  else { ed.size.w = Math.max(8, ed.size.w * f); ed.size.d = Math.max(8, ed.size.d * f); }
  hud(true);
}
export function editorClick() {
  if (!ed.on) return;
  if (ed.tool === 'hide') { hideUnderCrosshair(); return; }
  const p = aimHit();
  const box = { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), w: Math.round(ed.size.w), h: Math.round(ed.size.h), d: Math.round(ed.size.d), type: ed.tool };
  ed.patches.push(box); rebuild(); hud(true);
}
function deleteNearest() {
  if (!ed.patches.length) return;
  const p = aimHit(); let bi = -1, bd = 1e18;
  ed.patches.forEach((b, i) => { const dx = b.x - p.x, dy = b.y - p.y, dz = b.z - p.z, dd = dx * dx + dy * dy + dz * dz; if (dd < bd) { bd = dd; bi = i; } });
  if (bi >= 0) { ed.patches.splice(bi, 1); rebuild(); hud(true); }
}
function hideUnderCrosshair() {
  if (!ed.texturedScene) { showHint('No textured scene to hide'); return; }
  camera.getWorldPosition(_ro); camera.getWorldDirection(_rd);
  _rc.set(_ro, _rd); _rc.far = 6000;
  const hits = _rc.intersectObject(ed.texturedScene, true).filter(h => h.object.visible && h.object.name);
  if (!hits.length) { showHint('No surface under crosshair'); return; }
  const o = hits[0].object; o.visible = false; if (!ed.hides.includes(o.name)) ed.hides.push(o.name);
  showHint('Hid surface: ' + o.name);
}

/* ---- input from main.js keydown while editor is open ---- */
export function editorKey(code) {
  if (!ed.on) return false;
  if (code === 'Digit1') { ed.tool = 'solid'; hud(true); return true; }
  if (code === 'Digit2') { ed.tool = 'clip'; hud(true); return true; }
  if (code === 'Digit3') { ed.tool = 'hide'; hud(true); return true; }
  if (code === 'KeyX' || code === 'Delete') { deleteNearest(); return true; }
  if (code === 'KeyZ') { ed.patches.pop(); rebuild(); hud(true); return true; }   // undo last box
  if (code === 'KeyF') { save(); return true; }
  if (code === 'KeyG') { exportJSON(); return true; }
  return true;   // editor swallows other keys while open (except the toggle)
}

/* ---- HUD overlay ---- */
let _hud = null;
function hud(show) {
  if (!_hud) { _hud = document.createElement('div'); _hud.id = 'edHud'; _hud.style.cssText = 'position:fixed;top:54px;left:12px;z-index:60;background:rgba(12,16,22,.86);border:1px solid #2a3340;border-radius:8px;padding:10px 14px;font:12px "Trebuchet MS",sans-serif;color:#cfd6e2;line-height:1.7;pointer-events:none;max-width:320px;'; document.body.appendChild(_hud); }
  if (!ed.on) { _hud.style.display = 'none'; return; }
  _hud.style.display = 'block';
  const t = ed.tool;
  _hud.innerHTML = '<b style="color:#ffd54a">🛠 MAP PATCH EDITOR</b> &nbsp;<span style="opacity:.6">~ to exit</span><br>'
    + 'Tool: <b style="color:' + (t === 'clip' ? '#4488ff' : t === 'hide' ? '#ff7aa2' : '#33dd55') + '">' + (t === 'solid' ? 'SOLID box (fill holes / walls)' : t === 'clip' ? 'CLIP box (invisible boundary)' : 'HIDE surface') + '</b><br>'
    + '<span style="opacity:.8">1</span> solid · <span style="opacity:.8">2</span> clip · <span style="opacity:.8">3</span> hide-surface<br>'
    + '<span style="opacity:.8">WASD/QE</span> fly · <span style="opacity:.8">mouse</span> look · <span style="opacity:.8">wheel</span> size (Shift=height)<br>'
    + '<span style="opacity:.8">Click</span> place/hide · <span style="opacity:.8">X</span> delete nearest · <span style="opacity:.8">Z</span> undo<br>'
    + '<span style="opacity:.8">F</span> save · <span style="opacity:.8">G</span> export JSON<br>'
    + 'Box: ' + Math.round(ed.size.w) + '×' + Math.round(ed.size.h) + '×' + Math.round(ed.size.d) + ' &nbsp; Patches: <b>' + ed.patches.length + '</b> &nbsp; Hidden: <b>' + ed.hides.length + '</b>';
}
