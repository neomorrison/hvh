/* ============================== [SFX] ==============================
   Real sound effects (lazy-loaded OGG, WebAudio). Each sound is fetched + decoded on first
   use and cached. Positional sounds attenuate with distance and pan relative to the local
   listener (the player, the spectated player, or the free-cam). */
import * as THREE from 'three';
import { WEAPONS } from './data.js';
import { losClear } from './world.js';

let actx = null, master = null, enabled = true, localAgent = null;
const buf = new Map(), loading = new Map();
const listener = { x: 0, y: 50, z: 0, yaw: 0 };
const _la = new THREE.Vector3(), _lb = new THREE.Vector3();   // reused for the LOS muffle check

function ctx() {
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); master = actx.createGain(); master.gain.value = 0.7; master.connect(actx.destination); }
    catch (e) { actx = null; }
  }
  if (actx && actx.state === 'suspended') actx.resume();
  return actx;
}
function load(name) {
  if (buf.has(name)) return Promise.resolve(buf.get(name));
  if (loading.has(name)) return loading.get(name);
  const c = ctx(); if (!c) return Promise.resolve(null);
  const p = fetch('./sfx/' + name + '.ogg').then(r => r.arrayBuffer()).then(a => c.decodeAudioData(a))
    .then(b => { buf.set(name, b); loading.delete(name); return b; })
    .catch(() => { loading.delete(name); return null; });
  loading.set(name, p); return p;
}
function emit(b, vol, rate, pan) {
  const c = actx; if (!c || !b || vol <= 0.005) return;
  const src = c.createBufferSource(); src.buffer = b; src.playbackRate.value = rate;
  const g = c.createGain(); g.gain.value = Math.min(1, vol); src.connect(g);
  if (pan && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); g.connect(p); p.connect(master); }
  else g.connect(master);
  try { src.start(); } catch (e) {}
}
/** play a sound by name (path under sfx/, no extension). */
export function play(name, vol = 1, rate = 1, pan = 0) {
  if (!enabled || !name) return;
  if (!ctx()) return;
  const b = buf.get(name);
  if (b) emit(b, vol, rate, pan); else load(name).then(bb => emit(bb, vol, rate, pan));
}
export function setListener(x, y, z, yaw, local) { listener.x = x; listener.y = y; listener.z = z; listener.yaw = yaw; localAgent = local || null; }
export function setEnabled(on) { enabled = on; }
export function unlockAudio() { ctx(); }   // call from a user gesture so the context can start

// distance attenuation + stereo pan toward the listener's right, MUFFLED when a wall blocks the
// line of sight to the source (so you can't hear a gunshot clearly through the map).
function spatial(pos, baseVol, maxDist) {
  const dx = pos.x - listener.x, dz = pos.z - listener.z, d = Math.hypot(dx, dz);
  let vol = baseVol * Math.pow(Math.max(0, 1 - d / maxDist), 2.4);   // steeper falloff so far sounds are clearly quiet
  if (vol > 0.01 && d > 200) {
    _la.set(listener.x, listener.y, listener.z); _lb.set(pos.x, pos.y != null ? pos.y : listener.y, pos.z);
    if (!losClear(_la, _lb)) vol *= 0.4;   // through-wall muffle
  }
  // pan hard toward the source's side; pull near-centre sounds in so they don't feel detached
  const rx = Math.cos(listener.yaw), rz = -Math.sin(listener.yaw);
  const pan = d > 1 ? Math.max(-1, Math.min(1, (dx * rx + dz * rz) / d)) : 0;
  return { vol, pan, d };
}
const r = (a, b) => a + Math.random() * (b - a);

const FIRE = { usp: 'usp_01', glock: 'glock_01', duals: 'usp_01', deagle: 'deagle_01', r8: 'revolver-1_01', ssg: 'ssg08-1', scar: 'scar20_01', g3: 'g3sg1_01' };
const FIRE_FAR = { usp: 'usp1-distant', glock: 'glock18-1-distant', duals: 'usp1-distant', deagle: 'deagle-1-distant', r8: 'revolver-1_distant', ssg: 'ssg08-1-distant', scar: 'scar20_distant_01', g3: 'g3sg1-1-distant' };
const CLIPOUT = { usp: 'usp_clipout', glock: 'glock_clipout', duals: 'usp_clipout', deagle: 'de_clipout', r8: 'revolver_prepare', ssg: 'ssg08_clipout', scar: 'g3sg1_clipout', g3: 'g3sg1_clipout' };
const CLIPIN = { usp: 'usp_clipin', glock: 'glock_clipin', duals: 'usp_clipin', deagle: 'de_clipin', r8: 'revolver_prepare', ssg: 'ssg08_clipin', scar: 'g3sg1_clipin', g3: 'g3sg1_clipin' };
const SLIDE = { usp: 'usp_sliderelease', glock: 'glock_sliderelease', duals: 'usp_sliderelease', deagle: 'de_slideforward', ssg: 'ssg08_boltforward', scar: 'g3sg1_slideforward', g3: 'g3sg1_slideforward' };
const DRAW = { ssg: 'ssg08_draw', g3: 'g3sg1_draw', scar: 'g3sg1_draw', r8: 'revolver_draw', glock: 'glock_draw', usp: 'usp_sliderelease', deagle: 'de_slideforward' };

