/* ============================== [BRUSH EDITOR] ==============================
   A Hammer-style 4-pane map editor over the deployed map. One 3D fly preview pane plus three
   2D orthographic GRID panes (top / front / side). You build axis-aligned BRUSHES by click-
   dragging a grid-snapped rectangle in any 2D pane; drag a brush body to move it, drag a face
   edge to stretch it, paint per-face materials, and drop invisible clip brushes as boundaries.
   Brushes are visible geometry AND collision. They save to localStorage (per map) and export to
   JSON to bake in. It patches/extends cs_office — it does not replace it.                       */
import * as THREE from 'three';
import { scene, camera, renderer } from './core.js';
import { GAME, keys } from './state.js';
import { meshBackend } from './sourcemap.js';
import { showHint } from './hud.js';

const SKEY = name => 'hvh_patches_' + (name || 'cs_office');
const GRIDS = [4, 8, 16, 32, 64];
const AX = { top: ['x', 'z'], front: ['x', 'y'], side: ['z', 'y'] };   // [horizontal, vertical] world axis per 2D pane
const IDX = { x: 0, y: 1, z: 2 };
const third = name => 'xyz'.split('').find(a => !AX[name].includes(a));

/* ---- materials (textured persp brushes) ---- */
const MAT_KEYS = ['concrete', 'brick', 'metal', 'wood', 'white', 'dark', 'nodraw'];
const MAT_DEF = { concrete: [0x9a9a92, .95, 0], brick: [0x8a4a38, .9, 0], metal: [0x6a6e74, .5, .65], wood: [0x7a5636, .85, 0], white: [0xd8d8d4, .9, 0], dark: [0x2a2d33, .8, .2] };
const matCache = {};
function getMat(k) {
  if (matCache[k]) return matCache[k];
  let m;
  if (k === 'nodraw') m = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  else { const [c, r, me] = MAT_DEF[k] || MAT_DEF.concrete; m = new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: me, side: THREE.DoubleSide }); }
  return matCache[k] = m;
}

const ed = {
  on: false, brushes: [], hides: [], texturedScene: null,
  group: null, overlay: null, edgeGroup: null, grids: {}, selBox: null, preview: null,
  persp: null, oc: {}, scratch: null, wireDim: null,
  cam: new THREE.Vector3(-200, 260, 360), yaw: 0, pitch: -0.5,
  ov: { top: { cu: 0, cv: 0, upp: 4 }, front: { cu: 0, cv: 96, upp: 4 }, side: { cu: 0, cv: 96, upp: 4 } },
  gi: 2, sel: null, paint: 'concrete', depth: { x: 0, y: 64, z: 0 }, hover: 'persp',
  drag: null, _undo: [], _vm: [],
};
export function isEditorOpen() { return ed.on; }
const GRID = () => GRIDS[ed.gi];
const snap = v => Math.round(v / GRID()) * GRID();

/* ---- collision + visible meshes + outline edges, all from the brush list ---- */
function rebuild() {
  meshBackend.setPatches(ed.brushes.map(b => ({ x: (b.min[0] + b.max[0]) / 2, y: (b.min[1] + b.max[1]) / 2, z: (b.min[2] + b.max[2]) / 2, w: b.max[0] - b.min[0], h: b.max[1] - b.min[1], d: b.max[2] - b.min[2], type: b.type })));
  for (const m of ed.group.children.slice()) { ed.group.remove(m); m.geometry.dispose(); }
  for (const b of ed.brushes) {
    const w = Math.max(1, b.max[0] - b.min[0]), h = Math.max(1, b.max[1] - b.min[1]), d = Math.max(1, b.max[2] - b.min[2]);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), b.type === 'clip' ? getMat('nodraw') : b.mats.map(getMat));
    m.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    m.castShadow = b.type !== 'clip'; m.receiveShadow = true; m.userData.brush = b;
    ed.group.add(m);
  }
  rebuildEdges();
}
function rebuildEdges() {
  for (const m of ed.edgeGroup.children.slice()) { ed.edgeGroup.remove(m); m.geometry.dispose(); }
  for (const b of ed.brushes) {
    const w = Math.max(1, b.max[0] - b.min[0]), h = Math.max(1, b.max[1] - b.min[1]), d = Math.max(1, b.max[2] - b.min[2]);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), new THREE.LineBasicMaterial({ color: b === ed.sel ? 0xffd54a : b.type === 'clip' ? 0x4aa0ff : 0x46e06a }));
    e.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    ed.edgeGroup.add(e);
  }
  if (ed.sel) { const b = ed.sel; ed.selBox.visible = true; ed.selBox.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2); ed.selBox.scale.set(Math.max(1, b.max[0] - b.min[0]), Math.max(1, b.max[1] - b.min[1]), Math.max(1, b.max[2] - b.min[2])); }
  else ed.selBox.visible = false;
}
function pushUndo() { ed._undo.push(JSON.stringify(ed.brushes)); if (ed._undo.length > 50) ed._undo.shift(); }

