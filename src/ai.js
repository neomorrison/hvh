/* ============================== [AI] ==============================
   Bot economy + HvH behaviour.  Goal selection is map-agnostic so bots can
   path on both cs_office and any custom (grid-nav) level.                  */
import * as THREE from 'three';
import { WEAPONS, TEAM, JUMP_VEL } from './data.js';
import { NODES, EDGES, RESCUE_ZONES, MAP_BOUNDS, CT_SPAWNS, T_SPAWNS, astar, nearestNode, losClear } from './world.js';
import { hitboxCenter, eyePos } from './agents.js';
import { agents, GAME, clock } from './state.js';
import { aimbotFire, moveAgent, meleeAttack, visibleTo, startReload, giveWeapon, hasAnyAmmo, autoStopScale, applyFakeDuck, baseMoveSpeed } from './combat.js';
import { liveHostages, armorBuy } from './game.js';

export function botBuy(a) {
  const rifle = a.team === TEAM.CT ? "scar" : "g3", cost = k => WEAPONS[k].cost;
  // ARMOR: never re-buy what we already own. armorBuy() prices the CS2 way — a kept helmet makes a
  // vest top-up cost $650, not the full $1000, and full kit is simply not for sale.
  const kit = armorBuy(a, "kevhelm");
  if (kit) {
    if (a.money >= kit.cost + cost(rifle) || a.money >= kit.cost + 650) { a.armor = kit.armor; a.helmet = kit.helmet; a.money -= kit.cost; }
    else {
      const vest = armorBuy(a, "kevlar");
      if (vest && a.money >= vest.cost + 350) { a.armor = vest.armor; a.money -= vest.cost; }
    }
  }
  // BEST weapon we can afford — no saving. Rifle first, then autosniper, then a pistol upgrade.
  let buy = null;
  if (a.money >= cost(rifle)) buy = (Math.random() < 0.78) ? rifle : "ssg";       // mostly the rifle, sometimes a scout
  else if (a.money >= cost("ssg") && Math.random() < 0.7) buy = "ssg";
  else if (a.money >= cost("deagle")) buy = Math.random() < 0.65 ? "deagle" : "r8";
  else if (a.money >= cost("duals") && Math.random() < 0.7) buy = "duals";
  if (buy && a.money >= cost(buy)) { giveWeapon(a, buy); a.money -= cost(buy); }
  // grenades with whatever's left — one of each
  if (a.money >= 300 && !(a.nades.he > 0)) { a.nades.he = 1; a.money -= 300; a.curNade = a.curNade || "he"; }
  if (a.money >= 300 && !(a.nades.smoke > 0) && Math.random() < 0.45) { a.nades.smoke = 1; a.money -= 300; }
}

// Twelve bots at 56u of separation is twelve bots standing on top of each other: a player is 32u wide,
// so that radius only ever unstuck a literal overlap. At 150 a squad actually occupies a frontage.
const SEP_RADIUS = 150;
const SEP_ROAM = 0.9, SEP_FIGHT = 0.3;   // spread hard while moving; barely at all mid-fight, where the strafe matters

function separation(a) {
  let sx = 0, sz = 0, n = 0;
  for (const m of agents) {
    if (m === a || !m.alive || m.team !== a.team) continue;
    const dx = a.pos.x - m.pos.x, dz = a.pos.z - m.pos.z, d2 = dx * dx + dz * dz;
    if (d2 > 1 && d2 < SEP_RADIUS * SEP_RADIUS) { const d = Math.sqrt(d2); sx += dx / d; sz += dz / d; n++; }
  }
  return n ? new THREE.Vector3(sx, 0, sz).normalize() : null;
}

