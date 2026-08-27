/* ============================== [COMBAT] ==============================
   Shooting, the CS2 inaccuracy/bloom model, damage application, aimbot &
   manual fire (with wall penetration), melee, movement, and the weapon
   give/switch/reload helpers.  This is where the gameplay fixes live.     */
import * as THREE from 'three';
import {
  WEAPONS, INACC, INACC_K, AIRBORNE_INACC, LAND_INACC, GRAVITY, JUMP_VEL,
  EYE_STAND, EYE_CROUCH, PLAYER_RADIUS, ECON, computeDamage, TEAM, BHOP_MAX,
  TICK, MAX_BACKTRACK_TICKS, BT_SAMPLES, EXPOSE_TIME, SHIFT_MAX_TICKS, HIDE_SHOT_COST, SHIFT_REGEN,
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
  // scoped auto-snipers are the MOST movement-punished (CS2): accuracy collapses almost the instant you
  // move, on a harsh linear ramp — so you must be standing still to land a scoped shot.
  const scopedSniper = w.scope && a.scoped;
  const thr = (scopedSniper ? 0.08 : 0.34) * maxSp;
  if (sp > thr) { const t = Math.min(1, (sp - thr) / (maxSp - thr)); base = base + (runTarget - base) * (scopedSniper ? t : t * t); }
  if (!a.onGround) base += AIRBORNE_INACC;
  // firing buildup + getting-shot flinch + post-landing penalty (can't snap-accurate on landing)
  const total = base + (a.firePenalty || 0) + (a.hurtBloom || 0) + (a.landBloom || 0);
  return total * INACC_K;
}

/* shared movement + physics for player and bots */
// body-vs-body solidity: moveAgent has no agent-vs-agent collision, so without this bots stack into a
// single point and freeze (the pile). Push each bot out of every agent it overlaps, every frame.
function depenetrateAgents(a) {
  if (a.isHuman) return false;             // don't shove the player's own camera around; bots push off the player instead
  const R = PLAYER_RADIUS * 2; let px = 0, pz = 0;
  for (const m of agents) {
    if (m === a || !m.alive) continue;
    const dx = a.pos.x - m.pos.x, dz = a.pos.z - m.pos.z, d2 = dx * dx + dz * dz;
    if (d2 >= R * R) continue;
    const share = m.isHuman ? 1 : 0.5;     // the player is immovable here → the bot takes the whole push
    if (d2 < 1) { const j = a._sepSeed != null ? a._sepSeed : (a._sepSeed = Math.random() * 6.283); px += Math.cos(j) * R * share; pz += Math.sin(j) * R * share; continue; }   // perfectly stacked → fixed jitter so the pile explodes apart
    const d = Math.sqrt(d2), pen = (R - d) * share;
    px += (dx / d) * pen; pz += (dz / d) * pen;
  }
  if (px === 0 && pz === 0) return false;
  a.pos.x += px; a.pos.z += pz; return true;
}
export function moveAgent(a, dirXZ, dt, combat) {
  const w = WEAPONS[a.cur] || { run: 240 };
  let speed = (a.scoped && w.scopedRun) ? w.scopedRun : (w.run || 240);
  if (a.crouch) speed *= 0.52;
  if (a.walk) speed *= 0.52;
  if (combat) speed *= 0.9;
  if (a.speedScale != null) speed *= a.speedScale;          // auto-stop (see autoStopScale — a partial slow, not a hard stop)
  if (a.bhopBoost) speed *= Math.min(BHOP_MAX, a.bhopBoost);   // bunny-hop chain speed boost (human only sets it)
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
      a.pos.y = g; a._landedThisFrame = !wasOnGround;   // touched ground THIS frame → a same-frame jump bhops
      if (!wasOnGround) { const impact = Math.min(1, Math.abs(descend) / JUMP_VEL); a.landBloom = Math.max(a.landBloom || 0, LAND_INACC * (0.45 + impact * 0.9)); }
      a.vel.y = 0; a.onGround = true;
    } else { a.onGround = false; a._landedThisFrame = false; }
    if (depenetrateAgents(a)) {   // body-vs-body push, then keep it out of walls
      [a.pos.x, a.pos.z] = meshBackend.pushOut(a.pos.x, a.pos.z, slideFeet, PLAYER_RADIUS, crouch);
      a.pos.x = Math.min(Math.max(a.pos.x, MAP_BOUNDS.minX + PLAYER_RADIUS), MAP_BOUNDS.maxX - PLAYER_RADIUS);
      a.pos.z = Math.min(Math.max(a.pos.z, MAP_BOUNDS.minZ + PLAYER_RADIUS), MAP_BOUNDS.maxZ - PLAYER_RADIUS);
    }
    a.eye = (a.crouch ? EYE_CROUCH : EYE_STAND) + a.pos.y;
    return;
  }
  if (a.pos.y < 0) {
    a.pos.y = 0; a._landedThisFrame = !wasOnGround;
    if (!wasOnGround) {                                      // just landed → landing inaccuracy
      const impact = Math.min(1, Math.abs(descend) / JUMP_VEL);
      a.landBloom = Math.max(a.landBloom || 0, LAND_INACC * (0.45 + impact * 0.9));
    }
    a.vel.y = 0; a.onGround = true;
  } else { a.onGround = false; a._landedThisFrame = false; }
  a.eye = (a.crouch ? EYE_CROUCH : EYE_STAND) + a.pos.y;
  depenetrateAgents(a);                                       // body-vs-body push
  collideMove(a.pos, PLAYER_RADIUS, a.pos.y, a.crouch ? 46 : 72);   // then re-resolve walls
}