/* ---- persistence ---- */
export function loadPatches(mapName, texturedScene) {
  ed.texturedScene = texturedScene || ed.texturedScene;
  ensure();
  let data = null; try { data = JSON.parse(localStorage.getItem(SKEY(mapName)) || 'null'); } catch (e) {}
  ed.brushes = (data && data.brushes) || (data && data.patches || []).map(boxToBrush);
  ed.hides = (data && data.hides) || [];
  rebuild(); applyHides();
}
function boxToBrush(p) { return { min: [p.x - p.w / 2, p.y - p.h / 2, p.z - p.d / 2], max: [p.x + p.w / 2, p.y + p.h / 2, p.z + p.d / 2], mats: Array(6).fill('concrete'), type: p.type || 'solid' }; }
function save() { try { localStorage.setItem(SKEY(GAME.sourceMap), JSON.stringify({ brushes: ed.brushes, hides: ed.hides })); showHint('Saved ' + ed.brushes.length + ' brushes'); } catch (e) { showHint('Save failed: ' + e.message); } }
function exportJSON() { const j = JSON.stringify({ brushes: ed.brushes, hides: ed.hides }); console.log('=== MAP PATCHES (' + GAME.sourceMap + ') ===\n' + j); if (navigator.clipboard) navigator.clipboard.writeText(j).then(() => showHint('Brush JSON copied + logged')).catch(() => showHint('Logged to console')); else showHint('Logged to console'); }
function applyHides() { if (!ed.texturedScene) return; const s = new Set(ed.hides); ed.texturedScene.traverse(o => { if (o.isMesh && o.name && s.has(o.name)) o.visible = false; }); }

/* ---- build the scene objects (grids, overlay, cameras) once ---- */
const AXISCOL = { x: 0x9a4040, y: 0x408a40, z: 0x4060a0 };
function makeGrid(uAxis, vAxis) {
  const span = 8192, minor = 64, pos = [], col = [], c3 = new THREE.Color();
  const push = (u1, v1, u2, v2, hex) => { c3.setHex(hex); const p1 = [0, 0, 0], p2 = [0, 0, 0]; p1[IDX[uAxis]] = u1; p1[IDX[vAxis]] = v1; p2[IDX[uAxis]] = u2; p2[IDX[vAxis]] = v2; pos.push(...p1, ...p2); col.push(c3.r, c3.g, c3.b, c3.r, c3.g, c3.b); };
  for (let i = -span; i <= span; i += minor) {
    push(i, -span, i, span, i === 0 ? AXISCOL[vAxis] : (i % 512 === 0 ? 0x37475c : 0x1d2735));   // verticals (U const)
    push(-span, i, span, i, i === 0 ? AXISCOL[uAxis] : (i % 512 === 0 ? 0x37475c : 0x1d2735));   // horizontals (V const)
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const ls = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true })); ls.visible = false; ls.frustumCulled = false; return ls;
}
function ensure() {
  if (ed.group) return;
  ed.group = new THREE.Group(); scene.add(ed.group);
  ed.overlay = new THREE.Scene();
  ed.edgeGroup = new THREE.Group(); ed.overlay.add(ed.edgeGroup);
  ed.grids = { top: makeGrid('x', 'z'), front: makeGrid('x', 'y'), side: makeGrid('z', 'y') };
  for (const k in ed.grids) ed.overlay.add(ed.grids[k]);
  ed.selBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0.12, depthTest: false })); ed.selBox.visible = false; ed.overlay.add(ed.selBox);
  ed.preview = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffffff })); ed.preview.visible = false; ed.overlay.add(ed.preview);
  ed.persp = new THREE.PerspectiveCamera(70, 1, 1, 12000);
  ed.oc = { top: new THREE.OrthographicCamera(), front: new THREE.OrthographicCamera(), side: new THREE.OrthographicCamera() };
  ed.scratch = new THREE.OrthographicCamera();
  ed.wireDim = new THREE.MeshBasicMaterial({ color: 0x2f4860, wireframe: true });
}

