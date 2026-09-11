/* ============================== [PRACTICE] ==============================
   aim_botz-style config range: a flat arena where the enemy team just stands there (no guns, they
   turn to face you and respawn the moment they die) so you can dial in hit chance, resolver and
   anti-aim, plus a PEEK LANE on the east side — crates to peek from, and one armed guard at the far
   end whose aimbot fires at you the instant you show. No rounds, no economy: infinite money, the buy
   menu whenever you like.                                                                            */
import * as THREE from 'three';
import { TEAM, WEAPONS } from './data.js';
import { agents, refs, GAME } from './state.js';
import {
  floorTile, addBox, addMapObject, wall, cover, flushSpecs, buildGeometry, clearWorld,
  matConcrete, matWall, matWall2, matMetal, matWood, matCeil, CT_SPAWNS, T_SPAWNS, MAP_BOUNDS,
} from './world.js';
import { generateGridNav } from './map.js';
import { giveWeapon, aimbotFire } from './combat.js';

// the lane runs along z = 740 so nothing lines up with the spawn/target arc — you have to walk in and peek
const LZ = 740, GUARD_RANGE = 1500;
export const PRACTICE = { guardSpawn: Object.assign(new THREE.Vector3(2650, 0, LZ), { yaw: Math.PI / 2 }), peekSpawn: new THREE.Vector3(1500, 0, LZ) };

export function buildPracticeMap() {
  clearWorld();
  MAP_BOUNDS.minX = -1400; MAP_BOUNDS.maxX = 2900; MAP_BOUNDS.minZ = -1400; MAP_BOUNDS.maxZ = 1400;
  floorTile(-1400, 2900, -1400, 1400, matConcrete);
  // arena walls (west/north/south) + the east wall with a doorway into the peek lane
  wall(-1414, -1400, -1400, 1400, 260, matWall); wall(-1400, 2900, 1400, 1414, 260, matWall); wall(-1400, 2900, -1414, -1400, 260, matWall);
  wall(2900, 2914, -1400, 1400, 260, matWall);
  wall(1200, 1214, -1400, LZ - 140, 260, matWall2); wall(1200, 1214, LZ + 140, 1400, 260, matWall2);   // east partition, 280u gap = the lane entrance (off-axis from the range)
  // a few pillars so targets can be peeked/wallbanged
  for (const [x, z] of [[-300, -700], [-300, 700], [500, -900], [500, 900]]) wall(x - 40, x + 40, z - 40, z + 40, 260, matWall2);
  // peek lane: crates to peek from at x≈1500, half-wall for the guard at the far end
  cover(1440, 1560, LZ - 220, LZ - 100, 64, matWood, 0.42); cover(1440, 1560, LZ + 100, LZ + 220, 64, matWood, 0.42);
  cover(1440, 1500, LZ - 100, LZ - 20, 96, matMetal, 0.85); cover(1440, 1500, LZ + 20, LZ + 100, 96, matMetal, 0.85);
  cover(2560, 2600, LZ - 160, LZ + 160, 44, matMetal, 0.85);                                          // guard's half-wall (crouch cover)
  wall(2000, 2014, -1400, LZ - 400, 260, matWall2); wall(2000, 2014, LZ + 400, 1400, 260, matWall2);  // narrows the lane past the crates
  flushSpecs();
  const ceil = addBox(750, 0, 4300, 2800, 12, 268, matCeil); ceil.castShadow = false; ceil.receiveShadow = false;
  for (let gx = -1100; gx < 2900; gx += 600) for (let gz = -1000; gz < 1400; gz += 700) { const pl = new THREE.PointLight(0xffefd6, 0.55, 1500, 1.5); pl.position.set(gx, 230, gz); addMapObject(pl); }
  buildGeometry();
  // spawns: you (CT) at the west end facing the targets; targets (T) on an arc 600–1000u out
  CT_SPAWNS.push(Object.assign(new THREE.Vector3(-1000, 0, 0), { yaw: -Math.PI / 2 }));   // view = (-sin, 0, -cos) → facing +x, at the targets
  for (let i = 0; i < 12; i++) {
    const t = (i / 11 - 0.5) * 1.6, r = 700 + (i % 3) * 150;
    T_SPAWNS.push(Object.assign(new THREE.Vector3(-1000 + Math.cos(t) * r, 0, Math.sin(t) * r), { yaw: -Math.PI / 2, target: true }));
  }
  generateGridNav();
}

