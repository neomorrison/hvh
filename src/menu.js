/* ============================== [MENU] ==============================
   CS2-style main menu: a lit operator standing in a dusty street with the cheat's own ESP drawn on
   him (box, health bar, name + weapon, chams), a PLAY screen (map, bots per team, side) and the
   INJECT button. Rendered by the game renderer while the start panel is up; nothing here touches
   the match state until DEPLOY.                                                                     */
import * as THREE from 'three';
import { renderer } from './core.js';
import { makeBody, buildWeaponModel } from './agents.js';
import { updateBodyGLB, FACE, MODELS } from './models.js';
import { WEAPONS } from './data.js';

const $ = s => document.querySelector(s);
export const MENU = { map: 'cs_office', bots: 12, team: 'random', injected: false, view: 'home' };
let scene = null, cam = null, dummy = null, t0 = performance.now(), onDeploy = null;

function buildScene() {
  scene = new THREE.Scene(); scene.background = new THREE.Color(0xc9b797); scene.fog = new THREE.Fog(0xd8c7a6, 300, 2600);
  cam = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 1, 5000);
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x8a7a5a, 0.9));
  const sun = new THREE.DirectionalLight(0xfff0d0, 1.4); sun.position.set(300, 600, 400); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -300, right: 300, top: 300, bottom: -300, near: 10, far: 2000 }); scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshStandardMaterial({ color: 0xb8a37f, roughness: 1 })); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  // a street: low walls left and right, a kerb, a couple of crates — enough to read as "somewhere"
  const wallM = new THREE.MeshStandardMaterial({ color: 0xd9cfb6, roughness: .95 }), darkM = new THREE.MeshStandardMaterial({ color: 0x6f6553, roughness: .9 });
  const box = (w, h, d, x, y, z, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.castShadow = b.receiveShadow = true; scene.add(b); return b; };
  box(60, 360, 1800, -420, 180, -600, wallM); box(60, 300, 1800, 460, 150, -700, wallM); box(1200, 14, 60, 0, 7, -1000, darkM);
  box(70, 70, 70, -250, 35, -120, darkM); box(50, 50, 50, -250, 95, -130, darkM); box(90, 60, 90, 300, 30, -260, darkM);
  // the operator: a CT body with a rifle, chams on, facing the camera
  const body = makeBody('CT', false); dummy = { body, vel: new THREE.Vector3(), crouch: false, cheats: { antiaim: {} }, isHuman: false };
  body.g.position.set(0, 0, 0); scene.add(body.g);
  const gun = buildWeaponModel('scar'); body.weapon = gun; body.holder.add(gun);
  if (body.glb) { body.realYaw = -FACE + 0.55; body.aimYaw = -FACE + 0.55; body.pitch = 0.05; }   // three-quarter stance, gun across the frame like the CS2 menu
  else { body.legs.rotation.y = 0; body.upper.rotation.y = 0; }
  window.__menu = () => ({ dummy, scene, cam, builtWithGlb });   // live debug getter (probing the mount orientation from the console)
  // chams: flat, lit through-wall red like the ESP's "visible" colour
  const cham = new Map();
  body.g.traverse(o => { if (!o.isMesh) return; const arr = Array.isArray(o.material) ? o.material : [o.material]; const out = arr.map(m => { if (!cham.has(m)) { const c = m.clone(); c.color.setHex(0xff2a44); c.emissive = new THREE.Color(0x7a1020); c.roughness = 1; c.metalness = 0; cham.set(m, c); } return cham.get(m); }); o.material = Array.isArray(o.material) ? out : out[0]; });
}

const _v = new THREE.Vector3();
function project(x, y, z, W, H) { _v.set(x, y, z).project(cam); return { x: (_v.x + 1) / 2 * W, y: (1 - _v.y) / 2 * H }; }
function drawESP() {
  const cv = document.getElementById('esp'); if (!cv) return;
  if (cv.width !== innerWidth) { cv.width = innerWidth; cv.height = innerHeight; }
  const c = cv.getContext('2d'), W = cv.width, H = cv.height; c.clearRect(0, 0, W, H);
  const head = project(0, 84, 0, W, H), feet = project(0, -2, 0, W, H);
  const h = feet.y - head.y, w = h * 0.42, x = head.x - w / 2, y = head.y;
  c.lineWidth = 2; c.strokeStyle = '#39ff5a'; c.strokeRect(x, y, w, h);
  c.fillStyle = '#000'; c.fillRect(x - 8, y, 4, h); c.fillStyle = 'hsl(112,85%,50%)'; c.fillRect(x - 8, y + h * 0.13, 4, h * 0.87);
  c.font = "bold 13px 'Trebuchet MS',sans-serif"; c.textAlign = 'center'; c.fillStyle = '#d6f5d6'; c.fillText('awesome dog', head.x, y - 8);
  c.font = "12px 'Trebuchet MS',sans-serif"; c.fillStyle = '#ffd86b'; c.fillText('▸ ' + WEAPONS.scar.name + ' · 87 hp', head.x, feet.y + 16);
}