/* ---- ortho camera placement + screen↔world ---- */
function configOrtho(cam, name, cu, cv, w, h) {
  const upp = ed.ov[name].upp, hu = upp * w / 2, hv = upp * h / 2;
  cam.left = -hu; cam.right = hu; cam.top = hv; cam.bottom = -hv; cam.near = 1; cam.far = 16000;
  if (name === 'top') { cam.position.set(cu, 7000, cv); cam.up.set(0, 0, -1); cam.lookAt(cu, 0, cv); }
  else if (name === 'front') { cam.position.set(cu, cv, 7000); cam.up.set(0, 1, 0); cam.lookAt(cu, cv, 0); }
  else { cam.position.set(7000, cv, cu); cam.up.set(0, 1, 0); cam.lookAt(0, cv, cu); }
  cam.updateProjectionMatrix(); cam.updateMatrixWorld();
}
function quadRect(name) { const hw = innerWidth / 2, hh = innerHeight / 2; return name === 'persp' ? [0, 0, hw, hh] : name === 'top' ? [hw, 0, hw, hh] : name === 'front' ? [0, hh, hw, hh] : [hw, hh, hw, hh]; }
function viewAt(mx, my) { const hw = innerWidth / 2, hh = innerHeight / 2; return my < hh ? (mx < hw ? 'persp' : 'top') : (mx < hw ? 'front' : 'side'); }
function ndc(name, mx, my) { const [qx, qy, qw, qh] = quadRect(name); return [((mx - qx) / qw) * 2 - 1, -(((my - qy) / qh) * 2 - 1)]; }
// world point under the cursor in a 2D pane → { u, v } on that pane's two axes (unsnapped)
function worldUV(name, mx, my, cu, cv) {
  const [qx, qy, qw, qh] = quadRect(name); const cam = ed.scratch; configOrtho(cam, name, cu, cv, qw, qh);
  const [nx, ny] = ndc(name, mx, my); const p = new THREE.Vector3(nx, ny, 0).unproject(cam);
  const [ua, va] = AX[name]; return { u: p[ua], v: p[va] };
}

/* ---- enter / exit ---- */
export function toggleEditor() { ed.on ? exit() : enter(); }
function enter() {
  if (!meshBackend.active) { showHint('Deploy cs_office first'); return; }
  ensure(); ed.on = true; ed._prevPhase = GAME.phase; GAME.phase = 'editor';
  ed._vm = camera.children.map(c => [c, c.visible]); for (const [c] of ed._vm) c.visible = false;   // hide the FP viewmodel
  // open the 3D preview looking where the player was, and position the camera NOW so the face raycast
  // works on the very first interaction (editorRender re-derives it each frame thereafter)
  ed.cam.copy(camera.position); const _d = new THREE.Vector3(); camera.getWorldDirection(_d);
  ed.yaw = Math.atan2(-_d.x, -_d.z); ed.pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(_d.y, -1, 1)), -1.5, 1.5);
  ed.persp.position.copy(ed.cam); ed.persp.rotation.set(ed.pitch, ed.yaw, 0, 'YXZ');
  ed.persp.aspect = innerWidth / innerHeight; ed.persp.updateProjectionMatrix(); ed.persp.updateMatrixWorld();
  document.exitPointerLock();
  const el = renderer.domElement;
  el.addEventListener('mousedown', onDown); addEventListener('mousemove', onMove); addEventListener('mouseup', onUp); el.addEventListener('wheel', onWheel, { passive: false });
  el.style.cursor = 'crosshair';
  rebuild(); hud(true);
}
function exit() {
  ed.on = false; GAME.phase = ed._prevPhase || 'live';
  for (const [c, v] of ed._vm) c.visible = v;
  const el = renderer.domElement;
  el.removeEventListener('mousedown', onDown); removeEventListener('mousemove', onMove); removeEventListener('mouseup', onUp); el.removeEventListener('wheel', onWheel);
  el.style.cursor = ''; ed.drag = null; ed.preview.visible = false; hud(false);
}

/* ---- per-frame: fly the 3D preview cam (only while hovering it) ---- */
export function editorUpdate() {
  if (!ed.on || ed.hover !== 'persp') return;
  const sp = (keys['ShiftLeft'] ? 34 : 14), cp = Math.cos(ed.pitch);
  const fwd = new THREE.Vector3(-Math.sin(ed.yaw) * cp, Math.sin(ed.pitch), -Math.cos(ed.yaw) * cp), right = new THREE.Vector3(Math.cos(ed.yaw), 0, -Math.sin(ed.yaw));
  if (keys['KeyW']) ed.cam.addScaledVector(fwd, sp); if (keys['KeyS']) ed.cam.addScaledVector(fwd, -sp);
  if (keys['KeyA']) ed.cam.addScaledVector(right, -sp); if (keys['KeyD']) ed.cam.addScaledVector(right, sp);
  if (keys['KeyR']) ed.cam.y += sp; if (keys['KeyF']) ed.cam.y -= sp;
}