/* Team setup for practice: the human vs `n` unarmed targets + one armed guard in the lane. */
export function markPracticeAgents() {
  let i = 0;
  for (const a of agents) {
    if (a.isHuman) continue;
    if (i === 0) { a.practiceGuard = true; a.unarmed = false; a.name = "guard"; a.cheats.aimbot.on = true; a.cheats.aimbot.autoShoot = true; a.cheats.aimbot.hitchance = 30; a.cheats.aimbot.minDmg = 1; a.cheats.aimbot.silent = false; a.cheats.antiaim.on = false; }
    else { a.practiceTarget = true; a.unarmed = true; a.name = "bot " + i; a.cheats.aimbot.on = false; a.cheats.antiaim.on = false; a.cheats.autowall.on = false; }
    i++;
  }
}
export function practiceSpawnFor(a, i) {
  if (a.practiceGuard) return PRACTICE.guardSpawn;
  return T_SPAWNS[i % T_SPAWNS.length];
}
export function practiceArm(a) {
  if (a.practiceGuard) { giveWeapon(a, "scar"); giveWeapon(a, "usp"); a.cur = "scar"; a.armor = 100; a.helmet = true; }
  else { a.weapons = {}; a.slotPrimary = null; a.slotSecondary = null; a.cur = null; a.armor = 0; a.helmet = false; }
}

/* per-frame: targets face you and stand; the guard holds its post and fires; the dead respawn */
export function practiceThink(a, dt) {
  const h = refs.human; if (!h) return;
  const dx = h.pos.x - a.pos.x, dz = h.pos.z - a.pos.z;
  const want = Math.atan2(-dx, -dz);
  let d = want - a.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
  a.yaw += d * Math.min(1, dt * (a.practiceGuard ? 12 : 3)); a.realYaw = a.yaw;
  a.pitch = 0; a.vel.set(0, 0, 0); a.speedScale = 1;
  if (a.practiceGuard && h.alive && GAME.phase === "live" && Math.hypot(dx, dz) < GUARD_RANGE) aimbotFire(a);   // a peek exercise, not a map-wide sniper
}
export function updatePractice(dt) {
  if (!GAME.practice) return;
  let ti = 0;
  for (const a of agents) {
    if (a.isHuman) { if (!a.alive) { a._respawn = (a._respawn || 0) + dt; if (a._respawn > 2) { a._respawn = 0; respawn(a, CT_SPAWNS[0]); a.money = 16000; } } continue; }
    const sp = a.practiceGuard ? PRACTICE.guardSpawn : T_SPAWNS[(ti++) % T_SPAWNS.length];
    if (!a.alive) { a._respawn = (a._respawn || 0) + dt; if (a._respawn > 1.2) { a._respawn = 0; respawn(a, sp); } }
  }
  if (refs.human) refs.human.money = Math.max(refs.human.money, 16000);
}
function respawn(a, sp) {
  a.alive = true; a.hp = 100; a.pos.copy(sp); a.pos.y = sp.y || 0; a.vel.set(0, 0, 0); a.eye = 64 + a.pos.y;
  a.yaw = sp.yaw != null ? sp.yaw : a.yaw; a.realYaw = a.yaw; a.pitch = 0; a.crouch = false; a.reloadT = 0; a.fireCd = 0; a.flashT = 0; a.hitFlash = 0; a.body.g.visible = true;
  if (!a.isHuman) practiceArm(a);
  else if (!a.cur) { giveWeapon(a, "usp"); a.cur = "usp"; }
}