export function menuVisible() { const p = $('#startPanel'); return !!(p && p.classList.contains('show')); }
let builtWithGlb = false;
export function renderMenu() {
  if (!scene || (dummy && !dummy.body.glb && MODELS.player)) { buildScene(); builtWithGlb = !!(dummy && dummy.body.glb); }   // rebuild once the rigged model has arrived
  document.body.classList.add('menu');   // hides the match HUD (index.html: body.menu #hud > *:not(#esp)) but keeps the ESP canvas
  const t = (performance.now() - t0) / 1000;
  cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix();
  cam.position.set(Math.sin(t * 0.12) * 70, 74 + Math.sin(t * 0.3) * 3, 290); cam.lookAt(0, 40, 0);
  if (dummy.body.glb) { dummy.body.aimYaw = -FACE + 0.55 + Math.sin(t * 0.5) * 0.06; dummy.body.pitch = 0.05 + Math.sin(t * 0.7) * 0.03; updateBodyGLB(dummy, 1 / 60); }   // slow scan + breathing
  renderer.render(scene, cam);
  drawESP();
}

/* ---- the play screen ---- */
function setView(v) { MENU.view = v; for (const el of document.querySelectorAll('#startPanel .mview')) el.hidden = el.dataset.view !== v; for (const a of document.querySelectorAll('#menuNav a')) a.classList.toggle('on', a.dataset.view === v); }
function setInjected(on) {
  MENU.injected = on; try { localStorage.setItem('hvh_injected', on ? '1' : '0'); } catch (e) {}
  const b = $('#injectBtn'), s = $('#injectState'); if (!b) return;
  b.classList.toggle('done', on); b.textContent = on ? '✔ INJECTED' : 'INJECT CHEAT';
  if (s) s.textContent = on ? 'hvh.dll loaded · I opens the menu in-game' : 'legit — no menu until injected';
}
export function initMenu(handlers) {
  onDeploy = handlers.onDeploy;
  try { MENU.injected = localStorage.getItem('hvh_injected') === '1'; } catch (e) {}
  setInjected(MENU.injected);
  for (const a of document.querySelectorAll('#menuNav a')) a.onclick = () => setView(a.dataset.view);
  $('#injectBtn').onclick = () => {
    if (MENU.injected) { setInjected(false); return; }
    const b = $('#injectBtn'); b.disabled = true; let i = 0; const steps = ['scanning process…', 'mapping hvh.dll…', 'hooking CreateMove…', 'patching bloom…'];
    const s = $('#injectState'); const tick = () => { if (i < steps.length) { s.textContent = steps[i++]; setTimeout(tick, 260); } else { b.disabled = false; setInjected(true); } }; tick();
  };
  for (const card of document.querySelectorAll('.mapcard')) card.onclick = () => { MENU.map = card.dataset.map; for (const c of document.querySelectorAll('.mapcard')) c.classList.toggle('on', c === card); };
  const bots = $('#botsRange'), botsOut = $('#botsOut'); const syncBots = () => { MENU.bots = +bots.value; botsOut.textContent = MENU.bots + ' v ' + MENU.bots; }; bots.oninput = syncBots; syncBots();
  for (const r of document.querySelectorAll('input[name=side]')) r.onchange = () => { MENU.team = r.value; };
  // the start panel goes away THIS frame: the map load behind DEPLOY is async, and while it ran the menu
  // renderer kept re-adding the body class that hides the match HUD — which is how the HUD vanished
  $('#playBtn').onclick = () => { if ($('#playBtn').disabled) return; $('#startPanel').classList.remove('show'); document.body.classList.remove('menu'); onDeploy({ map: MENU.map, bots: MENU.bots, team: MENU.team, injected: MENU.injected }); };
  setView('home');
}
export function menuReady() { const b = $('#playBtn'); if (b) { b.disabled = false; b.textContent = 'DEPLOY'; } const ls = $('#loadStat'); if (ls) ls.textContent = ''; }
