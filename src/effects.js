/* ============================== [EFFECTS] ==============================
   Transient visuals: tracers, bullet impacts, grenade smokes/fires and
   live grenade projectiles.  Kept in one place so combat, grenades and the
   LoS code can all reference them without import cycles.                   */
import * as THREE from 'three';
import { scene } from './core.js';
import { sfxImpact } from './sfx.js';

export const tracers = [], impacts = [], smokes = [], fires = [], flashes = [], nadeProjectiles = [];

export function addTracer(from, to, color = 0xfff2a0, life = 0.2) {
  const g = new THREE.BufferGeometry().setFromPoints([from, to]);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: .9 }));
  scene.add(l); tracers.push({ l, t: 0, life });
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
  for (let i = impacts.length - 1; i >= 0; i--) {
    const im = impacts[i]; im.t -= dt; if (im.grow) im.m.scale.multiplyScalar(1 + dt * 4);
    if (im.t <= 0) { scene.remove(im.m); im.m.geometry.dispose(); im.m.material.dispose(); impacts.splice(i, 1); }
  }
}
export function clearEffects() {
  for (const tr of tracers) scene.remove(tr.l); tracers.length = 0;
  for (const im of impacts) scene.remove(im.m); impacts.length = 0;
  for (const s of smokes) scene.remove(s.mesh); smokes.length = 0;
  for (const f of fires) scene.remove(f.mesh); fires.length = 0;
  for (const n of nadeProjectiles) scene.remove(n.m); nadeProjectiles.length = 0;
}