/* ---- render the 4 panes ---- */
export function editorRender() {
  if (!ed.on) return;
  const hw = innerWidth / 2, hh = innerHeight / 2, prevAuto = renderer.autoClear;
  renderer.autoClear = false; renderer.setScissorTest(true);
  // TL: 3D textured preview (GL y is bottom-up, so the top row sits at y = hh)
  paneSetup(0, hh, hw, hh, 0x141922);
  ed.persp.aspect = hw / hh; ed.persp.updateProjectionMatrix();
  ed.persp.position.copy(ed.cam); ed.persp.rotation.set(ed.pitch, ed.yaw, 0, 'YXZ');
  scene.overrideMaterial = null; ed.group.visible = true; renderer.render(scene, ed.persp);
  // 2D ortho grid panes
  orthoPane('top', hw, hh, hw, hh); orthoPane('front', 0, 0, hw, hh); orthoPane('side', hw, 0, hw, hh);
  renderer.setScissorTest(false); renderer.autoClear = prevAuto;
  scene.overrideMaterial = null; for (const k in ed.grids) ed.grids[k].visible = false;
}
function paneSetup(x, y, w, h, clear) { renderer.setViewport(x, y, w, h); renderer.setScissor(x, y, w, h); renderer.setClearColor(clear, 1); renderer.clear(true, true, true); }
function orthoPane(name, x, y, w, h) {
  const v = ed.ov[name], cam = ed.oc[name]; configOrtho(cam, name, v.cu, v.cv, w, h);
  paneSetup(x, y, w, h, 0x0a0e14);
  ed.group.visible = false; scene.overrideMaterial = ed.wireDim; renderer.render(scene, cam); scene.overrideMaterial = null; ed.group.visible = true;   // map as dim wireframe
  for (const k in ed.grids) ed.grids[k].visible = (k === name); renderer.render(ed.overlay, cam);   // grid + bright brush edges on top
}