/* ============================== [TICKBASE] ==============================
   Backtrack, hide shots and the desync side-flip all live off one thing: a per-agent ring buffer of
   recorded TICKS.  Ticks, not milliseconds — lag compensation on a real server keeps a fixed number
   of ticks of history and a cheat rewinds a target to one of THOSE, so a millisecond slider was never
   the right unit (and the old one wasn't wired to anything at all).                                  */

/* One simulation tick of history per agent.  Called for every agent, every step. */
export function recordTick(a, dt) {
  const tr = a.trail || (a.trail = []);
  if (!a.alive) { tr.length = 0; a._recAcc = 0; return; }          // you cannot rewind a corpse
  a._recAcc = (a._recAcc || 0) + dt;
  if (a._recAcc < TICK) return;
  a._recAcc = 0;                                                    // drop the remainder: one record per boundary, never a burst
  a._tick = (a._tick | 0) + 1;
  tr.push({ tick: a._tick, pos: a.pos.clone(), crouch: !!a.crouch, eye: a.eye });
  while (tr.length > MAX_BACKTRACK_TICKS) tr.shift();
}

/* The records `shooter` is still allowed to rewind `tgt` into, newest first, thinned to BT_SAMPLES
   so a 16-tick window doesn't cost 16 line-of-sight traces per bot per frame. */
function sampleTrail(tgt, ticks) {
  const tr = tgt.trail; if (!tr || !tr.length) return [];
  const cur = tgt._tick | 0, out = [];
  for (let i = tr.length - 1; i >= 0; i--) { const r = tr[i], age = cur - r.tick; if (age > ticks) break; if (age > 0) out.push(r); }
  if (out.length <= BT_SAMPLES) return out;
  const step = (out.length - 1) / (BT_SAMPLES - 1), picked = [];
  for (let i = 0; i < BT_SAMPLES; i++) picked.push(out[Math.round(i * step)]);
  return picked;
}
export function backtrackTicks(a) { return Math.min(MAX_BACKTRACK_TICKS, Math.max(0, (a.cheats.tickbase && a.cheats.tickbase.backtrack) | 0)); }

/* Rewinding only changes the answer if the target actually MOVED inside the window — against someone
   holding still every record is the same shot.  Pure arithmetic, so it's the cheap guard that keeps the
   line-of-sight work in sampleTrail() off the hot path for the (common) stationary case. */
function trailMoved(tgt, ticks) {
  const tr = tgt.trail; if (!tr || !tr.length) return false;
  const cur = tgt._tick | 0;
  for (let i = tr.length - 1; i >= 0; i--) {
    const r = tr[i]; if (cur - r.tick > ticks) break;
    if (r.pos.distanceToSquared(tgt.pos) > 576) return true;      // >24u ≈ 1.5 player radii apart
  }
  return false;
}

/* Firing normally PINS your real angles at whoever you're shooting — that is exactly why a desyncing
   player's head becomes readable the moment they take a shot.  Hide shots spends banked shift ticks to
   push the shot out while the fake angle is still up.  The bank refills at a fraction of real time
   (SHIFT_REGEN), so taps can be hidden and a spray can't.  Returns true if the shot was hidden. */
