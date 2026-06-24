/* ============================== [AI] ==============================
   Bot economy + HvH behaviour.  Goal selection is map-agnostic so bots can
   path on both cs_office and any custom (grid-nav) level.                  */
import * as THREE from 'three';
import { WEAPONS, TEAM, JUMP_VEL } from './data.js';
import { NODES, EDGES, RESCUE_ZONES, MAP_BOUNDS, astar, nearestNode, losClear } from './world.js';
import { hitboxCenter, eyePos } from './agents.js';
import { agents, GAME } from './state.js';
import { aimbotFire, moveAgent, meleeAttack, visibleTo, startReload, giveWeapon, hasAnyAmmo } from './combat.js';
import { liveHostages } from './game.js';

export function botBuy(a) {
  const rifle = a.team === TEAM.CT ? "scar" : "g3", cost = k => WEAPONS[k].cost;
  // ARMOR: buy kevlar+helmet whenever we'd still have a weapon's worth left — don't sit on cash
  if (a.armor <= 0) {
    if (a.money >= cost(rifle) + 1000 || a.money >= 1650) { a.armor = 100; a.helmet = true; a.money -= 1000; }
    else if (a.money >= 650) { a.armor = 100; a.money -= 650; }
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

const SEP_RADIUS = 56;   // ~one node-spacing; tight enough that spawn crowds don't shove each other into walls

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
function botMove(a, dir, dt, combat) {
  const sep = separation(a);
  const d = dir.clone().setY(0);
  if (sep) d.add(sep.multiplyScalar(0.35));   // weaker separation: it must nudge, not override the goal into a wall
  if (d.lengthSq() > 1e-4) d.normalize();
  const before = a.pos.clone();
  moveAgent(a, d, dt, combat);
  // "stuck" = not advancing toward the goal direction — catches a bot sliding sideways along a wall
  const dl = Math.hypot(dir.x, dir.z) || 1;
  const progress = ((a.pos.x - before.x) * dir.x + (a.pos.z - before.z) * dir.z) / dl;
  if (dir.lengthSq() > 1e-4 && progress < dt * 18) {
    a.aiStuck = (a.aiStuck || 0) + dt;
    if (a.aiStuck > 0.3 && a.onGround && a.aiState !== "fight") a.vel.y = JUMP_VEL;   // hop a ledge while roaming (not mid-fight — jumping ruins aim)
    if (a.aiStuck > 0.7 && a.aiState !== "fight") {
      // can't traverse this edge — TEMPORARILY cut it so A* routes around (e.g. the real doorway).
      // Skip the cut when a teammate is shoving us (separation false-positive); pruneEdge auto-heals
      // it and refuses to sever chain edges, so the graph can never fragment into a stalemate.
      if (a.aiPath && a.aiPath.length && !sep) pruneEdge(nearestNode(a.pos), a.aiPath[0]);
      a.aiPath = []; a.aiTimer = 0; a.yaw += (Math.random() - 0.5) * 1.5; a.aiStuck = 0;
    }
  } else a.aiStuck = 0;
}

// follow the a* path, skipping ahead to the furthest node with clear line of sight
// so bots cut straight across open rooms instead of zig-zagging between grid cells.
function followPath(a, dt, combat) {
  if (!a.aiPath.length || !NODES[a.aiPath[0]]) { a.aiPath = []; return; }
  while (a.aiPath.length > 1 && NODES[a.aiPath[1]] && losClear(eyePos(a), NODES[a.aiPath[1]].p)) a.aiPath.shift();
  const to = NODES[a.aiPath[0]].p.clone().sub(a.pos); to.y = 0;
  if (to.length() < 44) { a.aiPath.shift(); return; }   // tighter arrival to match the denser nav grid
  a.yaw = Math.atan2(-to.x, -to.z);
  botMove(a, to.normalize(), dt, combat);
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
  healEdges();   // restore any temporary nav cuts whose cooldown elapsed (keeps CT<->T connected)
  a.aiTimer -= dt;
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
      if (needRepath(a)) { navTo(a, nearestNode(target.pos)); a.aiTimer = 0.7 + Math.random() * 0.5; }
      followPath(a, dt, true);
      aimbotFire(a);                                  // still try — autowall punches thin walls; thick ones just won't fire
    } else {
      a.aiState = "fight"; a.aiNoContact = 0; a.aiLastSeen = target.pos.clone(); a.aiLastSeenT = 3;
      const style = a.persona ? a.persona.style : "peek";
      if (a.aiTimer <= 0) { a.aiStrafe *= -1; a.aiTimer = (style === "rush" ? 0.25 : 0.45) + Math.random() * 0.6; }
      const right = new THREE.Vector3(Math.cos(a.yaw), 0, -Math.sin(a.yaw));
      let desired;
      if (style === "passive") desired = bestd > 340 ? dirTo.clone().setY(0).normalize() : right.clone().multiplyScalar(a.aiStrafe * 0.5);
      else if (style === "rush" || style === "rage") desired = bestd > 260 ? dirTo.clone().setY(0).normalize() : right.clone().multiplyScalar(a.aiStrafe);
      else desired = bestd > 300 ? dirTo.clone().setY(0).normalize() : right.clone().multiplyScalar(a.aiStrafe);   // peek/passive now commit to a push at mid-range instead of camping
      // stop-to-shoot in engagement range (bloom drops); full speed only while still closing the gap
      a.speedScale = (bestd > 360) ? 1 : 0.28;
      botMove(a, desired, dt, true);
      aimbotFire(a);
    }
  } else {
    a.aiState = "roam"; a.aiTarget = null; a.scoped = false;
    a.aiNoContact = (a.aiNoContact || 0) + dt;                       // anti-camp clock: rises while we see no one
    if (a.aiLastSeenT > 0) a.aiLastSeenT -= dt;
    if (a.aiLastSeenT > 0 && a.aiLastSeen && a.pos.distanceTo(a.aiLastSeen) > 80) {
      // an enemy just broke line of sight — chase to where we last saw them instead of forgetting them
      if (needRepath(a)) { navTo(a, nearestNode(a.aiLastSeen)); a.aiTimer = 1 + Math.random(); }
    } else {
      a.aiLastSeen = null;
      if (needRepath(a)) { pickGoal(a); a.aiTimer = 2 + Math.random() * 2; }
    }
    followPath(a, dt, false);
    const wp = a.weapons[a.cur]; if (wp && wp.ammo <= 2 && wp.reserve > 0 && a.reloadT <= 0) startReload(a);
  }
}

