/* ============================== [COMBAT] ==============================
   Shooting, the CS2 inaccuracy/bloom model, damage application, aimbot &
   manual fire (with wall penetration), melee, movement, and the weapon
   give/switch/reload helpers.  This is where the gameplay fixes live.     */
import * as THREE from 'three';
import {
  WEAPONS, INACC, INACC_K, AIRBORNE_INACC, LAND_INACC, GRAVITY, JUMP_VEL,
  EYE_STAND, EYE_CROUCH, PLAYER_RADIUS, ECON, computeDamage, TEAM,
} from './data.js';
import { WALLS, segAABB, rayAABB, penetrate, losClear, collideMove, MAP_BOUNDS, CT_SPAWNS, T_SPAWNS } from './world.js';
import { meshBackend } from './sourcemap.js';
import { hitboxes, hitboxCenter, eyePos, setViewmodel } from './agents.js';
import { agents } from './state.js';
import { addTracer, addImpact } from './effects.js';
import { hitmarker, playHitmarker, addHitLog, damageFlash, updateHUDWeapons, playShot, playBeep, showHint, addKillFeed } from './hud.js';
import { sfxFire, sfxReloadStart, sfxReloadEnd, sfxDraw, sfxHitmarker, sfxKnife, sfxImpact } from './sfx.js';
import { checkRoundEnd, onHumanDeath } from './game.js';

/* live aim cone (half-angle radians) — faithful CS2 inaccuracy model */
export function computeBloom(a) {
  const w = WEAPONS[a.cur]; if (!w || w.melee) return 0.002;
  const I = INACC[a.cur] || { stand: 6, crouch: 4, run: 30, max: 50 };
  const sp = Math.hypot(a.vel.x, a.vel.z);
  const maxSp = (a.scoped && w.scopedRun) ? w.scopedRun : (w.run || 240);
  let base, runTarget = I.run;
  if (w.scope) {
    if (a.scoped) base = I.scopedStill != null ? I.scopedStill : 0.3;
    else { base = I.unscoped != null ? I.unscoped : 50; runTarget = Math.max(I.run, base * 1.4); }
  } else base = a.crouch ? I.crouch : I.stand;
  const thr = 0.34 * maxSp;
  if (sp > thr) { const t = Math.min(1, (sp - thr) / (maxSp - thr)); base = base + (runTarget - base) * t * t; }
  if (!a.onGround) base += AIRBORNE_INACC;
  // firing buildup + getting-shot flinch + post-landing penalty (can't snap-accurate on landing)
  const total = base + (a.firePenalty || 0) + (a.hurtBloom || 0) + (a.landBloom || 0);
  return total * INACC_K;
}