// ---- self-healing nav: temporary edge cuts ----
// The old code DELETED nav edges permanently and globally when a bot got stuck, so over a match the
// shared graph fragmented until the CT and T sides could no longer path to each other — bots then sat
// in cover forever (the stalemate). Now a cut is TEMPORARY (auto-heals after PRUNE_TTL), skips low-degree
// chain edges (the common sever case), is capped to PRUNE_MAX active cuts, and the whole graph is restored
// at round start. The degree guard isn't a true bridge test, so the TTL + cap + round-restore are the real
// safety net — at worst a stray cut degrades pathing for a few seconds, never permanently.
const PRUNED = [];
const PRUNE_TTL = 8000, PRUNE_MAX = 6;
function pruneEdge(u, v) {
  if (u === v || PRUNED.length >= PRUNE_MAX) return;
  if ((EDGES[u] || []).length <= 2 || (EDGES[v] || []).length <= 2) return;   // skip chain edges — those most easily sever the map
  if (EDGES[u]) EDGES[u] = EDGES[u].filter(e => e !== v);
  if (EDGES[v]) EDGES[v] = EDGES[v].filter(e => e !== u);
  PRUNED.push({ a: u, b: v, until: performance.now() + PRUNE_TTL });
}
export function healEdges() {                                  // restore cuts whose cooldown elapsed
  if (!PRUNED.length) return;
  const now = performance.now();
  for (let i = PRUNED.length - 1; i >= 0; i--) {
    if (now >= PRUNED[i].until) { const { a, b } = PRUNED[i]; if (EDGES[a] && !EDGES[a].includes(b)) EDGES[a].push(b); if (EDGES[b] && !EDGES[b].includes(a)) EDGES[b].push(a); PRUNED.splice(i, 1); }
  }
}
export function restoreAllEdges() {                            // round start: no degradation carries over
  for (const { a, b } of PRUNED) { if (EDGES[a] && !EDGES[a].includes(b)) EDGES[a].push(b); if (EDGES[b] && !EDGES[b].includes(a)) EDGES[b].push(a); }
  PRUNED.length = 0;
}

// move along `dir` (blended with teammate separation) with stuck detection: hop a
// ledge/step, and if still wedged give up and repath.
function botMove(a, dir, dt, combat, sepW) {
  const sep = separation(a);
  const d = dir.clone().setY(0);
  if (sep) d.add(sep.multiplyScalar(sepW != null ? sepW : SEP_FIGHT));
  if (d.lengthSq() > 1e-4) d.normalize();
  const before = a.pos.clone();
  moveAgent(a, d, dt, combat);
  a._hopCd = Math.max(0, (a._hopCd || 0) - dt);
  // "stuck" = not advancing toward the goal direction — catches a bot sliding sideways along a wall.
  // Measured against what the bot is TRYING to do, not a fixed 18u/s: auto-stop deliberately holds it
  // still to take a shot, and a fixed threshold reads that as wedged. A bot barely trying to move at
  // all (heavily auto-stopped, or planted for a wallbang) is not stuck, it is aiming.
  const dl = Math.hypot(dir.x, dir.z) || 1;
  const progress = ((a.pos.x - before.x) * dir.x + (a.pos.z - before.z) * dir.z) / dl;
  const intent = baseMoveSpeed(a, combat) * (a.speedScale != null ? a.speedScale : 1);
  if (dir.lengthSq() > 1e-4 && intent > 60 && progress < intent * dt * 0.25) {
    a.aiStuck = (a.aiStuck || 0) + dt;
    // ONE hop per cooldown, and only with both feet down. This used to fire every frame for as long as
    // the bot was stuck, so a single wedge on a door frame turned into continuous bunny-hopping in the
    // corner — which is what it looked like from the outside. A hop is an attempt to clear a ledge; if
    // it didn't work, the repath below is the answer, not hopping harder.
    if (a.aiStuck > 0.35 && a.onGround && a._hopCd <= 0 && a.aiState !== "fight" && (a.speedScale == null || a.speedScale > 0.8)) {
      a.vel.y = JUMP_VEL; a._hopCd = 0.9;
    }
    if (a.aiStuck > 0.7) {                                                            // genuinely wedged → unstick, even mid-fight
      // can't traverse this edge — TEMPORARILY cut it so A* routes around (e.g. the real doorway).
      // Skip the cut when a teammate is shoving us (separation false-positive); pruneEdge auto-heals
      // it and refuses to sever chain edges, so the graph can never fragment into a stalemate.
      if (a.aiPath && a.aiPath.length && !sep) pruneEdge(nearestNode(a.pos), a.aiPath[0]);
      a.aiPath = []; a.aiTimer = 0; a.aiStuck = 0; a._hopCd = 0.9;   // repathing is the fix — don't also hop at it
      if (a.aiState !== "fight") a.yaw += (Math.random() - 0.5) * 1.5;                // roaming: spin to a new heading
      else { const pl = Math.hypot(dir.z, dir.x) || 1, s = (Math.random() < 0.5 ? 1 : -1) * 2; a.pos.x += -dir.z / pl * s; a.pos.z += dir.x / pl * s; }   // mid-fight: tiny perpendicular sidestep off the corner (don't spin aim)
    }
  } else a.aiStuck = 0;
}

