/* ============================== [PRACTICE] ==============================
   aim_practice — three rooms, aim_botz style. Only the room you are standing in is populated; the
   others' bots despawn the moment you leave and come back when you walk in. No rounds, infinite
   money, infinite reserve ammo (you still reload).
     MAIN  (north)      six knife-idle targets in a line; peek them from the crates at your spawn.
     AA    (south-west) one target running anti-aim (jitter + desync + fake duck) behind half cover —
                        for tuning the resolver and body aim; it never fires.
     FIGHT (south-east) one bot with the full kit (aimbot, anti-aim, resolver) that fires back; die
                        there and you respawn there.                                             */
import * as THREE from 'three';
import { TEAM, WEAPONS } from './data.js';
import { agents, refs, GAME } from './state.js';
import {
  floorTile, addBox, addMapObject, wall, cover, flushSpecs, buildGeometry, clearWorld,
  matConcrete, matCarpet, matWall, matWall2, matMetal, matWood, matPartition, CT_SPAWNS, T_SPAWNS, MAP_BOUNDS,
} from './world.js';
import { generateGridNav } from './map.js';
import { scene } from './core.js';
import { giveWeapon, aimbotFire, applyFakeDuck } from './combat.js';

const sp = (x, z, yaw, extra) => Object.assign(new THREE.Vector3(x, 0, z), { yaw }, extra || {});
export const ROOMS = {
  main:  { minX: -700, maxX: 700, minZ: -520, maxZ: 500, spawn: sp(-560, 0, -Math.PI / 2) },     // you face +x, at the targets
  aa:    { minX: -700, maxX: -60, minZ: 500, maxZ: 1300, spawn: sp(-380, 620, Math.PI) },         // you face +z (south), the AA bot is at the far end
  fight: { minX: 60, maxX: 700, minZ: 500, maxZ: 1300, spawn: sp(380, 620, Math.PI) },
};
const TARGETS = 6;
export const PRACTICE = {
  targets: Array.from({ length: TARGETS }, (_, i) => sp(430 + (i % 2) * 120, -375 + i * 150, Math.PI / 2, { room: 'main' })),
  aa: sp(-380, 1180, 0, { room: 'aa' }),
  fight: sp(380, 1180, 0, { room: 'fight' }),
};
export function roomOf(p) { return p.z < 500 ? 'main' : (p.x < 0 ? 'aa' : 'fight'); }

export function buildPracticeMap() {
  clearWorld();
  MAP_BOUNDS.minX = -700; MAP_BOUNDS.maxX = 700; MAP_BOUNDS.minZ = -520; MAP_BOUNDS.maxZ = 1300;
  floorTile(-700, 700, -520, 500, matConcrete);
  floorTile(-700, -60, 500, 1300, matCarpet); floorTile(60, 700, 500, 1300, matCarpet);
  const H = 190;
  // outer shell
  wall(-714, -700, -520, 1300, H, matWall); wall(700, 714, -520, 1300, H, matWall); wall(-700, 700, -534, -520, H, matWall); wall(-700, 700, 1300, 1314, H, matWall);
  // main ↔ south rooms: one shared wall with a doorway into each room (doors at x = -380 and x = 380)
  wall(-700, -480, 493, 507, H, matWall2); wall(-280, 280, 493, 507, H, matWall2); wall(480, 700, 493, 507, H, matWall2);
  wall(-60, 60, 507, 1300, H, matWall2);                                                     // the two south rooms are separated by a thick wall (60u — a wallbang test in itself)
  // main room: peek crates at your spawn, a low rail in front of the target line
  cover(-470, -410, -200, -80, 64, matWood, 0.42); cover(-470, -410, 80, 200, 64, matWood, 0.42);
  cover(-470, -430, -80, -20, 96, matMetal, 0.85); cover(-470, -430, 20, 80, 96, matMetal, 0.85);
  cover(300, 316, -450, 450, 34, matPartition, 0.45);
  // AA room: your cover box near the door, the AA bot's half wall at the far end
  cover(-440, -320, 660, 720, 64, matWood, 0.42); cover(-560, -200, 1100, 1120, 44, matMetal, 0.85);
  // FIGHT room: cover for both sides
  cover(320, 440, 660, 720, 64, matWood, 0.42); cover(200, 560, 1100, 1120, 44, matMetal, 0.85); cover(560, 640, 860, 960, 96, matMetal, 0.85);
  flushSpecs();
  // open sky
  scene.background = new THREE.Color(0x8fbbe8); scene.fog = new THREE.Fog(0xb9d3ee, 2500, 8000);
  addMapObject(new THREE.HemisphereLight(0xdcecff, 0x8a8474, 0.95));
  const sun = new THREE.DirectionalLight(0xfff0d0, 1.3); sun.position.set(900, 1800, 500); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -1400, right: 1400, top: 1400, bottom: -1400, near: 100, far: 5000 }); addMapObject(sun);
  addMapObject(new THREE.AmbientLight(0xbcd0e8, 0.35));
  // signs over the two south doors so you know which room is which
  const sign = (x, txt) => { const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64; const c = cv.getContext('2d'); c.fillStyle = '#111'; c.fillRect(0, 0, 256, 64); c.fillStyle = '#ffd86b'; c.font = 'bold 34px Trebuchet MS'; c.textAlign = 'center'; c.fillText(txt, 128, 44);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(200, 50), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv) })); m.position.set(x, 160, 492); m.rotation.y = Math.PI; addMapObject(m); };
  sign(-380, 'ANTI-AIM'); sign(380, 'FIGHT');
  buildGeometry();
  CT_SPAWNS.push(ROOMS.main.spawn);
  for (const t of PRACTICE.targets) T_SPAWNS.push(t);
  generateGridNav();
}