/* shared movement + physics for player and bots */
export function moveAgent(a, dirXZ, dt, combat) {
  const w = WEAPONS[a.cur] || { run: 240 };
  let speed = (a.scoped && w.scopedRun) ? w.scopedRun : (w.run || 240);
  if (a.crouch) speed *= 0.52;
  if (a.walk) speed *= 0.52;
  if (combat) speed *= 0.9;
  if (a.speedScale != null) speed *= a.speedScale;          // auto-stop
  const v = dirXZ.clone().setY(0); if (v.lengthSq() > 0) v.normalize().multiplyScalar(speed);
  a.vel.x = v.x; a.vel.z = v.z;
  a.vel.y -= GRAVITY * dt;
  const wasOnGround = a.onGround;
  const descend = a.vel.y;
  const prevX = a.pos.x, prevZ = a.pos.z, prevY = a.pos.y;
  a.pos.x += a.vel.x * dt; a.pos.z += a.vel.z * dt; a.pos.y += a.vel.y * dt;
  if (meshBackend.active) {
    // recover anything that fell out of the world (through a hole / off an edge) — teleport to a team spawn
    if (meshBackend.bounds && a.pos.y < meshBackend.bounds.min[1] - 50) {
      const sp = a.team === TEAM.CT ? CT_SPAWNS : T_SPAWNS;
      if (sp.length) { const s = sp[(Math.random() * sp.length) | 0]; a.pos.set(s.x, s.y || 0, s.z); const gg = meshBackend.groundHeight(s.x, s.z, (s.y || 0), 24); if (gg > -1e8) a.pos.y = gg; }
      a.vel.set(0, 0, 0); a.onGround = true; a.aiPath = []; a.aiTimer = 0;
      a.eye = (a.crouch ? EYE_CROUCH : EYE_STAND) + a.pos.y;
      return;
    }
    // imported mesh map: slide along real walls (above the step zone so stairs stay walkable),
    // follow the real (multi-level) floor
    const feetY = a.pos.y, crouch = a.crouch;
    // CS2 crouch-jump: crouching in the air tucks the legs up, so the body clears (and can mount) a
    // ledge higher than a standing jump. Model it by raising the collision feet while crouched+airborne.
    const tuck = (crouch && !wasOnGround) ? 18 : 0;
    const slideFeet = feetY + tuck;
    // substep the horizontal move so a fast frame (jump/peek) can't tunnel a thin wall
    const mvx = a.pos.x - prevX, mvz = a.pos.z - prevZ;
    const sub = Math.max(1, Math.ceil(Math.hypot(mvx, mvz) / (PLAYER_RADIUS * 0.75)));
    let cx = prevX, cz = prevZ;
    for (let i = 1; i <= sub; i++) {
      const [sx, sz] = meshBackend.slideXZ(cx, cz, prevX + mvx * i / sub, prevZ + mvz * i / sub, slideFeet, PLAYER_RADIUS, crouch);
      cx = sx; cz = sz;
    }
    [cx, cz] = meshBackend.pushOut(cx, cz, slideFeet, PLAYER_RADIUS, crouch);    // depenetrate from walls
    // hard playable-bounds clamp — last-resort guard against any residual leak out of the map
    cx = Math.min(Math.max(cx, MAP_BOUNDS.minX + PLAYER_RADIUS), MAP_BOUNDS.maxX - PLAYER_RADIUS);
    cz = Math.min(Math.max(cz, MAP_BOUNDS.minZ + PLAYER_RADIUS), MAP_BOUNDS.maxZ - PLAYER_RADIUS);
    a.pos.x = cx; a.pos.z = cz;
    // ceiling: when rising (a jump), stop the head at the first solid/clip surface above. Nothing
    // else constrains upward motion, so without this a jump clips straight through a low ceiling.
    if (a.vel.y > 0) {
      const ho = a.crouch ? 44 : 66, rise = a.vel.y * dt;
      let ch = meshBackend.bvh.raycast(a.pos.x, prevY + ho, a.pos.z, 0, 1, 0, rise + 2);
      if (meshBackend.clipBvh) { const c = meshBackend.clipBvh.raycast(a.pos.x, prevY + ho, a.pos.z, 0, 1, 0, rise + 2); if (c && (!ch || c.t < ch.t)) ch = c; }
      if (meshBackend.windowBvh) { const w = meshBackend.windowBvh.raycast(a.pos.x, prevY + ho, a.pos.z, 0, 1, 0, rise + 2); if (w && (!ch || w.t < ch.t)) ch = w; }   // unbroken glass overhead (consistent with slideXZ/pushOut)
      if (ch) { a.pos.y = prevY + Math.max(0, ch.t - 0.5); a.vel.y = 0; }
    }
    let g = meshBackend.groundHeight(a.pos.x, a.pos.z, a.pos.y, 18 + tuck);   // crouch-jump mounts a taller ledge
    let snap = g > -1e8 && a.pos.y <= g + 0.5;                  // landing / step-up onto a ledge
    if (!snap && wasOnGround && a.vel.y <= 0) {                 // grounded last frame, not jumping → stick to a nearby
      const gd = meshBackend.groundHeight(a.pos.x, a.pos.z, a.pos.y, 4);   // lower step so walking down stairs/edges doesn't free-fall
      if (gd > -1e8 && a.pos.y - gd <= 24) { g = gd; snap = true; }
    }
    if (snap) {
      a.pos.y = g;
      if (!wasOnGround) { const impact = Math.min(1, Math.abs(descend) / JUMP_VEL); a.landBloom = Math.max(a.landBloom || 0, LAND_INACC * (0.45 + impact * 0.9)); }
      a.vel.y = 0; a.onGround = true;
    } else a.onGround = false;
    a.eye = (a.crouch ? EYE_CROUCH : EYE_STAND) + a.pos.y;
    return;
  }
  if (a.pos.y < 0) {
    a.pos.y = 0;
    if (!wasOnGround) {                                      // just landed → landing inaccuracy
      const impact = Math.min(1, Math.abs(descend) / JUMP_VEL);
      a.landBloom = Math.max(a.landBloom || 0, LAND_INACC * (0.45 + impact * 0.9));
    }
    a.vel.y = 0; a.onGround = true;
  } else a.onGround = false;
  a.eye = (a.crouch ? EYE_CROUCH : EYE_STAND) + a.pos.y;
  collideMove(a.pos, PLAYER_RADIUS, a.pos.y, a.crouch ? 46 : 72);
}