function centerNode() { const cx = (MAP_BOUNDS.minX + MAP_BOUNDS.maxX) / 2, cz = (MAP_BOUNDS.minZ + MAP_BOUNDS.maxZ) / 2; return nearestNode(new THREE.Vector3(cx, 0, cz)); }
export function pickGoal(a) {
  let goalNode;
  const enemies = agents.filter(t => t.alive && t.team !== a.team);
  let near = null, nd = 1e9; for (const e of enemies) { const d = a.pos.distanceToSquared(e.pos); if (d < nd) { nd = d; near = e; } }
  // hvh deathmatch: hunt the nearest enemy so the teams actually meet and trade. Repathing toward the
  // enemy each cycle is self-reinforcing. The hunt chance RISES the longer a bot goes without contact
  // (anti-camp), and CT — which loses on the clock — is forced to push as the round timer runs down,
  // so rounds resolve instead of stalemating. The remainder drift to the contested CENTER, not spawn.
  const huntP = Math.min(0.95, 0.62 + (a.aiNoContact || 0) * 0.06);
  const lateCT = a.team === TEAM.CT && GAME.phase === "live" && GAME.timer < 35;
  if (near && (lateCT || (a.aiNoContact || 0) > 6 || Math.random() < huntP)) {
    goalNode = nearestNode(near.pos);
  } else if (a.team === TEAM.CT) {
    if (a.carrying && RESCUE_ZONES.length) goalNode = nearestNode(new THREE.Vector3(RESCUE_ZONES[0].x, 0, RESCUE_ZONES[0].z));
    else { const hs = liveHostages(); goalNode = hs.length ? nearestNode(hs[(Math.random() * hs.length) | 0].pos) : centerNode(); }
  } else {
    const h = liveHostages()[0];
    goalNode = (h && Math.random() < 0.5) ? nearestNode(h.pos) : centerNode();
  }
  navTo(a, goalNode);
}
