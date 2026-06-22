/* ============================== [COMBAT] ==============================
   Shooting, the CS2 inaccuracy/bloom model, damage application, aimbot &
   manual fire (with wall penetration), melee, movement, and the weapon
   give/switch/reload helpers.  This is where the gameplay fixes live.     */
import * as THREE from 'three';
import {
  WEAPONS, INACC, INACC_K, AIRBORNE_INACC, LAND_INACC, GRAVITY, JUMP_VEL,
  EYE_STAND, EYE_CROUCH, PLAYER_RADIUS, ECON, computeDamage,
} from './data.js';
import { WALLS, segAABB, rayAABB, penetrate, losClear, collideMove } from './world.js';
import { hitboxes, hitboxCenter, eyePos, setViewmodel } from './agents.js';
import { agents } from './state.js';
import { addTracer, addImpact } from './effects.js';
import { hitmarker, playHitmarker, addHitLog, damageFlash, updateHUDWeapons, playShot, playBeep, showHint, addKillFeed } from './hud.js';
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
  a.pos.x += a.vel.x * dt; a.pos.z += a.vel.z * dt; a.pos.y += a.vel.y * dt;
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

/* anti-aim "dodge" — probability a shot at the aimed point connects to the real hitbox */
export function resolveHitChance(shooter, target) {
  let base = (shooter.cheats.aimbot.hitchance || 50) / 100;
  if (target.alive && target.cheats.antiaim.on) {
    const aaStrength = (target.cheats.antiaim.desync ? (target.cheats.antiaim.desyncAngle / 58) : 0.4) *
      (target.cheats.antiaim.yaw === "jitter" || target.cheats.antiaim.yaw === "spin" ? 1.0 : 0.7);
    const resolve = shooter.cheats.resolver.on ? shooter.cheats.resolver.accuracy : 0.0;
    const bodyAim = shooter.cheats.aimbot.forceBody || shooter.cheats.aimbot.safepoint;
    const aaEff = aaStrength * (bodyAim ? 0.30 : 1.0);
    const beat = resolve - aaEff * 0.7;
    base *= THREE.MathUtils.clamp(0.5 + beat, bodyAim ? 0.55 : 0.12, 1.0);
  }
  return THREE.MathUtils.clamp(base, 0, 1);
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
  if (shooter.isHuman) { hitmarker(group === "head"); playHitmarker(group === "head"); addHitLog(group === "head" ? ("headshot for " + applied) : ("hit for " + applied), group === "head" ? "hs" : "hit"); }
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
  if (a.cur === "r8") a.fireCd = (a.fireMode === "fan") ? (w.cycleFan || 0.30) : (w.cyclePrimary || 0.40);
  a.lastShot = performance.now();
  const I = INACC[a.cur]; if (I) { a.firePenalty = Math.min(I.max, (a.firePenalty || 0) + I.fire); }
  if (a.cur === "r8" && a.fireMode === "fan") a.firePenalty = (a.firePenalty || 0) + 30;
  playShot(a.cur);
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
  // nearest enemy hitbox along the ray (walls accounted for afterwards via penetration)
  let best = null, bd = 9000, bg = null;
  for (const t of agents) {
    if (t === a || !t.alive || t.team === a.team) continue;
    for (const hb of hitboxes(t)) { const r = rayAABB(origin, dir, hb); if (r !== null && r < bd) { bd = r; best = t; bg = hb.group; } }
  }
  // nearest opaque blocking wall
  let wallDist = 9000;
  for (const wl of WALLS) { if (!wl.block || wl.mat < 0.4) continue; const r = segAABB(origin, dir, 9000, wl); if (r && r.enter > 1 && r.enter < wallDist) wallDist = r.enter; }
  const tracerStart = origin.clone().add(dir.clone().multiplyScalar(40));
  if (best) {
    const hitPt = hitboxCenter(best, bg);
    const dist = origin.distanceTo(hitPt);
    if (bd <= wallDist) {                                    // clean line — nothing in front
      addTracer(tracerStart, origin.clone().add(dir.clone().multiplyScalar(bd)));
      applyHit(a, best, bg, dist, { factor: 1, surfaces: 0, blocked: false });
      return;
    }
    const through = penetrate(origin, hitPt, a.cur);         // wall(s) between us and target
    if (through.factor > 0 && !through.blocked) {
      addTracer(tracerStart, origin.clone().add(dir.clone().multiplyScalar(bd)));
      applyHit(a, best, bg, dist, through);                 // wallbang with reduced damage
      return;
    }
    const wp = origin.clone().add(dir.clone().multiplyScalar(wallDist));   // too thick → bullet stops at wall
    addTracer(tracerStart, wp); addImpact(wp);
    if (a.isHuman) addHitLog("blocked — wall too thick", "inacc");
    return;
  }
  const end = origin.clone().add(dir.clone().multiplyScalar(Math.min(wallDist, 9000)));
  addTracer(tracerStart, end); addImpact(end);
  if (a.isHuman) { let near = false; for (const t of agents) { if (t.alive && t.team !== a.team && origin.distanceTo(t.pos) < 2500 && visibleTo(a, t)) { near = true; break; } } if (near) addHitLog("missed — inaccuracy", "inacc"); }
}

/* AIMBOT fire (bot or human-with-aimbot): pick target + hitbox, gate on
   min-damage / autowall-min-damage / hit-chance, then apply.  Min damage and
   hit chance are now strictly respected — if no hitbox meets the threshold the
   shot is NOT taken. */
