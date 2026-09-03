/* ============================== [EFFECTS] ==============================
   Transient visuals: tracers, bullet impacts, grenade smokes/fires and
   live grenade projectiles.  Kept in one place so combat, grenades and the
   LoS code can all reference them without import cycles.                   */
import * as THREE from 'three';
import { scene } from './core.js';
import { sfxImpact } from './sfx.js';

export const tracers = [], shotLines = [], impacts = [], smokes = [], fires = [], flashes = [], nadeProjectiles = [];

export function addTracer(from, to, color = 0xfff2a0, life = 0.2) {
  const g = new THREE.BufferGeometry().setFromPoints([from, to]);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: .9 }));
  scene.add(l); tracers.push({ l, t: 0, life });
}
/* A LOCAL shot line — where your own round actually went.  A tracer is a 0.2s streak you have already
   stopped looking at by the time the shot resolves; this is the same line kept up for `life` seconds
   (1.5 by default, `Shot line duration` in the menu) and faded out over it, so a spread miss or a
   backtracked hit is something you can look at afterwards instead of having to catch. */
export function addShotLine(from, to, life = 1.5, color = '#ff4d6d') {
  if (!(life > 0)) return;
  const g = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 1, depthTest: false }));
  l.renderOrder = 993;                       // drawn through geometry: the point is to see where it went
  scene.add(l); shotLines.push({ l, t: 0, life });
  while (shotLines.length > 64) { const old = shotLines.shift(); scene.remove(old.l); old.l.geometry.dispose(); old.l.material.dispose(); }
}
export function addImpact(p, glass) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(2.4, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffd070 }));
  m.position.copy(p); scene.add(m); impacts.push({ m, t: 0.25 });
  sfxImpact(p, !!glass);
}
export function addExplosion(p, color, size) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 12), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .6 }));
  m.position.copy(p); scene.add(m); impacts.push({ m, t: 0.35, grow: true });
}
export function updateEffects(dt) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    const tr = tracers[i]; tr.t += dt; tr.l.material.opacity = Math.max(0, 0.9 * (1 - tr.t / tr.life));
    if (tr.t >= tr.life) { scene.remove(tr.l); tr.l.geometry.dispose(); tr.l.material.dispose(); tracers.splice(i, 1); }
  }
  for (let i = shotLines.length - 1; i >= 0; i--) {
    const sl = shotLines[i]; sl.t += dt;
    sl.l.material.opacity = Math.max(0, 1 - sl.t / sl.life);       // linear fade over the configured lifetime
    if (sl.t >= sl.life) { scene.remove(sl.l); sl.l.geometry.dispose(); sl.l.material.dispose(); shotLines.splice(i, 1); }
  }
  for (let i = impacts.length - 1; i >= 0; i--) {
    const im = impacts[i]; im.t -= dt; if (im.grow) im.m.scale.multiplyScalar(1 + dt * 4);
    if (im.t <= 0) { scene.remove(im.m); im.m.geometry.dispose(); im.m.material.dispose(); impacts.splice(i, 1); }
  }
}
export function clearEffects() {
  for (const tr of tracers) scene.remove(tr.l); tracers.length = 0;
  for (const sl of shotLines) scene.remove(sl.l); shotLines.length = 0;
  for (const im of impacts) scene.remove(im.m); impacts.length = 0;
  for (const s of smokes) scene.remove(s.mesh); smokes.length = 0;
  for (const f of fires) scene.remove(f.mesh); fires.length = 0;
  for (const n of nadeProjectiles) scene.remove(n.m); nadeProjectiles.length = 0;
}