// follow the a* path, skipping ahead to the furthest node with clear line of sight
// so bots cut straight across open rooms instead of zig-zagging between grid cells.
function followPath(a, dt, combat, sepW) {
  if (!a.aiPath.length || !NODES[a.aiPath[0]]) { a.aiPath = []; return; }
  while (a.aiPath.length > 1 && NODES[a.aiPath[1]] && losClear(eyePos(a), NODES[a.aiPath[1]].p)) a.aiPath.shift();
  const to = NODES[a.aiPath[0]].p.clone().sub(a.pos); to.y = 0;
  if (to.length() < 44) { a.aiPath.shift(); return; }   // tighter arrival to match the denser nav grid
  a.yaw = Math.atan2(-to.x, -to.z);
  botMove(a, to.normalize(), dt, combat, sepW);
}

// path to a goal node. If it's unreachable (A* returns a 1-node degenerate path) flag aiPathFail so
// callers back off on aiTimer instead of re-running A* every frame (a stranded-bot CPU sink).
function navTo(a, goalNode) {
  const p = astar(nearestNode(a.pos), goalNode);
  a.aiPathFail = p.length <= 1;
  a.aiPath = a.aiPathFail ? [] : p;
}
const needRepath = a => a.aiTimer <= 0 || (!a.aiPath.length && !a.aiPathFail);   // empty path re-paths at once unless A* just failed