export function aimbotFire(a) {
  const cb = a.cheats; const enemies = agents.filter(t => t.alive && t.team !== a.team);
  if (!enemies.length) return false;
  const me = eyePos(a);
  let cands = enemies.map(t => ({ t, d: me.distanceTo(t.pos), vis: visibleTo(a, t) }));
  cands = cands.filter(c => c.vis || cb.autowall.on);
  if (!cands.length) return false;
  if (cb.aimbot.target === "lowhp") cands.sort((x, y) => x.t.hp - y.t.hp);
  else if (cb.aimbot.target === "distance") cands.sort((x, y) => x.d - y.d);
  else {
    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(a.pitch, a.yaw, 0, 'YXZ'));
    cands.forEach(c => { const to = hitboxCenter(c.t, "chest").sub(me).normalize(); c.dot = fwd.dot(to); });
    cands.sort((x, y) => y.dot - x.dot);
  }
  const tgt = cands[0].t;
  const directVis = visibleTo(a, tgt);

  // hitbox search order (head/body priority, or forced body)
  const order = cb.aimbot.forceBody ? ["stomach", "chest", "legs"]
    : (cb.aimbot.priority === "head" ? ["head", "chest", "stomach"] : ["chest", "stomach", "head"]);
  // effective minimum damage that MUST be met to take the shot
  const minDmg = Math.max(cb.aimbot.minDmg || 1, !directVis ? (cb.autowall.minDmg || 1) : 1);

  // find the first hitbox whose (penetration-adjusted) damage meets the threshold
  let chosen = null, chosenThrough = null, chosenAim = null;
  for (const group of order) {
    const aimPoint = hitboxCenter(tgt, group);
    const dist = me.distanceTo(aimPoint);
    const through = penetrate(me, aimPoint, a.cur);
    if (!directVis) { if (!cb.autowall.on || through.blocked || through.factor <= 0) continue; }
    const base = computeDamage(a.cur, group, dist, tgt.armor > 0, tgt.helmet, tgt.armor);
    const dmg = Math.round(base.damage * (directVis ? 1 : through.factor));
    if (dmg >= minDmg) { chosen = group; chosenThrough = directVis ? { factor: 1, surfaces: 0, blocked: false } : through; chosenAim = aimPoint; break; }
  }
  if (!chosen) return false;   // nothing meets min damage / autowall min damage → don't fire

  // turn view toward the chosen aim point
  const dirTo = chosenAim.clone().sub(me).normalize();
  const wantYaw = Math.atan2(-dirTo.x, -dirTo.z), wantPitch = Math.asin(THREE.MathUtils.clamp(dirTo.y, -1, 1));
  if (!cb.aimbot.silent) { a.yaw = wantYaw; a.pitch = wantPitch; }
  a.realYaw = wantYaw;
  const w = WEAPONS[a.cur];
  if (w.scope && cb.aimbot.autoScope && !a.scoped) a.scoped = true;

  // fire gate
  if (a.fireCd > 0 || a.reloadT > 0) return false;
  if ((a.weapons[a.cur].ammo || 0) <= 0) { startReload(a); return false; }
  const dist = me.distanceTo(chosenAim);
  const hc = resolveHitChance(a, tgt);
  const sb = computeBloom(a);
  const accFactor = THREE.MathUtils.clamp(1 - Math.max(0, sb - 0.015) / 0.12, 0.06, 1);  // scoped+still ≈ 1
  fireWeaponCommon(a);
  addTracer(me.clone().add(dirTo.clone().multiplyScalar(40)), chosenAim);
  const roll = Math.random();
  if (roll < hc * accFactor) {
    applyHit(a, tgt, chosen, dist, chosenThrough);
  } else {
    if (a.isHuman) addHitLog(roll >= hc ? "missed — resolver" : "missed — inaccuracy", roll >= hc ? "resolver" : "inacc");
    addImpact(chosenAim.clone().add(new THREE.Vector3((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40)));
  }
  return true;
}

/* melee: slash (stab=false) / stab (stab=true), with backstab bonus */
export function meleeAttack(a, stab) {
  if (a.fireCd > 0) return false;
  const w = WEAPONS.knife; a.fireCd = stab ? w.stabCd : w.slashCd; a.lastShot = performance.now();
  playShot('knife');
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
  if (!best) return false;
  const tf = new THREE.Vector3(-Math.sin(best.realYaw || best.yaw), 0, -Math.cos(best.realYaw || best.yaw));
  const toAtk = a.pos.clone().sub(best.pos).setY(0).normalize();
  const back = tf.dot(toAtk) < -0.1;
  let dmg = stab ? (back ? w.stabBack : w.stabFront) : (back ? w.slashBack : w.slashFront);
  if (best.armor > 0) dmg = Math.round(dmg * 0.85);
  best.hp -= dmg; best.lastDamageFrom = a;
  best.hurtBloom = Math.min(70, (best.hurtBloom || 0) + dmg);
  if (best.isHuman) { damageFlash(dmg); best.hitFlash = 0.3; }
  if (a.isHuman) { hitmarker(back); playBeep(back ? 900 : 560, 0.05); }
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
}
export function finishReload(a) {
  const key = a._reloadFor; const w = WEAPONS[key], wp = a.weapons[key]; if (!wp) return;
  const need = w.mag - wp.ammo; const take = Math.min(need, wp.reserve);
  wp.ammo += take; wp.reserve -= take;
  if (a.isHuman) updateHUDWeapons();
}
