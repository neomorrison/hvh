/* ============================== [COMBAT] ==============================
   Shooting, the CS2 inaccuracy/bloom model, damage application, aimbot &
   manual fire (with wall penetration), melee, movement, and the weapon
   give/switch/reload helpers.  This is where the gameplay fixes live.     */
import * as THREE from 'three';
import {
  WEAPONS, INACC, INACC_K, AIRBORNE_INACC, LAND_INACC, GRAVITY, JUMP_VEL,
  EYE_STAND, EYE_CROUCH, PLAYER_RADIUS, ECON, computeDamage, TEAM, BHOP_MAX,
  TICK, MAX_BACKTRACK_TICKS, BT_SAMPLES, EXPOSE_TIME, SHIFT_MAX_TICKS, HIDE_SHOT_COST, SHIFT_REGEN, dtTicks,
} from './data.js';
import { WALLS, segAABB, rayAABB, penetrate, losClear, collideMove, MAP_BOUNDS, CT_SPAWNS, T_SPAWNS } from './world.js';
import { meshBackend } from './sourcemap.js';
import { hitboxes, hitboxCenter, eyePos, setViewmodel } from './agents.js';
import { agents, clock } from './state.js';
import { addTracer, addImpact, addShotLine } from './effects.js';
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
/* Fake duck is not free: holding the fake stance means spamming the duck key, and in CS that leaves you
   crawling.  It is the trade the setting is FOR — a very hard read, bought with your mobility. */
