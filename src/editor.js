/* ============================== [EDITOR] ==============================
   Admin Map Builder — a top-down level editor.  Draw/move/delete walls,
   drop props, place CT/T spawns, hostages and rescue zones, then Play to
   test.  Maps save to localStorage and export/import as JSON.  buildCustomMap
   turns the data into geometry + an auto grid nav graph.                    */
import { PROP_TYPES, WALL_MATERIALS, blankEditorMap, saveCustomMap, listMaps, loadSavedMap, deleteSavedMap } from './map.js';
import { GAME } from './state.js';

const $ = s => document.querySelector(s);
let deployHandler = null;
export function setDeployHandler(fn) { deployHandler = fn; }

const ed = {
  map: null, tool: 'wall', propType: 'crate', wallMat: 'wall', wallHeight: 230,
  cam: { x: 0, z: 0, zoom: 0.16 }, drag: null, pan: null, selected: null, snap: 25, running: false,
};
let canvas, ctx;

const TOOLS = [
  ['select', '⬚ Select'], ['wall', '▭ Wall'], ['prop', '🪑 Prop'],
  ['ctspawn', '🔵 CT Spawn'], ['tspawn', '🟠 T Spawn'], ['hostage', '🧍 Hostage'],
  ['rescue', '🟢 Rescue'], ['erase', '🧽 Erase'], ['pan', '✋ Pan'],
];

export function openEditor() {
  GAME.phase = "editor";
  document.exitPointerLock();
  $("#startPanel").classList.remove("show");
  $("#editorPanel").classList.add("show");
  if (!ed.map) ed.map = blankEditorMap();
  canvas = $("#edCanvas"); ctx = canvas.getContext('2d');
  bindCanvas();
  fitView(); buildToolbar(); buildSide();
  ed.running = true; requestAnimationFrame(edLoop);
}
export function closeEditor() {
  $("#editorPanel").classList.remove("show"); ed.running = false;
  GAME.phase = "warmup"; $("#startPanel").classList.add("show");
}
export function isEditorOpen() { return ed.running; }

function fitView() {
  const b = ed.map.bounds;
  resizeCanvas();
  const W = canvas.width, H = canvas.height;
  const zx = (W - 60) / (b.maxX - b.minX), zz = (H - 60) / (b.maxZ - b.minZ);
  ed.cam.zoom = Math.min(zx, zz);
  ed.cam.x = (b.minX + b.maxX) / 2; ed.cam.z = (b.minZ + b.maxZ) / 2;
}
function resizeCanvas() {
  const host = $("#edMain"); const r = host.getBoundingClientRect();
  canvas.width = Math.max(200, Math.floor(r.width - 230)); canvas.height = Math.max(200, Math.floor(r.height - 4));
}
const sx = x => (x - ed.cam.x) * ed.cam.zoom + canvas.width / 2;
const sz = z => (z - ed.cam.z) * ed.cam.zoom + canvas.height / 2;
const wx = px => (px - canvas.width / 2) / ed.cam.zoom + ed.cam.x;
const wz = py => (py - canvas.height / 2) / ed.cam.zoom + ed.cam.z;
const snap = v => ed.snap ? Math.round(v / ed.snap) * ed.snap : Math.round(v);