export function botThink(a, dt) {
  if (!a.alive) return;
  // a bot's "bind": it fake ducks while holding an angle on someone, never while repositioning —
  // the same judgement a player makes with the key
  a._fdActive = !!a.aiTarget && Math.hypot(a.vel.x, a.vel.z) < 40;
  applyFakeDuck(a);              // a bot running fake duck is really ducked too — same stance, same cost
  healEdges();   // restore any temporary nav cuts whose cooldown elapsed (keeps CT<->T connected)
  a.aiTimer -= dt;
  a.aiClock = (a.aiClock || 0) + dt;      // time since the round started — drives the staggered push
  a.speedScale = 1;
  const enemies = agents.filter(t => t.alive && t.team !== a.team);
  // OUT OF AMMO → auto-knife: hunt nearest enemy and slash
  if (!hasAnyAmmo(a) && enemies.length) {
    let kt = null, kd = 1e9; for (const e of enemies) { const d = a.pos.distanceTo(e.pos); if (d < kd) { kd = d; kt = e; } }
    a.aiState = "knife"; a.scoped = false; if (a.cur !== 'knife') a.cur = 'knife';
    a.yaw = Math.atan2(-(kt.pos.x - a.pos.x), -(kt.pos.z - a.pos.z)); a.realYaw = a.yaw; a.pitch = 0;
    if (kd > WEAPONS.knife.knifeRange * 0.8) {
      if (visibleTo(a, kt)) botMove(a, kt.pos.clone().sub(a.pos).setY(0).normalize(), dt, true);
      else { if (needRepath(a)) { navTo(a, nearestNode(kt.pos)); a.aiTimer = 1 + Math.random(); } followPath(a, dt, true); }
    } else { moveAgent(a, new THREE.Vector3(0, 0, 0), dt, true); meleeAttack(a, kd < 38, true); }
    return;
  }
  // weighted target selection: nearest, finish low HP, punish enemies aiming at us, focus-fire with team
  let target = null, bestScore = -1e9;
  for (const e of enemies) {
    const vis = visibleTo(a, e), d = a.pos.distanceTo(e.pos);
    if (!vis && !(a.cheats.autowall.on && d < 900)) continue;
    let score = 1 - d / 4000;
    if (e.hp < 40) score += 0.6;
    const ef = new THREE.Vector3(-Math.sin(e.yaw), 0, -Math.cos(e.yaw));
    const toMe = a.pos.clone().sub(e.pos).setY(0);
    if (toMe.lengthSq() > 1 && ef.dot(toMe.normalize()) > 0.9) score += 0.5;
    if (!vis) score -= 0.5;
    let foc = 0; for (const m of agents) { if (m !== a && m.team === a.team && m.alive && m.aiTarget === e) foc++; }
    if (foc > 0 && foc < 2) score += 0.3;   // mild focus-fire (pair up), but don't let the WHOLE team dogpile one enemy into a cluster
    if (score > bestScore) { bestScore = score; target = e; }
  }

  if (target) {
    const bestd = a.pos.distanceTo(target.pos);
    const seen = visibleTo(a, target);
    a.aiTarget = target;
    const dirTo = target.pos.clone().sub(a.pos);
    a.yaw = Math.atan2(-dirTo.x, -dirTo.z);
    a.pitch = -Math.asin(THREE.MathUtils.clamp((hitboxCenter(target, a.cheats.aimbot.priority).y - a.eye) / Math.max(1, bestd), -1, 1));
    if (!seen) {
      // we only "see" them through a wall (autowall) and can't actually land a shot — so NAVIGATE to a
      // real angle instead of freezing against the wall shooting it. Roam state keeps stuck-detection and
      // repathing active so a bot wedged on cover routes around it. THIS is what breaks the camp standoff.
      a.aiState = "roam";
      if (needRepath(a)) { navTo(a, nearestNode(target.pos)); if (a.aiPathFail) navTo(a, roamNode(a)); a.aiTimer = 0.7 + Math.random() * 0.5; }   // target unreachable → relocate to a fresh angle, not the wall
      // steady up for a wallbang, but never fully root: floored at 0.3 so a bot lining up a penetration
      // still walks toward a real angle instead of camping the wall (the stalemate this branch exists to break).
      // And it is on a CLOCK: after a second and a half of shooting at a wall without solving it, the
      // slow-down is abandoned entirely and the bot just goes and finds a real angle. Otherwise a bot
      // that can "see" someone through cover crawls in a corner indefinitely.
      a._wallHold = (a._wallHold || 0) + dt;
      if (a.cheats.aimbot.autoStop && a._wallHold < 1.5) a.speedScale = Math.max(0.3, autoStopScale(a, true, true));
      followPath(a, dt, true);
      aimbotFire(a);                                  // still try — autowall punches thin walls; thick ones just won't fire
    } else {
      a.aiState = "fight"; a.aiNoContact = 0; a._wallHold = 0; a.aiLastSeen = target.pos.clone(); a.aiLastSeenT = 3;
      const style = a.persona ? a.persona.style : "peek";
      if (a.aiTimer <= 0) { a.aiStrafe *= -1; a.aiTimer = (style === "rush" ? 0.25 : 0.45) + Math.random() * 0.6; }
      const right = new THREE.Vector3(Math.cos(a.yaw), 0, -Math.sin(a.yaw));
      let desired;
      if (style === "passive") desired = bestd > 340 ? dirTo.clone().setY(0).normalize() : right.clone().multiplyScalar(a.aiStrafe * 0.5);
      else if (style === "rush" || style === "rage") desired = bestd > 260 ? dirTo.clone().setY(0).normalize() : right.clone().multiplyScalar(a.aiStrafe);
      else desired = bestd > 300 ? dirTo.clone().setY(0).normalize() : right.clone().multiplyScalar(a.aiStrafe);   // peek/passive now commit to a push at mid-range instead of camping
      // AUTO-STOP: shed exactly the speed the bot's own min hit chance needs — no more. Same helper the
      // player's auto-stop uses, so a bot doesn't plant like a statue when a light slow would do.
      // Bots always pass keepClosing: planting only pays when planting actually buys the shot. Rooted on
      // a shot that a dead stop still can't make, a bot stands there forever — it can never improve,
      // because standing still was already its best option. Closing the gap can.
      a.speedScale = a.cheats.aimbot.autoStop ? autoStopScale(a, true, true) : ((bestd > 360) ? 1 : 0.28);
      botMove(a, desired, dt, true);
      aimbotFire(a);
    }
  } else {
    a.aiState = "roam"; a.aiTarget = null; a.scoped = false; a._wallHold = 0;
    a.aiNoContact = (a.aiNoContact || 0) + dt;                       // anti-camp clock: rises while we see no one
    if (a.aiLastSeenT > 0) a.aiLastSeenT -= dt;
    if (a.aiLastSeenT > 0 && a.aiLastSeen && a.pos.distanceTo(a.aiLastSeen) > 80) {
      // an enemy just broke line of sight — chase to where we last saw them instead of forgetting them
      if (needRepath(a)) { navTo(a, nearestNode(a.aiLastSeen)); if (a.aiPathFail) navTo(a, roamNode(a)); a.aiTimer = 1 + Math.random(); }
    } else {
      a.aiLastSeen = null;
      if (needRepath(a)) { pickGoal(a); a.aiTimer = 2 + Math.random() * 2; }
    }
    followPath(a, dt, false, SEP_ROAM);
    // A HOLDER that has arrived plants on its angle and watches it instead of drifting on into the pile.
    // This is the single biggest reason the team stops arriving everywhere as one body.
    if (a.aiRole === "hold" && !a.aiPath.length && (a.aiNoContact || 0) < 7) {
      a.aiTimer = Math.max(a.aiTimer, 2.5);
      const look = a.aiLastSeen || enemyAnchor(a);
      if (look) { a.yaw = Math.atan2(-(look.x - a.pos.x), -(look.z - a.pos.z)); a.realYaw = a.yaw; }
    }
    const wp = a.weapons[a.cur]; if (wp && wp.ammo <= 2 && wp.reserve > 0 && a.reloadT <= 0) startReload(a);
  }
}