export const FAKEDUCK_SPEED = 0.34;
export function fakeDuckScale(a) {
  const aa = a.cheats && a.cheats.antiaim;
  return (aa && aa.on && aa.fakeduck) ? FAKEDUCK_SPEED : 1;
}
export function moveAgent(a, dirXZ, dt, combat) {
  const w = WEAPONS[a.cur] || { run: 240 };
  let speed = (a.scoped && w.scopedRun) ? w.scopedRun : (w.run || 240);
  if (a.crouch) speed *= 0.52;
  if (a.walk) speed *= 0.52;
  speed *= fakeDuckScale(a);
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
export function backtrackTicks(a) {
  const cfg = Math.min(MAX_BACKTRACK_TICKS, Math.max(0, (a.cheats.tickbase && a.cheats.tickbase.backtrack) | 0));
  // A tickbase shift that hasn't caught up yet has already spent the lag-compensation window: the
  // server is running your commands off-clock, so there is nothing left to rewind a target with.
  return Math.max(0, cfg - Math.ceil(a.shiftUsed || 0));
}

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

/* Decide which tick exploit (if any) this shot gets.  Exactly one, ever — see the note in data.js:
   double tap shifts the tickbase forward, hide shots shifts it backward, and a shot can't be both.
   Double tap takes priority when both are enabled, which is how real cheat menus resolve it, and it
   means a doubled shot is an EXPOSED shot.  Returns "dt" | "hidden" | "exposed". */
export function onShotFired(a) {
  const tb = a.cheats.tickbase || {}, aa = a.cheats.antiaim;
  a._dtPending = false;
  const dtc = dtTicks(a.cur, a.fireMode);
  const wantsDT = !!(tb.doubleTap && dtc);
  const wantsHide = !!(aa && aa.on && aa.desync && tb.hideShots);
  // a shift still in flight means the tickbase is already off-clock — no second trick until it lands
  if ((a.shiftUsed || 0) <= 0) {
    if (wantsDT && (a.shiftCharge || 0) >= dtc) {
      a.shiftCharge -= dtc; a.shiftUsed = dtc; a.shiftMode = "dt"; a._dtPending = true;
      expose(a);                                    // forward-shifted: the fake angle can't cover this one
      if (a.isHuman) addHitLog("double tap ×2", "hs");
      return "dt";
    }
    if (wantsHide && (a.shiftCharge || 0) >= HIDE_SHOT_COST) {
      a.shiftCharge -= HIDE_SHOT_COST; a.shiftUsed = HIDE_SHOT_COST; a.shiftMode = "hide"; a.hideFx = 0.25;
      return "hidden";
    }
  }
  expose(a);
  if (a.isHuman && (wantsHide || wantsDT)) addHitLog("no shift ticks — shot exposed", "inacc");
  return "exposed";
}
function expose(a) {
  a.exposeT = EXPOSE_TIME;
  // A shot that pins your real angles is the read every resolver actually lives on, so record when it
  // happened. Flipping the side afterwards does NOT hide you from that read — a resolver that saw the
  // exposure knows the flip is coming; what destroys the read is the side re-randomising later
  // (_sideStamp), which is why a fast side cadence is worth more than the flip.
  a._lastExpose = clock.t;
  a.desyncSide = -(a.desyncSide || 1);          // and don't come back on the SAME side afterwards
}

/* The second bullet of a double tap.  Both rounds are processed in the SAME server frame, so there is
   no recovery between them: the second one eats the first one's bloom and re-rolls independently.
   `resolve` is the caller's shot resolution (aimbot solution or manual raycast). */
export function fireDoubleTap(a, resolve) {
  if (!a._dtPending) return false;
  a._dtPending = false;
  const wp = a.weapons[a.cur];
  if (!wp || (wp.ammo || 0) <= 0) return false;
  wp.ammo--;
  const I = INACC[a.cur]; if (I) a.firePenalty = Math.min(I.max, (a.firePenalty || 0) + I.fire);
  sfxFire(a);
  resolve();
  return true;
}

/* Per-step tickbase bookkeeping: bleed the exposure window, refill the shift bank, and keep the desync
   side moving.  desyncSide never changed before, so every agent's fake was permanently on one side —
   a free read for any resolver.  It now flips on its own cadence (fast under jitter/spin AA). */
export function updateTickbase(a, dt) {
  if (a.exposeT > 0) a.exposeT -= dt;
  if (a.hideFx > 0) a.hideFx -= dt;
  // the server catches up on an off-clock tickbase at real time, one tick per tick
  if (a.shiftUsed > 0) { a.shiftUsed = Math.max(0, a.shiftUsed - dt / TICK); if (a.shiftUsed === 0) a.shiftMode = null; }
  a.shiftCharge = Math.min(SHIFT_MAX_TICKS, (a.shiftCharge || 0) + (dt / TICK) * SHIFT_REGEN);
  const aa = a.cheats.antiaim;
  if (!aa || !aa.on || !aa.desync) return;
  a._sideT = (a._sideT || 0) - dt;
  if (a._sideT <= 0) {
    const fast = aa.yaw === "jitter" || aa.yaw === "spin" || aa.yaw === "rand";
    a._sideT = (fast ? 0.10 : 0.32) + Math.random() * (fast ? 0.12 : 0.45);
    a._randYaw = (Math.random() * 2 - 1) * Math.PI;                 // the "rand" yaw mode's current fake angle
    const side = pickDesyncSide(a);
    // a re-roll is what actually destroys a resolver's read of your last exposure, so stamp it
    if (side !== a.desyncSide) { a.desyncSide = side; a._sideStamp = clock.t; }
  }
}

/* Which side the fake body stands on.
     · freestanding LOOKS AT THE MAP: it puts the fake where the nearest threat can see it and leaves
       the real body behind the corner, so an un-resolved shot goes into the wall you are peeking past.
       It is the mode that makes the desync angle do work rather than just flip a coin.
     · at_target keeps flipping, which is the old behaviour and still the right one when you are in the
       open and there is no corner to hide the real body behind. */
function pickDesyncSide(a) {
  const aa = a.cheats.antiaim, coin = () => (Math.random() < 0.5 ? 1 : -1);
  if (!aa || aa.mode !== "freestanding") return coin();
  let threat = null, bd = Infinity;
  for (const t of agents) { if (!t.alive || t.team === a.team || t === a) continue; const d = a.pos.distanceToSquared(t.pos); if (d < bd) { bd = d; threat = t; } }
  if (!threat) return coin();
  const from = eyePos(threat), mag = 30 * Math.sin((aa.desyncAngle || 0) * Math.PI / 180);
  if (mag <= 0) return coin();
  const chest = hitboxCenter(a, "chest"), dx = Math.cos(a.yaw) * mag, dz = -Math.sin(a.yaw) * mag;
  const seen = s => losClear(from, new THREE.Vector3(chest.x + dx * s, chest.y, chest.z + dz * s));
  const l = seen(1), r = seen(-1);
  return l === r ? coin() : (l ? 1 : -1);        // put the fake on the side they can actually shoot at
}

/* ================================ [RESOLVER] ================================
   The old resolver was one number: roll under `accuracy` and the desync is beaten, whatever the target
   was doing.  At 0.7-0.94 that made anti-aim decoration — you were hit anyway — and made the resolver
   the strongest cheat in the menu by a distance.  It now has to earn the read:

     · An enemy who fires WITHOUT hiding the shot pins its real angles.  That is a hard read and the
       resolver takes it: near-certain, for `memory` seconds, and only until the side re-randomises.
     · With no read it guesses, and the guess is degraded by how much work the target's anti-aim is
       doing (aaQuality: yaw mode, desync angle, fake duck, freestanding).
     · `brute` mode narrows the guess across repeated shots at the SAME target — it starts worse than
       animation and ends better, which is what brute force is.
     · `onshot` is nearly blind between exposures and excellent right after one.

   Net effect: a naked desync is still beaten most of the time, a good anti-aim that hides its shots is
   not, and the counter-play is "make them shoot" rather than "buy the resolver". */
export function aaQuality(a) {
  const aa = a.cheats.antiaim;
  if (!aa || !aa.on || !aa.desync) return 0;
  const yawQ = { back: 0.10, sideways: 0.20, sway: 0.26, spin: 0.34, rand: 0.36, jitter: 0.40 };
  let q = yawQ[aa.yaw] != null ? yawQ[aa.yaw] : 0.20;
  q += 0.14 * Math.min(1, (aa.desyncAngle || 0) / 58);        // a wider desync is a wider guess
  if (aa.fakeduck) q += 0.06;                                  // the fake is at the wrong HEIGHT too
  if (aa.pitch && aa.pitch !== "zero") q += 0.05;               // ...and pointing somewhere you are not
  if (aa.mode === "freestanding") q += 0.04;                   // the side is chosen, not rolled
  return Math.min(0.55, q);
}
/* brute force keeps a per-target read that decays: every miss narrows the next guess, a hit locks it
   in, and leaving the target alone for a moment loses it. */
function bruteRead(shooter, target) {
  const m = shooter._brute || (shooter._brute = new Map());
  let b = m.get(target);
  if (!b) { b = { n: 0, t: 0 }; m.set(target, b); }
  if (clock.t - b.t > 1.6) b.n = 0;                            // stale — the desync has moved on since
  b.t = clock.t;
  return b;
}
export function resolveDesync(shooter, target) {
  if (!target._desyncOff) return true;                         // no fake up — nothing to resolve
  const R = shooter.cheats.resolver || {};
  if (!R.on) return false;                                     // resolver off → the desync always wins
  const strength = R.strength != null ? R.strength : 0.6;
  const mode = R.mode || "animation";
  const fresh = target._lastExpose != null
    && (clock.t - target._lastExpose) < (R.memory != null ? R.memory : 0.55)
    && target._lastExpose >= (target._sideStamp || 0);         // the side hasn't re-rolled since the read
  const b = mode === "brute" ? bruteRead(shooter, target) : null;
  let p;
  if (fresh) p = strength + (1 - strength) * (mode === "onshot" ? 0.85 : 0.75);
  else {
    p = strength * (1 - aaQuality(target));
    if (mode === "brute") p = Math.min(0.9, p * 0.85 + b.n * 0.09);   // starts worse, converges
    else if (mode === "onshot") p *= 0.5;                             // blind between exposures
  }
  const ok = Math.random() < p;
  if (b) b.n = ok ? Math.max(b.n, 2) : Math.min(4, b.n + 1);
  return ok;
}

/* ============================ [SPREAD & HIT CHANCE] ============================
   CS offsets every bullet by  r·(cos φ, sin φ)  with  r = RandomFloat(0,1) · inaccuracy  — the radius
   scales LINEARLY with a uniform variate, so the cone is dense at the centre and thin at the rim.
   ONE implementation of that distribution is used by everything that fires (manual shots, the aimbot,
   and the hit-chance estimate), which is what makes the number the menu gates on an actual prediction
   of the bullet instead of a formula that happens to live next to it. */
const TAU = Math.PI * 2;
const _crRight = new THREE.Vector3(), _crUp = new THREE.Vector3(), _crTmp = new THREE.Vector3();
export function coneRay(dir, cone, r01, phi, out) {
  const o = (out || new THREE.Vector3()).copy(dir);
  if (!(cone > 0) || !(r01 > 0)) return o;
  _crTmp.set(0, 1, 0); if (Math.abs(dir.y) > 0.99) _crTmp.set(1, 0, 0);
  _crRight.crossVectors(dir, _crTmp).normalize();
  _crUp.crossVectors(_crRight, dir).normalize();
  const rad = cone * r01;                                     // small-angle: adding rad then renormalising IS an angle of ~rad
  return o.addScaledVector(_crRight, Math.cos(phi) * rad).addScaledVector(_crUp, Math.sin(phi) * rad).normalize();
}

/* The estimator walks a fixed set of quantiles of that same distribution instead of rolling dice, so
   the number doesn't shimmer frame to frame: radius (i+½)/N spans the uniform variate evenly and the
   golden angle keeps the directions from lining up into spokes. */
const HC_N = 32, _hcR = new Float64Array(HC_N), _hcPhi = new Float64Array(HC_N);
for (let i = 0; i < HC_N; i++) { _hcR[i] = (i + 0.5) / HC_N; _hcPhi[i] = i * Math.PI * (3 - Math.sqrt(5)); }
const _hcDir = new THREE.Vector3(), _hcRay = new THREE.Vector3();

/* Hit chance = the fraction of the spread cone that actually lands on the hitbox being aimed at,
   traced against the real box, times how much of that box the shooter can SEE (`exposure`).
   Two things follow from doing it this way rather than with the old cone-vs-radius ratio:
     · 100% is a claim, not a rounding.  It needs the whole cone inside the hitbox AND the whole
       silhouette out of cover — so at 100 min hit chance the aimbot holds fire almost always, and
       when it does fire the only thing left that can beat it is the resolver.
     · the estimate is the shot.  aimbotFire() rolls one ray out of this same cone against this same
       box, so "hit chance" is a prediction that can be checked rather than a number to trust. */
export function computeAccuracy(a, aimPoint, body, group, exposure) {
  const from = eyePos(a);
  _hcDir.copy(aimPoint).sub(from); const dist = _hcDir.length();
  if (dist < 1) return 1;
  _hcDir.multiplyScalar(1 / dist);
  const hb = hitboxes(body).find(h => h.group === group);
  if (!hb) return 0;
  const exp = exposure == null ? 1 : exposure;
  const cone = computeBloom(a);                              // bullet spread half-angle (radians)
  // the largest circle guaranteed to fit inside the box's silhouette from ANY angle — if the cone fits
  // inside that, every bullet in it is on the box and there is nothing to sample
  const rin = Math.min(hb.maxX - hb.minX, hb.maxY - hb.minY, hb.maxZ - hb.minZ) / 2;
  if (cone <= Math.atan2(rin, dist)) return exp;
  let hits = 0;
  for (let i = 0; i < HC_N; i++) {
    coneRay(_hcDir, cone, _hcR[i], _hcPhi[i], _hcRay);
    if (rayAABB(from, _hcRay, hb) !== null) hits++;
  }
  // N quantiles cannot PROVE the last slice of the cone, so a sampled estimate never claims certainty
  return Math.min(hits / HC_N, 1 - 1 / HC_N) * exp;
}

/* How much of the hitbox the shooter can actually see.  A cone tight enough to be a certainty still
   isn't one when half of it is buried in the corner you're peeking, so the silhouette's extremes are
   probed for line of sight and the coverage is scaled by how many came back clear.  Only meaningful on
   a directly visible solution — a wallbang is already gated on penetration damage. */
export function hitboxExposure(a, body, group) {
  const hb = hitboxes(body).find(h => h.group === group); if (!hb) return 0;
  const from = eyePos(a);
  const cx = (hb.minX + hb.maxX) / 2, cy = (hb.minY + hb.maxY) / 2, cz = (hb.minZ + hb.maxZ) / 2;
  const ex = (hb.maxX - hb.minX) * 0.4, ey = (hb.maxY - hb.minY) * 0.4, ez = (hb.maxZ - hb.minZ) * 0.4;
  const dx = cx - from.x, dz = cz - from.z, dl = Math.hypot(dx, dz) || 1;
  const sx = -dz / dl, sz = dx / dl;                         // across the line of sight, in the ground plane
  const half = Math.abs(sx) * ex + Math.abs(sz) * ez;
  let clear = 1;                                             // the centre is clear already — this only runs on a visible solution
  const P = [[cx + sx * half, cy, cz + sz * half], [cx - sx * half, cy, cz - sz * half], [cx, cy + ey, cz], [cx, cy - ey, cz]];
  for (const [px, py, pz] of P) if (losClear(from, _hcRay.set(px, py, pz))) clear++;
  return clear / (P.length + 1);
}

/* One bullet, traced. Returns the nearest hitbox of `body` the ray crosses, or null for a clean miss. */
export function traceHitbox(from, dir, body) {
  let bd = Infinity, bg = null;
  for (const hb of hitboxes(body)) { const r = rayAABB(from, dir, hb); if (r !== null && r < bd) { bd = r; bg = hb.group; } }
  return bg ? { group: bg, dist: bd, point: from.clone().addScaledVector(dir, bd) } : null;
}

/* Evaluate ONE candidate position of a target — either the live body or one of its recorded ticks.
   `ghost` only needs { pos, crouch }, which is all hitboxes()/hitboxCenter() read. */
function evalShot(a, tgt, ghost, order, cb) {
  const me = eyePos(a);
  const directVis = visibleTo(a, ghost);
  const none = { group: null, aimPoint: null, through: null, dmg: 0, exposure: 0 };
  const shots = [];
  for (const group of order) {
    const aimPoint = hitboxCenter(ghost, group);
    const through = directVis ? { factor: 1, surfaces: 0, blocked: false } : penetrate(me, aimPoint, a.cur);
    if (!directVis && (!cb.autowall.on || through.blocked || through.factor <= 0)) continue;
    const base = computeDamage(a.cur, group, me.distanceTo(aimPoint), tgt.armor > 0, tgt.helmet, tgt.armor);
    shots.push({ group, aimPoint, through, vis: directVis, dmg: Math.round(base.damage * through.factor) });
  }
  if (!shots.length) return none;
  // A wallbang keeps its hard min-damage gate — that's what min damage is FOR. A clear shot never
  // demands more damage than the gun can physically deliver here: a pistol round against armour would
  // otherwise leave a 30-min-damage bot standing there refusing to shoot at all.
  const want = directVis
    ? Math.min(cb.aimbot.minDmg || 1, Math.max(...shots.map(x => x.dmg)))
    : Math.max(cb.aimbot.minDmg || 1, cb.autowall.minDmg || 1);
  // the exposure probe costs four line-of-sight traces, so it is paid once, for the hitbox we settled on
  for (const x of shots) if (x.dmg >= want) { x.exposure = x.vis ? hitboxExposure(a, ghost, x.group) : 1; return x; }
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
  const res = { have: false, ok: false, tgt: null, body: null, group: null, aimPoint: null, through: null, dmg: 0, exposure: 1, hitChance: 0, btTicks: 0, rec: null, safepoint: false };
  const enemies = agents.filter(t => t.alive && t.team !== a.team);
  if (!enemies.length) return res;
  const me = eyePos(a);
  let cands = enemies.map(t => ({ t, d: me.distanceTo(t.pos), vis: visibleTo(a, t) })).filter(c => c.vis || cb.autowall.on || backtrackTicks(a) > 0);
  // AIMBOT FOV — the cone off your crosshair the bot is allowed to reach into. 180 is a rage bot that
  // takes anything; narrowing it makes the aimbot legit-looking and puts target choice back on you.
  const fov = cb.aimbot.fov != null ? cb.aimbot.fov : 180;
  if (fov < 180 && cands.length) {
    const look = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(a.pitch, a.yaw, 0, 'YXZ'));
    const cosHalf = Math.cos(Math.max(1, fov) * Math.PI / 360);
    const inFov = cands.filter(c => look.dot(hitboxCenter(c.t, "chest").sub(me).normalize()) >= cosHalf);
    if (inFov.length) cands = inFov; else return res;
  }
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
  // hit chance is measured against the BODY the solution belongs to — a rewound aim point on the live
  // hitboxes is a shot at where nobody is, which is what the old signature quietly asked for.
  const accOf = (x, body) => (x.group ? computeAccuracy(a, x.aimPoint, body, x.group, x.exposure) : 0);
  let best = evalShot(a, tgt, tgt, order, cb), bestBody = tgt, bestAcc = accOf(best, tgt), bestAge = 0, bestRec = null;
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
      const acc = accOf(alt, rec);
      if (acc > bestAcc) { best = alt; bestBody = rec; bestAcc = acc; bestAge = (tgt._tick | 0) - rec.tick; bestRec = rec; }
      if (bestAcc * 100 >= minHc) break;
    }
  }
  if (!best.group) return res;
  res.have = true; res.group = best.group; res.aimPoint = best.aimPoint; res.through = best.through; res.dmg = best.dmg;
  res.body = bestBody; res.exposure = best.exposure;
  res.btTicks = bestAge; res.rec = bestRec;
  // SAFEPOINT — the shot that does not care whether the resolver was right.  Against a desync there are
  // two places the target might be: where the resolver says (the aim point) and where the fake is (aim
  // point + the desync offset).  Aiming at the MIDDLE of the two leaves the same error either way, so a
  // wrong read no longer whiffs — it just costs you half the desync's width.  That is the whole trade:
  // a body shot that keeps landing, instead of a head shot that lands only when the resolver wins.  It
  // pays for itself in hit chance automatically, because the gate measures this shifted point.
  if (cb.aimbot.safepoint && tgt._desyncOff) {
    res.aimPoint = res.aimPoint.clone().addScaledVector(tgt._desyncOff, 0.5);
    res.safepoint = true;
  }
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
  res.hitChance = computeAccuracy(a, res.aimPoint, res.body, res.group, res.exposure);
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
  speed *= fakeDuckScale(a);
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
  const accAt = sc => { a.vel.x = full * sc; a.vel.z = 0; const acc = computeAccuracy(a, cs.aimPoint, cs.body, cs.group, cs.exposure); a.vel.x = vx; a.vel.z = vz; return acc; };
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
  coneRay(dir, spread, Math.random(), Math.random() * TAU, dir);    // same cone the hit-chance estimate samples

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
      const impact = origin.clone().add(dir.clone().multiplyScalar(bd));
      addTracer(tracerStart, impact); shotLine(a, origin, impact, true);
      applyHit(a, best, bg, dist, through);                 // clean (factor 1) or wallbang (reduced)
      return;
    }
    const wp = origin.clone().add(dir.clone().multiplyScalar(Math.min(wallDist, bd)));   // too thick → bullet stops at wall
    addTracer(tracerStart, wp); addImpact(wp); shotLine(a, origin, wp, false);
    if (a.isHuman) addHitLog("blocked — wall too thick", "inacc");
    return;
  }
  const end = origin.clone().add(dir.clone().multiplyScalar(Math.min(wallDist, 9000)));
  addTracer(tracerStart, end); addImpact(end); shotLine(a, origin, end, false);
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
  const body = cs.body || cs.tgt;          // the live target, or the recorded tick backtrack rewound it to
  // THE CONE THIS SHOT GOES OUT WITH IS THE ONE THE GATE APPROVED.  CS charges a shot's own bloom to
  // the NEXT shot, and fireWeaponCommon() adds it below — the old code rolled the bullet AFTER that,
  // against a cone the min-hit-chance gate had never seen.  That is why a 100% hit chance shot used to
  // fire constantly and then miss "due to inaccuracy": the gate approved the standing cone and the
  // bullet was rolled against the standing cone plus a full fire penalty.  At 100% now, the aimbot
  // holds fire until the whole cone is inside the hitbox and the hitbox is out of cover — and when it
  // does fire, the only thing left that can beat it is the resolver.
  const approved = computeBloom(a);
  // One bullet against the solution canShoot() picked, traced for real: same cone, same hitboxes, same
  // world as the estimate, so the hit chance is a prediction rather than an assertion.  Called twice
  // for a double tap — both rounds leave in the same server frame, so the second one gets the cone the
  // first one just widened.
  const resolve = (cone) => {
    if (!cs.tgt.alive) { addTracer(me.clone().add(dirTo.clone().multiplyScalar(40)), cs.aimPoint); addImpact(cs.aimPoint); return; }
    // RESOLVER vs a desyncing enemy: an un-resolved shot whiffs to the FAKE (rendered) side —
    // unless we took a safepoint, which is aimed between the two answers precisely so it doesn't.
    if (cs.tgt._desyncOff && !cs.safepoint && !resolveDesync(a, cs.tgt)) {
      const fake = cs.aimPoint.clone().add(cs.tgt._desyncOff);
      addTracer(me.clone().add(fake.clone().sub(me).normalize().multiplyScalar(40)), fake); addImpact(fake);
      shotLine(a, me, fake, false);
      if (a.isHuman) addHitLog("desync beat the resolver", "inacc");
      return;
    }
    const dir = coneRay(dirTo, cone, Math.random(), Math.random() * TAU, new THREE.Vector3());
    const hit = traceHitbox(me, dir, body);
    // a bullet that strays into the cover we were peeking past is stopped by it, exactly as the
    // exposure term in the hit chance said it might be
    const blocked = !!hit && cs.through.factor >= 1 && !losClear(me, hit.point);
    const end = (hit && !blocked) ? hit.point : me.clone().addScaledVector(dir, dist + 60);
    addTracer(me.clone().addScaledVector(dir, 40), end);
    if (cs.rec) cs.tgt._btMark = { pos: cs.rec.pos, crouch: cs.rec.crouch, life: 0.7 };   // the record we rewound to (drawn by the backtrack ghost visual)
    if (meshBackend.active) { const brk = meshBackend.breakWindowsAlong(me.x, me.y, me.z, dir.x, dir.y, dir.z, dist + 60); if (brk && brk.center) sfxImpact(brk.center, true); }   // shatter glass in the line of fire
    // Everyone lands at pure bloom accuracy. Bots used to have their roll capped by a persona "skill"
    // number on top of the accuracy they'd already earned, which made the player's identical cheat
    // strictly better than theirs — the 1-v-10 problem. Same maths for every agent now; a persona's
    // edge is its min hit chance, min damage, backtrack depth and resolver, not a secret handicap.
    if (hit && !blocked) {
      // the hitbox the BULLET found, not the one we aimed at — a round that strays off the head onto
      // the chest still does chest damage, which is the honest outcome of a cone that missed its mark
      applyHit(a, cs.tgt, hit.group, hit.dist, cs.through);
      if (a.isHuman && cs.btTicks > 0) addHitLog(`backtracked ${cs.btTicks} tick${cs.btTicks > 1 ? 's' : ''}`, "hs");
    } else {
      if (a.isHuman) addHitLog(blocked ? "clipped cover" : "missed — inaccuracy", "inacc");
      addImpact(end);
    }
    shotLine(a, me, end, !!(hit && !blocked));
  };
  fireWeaponCommon(a);          // arms _dtPending if this shot won a forward shift
  resolve(approved);
  fireDoubleTap(a, () => resolve(computeBloom(a)));
  return true;
}

/* Local shot lines: the beam the LOCAL player's own rounds leave behind, so you can see where a shot
   actually went after the tracer is long gone.  World-space and fixed at the muzzle it left from, so it
   stays put while you keep moving; `shotLineTime` in the config decides how long it takes to fade. */
function shotLine(a, from, to, hit) {
  if (!a.isHuman) return;
  const v = a.cheats.visuals || {};
  if (!v.shotLines) return;
  const fwd = new THREE.Vector3(-Math.sin(a.yaw), 0, -Math.cos(a.yaw));
  const start = from.clone().addScaledVector(new THREE.Vector3(-fwd.z, 0, fwd.x), 7).addScaledVector(fwd, 14); start.y -= 5;   // off the eye, roughly at the muzzle, so it is visible in first person
  addShotLine(start, to, v.shotLineTime != null ? v.shotLineTime : 1.5, hit ? (v.shotLineHit || '#ff4d6d') : (v.shotLineMiss || '#4dc3ff'));
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