/* Hit chance = pure accuracy from the live bloom cone vs the target hitbox's
   angular size at the crosshair.  No desync / resolver / anti-aim term — a shot
   aimed at the hitbox lands iff the cone is tight enough to keep it on target. */
export function computeAccuracy(a, aimPoint, target, group) {
  const dist = Math.max(1, eyePos(a).distanceTo(aimPoint));
  const cone = computeBloom(a);                              // bullet spread half-angle (radians)
  if (cone < 1e-5) return 1;
  const hb = hitboxes(target).find(h => h.group === group);
  if (!hb) return 0;
  const r = Math.min(hb.maxX - hb.minX, hb.maxY - hb.minY, hb.maxZ - hb.minZ) / 2;   // conservative target radius
  const targetHalfAngle = Math.atan2(r, dist);
  return THREE.MathUtils.clamp(targetHalfAngle / cone, 0, 1);
}

/* Shared "can I take this shot right now?" predicate used by BOTH auto-shoot and
   auto-stop so they agree exactly.  Picks the best target + first hitbox meeting
   min-damage, then evaluates min-hit-chance and weapon-firable.
   Returns { have, ok, tgt, group, aimPoint, through, dmg, hitChance } where
     have = a min-damage hitbox exists to aim at,
     ok   = have AND firable (real gun, not reloading, has ammo) AND hitChance >= min. */
export function canShoot(a) {
  const cb = a.cheats;
  const res = { have: false, ok: false, tgt: null, group: null, aimPoint: null, through: null, dmg: 0, hitChance: 0 };
  const enemies = agents.filter(t => t.alive && t.team !== a.team);
  if (!enemies.length) return res;
  const me = eyePos(a);
  let cands = enemies.map(t => ({ t, d: me.distanceTo(t.pos), vis: visibleTo(a, t) })).filter(c => c.vis || cb.autowall.on);
  if (!cands.length) return res;
  if (cb.aimbot.target === "lowhp") cands.sort((x, y) => x.t.hp - y.t.hp);
  else if (cb.aimbot.target === "distance") cands.sort((x, y) => x.d - y.d);
  else {
    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(a.pitch, a.yaw, 0, 'YXZ'));
    cands.forEach(c => { const to = hitboxCenter(c.t, "chest").sub(me).normalize(); c.dot = fwd.dot(to); });
    cands.sort((x, y) => y.dot - x.dot);
  }
  const tgt = cands[0].t; res.tgt = tgt;
  const directVis = visibleTo(a, tgt);
  const order = cb.aimbot.forceBody ? ["stomach", "chest", "legs"]
    : (cb.aimbot.priority === "head" ? ["head", "chest", "stomach"] : ["chest", "stomach", "head"]);
  const minDmg = Math.max(cb.aimbot.minDmg || 1, !directVis ? (cb.autowall.minDmg || 1) : 1);
  for (const group of order) {
    const aimPoint = hitboxCenter(tgt, group);
    const dist = me.distanceTo(aimPoint);
    const through = penetrate(me, aimPoint, a.cur);
    if (!directVis) { if (!cb.autowall.on || through.blocked || through.factor <= 0) continue; }
    const base = computeDamage(a.cur, group, dist, tgt.armor > 0, tgt.helmet, tgt.armor);
    const dmg = Math.round(base.damage * (directVis ? 1 : through.factor));
    if (dmg >= minDmg) { res.group = group; res.aimPoint = aimPoint; res.through = directVis ? { factor: 1, surfaces: 0, blocked: false } : through; res.dmg = dmg; break; }
  }
  if (!res.group) return res;
  res.have = true;
  res.hitChance = computeAccuracy(a, res.aimPoint, tgt, res.group);
  const w = WEAPONS[a.cur];
  const firable = !!w && !w.melee && a.reloadT <= 0 && (a.weapons[a.cur]?.ammo || 0) > 0;
  // The human's auto-shoot must respect the configured Min Hit Chance (items 10/11). Bots are
  // aimbots — they always take the shot when able; their persona skill caps the hit roll below.
  res.ok = firable && (!a.isHuman || res.hitChance * 100 >= (cb.aimbot.hitchance || 0));
  return res;
}