export function onShotFired(a) {
  const tb = a.cheats.tickbase || {}, aa = a.cheats.antiaim;
  const canHide = !!(aa && aa.on && aa.desync && tb.hideShots);
  if (canHide && (a.shiftCharge || 0) >= HIDE_SHOT_COST) { a.shiftCharge -= HIDE_SHOT_COST; a.hideFx = 0.25; return true; }
  a.exposeT = EXPOSE_TIME;
  a.desyncSide = -(a.desyncSide || 1);          // and don't come back on the SAME side afterwards
  if (a.isHuman && canHide) addHitLog("shot exposed — no shift ticks", "inacc");
  return false;
}

/* Per-step tickbase bookkeeping: bleed the exposure window, refill the shift bank, and keep the desync
   side moving.  desyncSide never changed before, so every agent's fake was permanently on one side —
   a free read for any resolver.  It now flips on its own cadence (fast under jitter/spin AA). */
export function updateTickbase(a, dt) {
  if (a.exposeT > 0) a.exposeT -= dt;
  if (a.hideFx > 0) a.hideFx -= dt;
  a.shiftCharge = Math.min(SHIFT_MAX_TICKS, (a.shiftCharge || 0) + (dt / TICK) * SHIFT_REGEN);
  const aa = a.cheats.antiaim;
  if (!aa || !aa.on || !aa.desync) return;
  a._sideT = (a._sideT || 0) - dt;
  if (a._sideT <= 0) {
    const fast = aa.yaw === "jitter" || aa.yaw === "spin";
    a._sideT = (fast ? 0.10 : 0.32) + Math.random() * (fast ? 0.12 : 0.45);
    a.desyncSide = Math.random() < 0.5 ? 1 : -1;
  }
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

/* Evaluate ONE candidate position of a target — either the live body or one of its recorded ticks.
   `ghost` only needs { pos, crouch }, which is all hitboxes()/hitboxCenter() read. */
function evalShot(a, tgt, ghost, order, cb) {
  const me = eyePos(a);
  const directVis = visibleTo(a, ghost);
  const none = { group: null, aimPoint: null, through: null, dmg: 0 };
  const shots = [];
  for (const group of order) {
    const aimPoint = hitboxCenter(ghost, group);
    const through = directVis ? { factor: 1, surfaces: 0, blocked: false } : penetrate(me, aimPoint, a.cur);
    if (!directVis && (!cb.autowall.on || through.blocked || through.factor <= 0)) continue;
    const base = computeDamage(a.cur, group, me.distanceTo(aimPoint), tgt.armor > 0, tgt.helmet, tgt.armor);
    shots.push({ group, aimPoint, through, dmg: Math.round(base.damage * through.factor) });
  }
  if (!shots.length) return none;
  // A wallbang keeps its hard min-damage gate — that's what min damage is FOR. A clear shot never
  // demands more damage than the gun can physically deliver here: a pistol round against armour would
  // otherwise leave a 30-min-damage bot standing there refusing to shoot at all.
  const want = directVis
    ? Math.min(cb.aimbot.minDmg || 1, Math.max(...shots.map(x => x.dmg)))
    : Math.max(cb.aimbot.minDmg || 1, cb.autowall.minDmg || 1);
  for (const x of shots) if (x.dmg >= want) return x;
  return none;
}

/* Shared "can I take this shot right now?" predicate used by BOTH auto-shoot and
   auto-stop so they agree exactly.  Picks the best target, then the best position of that target —
   live, or rewound through its backtrack records — and the first hitbox meeting min damage.
   Returns { have, ok, tgt, group, aimPoint, through, dmg, hitChance, btTicks, rec } where
     have = a min-damage hitbox exists to aim at,
     ok   = have AND firable (real gun, not reloading, has ammo) AND hitChance >= min. */
function selectShot(a) {
  const cb = a.cheats;
  const res = { have: false, ok: false, tgt: null, group: null, aimPoint: null, through: null, dmg: 0, hitChance: 0, btTicks: 0, rec: null };
  const enemies = agents.filter(t => t.alive && t.team !== a.team);
  if (!enemies.length) return res;
  const me = eyePos(a);
  let cands = enemies.map(t => ({ t, d: me.distanceTo(t.pos), vis: visibleTo(a, t) })).filter(c => c.vis || cb.autowall.on || backtrackTicks(a) > 0);
  if (!cands.length) return res;
  if (cb.aimbot.target === "lowhp") cands.sort((x, y) => x.t.hp - y.t.hp);
  else if (cb.aimbot.target === "distance") cands.sort((x, y) => x.d - y.d);
  else {
    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(a.pitch, a.yaw, 0, 'YXZ'));
    cands.forEach(c => { const to = hitboxCenter(c.t, "chest").sub(me).normalize(); c.dot = fwd.dot(to); });
    cands.sort((x, y) => y.dot - x.dot);
  }
  cands.sort((x, y) => (y.vis ? 1 : 0) - (x.vis ? 1 : 0));   // stable: a target we can actually see outranks one we can only rewind/wallbang
  const tgt = cands[0].t; res.tgt = tgt;
  let order = cb.aimbot.forceBody ? ["stomach", "chest", "legs"]
    : (cb.aimbot.priority === "head" ? ["head", "chest", "stomach"] : ["chest", "stomach", "head"]);
  // baim-if-lethal: if a body shot already KILLS, take the bigger/safer body hitbox instead of the head
  if (cb.aimbot.baimLethal && !cb.aimbot.forceBody && order[0] === "head") {
    const cd = me.distanceTo(hitboxCenter(tgt, "chest")), bodyDmg = computeDamage(a.cur, "chest", cd, tgt.armor > 0, tgt.helmet, tgt.armor).damage;
    if (bodyDmg >= tgt.hp) order = ["chest", "stomach", "head"];
  }
  const minHc = cb.aimbot.hitchance || 0;
  const accOf = x => (x.group ? computeAccuracy(a, x.aimPoint, tgt, x.group) : 0);
  let best = evalShot(a, tgt, tgt, order, cb), bestAcc = accOf(best), bestAge = 0, bestRec = null;
  // BACKTRACK — only when the live shot isn't already good enough. A peeker who is behind cover NOW
  // was standing in the open a few ticks ago; the server still accepts a hit on that tick.
  // ...but only when rewinding can actually change the answer: the live shot has to be failing AND the
  // target has to have moved during the window. Against someone standing still every recorded tick is
  // the same shot, and the fix for a merely-bloomed one is auto-stop, not time travel.
  const bt = backtrackTicks(a);
  if (bt > 0 && bestAcc * 100 < minHc && (!best.group || trailMoved(tgt, bt))) {
    for (const rec of sampleTrail(tgt, bt)) {
      const alt = evalShot(a, tgt, rec, order, cb);
      if (!alt.group) continue;
      const acc = accOf(alt);
      if (acc > bestAcc) { best = alt; bestAcc = acc; bestAge = (tgt._tick | 0) - rec.tick; bestRec = rec; }
      if (bestAcc * 100 >= minHc) break;
    }
  }
  if (!best.group) return res;
  res.have = true; res.group = best.group; res.aimPoint = best.aimPoint; res.through = best.through; res.dmg = best.dmg;
  res.btTicks = bestAge; res.rec = bestRec;
  return res;
}