/* ---------- toolbar / side ---------- */
function buildToolbar() {
  const tb = $("#edTools"); tb.innerHTML = "";
  for (const [id, label] of TOOLS) {
    const b = document.createElement('button'); b.className = 'edbtn' + (ed.tool === id ? ' on' : ''); b.textContent = label;
    b.onclick = () => { ed.tool = id; ed.selected = null; buildToolbar(); buildSide(); }; tb.appendChild(b);
  }
}
function actionBtn(label, fn) { const b = document.createElement('button'); b.className = 'edbtn act'; b.textContent = label; b.onclick = fn; return b; }
function buildSide() {
  const side = $("#edProps"); side.innerHTML = "";
  const h = (t) => { const d = document.createElement('div'); d.className = 'edh'; d.textContent = t; side.appendChild(d); };

  if (ed.tool === 'prop') {
    h("Prop type");
    const grid = document.createElement('div'); grid.className = 'edpalette';
    for (const k in PROP_TYPES) { const b = document.createElement('button'); b.className = 'edbtn' + (ed.propType === k ? ' on' : ''); b.textContent = PROP_TYPES[k].label; b.onclick = () => { ed.propType = k; buildSide(); }; grid.appendChild(b); }
    side.appendChild(grid);
  }
  if (ed.tool === 'wall' || (ed.selected && ed.selected.kind === 'wall')) {
    h("Wall material");
    const matSel = document.createElement('select'); matSel.className = 'edsel';
    for (const k in WALL_MATERIALS) { const o = document.createElement('option'); o.value = k; o.textContent = WALL_MATERIALS[k].label; matSel.appendChild(o); }
    matSel.value = (ed.selected && ed.selected.kind === 'wall') ? ed.map.walls[ed.selected.i].mat : ed.wallMat;
    matSel.onchange = () => { if (ed.selected && ed.selected.kind === 'wall') ed.map.walls[ed.selected.i].mat = matSel.value; else ed.wallMat = matSel.value; };
    side.appendChild(matSel);
    h("Wall height");
    const hr = document.createElement('input'); hr.type = 'range'; hr.min = 40; hr.max = 320; hr.step = 10;
    hr.value = (ed.selected && ed.selected.kind === 'wall') ? ed.map.walls[ed.selected.i].h : ed.wallHeight;
    const hv = document.createElement('span'); hv.className = 'edval'; hv.textContent = hr.value;
    hr.oninput = () => { hv.textContent = hr.value; if (ed.selected && ed.selected.kind === 'wall') ed.map.walls[ed.selected.i].h = +hr.value; else ed.wallHeight = +hr.value; };
    side.appendChild(hr); side.appendChild(hv);
  }
  if (ed.selected) {
    h("Selected: " + ed.selected.kind);
    side.appendChild(actionBtn('🗑 Delete (Del)', () => { deleteSelected(); buildSide(); }));
  }
  h("Snap");
  const sn = document.createElement('select'); sn.className = 'edsel';
  for (const g of [0, 10, 25, 50, 100]) { const o = document.createElement('option'); o.value = g; o.textContent = g ? g + 'u grid' : 'off'; sn.appendChild(o); }
  sn.value = ed.snap; sn.onchange = () => ed.snap = +sn.value; side.appendChild(sn);

  // IO actions
  const io = $("#edIO"); io.innerHTML = "";
  io.appendChild(actionBtn('🆕 New', () => { if (confirm('Discard current map?')) { ed.map = blankEditorMap(); ed.selected = null; fitView(); buildSide(); } }));
  io.appendChild(actionBtn('💾 Save', saveMap));
  io.appendChild(actionBtn('📂 Load', loadMapPrompt));
  io.appendChild(actionBtn('⬇ Export', exportMap));
  io.appendChild(actionBtn('⬆ Import', importMap));
  io.appendChild(actionBtn('▶ PLAY', playMap));
  io.appendChild(actionBtn('⮌ Back', closeEditor));

  $("#edHelp").innerHTML = `<b>${counts()}</b><br>Drag = draw/move · Wheel = zoom · Space-drag or Pan tool = pan · Del = delete selection.`;
}
function counts() {
  const m = ed.map;
  return `${m.walls.length} walls · ${m.props.length} props · ${m.ctSpawns.length} CT · ${m.tSpawns.length} T · ${m.hostages.length} hostages · ${m.rescueZones.length} rescue`;
}

/* ---------- canvas interaction ---------- */
function bindCanvas() {
  if (canvas._bound) return; canvas._bound = true;
  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
}
let spaceDown = false;
window.addEventListener('keydown', e => {
  if (!ed.running) return;
  if (e.code === 'Space') spaceDown = true;
  if (e.code === 'Delete' || e.code === 'Backspace') { deleteSelected(); buildSide(); e.preventDefault(); }
  const map = { KeyV: 'select', KeyB: 'wall', KeyP: 'prop', KeyE: 'erase', KeyH: 'pan' };
  if (map[e.code]) { ed.tool = map[e.code]; ed.selected = null; buildToolbar(); buildSide(); }
});
window.addEventListener('keyup', e => { if (e.code === 'Space') spaceDown = false; });