export function applyHit(shooter, target, group, dist, throughWall) {
  if (!target.alive) return;
  const wkey = shooter.cur;
  const dmg = computeDamage(wkey, group, dist, target.armor > 0, target.helmet, target.armor);
  let applied = dmg.damage;
  if (throughWall.factor < 1) applied = Math.round(applied * throughWall.factor);   // wallbang costs damage
  if (applied <= 0) return;
  target.armor = throughWall.factor >= 1 ? dmg.armor : target.armor;
  target.hp -= applied;
  target.lastDamageFrom = shooter;
  target.hurtBloom = Math.min(70, (target.hurtBloom || 0) + applied * (target.armor > 0 ? 0.45 : 0.9));
  if (target.isHuman) {
    damageFlash(applied); target.hitFlash = 0.3;
    const kick = applied * 0.0016 * (target.armor > 0 ? 0.6 : 1);   // aimpunch from being shot (not weapon recoil)
    target.pitch = THREE.MathUtils.clamp(target.pitch - kick, -1.5, 1.5);
    target.yaw += (Math.random() - 0.5) * kick * 1.4;
  }
  if (shooter.isHuman) { hitmarker(group === "head"); sfxHitmarker(group === "head", target.armor > 0 || target.helmet); addHitLog(group === "head" ? ("headshot for " + applied) : ("hit for " + applied), group === "head" ? "hs" : "hit"); }
  if (target.hp <= 0) killAgent(shooter, target, group, wkey);
  return applied;
}

export function killAgent(shooter, target, group, wkey) {
  if (!target.alive) return;
  target.alive = false; target.hp = 0; target.body.g.visible = false; target.deaths++;
  if (shooter && shooter !== target) { shooter.kills++; shooter.money = Math.min(ECON.max, shooter.money + (WEAPONS[wkey]?.kill || ECON.killReward)); }
  if (target.carrying) { target.carrying.carrier = null; target.carrying = null; }
  addKillFeed(shooter, target, wkey, group === "head");
  playBeep(140, 0.12);
  checkRoundEnd();
  if (target.isHuman) onHumanDeath();
}

export function visibleTo(a, t) {
  const from = eyePos(a);
  for (const g of ["chest", "head", "stomach"]) { if (losClear(from, hitboxCenter(t, g))) return true; }
  return false;
}

export function fireWeaponCommon(a) {
  const w = WEAPONS[a.cur]; const wp = a.weapons[a.cur];
  wp.ammo--; a.fireCd = 60 / w.rpm;
  // R8 Revolver: real CS2 cadence — primary is a slow hammer-cock shot, the fan
  // is quicker but still gated (no more machine-gun revolver).
  if (a.cur === "r8") a.fireCd = (a.fireMode === "fan") ? (w.cycleFan || 0.30) : (w.cyclePrimary || 0.25);
  a.lastShot = performance.now();
  const I = INACC[a.cur]; if (I) { a.firePenalty = Math.min(I.max, (a.firePenalty || 0) + I.fire); }
  if (a.cur === "r8" && a.fireMode === "fan") a.firePenalty = (a.firePenalty || 0) + 30;
  sfxFire(a);
}

export function hasAnyAmmo(a) { for (const k of [a.slotPrimary, a.slotSecondary]) { if (k && a.weapons[k] && ((a.weapons[k].ammo || 0) > 0 || (a.weapons[k].reserve || 0) > 0)) return true; } return false; }

/* Hitscan for HUMAN manual fire (no aimbot): raycast crosshair vs hitboxes + walls.
   Bullets now PENETRATE thin walls (reduced damage) and are STOPPED by walls too
   thick/dense for the weapon's penetration power. */