const w = k => 'weapons/' + k;
const isLocal = a => a === localAgent;

export function sfxFire(a) {
  const key = a.cur, snd = FIRE[key]; if (!snd) return;
  if (isLocal(a)) { play(w(snd), 0.5, r(0.98, 1.02)); return; }   // the local R8 cock is driven by its charge animation (sfxRevolverCock)
  if (key === 'r8') { const s2 = spatial(a.pos, 0.45, 2800); play(w('revolver_prepare'), s2.vol, 1, s2.pan); }   // bot R8 cocks each shot
  const s = spatial(a.pos, 0.6, 4200); if (s.vol < 0.012) return;
  const far = s.d > 2000;
  play(w(far ? (FIRE_FAR[key] || snd) : snd), s.vol * (far ? 0.7 : 1), r(0.97, 1.03), s.pan);   // distant variant, quieter
}
export function sfxRevolverCock() { play(w('revolver_prepare'), 0.42, r(1.0, 1.08)); }   // the hammer coming back (local R8)
export function sfxReloadStart(a) {
  const k = CLIPOUT[a.cur]; if (!k) return;
  if (isLocal(a)) play(w(k), 0.55); else { const s = spatial(a.pos, 0.5, 2200); play(w(k), s.vol, 1, s.pan); }
}
export function sfxReloadEnd(a) {
  const ci = CLIPIN[a.cur], sl = SLIDE[a.cur];
  if (isLocal(a)) { play(w(ci), 0.55); if (sl) setTimeout(() => play(w(sl), 0.5), 180); }
  else { const s = spatial(a.pos, 0.45, 2000); play(w(ci), s.vol, 1, s.pan); }
}
export function sfxDraw(a) { if (isLocal(a) && DRAW[a.cur]) play(w(DRAW[a.cur]), 0.5); }
export function sfxEquip() { play('equip', 0.5); }   // ONLY on a buy-menu purchase
export function sfxScope() { play('weapons/scope_zoom', 0.4); }
export function sfxLowAmmo(a) { if (isLocal(a)) play('weapons/lowammo_01', 0.5); }
export function sfxHitmarker(headshot, hadArmor) {   // only the local shooter hears their hitmarker
  if (headshot) play(hadArmor ? 'armor_headshot_hitmarker' : 'noarmor_headshot_hitmarker', 0.3);   // headshot tick at half volume
  else play('hitmarker', 0.6);
}
export function sfxImpact(pos, glass) {
  const s = spatial(pos, 0.6, 3500); if (s.vol < 0.02) return;
  play(glass ? 'glass_impact_bullet1' : 'concrete_impact_bullet1', s.vol, r(0.95, 1.05), s.pan);
}
export function sfxKnife(a, hit) {
  if (isLocal(a)) play(hit ? w(Math.random() < 0.5 ? 'knife_hit_01' : 'knife_hit_02') : 'weapons/stab', 0.5);
  else { const s = spatial(a.pos, 0.5, 1500); play(hit ? w('knife_hit_01') : w('stab'), s.vol, 1, s.pan); }
}
export function sfxNade(kind, pos) {
  const map = { throw: 'grenade_throw', bounce: 'he_bounce-1', pin: 'pinpull', land: 'grenade_hit1' };
  if (kind === 'detonate') { const s = spatial(pos, 1.0, 6000); play(s.d > 2400 ? 'weapons/hegrenade_distant_detonate_01' : 'weapons/hegrenade_detonate_01', s.vol, 1, s.pan); return; }
  const name = map[kind]; if (!name) return;
  const s = spatial(pos, 0.6, 2800); play(w(name), s.vol, 1, s.pan);
}