function evtPos(e) { const r = canvas.getBoundingClientRect(); return { px: e.clientX - r.left, py: e.clientY - r.top }; }
function onDown(e) {
  const { px, py } = evtPos(e); const x = wx(px), z = wz(py);
  if (ed.tool === 'pan' || spaceDown || e.button === 1 || e.button === 2) { ed.pan = { px, py, camx: ed.cam.x, camz: ed.cam.z }; return; }
  if (ed.tool === 'wall') { ed.drag = { kind: 'wall', x0: snap(x), z0: snap(z), x1: snap(x), z1: snap(z) }; return; }
  if (ed.tool === 'prop') { ed.map.props.push({ type: ed.propType, x: snap(x), z: snap(z) }); buildSide(); return; }
  if (ed.tool === 'ctspawn') { ed.map.ctSpawns.push({ x: snap(x), z: snap(z) }); buildSide(); return; }
  if (ed.tool === 'tspawn') { ed.map.tSpawns.push({ x: snap(x), z: snap(z) }); buildSide(); return; }
  if (ed.tool === 'hostage') { ed.map.hostages.push({ x: snap(x), z: snap(z) }); buildSide(); return; }
  if (ed.tool === 'rescue') { ed.map.rescueZones.push({ x: snap(x), z: snap(z), r: 160 }); buildSide(); return; }
  if (ed.tool === 'erase') { const hit = hitTest(x, z); if (hit) { removeAt(hit); buildSide(); } return; }
  if (ed.tool === 'select') {
    const hit = hitTest(x, z); ed.selected = hit;
    if (hit) ed.drag = { kind: 'move', sel: hit, ox: snap(x), oz: snap(z), start: snapshot(hit) };
    buildSide();
  }
}
function onMove(e) {
  const { px, py } = evtPos(e);
  if (ed.pan) { ed.cam.x = ed.pan.camx - (px - ed.pan.px) / ed.cam.zoom; ed.cam.z = ed.pan.camz - (py - ed.pan.py) / ed.cam.zoom; return; }
  const x = wx(px), z = wz(py);
  if (!ed.drag) return;
  if (ed.drag.kind === 'wall') { ed.drag.x1 = snap(x); ed.drag.z1 = snap(z); }
  else if (ed.drag.kind === 'move') moveSelected(ed.drag, snap(x), snap(z));
}
function onUp() {
  if (ed.drag && ed.drag.kind === 'wall') {
    const d = ed.drag; const minX = Math.min(d.x0, d.x1), maxX = Math.max(d.x0, d.x1), minZ = Math.min(d.z0, d.z1), maxZ = Math.max(d.z0, d.z1);
    if (maxX - minX >= 8 && maxZ - minZ >= 8) { ed.map.walls.push({ minX, maxX, minZ, maxZ, h: ed.wallHeight, mat: ed.wallMat }); buildSide(); }
  }
  ed.drag = null; ed.pan = null;
}
function onWheel(e) {
  e.preventDefault();
  const { px, py } = evtPos(e); const bx = wx(px), bz = wz(py);
  const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  ed.cam.zoom = Math.max(0.03, Math.min(2, ed.cam.zoom * f));
  ed.cam.x = bx - (px - canvas.width / 2) / ed.cam.zoom;
  ed.cam.z = bz - (py - canvas.height / 2) / ed.cam.zoom;
}

