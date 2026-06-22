/* ============================== [AI] ==============================
   Bot economy + HvH behaviour.  Goal selection is map-agnostic so bots can
   path on both cs_office and any custom (grid-nav) level.                  */
import * as THREE from 'three';
import { WEAPONS, TEAM } from './data.js';
import { NODES, RESCUE_ZONES, MAP_BOUNDS, astar, nearestNode } from './world.js';
import { hitboxCenter } from './agents.js';
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

export function botThink(a, dt) {
  if (!a.alive) return;
  a.aiTimer -= dt;
  const enemies = agents.filter(t => t.alive && t.team !== a.team);
  // OUT OF AMMO → auto-knife: hunt nearest enemy and slash
  if (!hasAnyAmmo(a) && enemies.length) {
    let kt = null, kd = 1e9; for (const e of enemies) { const d = a.pos.distanceTo(e.pos); if (d < kd) { kd = d; kt = e; } }
    a.aiState = "knife"; a.scoped = false; if (a.cur !== 'knife') a.cur = 'knife';
    a.yaw = Math.atan2(-(kt.pos.x - a.pos.x), -(kt.pos.z - a.pos.z)); a.realYaw = a.yaw; a.pitch = 0;
    if (kd > WEAPONS.knife.knifeRange * 0.8) {
      if (visibleTo(a, kt)) moveAgent(a, kt.pos.clone().sub(a.pos).setY(0).normalize(), dt, true);
      else {
        if (!a.aiPath.length || a.aiTimer <= 0) { a.aiPath = astar(nearestNode(a.pos), nearestNode(kt.pos)); a.aiTimer = 1 + Math.random(); }
        if (a.aiPath.length) { const n = NODES[a.aiPath[0]].p, to = n.clone().sub(a.pos).setY(0); if (to.length() < 80) a.aiPath.shift(); else { a.yaw = Math.atan2(-to.x, -to.z); moveAgent(a, to.normalize(), dt, true); } }
      }
    } else { moveAgent(a, new THREE.Vector3(0, 0, 0), dt, true); meleeAttack(a, kd < 38); }
    return;
  }
  let target = null, bestd = 1e9;
  for (const e of enemies) { if (visibleTo(a, e)) { const d = a.pos.distanceTo(e.pos); if (d < bestd) { bestd = d; target = e; } } }
  if (!target && a.cheats.autowall.on) { for (const e of enemies) { const d = a.pos.distanceTo(e.pos); if (d < 900 && d < bestd) { bestd = d; target = e; } } }

  if (target) {
    a.aiState = "fight"; a.aiTarget = target;
    const dirTo = target.pos.clone().sub(a.pos);
    a.yaw = Math.atan2(-dirTo.x, -dirTo.z);
    a.pitch = -Math.asin(THREE.MathUtils.clamp((hitboxCenter(target, a.cheats.aimbot.priority).y - a.eye) / Math.max(1, a.pos.distanceTo(target.pos)), -1, 1));
    const style = a.persona ? a.persona.style : "peek";
    if (a.aiTimer <= 0) { a.aiStrafe *= -1; a.aiTimer = (style === "rush" ? 0.25 : 0.45) + Math.random() * 0.6; }
    const right = new THREE.Vector3(Math.cos(a.yaw), 0, -Math.sin(a.yaw));
    let desired;
    if (style === "passive") desired = right.clone().multiplyScalar(a.aiStrafe * 0.4);
    else if (style === "rush" || style === "rage") desired = bestd > 260 ? dirTo.clone().setY(0).normalize() : right.clone().multiplyScalar(a.aiStrafe);
    else desired = bestd > 520 ? dirTo.clone().setY(0).normalize() : right.clone().multiplyScalar(a.aiStrafe);
    moveAgent(a, desired, dt, true);
    aimbotFire(a);
  } else {
    a.aiState = "roam"; a.scoped = false;
    if (!a.aiPath.length || a.aiTimer <= 0) { pickGoal(a); a.aiTimer = 2 + Math.random() * 2; }
    if (a.aiPath.length) {
      const next = NODES[a.aiPath[0]].p;
      const toNext = next.clone().sub(a.pos); toNext.y = 0;
      if (toNext.length() < 80) a.aiPath.shift();
      else { a.yaw = Math.atan2(-toNext.x, -toNext.z); moveAgent(a, toNext.normalize(), dt, false); }
    }
    const wp = a.weapons[a.cur]; if (wp && wp.ammo <= 2 && wp.reserve > 0 && a.reloadT <= 0) startReload(a);
  }
}

function randomNodeId() { return NODES.length ? NODES[Math.floor(Math.random() * NODES.length)].id : 0; }
function centerNode() { const cx = (MAP_BOUNDS.minX + MAP_BOUNDS.maxX) / 2, cz = (MAP_BOUNDS.minZ + MAP_BOUNDS.maxZ) / 2; return nearestNode(new THREE.Vector3(cx, 0, cz)); }
export function pickGoal(a) {
  let goalNode;
  if (a.team === TEAM.CT) {
    if (a.carrying && RESCUE_ZONES.length) goalNode = nearestNode(new THREE.Vector3(RESCUE_ZONES[0].x, 0, RESCUE_ZONES[0].z));
    else { const h = liveHostages()[0]; goalNode = h ? nearestNode(h.pos) : centerNode(); }
  } else {
    const h = liveHostages()[0]; goalNode = h ? nearestNode(h.pos) : randomNodeId();
    if (Math.random() < 0.4) goalNode = randomNodeId();
  }
  a.aiPath = astar(nearestNode(a.pos), goalNode);
}