/* ---- squad roles ----
   Every bot ran the identical routine — "walk at the nearest enemy" — so a 12-man team left spawn as one
   blob, arrived at one doorway, and died in one grenade. Roles and lanes are assigned per round: a pusher
   takes ground, a holder plants on an angle and watches it, a flanker works the side of the map its own
   team is NOT crowding. Departures are staggered so nobody leaves at the same second. */
export function assignRoles() {
  for (const side of [TEAM.CT, TEAM.T]) {
    const list = agents.filter(a => a.team === side);
    for (let i = list.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [list[i], list[j]] = [list[j], list[i]]; }
    list.forEach((a, i) => {
      a.aiRole = ["push", "hold", "push", "flank", "push", "push"][i % 6];
      a.aiLane = (i + 0.5) / list.length;                  // a stable LATERAL lane for the round
      // Keep the stagger short: the lanes do the spreading, and a long one only makes rounds crawl.
      a.aiPushAt = (a.aiRole === "push" ? 0.5 : 2) + Math.random() * 4;
      a.aiClock = 0; a.aiHoldSpot = null;
    });
  }
}

/* Lanes run ACROSS the map, depth runs along it. Slicing the map along the axis the two teams attack
   along makes a "lane" a depth band instead — the bot on band 0.1 sits in its own spawn all round and
   the one on 0.9 stands in the enemy's face, so the teams spread out and never meet. Keeping the two
   separate is what lets a team fan out sideways while still advancing. */