/* ============================== mouse ============================== */
function setHover(mx, my) { ed.hover = viewAt(mx, my); }
// which face-edge handle (if any) is near (u,v) in this pane → {axis, sign}; else null = body
function edgeHandle(name, b, u, v) {
  const [ua, va] = AX[name], m = 7 * ed.ov[name].upp, ui = IDX[ua], vi = IDX[va], out = [];
  if (Math.abs(u - b.min[ui]) < m) out.push({ axis: ui, sign: -1, d: Math.abs(u - b.min[ui]) });
  if (Math.abs(u - b.max[ui]) < m) out.push({ axis: ui, sign: 1, d: Math.abs(u - b.max[ui]) });
  if (Math.abs(v - b.min[vi]) < m) out.push({ axis: vi, sign: -1, d: Math.abs(v - b.min[vi]) });
  if (Math.abs(v - b.max[vi]) < m) out.push({ axis: vi, sign: 1, d: Math.abs(v - b.max[vi]) });
  out.sort((a, c) => a.d - c.d); return out[0] || null;
}
function brushAt(name, u, v) {   // topmost brush whose footprint contains (u,v) in this pane
  const [ua, va] = AX[name], ui = IDX[ua], vi = IDX[va];
  for (let i = ed.brushes.length - 1; i >= 0; i--) { const b = ed.brushes[i]; if (u >= b.min[ui] && u <= b.max[ui] && v >= b.min[vi] && v <= b.max[vi]) return b; }
  return null;
}
function onDown(e) {
  const name = viewAt(e.clientX, e.clientY); ed.hover = name;
  if (name === 'persp') {
    if (e.button === 2) { ed.drag = { kind: 'look' }; return; }
    if (e.button === 0) {
      const [nx, ny] = ndc('persp', e.clientX, e.clientY); _rc.setFromCamera({ x: nx, y: ny }, ed.persp);
      const bHit = _rc.intersectObjects(ed.group.children, false)[0];
      const mHit = ed.texturedScene ? _rc.intersectObject(ed.texturedScene, true).filter(h => h.object.visible && h.face)[0] : null;
      if (bHit && (!mHit || bHit.distance <= mHit.distance)) {                 // hit a brush → select + pull its face
        pushUndo(); const b = bHit.object.userData.brush; ed.sel = b; const fa = faceAxis(bHit);
        startFacePull(b, fa.ax, fa.sign, e.clientX, e.clientY); rebuildEdges(); hud(true);
      } else if (mHit) {                                                       // hit the MAP → make a flush brush and pull it out
        pushUndo(); const made = makeFaceBrush(mHit);
        if (made) { ed.sel = made.b; startFacePull(made.b, made.ax, made.sign, e.clientX, e.clientY); rebuild(); hud(true); }
        else { ed.sel = null; rebuildEdges(); }
      } else { ed.sel = null; rebuildEdges(); hud(true); }
    }
    return;
  }
  const v = ed.ov[name];
  if (e.button === 2 || e.button === 1) { ed.drag = { kind: 'pan', name, sx: e.clientX, sy: e.clientY, cu0: v.cu, cv0: v.cv }; e.preventDefault(); return; }
  const w = worldUV(name, e.clientX, e.clientY, v.cu, v.cv), hit = brushAt(name, w.u, w.v);
  if (hit) {
    ed.sel = hit; const eh = edgeHandle(name, hit, w.u, w.v);
    pushUndo();
    ed.drag = eh ? { kind: 'resize', name, b: hit, axis: eh.axis, sign: eh.sign } : { kind: 'move', name, b: hit, min0: hit.min.slice(), max0: hit.max.slice(), u0: snap(w.u), v0: snap(w.v) };
    rebuildEdges();
  } else { ed.sel = null; ed.drag = { kind: 'create', name, u0: snap(w.u), v0: snap(w.v), u1: snap(w.u), v1: snap(w.v) }; rebuildEdges(); }
}
function onMove(e) {
  setHover(e.clientX, e.clientY); const d = ed.drag; if (!d) return;
  if (d.kind === 'look') { ed.yaw -= e.movementX * 0.005; ed.pitch = THREE.MathUtils.clamp(ed.pitch - e.movementY * 0.005, -1.5, 1.5); return; }
  if (d.kind === 'facepull') {   // pull the face outward (+) / inward (−) along its normal by the on-screen drag
    const along = (e.clientX - d.sx) * d.dirU[0] + (e.clientY - d.sy) * d.dirU[1], amount = snap(along * d.wpp);
    if (d.sign > 0) d.b.max[d.ax] = Math.max(d.b.min[d.ax] + GRID(), d.start + amount);
    else d.b.min[d.ax] = Math.min(d.b.max[d.ax] - GRID(), d.start - amount);
    rebuild(); return;
  }
  const v = ed.ov[d.name];
  if (d.kind === 'pan') { const w0 = worldUV(d.name, d.sx, d.sy, d.cu0, d.cv0), w1 = worldUV(d.name, e.clientX, e.clientY, d.cu0, d.cv0); v.cu = d.cu0 - (w1.u - w0.u); v.cv = d.cv0 - (w1.v - w0.v); return; }
  const w = worldUV(d.name, e.clientX, e.clientY, v.cu, v.cv), [ua, va] = AX[d.name], ui = IDX[ua], vi = IDX[va];
  if (d.kind === 'create') { d.u1 = snap(w.u); d.v1 = snap(w.v); showPreview(d); }
  else if (d.kind === 'move') { const du = snap(w.u) - d.u0, dv = snap(w.v) - d.v0; d.b.min[ui] = d.min0[ui] + du; d.b.max[ui] = d.max0[ui] + du; d.b.min[vi] = d.min0[vi] + dv; d.b.max[vi] = d.max0[vi] + dv; rebuild(); }
  else if (d.kind === 'resize') { const val = snap(d.axis === ui ? w.u : (d.axis === vi ? w.v : w.u)); if (d.sign < 0) d.b.min[d.axis] = Math.min(val, d.b.max[d.axis] - GRID()); else d.b.max[d.axis] = Math.max(val, d.b.min[d.axis] + GRID()); rebuild(); }
}
function onUp(e) {
  const d = ed.drag; ed.drag = null; ed.preview.visible = false; if (!d) return;
  if (d.kind === 'create') {
    const [ua, va] = AX[d.name], ui = IDX[ua], vi = IDX[va], ti = IDX[third(d.name)];
    const u0 = Math.min(d.u0, d.u1), u1 = Math.max(d.u0, d.u1), v0 = Math.min(d.v0, d.v1), v1 = Math.max(d.v0, d.v1);
    if (u1 - u0 >= GRID() && v1 - v0 >= GRID()) {
      pushUndo(); const b = { min: [0, 0, 0], max: [0, 0, 0], mats: Array(6).fill(ed.paint), type: 'solid' };
      b.min[ui] = u0; b.max[ui] = u1; b.min[vi] = v0; b.max[vi] = v1;
      b.min[ti] = snap(ed.depth['xyz'[ti]] - 64); b.max[ti] = snap(ed.depth['xyz'[ti]] + 64);   // default depth on the 3rd axis
      ed.brushes.push(b); ed.sel = b;
    }
    rebuild(); hud(true);
  } else if (d.kind === 'move' || d.kind === 'resize' || d.kind === 'facepull') { ed.depth = { x: (d.b.min[0] + d.b.max[0]) / 2, y: (d.b.min[1] + d.b.max[1]) / 2, z: (d.b.min[2] + d.b.max[2]) / 2 }; hud(true); }
}
function onWheel(e) {
  const name = viewAt(e.clientX, e.clientY); e.preventDefault();
  if (name === 'persp') { const cp = Math.cos(ed.pitch); ed.cam.addScaledVector(new THREE.Vector3(-Math.sin(ed.yaw) * cp, Math.sin(ed.pitch), -Math.cos(ed.yaw) * cp), e.deltaY < 0 ? 80 : -80); return; }
  const v = ed.ov[name]; v.upp = THREE.MathUtils.clamp(v.upp * (e.deltaY < 0 ? 1 / 1.15 : 1.15), 0.25, 40);
}
function showPreview(d) {
  const [ua, va] = AX[d.name], ui = IDX[ua], vi = IDX[va], ti = IDX[third(d.name)];
  const u0 = Math.min(d.u0, d.u1), u1 = Math.max(d.u0, d.u1), v0 = Math.min(d.v0, d.v1), v1 = Math.max(d.v0, d.v1);
  const sz = [0, 0, 0], ct = [0, 0, 0]; sz[ui] = Math.max(1, u1 - u0); sz[vi] = Math.max(1, v1 - v0); sz[ti] = Math.max(1, snap(ed.depth['xyz'[ti]] + 64) - snap(ed.depth['xyz'[ti]] - 64));
  ct[ui] = (u0 + u1) / 2; ct[vi] = (v0 + v1) / 2; ct[ti] = ed.depth['xyz'[ti]];
  ed.preview.geometry.dispose(); ed.preview.geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(sz[0], sz[1], sz[2]));
  ed.preview.position.set(ct[0], ct[1], ct[2]); ed.preview.visible = true;
}
const _rc = new THREE.Raycaster();
function selectPersp(mx, my) {
  const [nx, ny] = ndc('persp', mx, my); _rc.setFromCamera({ x: nx, y: ny }, ed.persp);
  const hit = _rc.intersectObjects(ed.group.children, false)[0];
  ed.sel = hit ? hit.object.userData.brush : null; rebuildEdges(); hud(true);
}