export function manualFire(a) {
  const origin = eyePos(a);
  const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(a.pitch, a.yaw, 0, 'YXZ'));
  let spread = computeBloom(a);
  if (a.cur === "r8" && a.fireMode === "fan") spread += 0.06;
  dir.x += (Math.random() - 0.5) * spread; dir.y += (Math.random() - 0.5) * spread; dir.z += (Math.random() - 0.5) * spread; dir.normalize();
  if (meshBackend.active) { const brk = meshBackend.breakWindowsAlong(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, 9000); if (brk && brk.center) sfxImpact(brk.center, true); }   // shatter glass in the line of fire
  // nearest enemy hitbox along the ray (walls accounted for afterwards via penetration)
  let best = null, bd = 9000, bg = null;
  for (const t of agents) {
    if (t === a || !t.alive || t.team === a.team) continue;
    for (const hb of hitboxes(t)) { const r = rayAABB(origin, dir, hb); if (r !== null && r < bd) { bd = r; best = t; bg = hb.group; } }
  }
  // first solid wall along the ray — from the MESH hull (cs_office) or procedural WALLS. Used for
  // tracer-stop + miss impacts; the damage gate is penetrate() below, same as the aimbot.
  let wallDist = 9000;
  if (meshBackend.active && meshBackend.bvh) { const h = meshBackend.bvh.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, 9000); if (h) wallDist = h.t; }
  else for (const wl of WALLS) { if (!wl.block || wl.mat < 0.4) continue; const r = segAABB(origin, dir, 9000, wl); if (r && r.enter > 1 && r.enter < wallDist) wallDist = r.enter; }
  const tracerStart = origin.clone().add(dir.clone().multiplyScalar(40));
  if (best) {
    const hitPt = hitboxCenter(best, bg);
    const dist = origin.distanceTo(hitPt);
    const through = penetrate(origin, hitPt, a.cur);         // wall(s) between us and target — limited exactly like the aimbot (no more shooting through the whole map)
    if (through.factor > 0 && !through.blocked) {
      addTracer(tracerStart, origin.clone().add(dir.clone().multiplyScalar(bd)));
      applyHit(a, best, bg, dist, through);                 // clean (factor 1) or wallbang (reduced)
      return;
    }
    const wp = origin.clone().add(dir.clone().multiplyScalar(Math.min(wallDist, bd)));   // too thick → bullet stops at wall
    addTracer(tracerStart, wp); addImpact(wp);
    if (a.isHuman) addHitLog("blocked — wall too thick", "inacc");
    return;
  }
  const end = origin.clone().add(dir.clone().multiplyScalar(Math.min(wallDist, 9000)));
  addTracer(tracerStart, end); addImpact(end);
  if (a.isHuman) { let near = false; for (const t of agents) { if (t.alive && t.team !== a.team && origin.distanceTo(t.pos) < 2500 && visibleTo(a, t)) { near = true; break; } } if (near) addHitLog("missed — inaccuracy", "inacc"); }
}

/* AIMBOT fire (bot or human-with-aimbot): aim at the best min-damage hitbox, then
   fire only when the shot is firable AND meets the configured min hit chance.
   Target/hitbox/min-damage/hit-chance selection is shared with auto-stop via
   canShoot(), so the two features engage under exactly the same conditions. */