/* roles: bot 0 = the fighter, bot 1 = the anti-aimer, the rest are targets */
export function markPracticeAgents() {
  let i = 0;
  for (const a of agents) {
    if (a.isHuman) continue;
    const c = a.cheats; c.autowall.on = false;
    if (i === 0) { a.practiceFighter = true; a.room = 'fight'; a.name = "fighter"; Object.assign(c.aimbot, { on: true, autoShoot: true, hitchance: 40, minDmg: 1, silent: false, autoStop: true }); Object.assign(c.antiaim, { on: true, yaw: 'jitter', jitter: 58, desync: true, desyncAngle: 58, pitch: 'down', mode: 'freestanding', fakeduck: false }); c.resolver.on = true; }
    else if (i === 1) { a.practiceAA = true; a.room = 'aa'; a.name = "anti-aim"; c.aimbot.on = false; Object.assign(c.antiaim, { on: true, yaw: 'jitter', jitter: 58, desync: true, desyncAngle: 58, pitch: 'down', mode: 'freestanding', fakeduck: true, fakeduckMode: 'hold' }); }
    else { a.practiceTarget = true; a.room = 'main'; a.name = "bot " + (i - 1); c.aimbot.on = false; c.antiaim.on = false; }
    i++;
  }
}
export function practiceSpawnOf(a) {
  if (a.isHuman) return ROOMS[a._room || 'main'].spawn;
  if (a.practiceFighter) return PRACTICE.fight;
  if (a.practiceAA) return PRACTICE.aa;
  let k = 0; for (const b of agents) { if (b === a) break; if (b.practiceTarget) k++; }
  return PRACTICE.targets[k % PRACTICE.targets.length];
}
export function practiceArm(a) {
  if (a.practiceFighter) { a.weapons = { knife: { melee: true } }; giveWeapon(a, "scar"); giveWeapon(a, "usp"); a.cur = "scar"; a.armor = 100; a.helmet = true; }
  else { a.weapons = { knife: { melee: true } }; a.slotPrimary = null; a.slotSecondary = null; a.slotMelee = 'knife'; a.cur = 'knife'; a.armor = 0; a.helmet = false; }
}

/* per frame: everyone faces you; the fighter shoots; the anti-aimer fake ducks in bursts; nobody moves */
export function practiceThink(a, dt) {
  const h = refs.human; if (!h) return;
  const dx = h.pos.x - a.pos.x, dz = h.pos.z - a.pos.z;
  const want = Math.atan2(-dx, -dz);
  let d = want - a.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
  a.yaw += d * Math.min(1, dt * (a.practiceFighter ? 12 : 3)); a.realYaw = a.yaw;
  a.pitch = 0; a.vel.set(0, 0, 0); a.speedScale = 1;
  if (a.practiceAA) { a._fdActive = Math.floor(performance.now() / 1500) % 2 === 0; a.crouch = false; applyFakeDuck(a); }   // fake duck on for 1.5s, off for 1.5s (really ducks, like a bind)
  if (a._grace > 0) a._grace -= dt;   // half a second of not firing after a respawn (yours or its own), so the duel restarts fair
  if (a.practiceFighter && h.alive && GAME.phase === "live" && roomOf(h.pos) === 'fight' && !(a._grace > 0)) aimbotFire(a);
}
export function updatePractice(dt) {
  if (!GAME.practice) return;
  const h = refs.human; if (!h) return;
  const active = roomOf(h.pos); if (h.alive) h._room = active;
  // the moment you die in the duel room the fighter goes back to its post (it can't wander off while
  // you are dead) and holds fire for half a second once you are back
  if (!h.alive && !h._wasDead) { for (const a of agents) if (a.practiceFighter) { respawn(a, PRACTICE.fight); a._grace = 0.5; } }
  h._wasDead = !h.alive;
  for (const a of agents) {
    if (a.isHuman) { if (!a.alive) { a._respawn = (a._respawn || 0) + dt; if (a._respawn > 2) { a._respawn = 0; respawn(a, ROOMS[a._room || 'main'].spawn); a.money = 16000; for (const b of agents) if (b.practiceFighter) b._grace = 0.5; } } continue; }
    if (a.room !== active) { if (a.alive) { a.alive = false; a.body.g.visible = false; } a._respawn = 0; continue; }   // other rooms stay empty
    if (!a.alive) { a._respawn = (a._respawn || 0) + dt; if (a._respawn > 1.2) { a._respawn = 0; respawn(a, practiceSpawnOf(a)); } }
  }
  h.money = Math.max(h.money, 16000);
  for (const k in h.weapons) { const wp = h.weapons[k]; if (wp && !wp.melee && WEAPONS[k]) wp.reserve = Math.max(wp.reserve || 0, WEAPONS[k].reserve || 90); }   // infinite ammo, but you still reload
}
function respawn(a, s) {
  a.alive = true; a.hp = 100; a.pos.copy(s); a.pos.y = s.y || 0; a.vel.set(0, 0, 0); a.eye = 64 + a.pos.y;
  a.yaw = s.yaw != null ? s.yaw : a.yaw; a.realYaw = a.yaw; a.pitch = 0; a.crouch = false; a.reloadT = 0; a.fireCd = 0; a.flashT = 0; a.hitFlash = 0; a.body.g.visible = true;
  if (!a.isHuman) { practiceArm(a); a._grace = 0.5; }
  else if (!a.cur || !a.weapons[a.cur]) { giveWeapon(a, "usp"); a.cur = "usp"; }
}