/* ---- 3D FACE EDITING: click a surface, drag it out along its normal to extend/patch ---- */
function projectToPane(w) { const v = w.clone().project(ed.persp); return [(v.x * 0.5 + 0.5) * (innerWidth / 2), (1 - (v.y * 0.5 + 0.5)) * (innerHeight / 2)]; }
// which world axis (and outward sign) the hit face points along, and whether it's axis-aligned enough for an AABB brush
function faceAxis(hit) {
  const n = (hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0)).transformDirection(hit.object.matrixWorld).normalize();
  const ax = (Math.abs(n.x) >= Math.abs(n.y) && Math.abs(n.x) >= Math.abs(n.z)) ? 0 : (Math.abs(n.y) >= Math.abs(n.z) ? 1 : 2);
  return { ax, sign: n.getComponent(ax) < 0 ? -1 : 1, aligned: Math.abs(n.getComponent(ax)) > 0.9 };
}
// flood the coplanar triangles of the hit mesh near the hit point → the wall face's world rectangle
function coplanarFaceRect(hit) {
  const fa = faceAxis(hit); if (!fa.aligned) return null;
  const geo = hit.object.geometry, pos = geo.attributes && geo.attributes.position; if (!pos) return null;
  const index = geo.index, triCount = index ? index.count / 3 : pos.count / 3; if (triCount > 150000) return null;
  const ax = fa.ax, u = (ax + 1) % 3, v = (ax + 2) % 3, planeD = hit.point.getComponent(ax), M = hit.object.matrixWorld;
  const hu = hit.point.getComponent(u), hv = hit.point.getComponent(v), R = 1600;   // keep the face LOCAL (don't merge the whole floor)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), tn = new THREE.Vector3();
  const gi = (t, k) => index ? index.getX(t * 3 + k) : t * 3 + k;
  let minU = 1e9, maxU = -1e9, minV = 1e9, maxV = -1e9, found = 0;
  for (let t = 0; t < triCount; t++) {
    a.fromBufferAttribute(pos, gi(t, 0)).applyMatrix4(M); b.fromBufferAttribute(pos, gi(t, 1)).applyMatrix4(M); c.fromBufferAttribute(pos, gi(t, 2)).applyMatrix4(M);
    e1.subVectors(b, a); e2.subVectors(c, a); tn.crossVectors(e1, e2).normalize();
    if (Math.abs(tn.getComponent(ax)) < 0.9) continue;                                   // not parallel to our face
    if (Math.abs((a.getComponent(ax) + b.getComponent(ax) + c.getComponent(ax)) / 3 - planeD) > 6) continue;   // not coplanar
    const cu = (a.getComponent(u) + b.getComponent(u) + c.getComponent(u)) / 3, cv = (a.getComponent(v) + b.getComponent(v) + c.getComponent(v)) / 3;
    if (Math.abs(cu - hu) > R || Math.abs(cv - hv) > R) continue;                         // too far from the click
    for (const p of [a, b, c]) { const pu = p.getComponent(u), pv = p.getComponent(v); if (pu < minU) minU = pu; if (pu > maxU) maxU = pu; if (pv < minV) minV = pv; if (pv > maxV) maxV = pv; }
    found++;
  }
  return found ? { ax, sign: fa.sign, planeD, u, v, minU, maxU, minV, maxV } : null;
}
// create a thin brush flush with a map face (matching its coplanar rectangle), ready to be pulled out
function makeFaceBrush(hit) {
  const r = coplanarFaceRect(hit), fa = faceAxis(hit);
  if (!fa.aligned) { showHint('Angled face — AABB brushes only; use the 2D panes'); return null; }
  const ax = fa.ax, sign = fa.sign, u = (ax + 1) % 3, v = (ax + 2) % 3, P = hit.point, g = GRID();
  const b = { min: [0, 0, 0], max: [0, 0, 0], mats: Array(6).fill(ed.paint), type: 'solid' };
  if (r) { b.min[u] = snap(r.minU); b.max[u] = snap(r.maxU); b.min[v] = snap(r.minV); b.max[v] = snap(r.maxV); }
  else { b.min[u] = snap(P.getComponent(u) - 96); b.max[u] = snap(P.getComponent(u) + 96); b.min[v] = snap(P.getComponent(v) - 96); b.max[v] = snap(P.getComponent(v) + 96); }
  if (b.max[u] - b.min[u] < g) b.max[u] = b.min[u] + g;
  if (b.max[v] - b.min[v] < g) b.max[v] = b.min[v] + g;
  const d0 = snap((r ? r.planeD : P.getComponent(ax)));
  if (sign > 0) { b.max[ax] = d0; b.min[ax] = d0 - g; } else { b.min[ax] = d0; b.max[ax] = d0 + g; }   // thin slab flush to the wall
  ed.brushes.push(b); return { b, ax, sign };
}
// begin dragging a face (of a brush, or a freshly-made map-face brush) outward along its normal
function startFacePull(b, ax, sign, mx, my) {
  const start = sign > 0 ? b.max[ax] : b.min[ax];
  const C = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2); C.setComponent(ax, start);
  const N = new THREE.Vector3(); N.setComponent(ax, sign);
  const p0 = projectToPane(C), p1 = projectToPane(C.clone().addScaledVector(N, 64));
  let dirU = [0, -1], wpp = 1; const dx = p1[0] - p0[0], dy = p1[1] - p0[1], len = Math.hypot(dx, dy);
  if (len > 0.5) { dirU = [dx / len, dy / len]; wpp = 64 / len; }
  ed.drag = { kind: 'facepull', b, ax, sign, start, sx: mx, sy: my, dirU, wpp };
}