/* ---------- selection helpers ---------- */
function hitTest(x, z) {
  const m = ed.map; const pr = 22 / ed.cam.zoom;
  for (let i = m.props.length - 1; i >= 0; i--) { const p = m.props[i]; if (Math.hypot(p.x - x, p.z - z) < pr) return { kind: 'prop', i }; }
  for (let i = m.rescueZones.length - 1; i >= 0; i--) { const r = m.rescueZones[i]; if (Math.hypot(r.x - x, r.z - z) < r.r) return { kind: 'rescue', i }; }
  for (let i = m.hostages.length - 1; i >= 0; i--) { const p = m.hostages[i]; if (Math.hypot(p.x - x, p.z - z) < pr) return { kind: 'hostage', i }; }
  for (let i = m.ctSpawns.length - 1; i >= 0; i--) { const p = m.ctSpawns[i]; if (Math.hypot(p.x - x, p.z - z) < pr) return { kind: 'ctspawn', i }; }
  for (let i = m.tSpawns.length - 1; i >= 0; i--) { const p = m.tSpawns[i]; if (Math.hypot(p.x - x, p.z - z) < pr) return { kind: 'tspawn', i }; }
  for (let i = m.walls.length - 1; i >= 0; i--) { const w = m.walls[i]; if (x >= w.minX && x <= w.maxX && z >= w.minZ && z <= w.maxZ) return { kind: 'wall', i }; }
  return null;
}
function arrOf(kind) { const m = ed.map; return { prop: m.props, rescue: m.rescueZones, hostage: m.hostages, ctspawn: m.ctSpawns, tspawn: m.tSpawns, wall: m.walls }[kind]; }
function removeAt(sel) { arrOf(sel.kind).splice(sel.i, 1); ed.selected = null; }
function deleteSelected() { if (ed.selected) removeAt(ed.selected); }
function snapshot(sel) { return JSON.parse(JSON.stringify(arrOf(sel.kind)[sel.i])); }
function moveSelected(drag, x, z) {
  const o = arrOf(drag.sel.kind)[drag.sel.i]; if (!o) return; const s = drag.start;
  if (drag.sel.kind === 'wall') { const dx = x - drag.ox, dz = z - drag.oz; o.minX = s.minX + dx; o.maxX = s.maxX + dx; o.minZ = s.minZ + dz; o.maxZ = s.maxZ + dz; }
  else { o.x = x; o.z = z; }
}