let _lanes = null, _lanesLen = -1, _ctAtLow = true;
function laneTable() {
  if (_lanes && _lanesLen === NODES.length) return _lanes;
  const lx = (MAP_BOUNDS.maxX - MAP_BOUNDS.minX) >= (MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ);
  const aLo = lx ? MAP_BOUNDS.minX : MAP_BOUNDS.minZ, aHi = lx ? MAP_BOUNDS.maxX : MAP_BOUNDS.maxZ;
  const cLo = lx ? MAP_BOUNDS.minZ : MAP_BOUNDS.minX, cHi = lx ? MAP_BOUNDS.maxZ : MAP_BOUNDS.maxX;
  const aSpan = Math.max(1, aHi - aLo), cSpan = Math.max(1, cHi - cLo);
  _lanes = NODES.map(n => ({ id: n.id, a: ((lx ? n.p.x : n.p.z) - aLo) / aSpan, c: ((lx ? n.p.z : n.p.x) - cLo) / cSpan }));
  let sum = 0; for (const p of CT_SPAWNS) sum += (lx ? p.x : p.z);
  _ctAtLow = !CT_SPAWNS.length || ((sum / CT_SPAWNS.length) - aLo) / aSpan < 0.5;
  _lanesLen = NODES.length;
  return _lanes;
}
const depthOf = (a, rec) => ((a.team === TEAM.CT) === _ctAtLow ? rec.a : 1 - rec.a);   // 0 = our end, 1 = theirs
function pickNode(a, lane, depth, laneW, depthW) {
  const tab = laneTable(); if (!tab.length) return 0;
  let best = tab[0].id, bestS = -1e18;
  for (const rec of tab) {
    const sc = -(Math.abs(rec.c - lane) * laneW + Math.abs(depthOf(a, rec) - depth) * depthW) + Math.random() * 0.03;
    if (sc > bestS) { bestS = sc; best = rec.id; }
  }
  return best;
}
function flankLane(a) {                                     // the side of the map our own team is not using
  const tab = laneTable(); if (!tab.length) return 0.5;
  const lx = (MAP_BOUNDS.maxX - MAP_BOUNDS.minX) >= (MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ);
  const cLo = lx ? MAP_BOUNDS.minZ : MAP_BOUNDS.minX, cHi = lx ? MAP_BOUNDS.maxZ : MAP_BOUNDS.maxX;
  let sum = 0, n = 0;
  for (const m of agents) { if (m === a || !m.alive || m.team !== a.team) continue; sum += ((lx ? m.pos.z : m.pos.x) - cLo) / Math.max(1, cHi - cLo); n++; }
  return (n ? sum / n : 0.5) < 0.5 ? 0.82 + Math.random() * 0.15 : 0.03 + Math.random() * 0.15;
}
function enemyAnchor(a) {                                   // roughly where the other team comes from
  const sp = a.team === TEAM.CT ? T_SPAWNS : CT_SPAWNS;
  if (!sp.length) return null;
  let x = 0, z = 0; for (const p of sp) { x += p.x; z += p.z; }
  return new THREE.Vector3(x / sp.length, 0, z / sp.length);
}
const botIndex = a => (a._botIdx != null ? a._botIdx : (a._botIdx = agents.indexOf(a)));
function roamNode(a) {                                      // fallback wander: own lane, drifting depth
  const lane = a.aiLane != null ? a.aiLane : ((botIndex(a) % 12) + 0.5) / 12;
  const depth = 0.5 + Math.sin(clock.t * 0.12 + botIndex(a) * 1.7) * 0.28;
  return pickNode(a, lane, depth, 1.0, 0.9);
}

export function pickGoal(a) {
  const enemies = agents.filter(t => t.alive && t.team !== a.team);
  let near = null, nd = 1e9;
  for (const e of enemies) { const d = a.pos.distanceToSquared(e.pos); if (d < nd) { nd = d; near = e; } }
  let role = a.aiRole || "push";
  const stale = a.aiNoContact || 0;
  const lateCT = a.team === TEAM.CT && GAME.phase === "live" && GAME.timer < 40;
  if (stale > 7 || lateCT) role = "push";                   // a holder nobody came for stops holding
  let hunters = 0; if (near) for (const m of agents) { if (m !== a && m.team === a.team && m.alive && m.aiTarget === near) hunters++; }

  // Anti-stalemate first: a quiet round, or a CT running out of clock, overrides roles entirely.
  if (near && hunters < 3 && (lateCT || stale > 8)) return navTo(a, nearestNode(near.pos));
  // Otherwise only pushers converge on an enemy, only after their own staggered start, and never more
  // than two onto the same one — that is what stops twelve bots arriving at one doorway together.
  const started = (a.aiClock || 0) > (a.aiPushAt || 0);
  if (near && hunters < 2 && role === "push" && started && Math.random() < 0.45 + stale * 0.05) return navTo(a, nearestNode(near.pos));
  if (a.team === TEAM.CT && a.carrying && RESCUE_ZONES.length) return navTo(a, nearestNode(new THREE.Vector3(RESCUE_ZONES[0].x, 0, RESCUE_ZONES[0].z)));
  if (Math.random() < 0.18 && liveHostages().length) { const hs = liveHostages(); return navTo(a, nearestNode(hs[(Math.random() * hs.length) | 0].pos)); }
  const lane = a.aiLane != null ? a.aiLane : 0.5;
  if (role === "flank") return navTo(a, pickNode(a, flankLane(a), 0.78, 1.4, 0.9));
  if (role === "hold") {
    if (a.aiHoldSpot == null) a.aiHoldSpot = pickNode(a, lane, 0.44, 1.2, 1.0);      // midfield angle in our own lane
    return navTo(a, a.aiHoldSpot);
  }
  return navTo(a, pickNode(a, lane, started ? 0.86 : 0.6, 1.0, 1.4));                // push: take our lane deep
}
