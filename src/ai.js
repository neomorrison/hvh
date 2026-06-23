/* ============================== [AI] ==============================
   Bot economy + HvH behaviour.  Goal selection is map-agnostic so bots can
   path on both cs_office and any custom (grid-nav) level.                  */
import * as THREE from 'three';
import { WEAPONS, TEAM, JUMP_VEL } from './data.js';
import { NODES, EDGES, RESCUE_ZONES, MAP_BOUNDS, astar, nearestNode, losClear } from './world.js';
import { hitboxCenter, eyePos } from './agents.js';
import { agents } from './state.js';
import { aimbotFire, moveAgent, meleeAttack, visibleTo, startReload, giveWeapon, hasAnyAmmo } from './combat.js';
import { liveHostages } from './game.js';

export function botBuy(a) {
  const m = a.money;
  if (m >= 1000 && a.armor <= 0 && Math.random() < 0.85) { a.armor = 100; a.helmet = true; a.money -= 1000; }
  else if (m >= 650 && a.armor <= 0 && Math.random() < 0.6) { a.armor = 100; a.money -= 650; }
  let buy = null;
  const bias = a.persona && a.persona.wepBias;
  const biasKey = bias === "scar" ? (a.team === TEAM.CT ? "scar" : "g3") : bias === "g3" ? (a.team === TEAM.CT ? "scar" : "g3") : bias;
  if (biasKey && WEAPONS[biasKey] && m >= WEAPONS[biasKey].cost && Math.random() < 0.7) buy = biasKey;
  else if (m >= 5000 && Math.random() < 0.4) buy = a.team === TEAM.CT ? "scar" : "g3";
  else if (m >= 1700 && Math.random() < 0.5) buy = "ssg";
  else if (m >= 700 && Math.random() < 0.6) buy = "deagle";
  else if (m >= 600 && Math.random() < 0.4) buy = "r8";
  else if (m >= 300 && Math.random() < 0.3) buy = "duals";
  if (buy && a.money >= WEAPONS[buy].cost) { giveWeapon(a, buy); a.money -= WEAPONS[buy].cost; }
  if (a.money >= 300 && Math.random() < 0.4) { a.nades.he = 1; a.money -= 300; a.curNade = "he"; }
  if (a.money >= 200 && Math.random() < 0.3) { a.nades.flash = (a.nades.flash || 0) + 1; a.money -= 200; }
}

const SEP_RADIUS = 90;   // bots keep this much space from same-team bots to avoid bunching

function separation(a) {
  let sx = 0, sz = 0, n = 0;
  for (const m of agents) {
    if (m === a || !m.alive || m.team !== a.team) continue;
    const dx = a.pos.x - m.pos.x, dz = a.pos.z - m.pos.z, d2 = dx * dx + dz * dz;
    if (d2 > 1 && d2 < SEP_RADIUS * SEP_RADIUS) { const d = Math.sqrt(d2); sx += dx / d; sz += dz / d; n++; }
  }
  return n ? new THREE.Vector3(sx, 0, sz).normalize() : null;
}

// move along `dir` (blended with teammate separation) with stuck detection: hop a
// ledge/step, and if still wedged give up and repath.
function botMove(a, dir, dt, combat) {
  const sep = separation(a);
  const d = dir.clone().setY(0);
  if (sep) d.add(sep.multiplyScalar(0.6));
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
      // can't traverse this edge (a wall the nav wrongly bridged) — prune it so A* routes
      // around it (e.g. through the real doorway). Bots collectively self-heal the nav graph.
      if (a.aiPath && a.aiPath.length) {
        const cur = nearestNode(a.pos), nxt = a.aiPath[0];
        if (cur !== nxt) { if (EDGES[cur]) EDGES[cur] = EDGES[cur].filter(e => e !== nxt); if (EDGES[nxt]) EDGES[nxt] = EDGES[nxt].filter(e => e !== cur); }
      }
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
  if (to.length() < 72) { a.aiPath.shift(); return; }
  a.yaw = Math.atan2(-to.x, -to.z);
  botMove(a, to.normalize(), dt, combat);
}