/* ---------- IO ---------- */
function saveMap() { const n = prompt("Save map as:", ed.map.name || "mymap"); if (!n) return; ed.map.name = n; saveCustomMap(n, ed.map); flash("Saved “" + n + "”"); buildSide(); }
function loadMapPrompt() {
  const all = listMaps(); const names = Object.keys(all);
  if (!names.length) { alert("No saved maps yet."); return; }
  const n = prompt("Load which map?\n\n" + names.join("\n"), names[0]); if (!n) return;
  const m = loadSavedMap(n); if (!m) { alert("Not found: " + n); return; }
  ed.map = normalize(m); ed.selected = null; fitView(); buildSide(); flash("Loaded “" + n + "”");
}
function exportMap() {
  const json = JSON.stringify(ed.map, null, 2);
  $("#edJson").value = json;
  try { const blob = new Blob([json], { type: "application/json" }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (ed.map.name || "map") + ".json"; a.click(); } catch (e) {}
  flash("Exported (also in the text box)");
}
function importMap() {
  const t = $("#edJson").value.trim(); if (!t) { alert("Paste map JSON into the text box first."); return; }
  try { ed.map = normalize(JSON.parse(t)); ed.selected = null; fitView(); buildSide(); flash("Imported"); } catch (e) { alert("Invalid JSON: " + e.message); }
}
function normalize(m) {
  return {
    name: m.name || "untitled", bounds: m.bounds || { minX: -1100, maxX: 1100, minZ: -900, maxZ: 900 },
    walls: m.walls || [], props: m.props || [], ctSpawns: m.ctSpawns || [], tSpawns: m.tSpawns || [],
    hostages: m.hostages || [], rescueZones: m.rescueZones || [],
  };
}
function playMap() {
  if (!ed.map.ctSpawns.length || !ed.map.tSpawns.length) { alert("Add at least one CT spawn and one T spawn before playing."); return; }
  if (!deployHandler) { alert("Game not ready."); return; }
  $("#editorPanel").classList.remove("show"); ed.running = false;
  deployHandler(normalize(JSON.parse(JSON.stringify(ed.map))));
}
function flash(t) { const h = $("#edFlash"); if (!h) return; h.textContent = t; h.style.opacity = "1"; clearTimeout(flash._t); flash._t = setTimeout(() => h.style.opacity = "0", 1800); }

/* ---------- draw ---------- */
function edLoop() { if (!ed.running) return; draw(); requestAnimationFrame(edLoop); }
function draw() {
  if (!ctx) return;
  const W = canvas.width, H = canvas.height; const m = ed.map;
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = "#0c1016"; ctx.fillRect(0, 0, W, H);
  // grid
  if (ed.snap && ed.cam.zoom > 0.06) {
    ctx.strokeStyle = "rgba(255,255,255,.04)"; ctx.lineWidth = 1; const g = ed.snap;
    const x0 = Math.floor(wx(0) / g) * g, x1 = wx(W), z0 = Math.floor(wz(0) / g) * g, z1 = wz(H);
    for (let x = x0; x < x1; x += g) { ctx.beginPath(); ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), H); ctx.stroke(); }
    for (let z = z0; z < z1; z += g) { ctx.beginPath(); ctx.moveTo(0, sz(z)); ctx.lineTo(W, sz(z)); ctx.stroke(); }
  }
  // bounds
  const b = m.bounds; ctx.strokeStyle = "#3a4658"; ctx.lineWidth = 2; ctx.strokeRect(sx(b.minX), sz(b.minZ), (b.maxX - b.minX) * ed.cam.zoom, (b.maxZ - b.minZ) * ed.cam.zoom);
  // walls
  const wallColor = { wall: "#8a8378", concrete: "#6c7178", metal: "#9aa3ae", wood: "#9a6a3a", glass: "rgba(150,210,235,.4)" };
  m.walls.forEach((w, i) => {
    ctx.fillStyle = wallColor[w.mat] || "#8a8378"; ctx.fillRect(sx(w.minX), sz(w.minZ), (w.maxX - w.minX) * ed.cam.zoom, (w.maxZ - w.minZ) * ed.cam.zoom);
    if (ed.selected && ed.selected.kind === 'wall' && ed.selected.i === i) { ctx.strokeStyle = "#ffd86b"; ctx.lineWidth = 2; ctx.strokeRect(sx(w.minX), sz(w.minZ), (w.maxX - w.minX) * ed.cam.zoom, (w.maxZ - w.minZ) * ed.cam.zoom); }
  });
  // rescue zones
  m.rescueZones.forEach(r => { ctx.fillStyle = "rgba(60,200,90,.18)"; ctx.strokeStyle = "#3cc85a"; ctx.beginPath(); ctx.arc(sx(r.x), sz(r.z), r.r * ed.cam.zoom, 0, 7); ctx.fill(); ctx.stroke(); });
  // props
  m.props.forEach(p => dot(sx(p.x), sz(p.z), 7, "#caa46a", (PROP_TYPES[p.type] ? PROP_TYPES[p.type].label[0] : "?")));
  // spawns + hostages
  m.ctSpawns.forEach(p => dot(sx(p.x), sz(p.z), 7, "#7db9ff", "C"));
  m.tSpawns.forEach(p => dot(sx(p.x), sz(p.z), 7, "#ffce6b", "T"));
  m.hostages.forEach(p => dot(sx(p.x), sz(p.z), 7, "#ff8a3c", "H"));
  // selection marker for point objects
  if (ed.selected && ed.selected.kind !== 'wall') { const o = arrOf(ed.selected.kind)[ed.selected.i]; if (o) { ctx.strokeStyle = "#ffd86b"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx(o.x), sz(o.z), 11, 0, 7); ctx.stroke(); } }
  // live wall drag preview
  if (ed.drag && ed.drag.kind === 'wall') { const d = ed.drag; ctx.strokeStyle = "#ffd86b"; ctx.setLineDash([5, 4]); ctx.strokeRect(sx(Math.min(d.x0, d.x1)), sz(Math.min(d.z0, d.z1)), Math.abs(d.x1 - d.x0) * ed.cam.zoom, Math.abs(d.z1 - d.z0) * ed.cam.zoom); ctx.setLineDash([]); }
}
function dot(x, y, r, color, letter) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  if (letter) { ctx.fillStyle = "#10141b"; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(letter, x, y + 0.5); }
}