export function aimbotFire(a) {
  const cb = a.cheats;
  const cs = canShoot(a);
  if (!cs.have) return false;                                // no min-damage hitbox to aim at
  const me = eyePos(a);
  const dirTo = cs.aimPoint.clone().sub(me).normalize();
  const wantYaw = Math.atan2(-dirTo.x, -dirTo.z), wantPitch = Math.asin(THREE.MathUtils.clamp(dirTo.y, -1, 1));
  if (!cb.aimbot.silent) { a.yaw = wantYaw; a.pitch = wantPitch; }
  a.realYaw = wantYaw;
  const w = WEAPONS[a.cur];
  if (w && w.scope && cb.aimbot.autoScope && !a.scoped) a.scoped = true;
  // fire only when the shot qualifies (firable + min hit chance) and off cooldown
  if (!cs.ok) return false;
  if (a.fireCd > 0) return false;
  if ((a.weapons[a.cur].ammo || 0) <= 0) { startReload(a); return false; }
  const dist = me.distanceTo(cs.aimPoint);
  fireWeaponCommon(a);
  addTracer(me.clone().add(dirTo.clone().multiplyScalar(40)), cs.aimPoint);
  if (meshBackend.active) { const brk = meshBackend.breakWindowsAlong(me.x, me.y, me.z, dirTo.x, dirTo.y, dirTo.z, dist + 60); if (brk && brk.center) sfxImpact(brk.center, true); }   // shatter glass in the line of fire
  // human lands at pure bloom accuracy (already past the min-hit-chance gate); a bot lands at
  // min(accuracy, persona skill) so distance/movement still matter but skilled bots stay lethal.
  const hitProb = a.isHuman ? cs.hitChance : Math.min(cs.hitChance, (cb.aimbot.hitchance || 100) / 100);
  if (Math.random() < hitProb) {
    applyHit(a, cs.tgt, cs.group, dist, cs.through);
  } else {
    if (a.isHuman) addHitLog("missed — inaccuracy", "inacc");
    addImpact(cs.aimPoint.clone().add(new THREE.Vector3((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40)));
  }
  return true;
}

/* melee: slash (stab=false) / stab (stab=true), with backstab bonus */
export function meleeAttack(a, stab, auto) {
  if (a.fireCd > 0) return false;
  const w = WEAPONS.knife;
  // scan for a target in range/front/LOS BEFORE making any noise
  const fwd = new THREE.Vector3(-Math.sin(a.yaw), 0, -Math.cos(a.yaw));
  const me = eyePos(a); let best = null, bd = w.knifeRange;
  for (const t of agents) {
    if (t === a || !t.alive || t.team === a.team) continue;
    const d = a.pos.distanceTo(t.pos); if (d > w.knifeRange) continue;
    const to = t.pos.clone().sub(a.pos).setY(0); if (to.lengthSq() < 1) { best = t; bd = 0; continue; } to.normalize();
    if (fwd.dot(to) < 0.35) continue;
    if (!losClear(me, hitboxCenter(t, "chest"))) continue;
    if (d < bd) { bd = d; best = t; }
  }
  // AUTO knife (cheat / bot out-of-ammo): only swing when something is actually in range — no
  // cooldown burned and NO sound when whiffing empty air. This is what stops the stab-sound loop.
  if (auto && !best) return false;
  a.fireCd = stab ? w.stabCd : w.slashCd; a.lastShot = performance.now();
  if (a.isHuman) sfxKnife(a, false);   // local swing (manual whiff still sounds; auto only reaches here with a target)
  if (!best) return false;
  const tf = new THREE.Vector3(-Math.sin(best.realYaw || best.yaw), 0, -Math.cos(best.realYaw || best.yaw));
  const toAtk = a.pos.clone().sub(best.pos).setY(0).normalize();
  const back = tf.dot(toAtk) < -0.1;
  let dmg = stab ? (back ? w.stabBack : w.stabFront) : (back ? w.slashBack : w.slashFront);
  if (best.armor > 0) dmg = Math.round(dmg * 0.85);
  best.hp -= dmg; best.lastDamageFrom = a;
  best.hurtBloom = Math.min(70, (best.hurtBloom || 0) + dmg);
  if (best.isHuman) { damageFlash(dmg); best.hitFlash = 0.3; }
  sfxKnife(a, true);   // connect
  if (a.isHuman) hitmarker(back);
  if (best.hp <= 0) killAgent(a, best, "chest", "knife");
  return true;
}

/* ---- weapons: give / switch / reload ---- */
export function giveWeapon(a, key) {
  const w = WEAPONS[key];
  a.weapons[key] = { ammo: w.mag, reserve: w.reserve };
  if (w.slot === 2) a.slotPrimary = key; else a.slotSecondary = key;
  selectBest(a);
}
export function selectBest(a) { a.cur = a.slotPrimary || a.slotSecondary; a.scoped = false; if (a.isHuman) { a.equippedNade = null; setViewmodel(a.cur, false); } }
export function switchTo(a, key) { if (a.weapons[key]) { a.cur = key; a.scoped = false; a.reloadT = 0; if (a.isHuman) { a.equippedNade = null; setViewmodel(key, false); } updateHUDWeapons(); } }
export function startReload(a) {
  if (a.reloadT > 0) return;
  const w = WEAPONS[a.cur]; if (!w || w.melee) return;
  const wp = a.weapons[a.cur]; if (!wp || wp.reserve <= 0 || wp.ammo >= w.mag) { if (a.isHuman && wp && wp.reserve <= 0 && wp.ammo <= 0) showHint("Out of ammo — press 3 for knife"); return; }
  a.reloadT = w.reload; a.reloadTotal = w.reload; a.scoped = false;
  a._reloadFor = a.cur;
  sfxReloadStart(a);
}
export function finishReload(a) {
  const key = a._reloadFor; const w = WEAPONS[key], wp = a.weapons[key]; if (!wp) return;
  const need = w.mag - wp.ammo; const take = Math.min(need, wp.reserve);
  wp.ammo += take; wp.reserve -= take;
  sfxReloadEnd(a);
  if (a.isHuman) updateHUDWeapons();
}