export function botThink(a, dt) {
  if (!a.alive) return;
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
      else { if (!a.aiPath.length || a.aiTimer <= 0) { a.aiPath = astar(nearestNode(a.pos), nearestNode(kt.pos)); a.aiTimer = 1 + Math.random(); } followPath(a, dt, true); }
    } else { moveAgent(a, new THREE.Vector3(0, 0, 0), dt, true); meleeAttack(a, kd < 38); }
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
    for (const m of agents) { if (m !== a && m.team === a.team && m.alive && m.aiTarget === e) { score += 0.3; break; } }
    if (score > bestScore) { bestScore = score; target = e; }
  }

  if (target) {
    const bestd = a.pos.distanceTo(target.pos);
    a.aiState = "fight"; a.aiTarget = target;
    const dirTo = target.pos.clone().sub(a.pos);
    a.yaw = Math.atan2(-dirTo.x, -dirTo.z);
    a.pitch = -Math.asin(THREE.MathUtils.clamp((hitboxCenter(target, a.cheats.aimbot.priority).y - a.eye) / Math.max(1, bestd), -1, 1));
    const style = a.persona ? a.persona.style : "peek";
    if (a.aiTimer <= 0) { a.aiStrafe *= -1; a.aiTimer = (style === "rush" ? 0.25 : 0.45) + Math.random() * 0.6; }
    const right = new THREE.Vector3(Math.cos(a.yaw), 0, -Math.sin(a.yaw));
    let desired;
    if (style === "passive") desired = right.clone().multiplyScalar(a.aiStrafe * 0.4);
    else if (style === "rush" || style === "rage") desired = bestd > 260 ? dirTo.clone().setY(0).normalize() : right.clone().multiplyScalar(a.aiStrafe);
    else desired = bestd > 520 ? dirTo.clone().setY(0).normalize() : right.clone().multiplyScalar(a.aiStrafe);
    // stop-to-shoot: slow right down in engagement range so bloom drops enough to pass the hit-chance gate
    a.speedScale = ((style === "rush" || style === "rage") && bestd > 300) ? 1 : 0.28;
    botMove(a, desired, dt, true);
    aimbotFire(a);
  } else {
    a.aiState = "roam"; a.aiTarget = null; a.scoped = false;
    if (!a.aiPath.length || a.aiTimer <= 0) { pickGoal(a); a.aiTimer = 2 + Math.random() * 2; }
    followPath(a, dt, false);
    const wp = a.weapons[a.cur]; if (wp && wp.ammo <= 2 && wp.reserve > 0 && a.reloadT <= 0) startReload(a);
  }
}

function randomNodeId() { return NODES.length ? NODES[Math.floor(Math.random() * NODES.length)].id : 0; }
function centerNode() { const cx = (MAP_BOUNDS.minX + MAP_BOUNDS.maxX) / 2, cz = (MAP_BOUNDS.minZ + MAP_BOUNDS.maxZ) / 2; return nearestNode(new THREE.Vector3(cx, 0, cz)); }
export function pickGoal(a) {
  let goalNode;
  const enemies = agents.filter(t => t.alive && t.team !== a.team);
  // hvh deathmatch: mostly hunt the nearest enemy so the teams actually meet and trade.
  // Repathing toward the nearest enemy each cycle is self-reinforcing — it pulls them together.
  if (enemies.length && Math.random() < 0.7) {
    let near = enemies[0], nd = 1e9; for (const e of enemies) { const d = a.pos.distanceToSquared(e.pos); if (d < nd) { nd = d; near = e; } }
    goalNode = nearestNode(near.pos);
  } else if (a.team === TEAM.CT) {
    if (a.carrying && RESCUE_ZONES.length) goalNode = nearestNode(new THREE.Vector3(RESCUE_ZONES[0].x, 0, RESCUE_ZONES[0].z));
    else { const hs = liveHostages(); goalNode = hs.length ? nearestNode(hs[(Math.random() * hs.length) | 0].pos) : randomNodeId(); }
  } else {
    const h = liveHostages()[0];
    goalNode = (h && Math.random() < 0.5) ? nearestNode(h.pos) : randomNodeId();
  }
  a.aiPath = astar(nearestNode(a.pos), goalNode);
}