/* Target/hitbox selection is the expensive half (line-of-sight traces + penetration), and it does not
   depend on how fast we're moving — so it's memoised for one simulation step.  Hit chance and the
   firable gate are re-derived on every call, because auto-stop's whole job is asking "what would the
   hit chance be if I were slower" between two calls in the SAME step. */
let _simFrame = 0;
export function beginSimFrame() { _simFrame++; }
export function canShoot(a) {
  let res = a._cs;
  if (a._csFrame !== _simFrame || !res || (res.tgt && !res.tgt.alive)) { res = selectShot(a); a._cs = res; a._csFrame = _simFrame; }
  res.hitChance = 0; res.ok = false;
  if (!res.have) return res;
  res.hitChance = computeAccuracy(a, res.aimPoint, res.tgt, res.group);
  const w = WEAPONS[a.cur];
  const firable = !!w && !w.melee && a.reloadT <= 0 && (a.weapons[a.cur]?.ammo || 0) > 0;
  // EVERYONE respects min hit chance now, bots included. Bots used to ignore it and spray at whatever
  // accuracy they happened to have, then had their hit roll CAPPED by their persona on top — which is
  // why one player's aimbot could hold off ten of them. Same gate, same rules, both sides.
  res.ok = firable && res.hitChance * 100 >= (a.cheats.aimbot.hitchance || 0);
  return res;
}