/* ============================== keyboard ============================== */
export function editorKey(code) {
  if (!ed.on) return false;
  if (code === 'KeyZ') { if (ed._undo.length) { ed.brushes = JSON.parse(ed._undo.pop()); ed.sel = null; rebuild(); hud(true); } return true; }
  if (code === 'KeyG') { ed.gi = (ed.gi + 1) % GRIDS.length; hud(true); return true; }
  if (code === 'KeyP') { save(); return true; }
  if (code === 'KeyM') { exportJSON(); return true; }
  if (code === 'KeyH') { hideSurface(); return true; }
  if (code === 'BracketLeft' || code === 'BracketRight') { const t = third(ed.hover === 'persp' ? 'top' : ed.hover); ed.depth[t] += (code === 'BracketRight' ? GRID() : -GRID()); hud(true); return true; }
  if (code === 'KeyB') { pushUndo(); const c = ed.depth; const b = { min: [snap(c.x - 32), snap(c.y), snap(c.z - 32)], max: [snap(c.x + 32), snap(c.y + 128), snap(c.z + 32)], mats: Array(6).fill(ed.paint), type: 'solid' }; ed.brushes.push(b); ed.sel = b; rebuild(); hud(true); return true; }
  if (ed.sel) {
    const b = ed.sel;
    if (code === 'KeyX' || code === 'Delete') { pushUndo(); const i = ed.brushes.indexOf(b); if (i >= 0) ed.brushes.splice(i, 1); ed.sel = null; rebuild(); hud(true); return true; }
    if (code === 'KeyT') { pushUndo(); b.type = b.type === 'clip' ? 'solid' : 'clip'; rebuild(); hud(true); return true; }
    if (code === 'KeyC') { pushUndo(); const c = JSON.parse(JSON.stringify(b)); c.min[1] += 128; c.max[1] += 128; ed.brushes.push(c); ed.sel = c; rebuild(); return true; }
    if (code === 'KeyY') { pushUndo(); b.mats = Array(6).fill(ed.paint); rebuild(); hud(true); return true; }
    if (/^Digit[1-7]$/.test(code)) { pushUndo(); ed.paint = MAT_KEYS[+code.slice(5) - 1]; b.mats = Array(6).fill(ed.paint); rebuild(); hud(true); return true; }
  } else if (/^Digit[1-7]$/.test(code)) { ed.paint = MAT_KEYS[+code.slice(5) - 1]; hud(true); return true; }
  return true;
}
function hideSurface() {
  if (ed.hover !== 'persp' || !ed.texturedScene) { showHint('Aim the 3D pane at a surface, press H'); return; }
  _rc.setFromCamera({ x: 0, y: 0 }, ed.persp);
  const hits = _rc.intersectObject(ed.texturedScene, true).filter(h => h.object.visible && h.object.name);
  if (!hits.length) { showHint('No surface centered in the 3D pane'); return; }
  const o = hits[0].object; o.visible = false; if (!ed.hides.includes(o.name)) ed.hides.push(o.name); showHint('Hid ' + o.name);
}