/* ---- auto-stop ----
   Not a hard stop: slow down EXACTLY as much as the configured min hit chance needs and no more, so
   you keep whatever movement the shot can afford instead of planting like a statue every time an enemy
   crosses the crosshair.  Returns a speed multiplier in [0,1]. */
export function baseMoveSpeed(a, combat) {
  const w = WEAPONS[a.cur] || { run: 240 };
  let speed = (a.scoped && w.scopedRun) ? w.scopedRun : (w.run || 240);
  if (a.crouch) speed *= 0.52;
  if (a.walk) speed *= 0.52;
  if (combat) speed *= 0.9;
  if (a.bhopBoost) speed *= Math.min(BHOP_MAX, a.bhopBoost);
  return speed;
}
export function autoStopScale(a, combat) {
  const w = WEAPONS[a.cur];
  if (!w || w.melee) return 1;                                     // never auto-stop on the knife
  const wp = a.weapons[a.cur];
  if (a.reloadT > 0 || !wp || (wp.ammo || 0) <= 0) return 1;
  const cs = canShoot(a);
  if (!cs.have || !cs.tgt) return 1;                               // nothing worth slowing down for
  const need = THREE.MathUtils.clamp((a.cheats.aimbot.hitchance || 0) / 100, 0, 1);
  if (need <= 0) return 1;
  const vx = a.vel.x, vz = a.vel.z, full = baseMoveSpeed(a, combat);
  const accAt = sc => { a.vel.x = full * sc; a.vel.z = 0; const acc = computeAccuracy(a, cs.aimPoint, cs.tgt, cs.group); a.vel.x = vx; a.vel.z = vz; return acc; };
  if (accAt(1) >= need) return 1;                                  // already accurate enough at full speed
  if (accAt(0) < need) return 1;                                   // even planted this shot isn't makeable — don't root for nothing, keep closing
  let lo = 0, hi = 1;
  for (let i = 0; i < 8; i++) { const mid = (lo + hi) / 2; if (accAt(mid) >= need) lo = mid; else hi = mid; }
  return lo;
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
  if (target.isHuman) {
    if (shooter && shooter !== target) addTracer(eyePos(shooter), hitboxCenter(target, "chest"), 0xff3030, 3);   // killing-shot tracer, lingers 3s on the death-cam
    onHumanDeath();
  }
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
  onShotFired(a);          // pins the real angles for a moment — unless hide shots pays for it
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
  // RESOLVER vs a desyncing enemy: an un-resolved shot whiffs to the FAKE (rendered) side. Resolver OFF →
  // the desync always beats you; resolver ON resolves with probability cb.resolver.accuracy (so it can
  // still be baited). Non-desyncing targets are unaffected (cs.tgt._desyncOff is null).
  if (cs.tgt._desyncOff) {
    const rp = cb.resolver.on ? (cb.resolver.accuracy != null ? cb.resolver.accuracy : 0.7) : 0;
    if (Math.random() >= rp) {
      const fake = cs.aimPoint.clone().add(cs.tgt._desyncOff);
      addTracer(me.clone().add(fake.clone().sub(me).normalize().multiplyScalar(40)), fake); addImpact(fake);
      if (a.isHuman) addHitLog("desync beat the resolver", "inacc");
      return true;
    }
  }
  addTracer(me.clone().add(dirTo.clone().multiplyScalar(40)), cs.aimPoint);
  if (cs.rec) cs.tgt._btMark = { pos: cs.rec.pos, crouch: cs.rec.crouch, life: 0.7 };   // the record we rewound to (drawn by the backtrack ghost visual)
  if (meshBackend.active) { const brk = meshBackend.breakWindowsAlong(me.x, me.y, me.z, dirTo.x, dirTo.y, dirTo.z, dist + 60); if (brk && brk.center) sfxImpact(brk.center, true); }   // shatter glass in the line of fire
  // Everyone lands at pure bloom accuracy. Bots used to have their roll capped by a persona "skill"
  // number on top of the accuracy they'd already earned, which made the player's identical cheat
  // strictly better than theirs — the 1-v-10 problem. Same maths for every agent now; a persona's
  // edge is its min hit chance, min damage, backtrack depth and resolver, not a secret handicap.
  if (Math.random() < cs.hitChance) {
    applyHit(a, cs.tgt, cs.group, dist, cs.through);
    if (a.isHuman && cs.btTicks > 0) addHitLog(`backtracked ${cs.btTicks} tick${cs.btTicks > 1 ? 's' : ''}`, "hs");
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