/* ---- HUD ---- */
let _hud = null;
function hud(show) {
  if (!_hud) { _hud = document.createElement('div'); _hud.id = 'edHud'; _hud.style.cssText = 'position:fixed;left:50%;top:6px;transform:translateX(-50%);z-index:60;background:rgba(12,16,22,.9);border:1px solid #2a3340;border-radius:7px;padding:6px 13px;font:11.5px "Trebuchet MS",sans-serif;color:#cfd6e2;pointer-events:none;white-space:nowrap;'; document.body.appendChild(_hud); }
  if (!ed.on) { _hud.style.display = 'none'; return; }
  _hud.style.display = 'block';
  const sw = k => '<span style="display:inline-block;width:9px;height:9px;border-radius:2px;vertical-align:middle;background:' + (k === 'nodraw' ? 'transparent;border:1px solid #889' : '#' + (MAT_DEF[k] ? MAT_DEF[k][0].toString(16).padStart(6, '0') : '888')) + '"></span>';
  _hud.innerHTML = '<b style="color:#ffd54a">🛠 BRUSH EDITOR</b> &nbsp;<span style="opacity:.85">2D pane:</span> drag=new brush · drag body=move · drag edge=stretch · RMB=pan · wheel=zoom &nbsp;|&nbsp; '
    + '<span style="opacity:.85">3D:</span> WASD/RF fly · RMB look · <b>drag a wall/face = pull it out to extend</b> &nbsp;|&nbsp; <b>1-7</b> material · <b>T</b> clip · <b>C</b> dup · <b>X</b> del · <b>Z</b> undo · <b>[ ]</b> depth · <b>G</b> grid ' + GRID() + ' · <b>H</b> hide · <b>P</b> save · <b>M</b> export · <b>~</b> exit'
    + '<br>paint ' + sw(ed.paint) + ' ' + ed.paint + ' · depth ' + Math.round(ed.depth.x) + ',' + Math.round(ed.depth.y) + ',' + Math.round(ed.depth.z) + ' · brushes <b>' + ed.brushes.length + '</b>' + (ed.sel ? ' · <span style="color:#ffd54a">selected ' + ed.sel.type + '</span>' : '');
}
