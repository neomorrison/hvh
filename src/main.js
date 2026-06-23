/* ============================== [MAIN] ==============================
   Input handling, the main loop, boot/deploy wiring, and the window.HVH
   debug/test surface.  This module imports everything and ties it together. */
import * as THREE from 'three';
import { scene, camera, renderer } from './core.js';
import { WEAPONS, TEAM, INACC, LAND_RECOVER, JUMP_VEL, ECON, computeDamage } from './data.js';
import { agents, refs, GAME, vm, clock, keys, input } from './state.js';
import { WALLS, NODES, EDGES, segAABB, losClear, penetrate } from './world.js';
import { updateEffects, nadeProjectiles } from './effects.js';
import { setViewmodel, updateAgentVisual, hitboxCenter, eyePos } from './agents.js';
import { manualFire, aimbotFire, fireWeaponCommon, meleeAttack, moveAgent, computeBloom, startReload, finishReload, switchTo, selectBest, visibleTo } from './combat.js';
import { botThink } from './ai.js';
import {
  openBuy, closeBuy, beginBuyToLive, awardWin, endRoundAdvance, startRound, buildTeams,
  updateHostages, updateNades, updateAreas, tryRescueInteract, equipGrenade, throwNade, liveHostages,
} from './game.js';
import {
  updateAllHUD, updateTopHUD, updatePlayerHUD, updateBotBars, updateHUDWeapons, drawRadar,
  updateESP, updateReloadRing, updateBloomRing, updateScopeOverlay, updateR8Hammer,
  renderScoreboard, centerMessage, showHint, showHintOnce, formatTime, buildCrosshair, anyPanelOpen, audio,
} from './hud.js';
import { toggleCheatMenu, buildCheatMenu, loadConfig, saveConfig, syncCheatUI } from './cheats.js';
import { buildDefaultMap, buildCustomMap, blankEditorMap } from './map.js';
import { openEditor, setDeployHandler, isEditorOpen } from './editor.js';
import { loadSourceMap } from './sourcemap_load.js';

const $ = s => document.querySelector(s);

/* ============================== input ============================== */
addEventListener('keydown', e => {
  if (e.code === "KeyI" && GAME.phase !== "editor") { toggleCheatMenu(); e.preventDefault(); return; }
  if (GAME.phase === "warmup" || GAME.phase === "editor") return;
  const human = refs.human;
  keys[e.code] = true;
  if (e.code === "KeyB") { const p = $("#buyPanel"); p.classList.contains("show") ? closeBuy() : openBuy(); }
  if (e.code === "Tab") { $("#sbPanel").classList.add("show"); renderScoreboard(); e.preventDefault(); }
  if (e.code === "Digit1") { human.equippedNade = null; if (human.slotSecondary) switchTo(human, human.slotSecondary); }
  if (e.code === "Digit2") { human.equippedNade = null; if (human.slotPrimary) switchTo(human, human.slotPrimary); }
  if (e.code === "Digit3") { human.equippedNade = null; switchTo(human, 'knife'); }
  if (e.code === "Digit4" || e.code === "KeyG") { equipGrenade(); }
  if (e.code === "KeyR") { startReload(human); }
  if (e.code === "KeyE") { tryRescueInteract(human); }
  if (e.code === "KeyV") { GAME.thirdPerson = !GAME.thirdPerson; showHint("Third person " + (GAME.thirdPerson ? "ON" : "OFF")); }
  const c = human.cheats;
  if (e.code === "F1") { c.aimbot.on = !c.aimbot.on; showHint("Aimbot " + (c.aimbot.on ? "ON" : "OFF")); syncCheatUI(); }
  if (e.code === "F2") { c.aimbot.forceBody = !c.aimbot.forceBody; showHint("Force baim " + (c.aimbot.forceBody ? "ON" : "OFF")); syncCheatUI(); }
  if (e.code === "F3") { c.aimbot.autoShoot = !c.aimbot.autoShoot; showHint("Triggerbot " + (c.aimbot.autoShoot ? "ON" : "OFF")); syncCheatUI(); }
  if (e.code === "F4") { c.autowall.on = !c.autowall.on; showHint("Autowall " + (c.autowall.on ? "ON" : "OFF")); syncCheatUI(); }
  if (e.code === "F5") { c.antiaim.on = !c.antiaim.on; showHint("Anti-aim " + (c.antiaim.on ? "ON" : "OFF")); syncCheatUI(); }
  if (e.code === "F6") { c.aimbot.autoStop = !c.aimbot.autoStop; showHint("Auto stop " + (c.aimbot.autoStop ? "ON" : "OFF")); syncCheatUI(); }
  if (e.code === "F7") { c.visuals.esp = !c.visuals.esp; showHint("ESP " + (c.visuals.esp ? "ON" : "OFF")); syncCheatUI(); }
  if (e.code === "F8") { c.visuals.chams = !c.visuals.chams; showHint("Chams " + (c.visuals.chams ? "ON" : "OFF")); syncCheatUI(); }
  // swallow browser shortcuts for game keys — most importantly Ctrl+W (closes the tab)
  if (["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ControlLeft", "ControlRight", "ShiftLeft", "KeyC", "Tab"].includes(e.code)) e.preventDefault();
  if (e.ctrlKey) e.preventDefault();
});
addEventListener('keyup', e => { keys[e.code] = false; if (e.code === "Tab") $("#sbPanel").classList.remove("show"); });

renderer.domElement.addEventListener('mousedown', e => { if (e.button === 0) { input.mouseDown = true; if (refs.human && refs.human.cur === "r8") refs.human.fireMode = "primary"; } if (e.button === 2) { input.rmbDown = true; onRMB(); } });
addEventListener('mouseup', e => { if (e.button === 0) input.mouseDown = false; if (e.button === 2) input.rmbDown = false; });
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== renderer.domElement || !refs.human || !refs.human.alive) return;
  const sens = 0.0022;
  refs.human.yaw -= e.movementX * sens; refs.human.pitch -= e.movementY * sens;
  refs.human.pitch = THREE.MathUtils.clamp(refs.human.pitch, -1.5, 1.5);
});
function onRMB() {
  const human = refs.human; if (!human.alive) return;
  const w = WEAPONS[human.cur];
  if (w.scope) human.scoped = !human.scoped;
  else if (human.cur === "glock") { human.glockBurst = !human.glockBurst; showHint("Glock " + (human.glockBurst ? "burst" : "semi")); }
  else if (human.cur === "r8") human.fireMode = "fan";
}
renderer.domElement.addEventListener('click', () => { if (GAME.phase !== "warmup" && GAME.phase !== "editor" && !anyPanelOpen()) renderer.domElement.requestPointerLock(); });

/* ============================== human control ============================== */
function humanMove(dt) {
  const human = refs.human;
  // crouch responds to Ctrl OR C (Ctrl+W can close the browser tab, so C is a safe duck key)
  human.crouch = !!(keys["ControlLeft"] || keys["ControlRight"] || keys["KeyC"]);
  human.walk = !!keys["ShiftLeft"];
  let f = 0, s = 0; if (keys["KeyW"]) f++; if (keys["KeyS"]) f--; if (keys["KeyA"]) s--; if (keys["KeyD"]) s++;
  const fwd = new THREE.Vector3(-Math.sin(human.yaw), 0, -Math.cos(human.yaw));
  const right = new THREE.Vector3(Math.cos(human.yaw), 0, -Math.sin(human.yaw));
  const dir = fwd.multiplyScalar(f).add(right.multiplyScalar(s));
  if (keys["Space"] && human.onGround) human.vel.y = JUMP_VEL;
  human.realYaw = human.yaw;
  human.speedScale = 1;
  const c = human.cheats;
  if (c.aimbot.on && c.aimbot.autoStop && human.onGround && human.reloadT <= 0) {
    let see = false; for (const e of agents) { if (e.alive && e.team !== human.team && visibleTo(human, e)) { see = true; break; } }
    if (see) human.speedScale = THREE.MathUtils.clamp(1 - c.aimbot.hitchance / 100, 0.0, 1);
  }
  moveAgent(human, dir, dt, false);
}

function humanShoot(dt) {
  const human = refs.human;
  if (!human.alive) return;
  const md = input.mouseDown, rmb = input.rmbDown;
  // grenade equipped → left-click throws, then back to gun
  if (human.equippedNade) {
    if (md && human.fireCd <= 0) {
      const key = human.equippedNade;
      if (throwNade(human, key)) {
        human.fireCd = 0.8; input.mouseDown = false;
        human.equippedNade = human.nades[key] > 0 ? key : null;
        if (!human.equippedNade) { selectBest(human); setViewmodel(human.cur, false); } else setViewmodel(human.equippedNade, true);
        updateHUDWeapons();
      }
    }
    return;
  }
  // knife
  if (WEAPONS[human.cur] && WEAPONS[human.cur].melee) {
    const c2 = human.cheats;
    if (c2.aimbot.on && c2.aimbot.autoKnife) { if (human.fireCd <= 0) meleeAttack(human, false); return; }
    if (human.fireCd <= 0) { if (md) meleeAttack(human, false); else if (rmb) meleeAttack(human, true); }
    return;
  }
  // R8 Revolver: primary = hold to cock, fires at full draw; RMB = fan
  if (human.cur === "r8" && human.reloadT <= 0) {
    const wp8 = human.weapons.r8; if (!wp8) return; const c8 = human.cheats; const COCK = WEAPONS.r8.cockTime || 0.4;
    if (rmb) {
      human.r8Charge = 0;
      if (human.fireCd <= 0) { if (wp8.ammo <= 0) { startReload(human); return; } human.fireMode = "fan"; fireWeaponCommon(human); manualFire(human); updateHUDWeapons(); }
      return;
    }
    if (c8.aimbot.on && c8.aimbot.autoRevolver) {
      human.r8Charge = Math.min(0.97, (human.r8Charge || 0) + dt / COCK);
      if (human.fireCd <= 0 && human.r8Charge >= 0.9) { if (wp8.ammo <= 0) { startReload(human); return; } human.fireMode = "primary"; human.r8Charge = 1; if (aimbotFire(human)) human.r8Charge = 0; updateHUDWeapons(); }
      return;
    }
    if (c8.aimbot.on) {
      if (md || c8.aimbot.autoShoot) {
        human.r8Charge = Math.min(1, (human.r8Charge || 0) + dt / COCK);
        if (human.r8Charge >= 1 && human.fireCd <= 0) { if (wp8.ammo <= 0) { startReload(human); return; } human.fireMode = "primary"; if (aimbotFire(human)) human.r8Charge = 0; updateHUDWeapons(); }
      } else human.r8Charge = Math.max(0, (human.r8Charge || 0) - dt / COCK * 2);
      return;
    }
    if (md) {
      human.r8Charge = Math.min(1, (human.r8Charge || 0) + dt / COCK);
      if (human.r8Charge >= 1 && human.fireCd <= 0) { if (wp8.ammo <= 0) { startReload(human); human.r8Charge = 0; return; } human.fireMode = "primary"; fireWeaponCommon(human); manualFire(human); human.r8Charge = 0; updateHUDWeapons(); }
    } else human.r8Charge = Math.max(0, (human.r8Charge || 0) - dt / COCK * 2);
    return;
  }
  if (human.fireCd > 0 || human.reloadT > 0) return;
  const wp = human.weapons[human.cur]; if (!wp) return;
  const c = human.cheats;
  if (c.aimbot.on && (md || c.aimbot.autoShoot)) {
    if (wp.ammo <= 0) { startReload(human); return; }
    if (aimbotFire(human)) { updateHUDWeapons(); return; }
  }
  const r8fan = human.cur === "r8" && rmb;
  if (md || r8fan || (human.glockBurst && human.burstQ > 0)) {
    if (wp.ammo <= 0) { startReload(human); return; }
    human.fireMode = r8fan ? "fan" : "primary";
    fireWeaponCommon(human); manualFire(human);
    if (human.cur === "glock" && human.glockBurst) human.burstQ = human.burstQ > 0 ? human.burstQ - 1 : 2;
    if (!WEAPONS[human.cur].auto && !human.glockBurst && !r8fan) input.mouseDown = false;  // semi-auto: one click one shot
    updateHUDWeapons();
  }
}

/* ============================== main loop ============================== */
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  let dt = Math.min(0.05, (now - last) / 1000); last = now; clock.t += dt;
  if (GAME.phase !== "warmup" && GAME.phase !== "editor") step(dt);
  render();
}
export function step(dt) {
  if (GAME.phase === "buy") { GAME.freeze -= dt; if (GAME.freeze <= 0) beginBuyToLive(); }
  else if (GAME.phase === "live") { GAME.timer -= dt; if (GAME.timer <= 0) awardWin(TEAM.T, "time"); }
  else if (GAME.phase === "end") { GAME.timer -= dt; if (GAME.timer <= 0) endRoundAdvance(); }

  for (const a of agents) {
    if (a.fireCd > 0) a.fireCd -= dt;
    if (a.reloadT > 0) { a.reloadT -= dt; if (a.reloadT <= 0) finishReload(a); }
    if (a.flashT > 0) a.flashT -= dt;
    if (a.firePenalty > 0) { const I = INACC[a.cur]; const rec = I ? (a.crouch ? I.recov * 0.7 : I.recov) : 0.35; a.firePenalty *= Math.pow(0.5, dt / rec); if (a.firePenalty < 0.05) a.firePenalty = 0; }
    if (a.hurtBloom > 0) { a.hurtBloom *= Math.pow(0.5, dt / 0.18); if (a.hurtBloom < 0.05) a.hurtBloom = 0; }
    if (a.landBloom > 0) { a.landBloom = Math.max(0, a.landBloom - LAND_RECOVER * dt); }   // landing inaccuracy bleeds off
    if (a.alive && a.reloadT <= 0 && a.cur && a.weapons[a.cur] && a.weapons[a.cur].ammo <= 0 && a.weapons[a.cur].reserve > 0 && !(a.isHuman && a.equippedNade)) startReload(a);
  }

  const human = refs.human;
  if (human.alive && GAME.phase !== "end") {
    humanMove(dt);
    if (GAME.phase === "live") humanShoot(dt);
  }
  const canAct = GAME.phase === "live";
  for (const a of agents) {
    if (a.isHuman) continue;
    if (GAME.phase === "buy") a.body.g.position.copy(a.pos);
    else if (canAct) botThink(a, dt);
  }
  updateHostages(dt); updateNades(dt); updateAreas(dt); updateEffects(dt);
  for (const a of agents) updateAgentVisual(a);
  updateESP(); updateReloadRing(); updateBloomRing(); updateScopeOverlay(); updateR8Hammer();
  updateCamera();
  updateTopHUD(); updatePlayerHUD(); updateBotBars(); updateHUDWeapons();
  $("#roundTimer").textContent = formatTime(GAME.phase === "buy" ? GAME.freeze : GAME.timer);
  $("#phaseBanner").textContent = GAME.phase === "buy" ? "BUY" : (GAME.phase === "end" ? "ROUND OVER" : "");
  if (human.alive && human.team === TEAM.CT && !human.carrying) { for (const h of liveHostages()) { if (human.pos.distanceTo(h.pos) < 70) { showHintOnce("Press E to grab hostage"); break; } } }
  drawRadar();
}
function updateCamera() {
  const human = refs.human;
  if (human.alive) {
    const scopedNow = human.scoped && WEAPONS[human.cur] && WEAPONS[human.cur].scope;
    const tp = GAME.thirdPerson;
    const fov = (scopedNow && !tp) ? 40 : 74;
    if (Math.abs(camera.fov - fov) > 0.5) { camera.fov += (fov - camera.fov) * 0.4; camera.updateProjectionMatrix(); }
    if (tp) {
      const fwd = new THREE.Vector3(-Math.sin(human.yaw), 0, -Math.cos(human.yaw));
      const dist = 130, back = fwd.clone().multiplyScalar(-dist);
      camera.position.set(human.pos.x + back.x, human.eye + 30, human.pos.z + back.z);
      camera.rotation.set(human.pitch, human.yaw, 0, 'YXZ');
      if (vm.current) vm.current.visible = false;
    } else {
      camera.position.set(human.pos.x, human.eye, human.pos.z);
      camera.rotation.set(human.pitch, human.yaw, 0, 'YXZ');
      if (vm.current) vm.current.visible = !scopedNow;
    }
  } else {
    if (vm.current) vm.current.visible = false;
    const mate = agents.find(a => a.alive && a.team === human.team && !a.isHuman) || agents.find(a => a.alive);
    if (mate) { camera.position.set(mate.pos.x, mate.eye + 10, mate.pos.z); camera.rotation.set(mate.pitch, mate.yaw, 0, 'YXZ'); }
  }
}
function render() { renderer.render(scene, camera); }

/* ============================== boot / deploy ============================== */
function deploy(custom) {
  $("#startPanel").classList.remove("show");
  GAME.customMap = custom || null; GAME.sourceMap = null;
  GAME.phase = "idle";
  if (custom) buildCustomMap(custom); else buildDefaultMap();
  GAME.round = 1; GAME.half = 1; GAME.scoreCT = 0; GAME.scoreT = 0; GAME.lossStreak = { CT: 0, T: 0 };
  GAME.humanTeam = TEAM.CT; GAME.ctIsHuman = true;
  buildTeams();
  loadConfig();
  buildCheatMenu();
  startRound();
  renderer.domElement.requestPointerLock();
  audio();
}
setDeployHandler(deploy);

/* ---- import a real CS2 map (.glb geometry + spawns.json) for offline play ---- */
async function loadAndPlaySource() {
  const errEl = $("#importErr"); if (errEl) errEl.textContent = "";
  const gf = $("#glbFile").files[0], sf = $("#spawnFile").files[0];
  if (!gf) { if (errEl) errEl.textContent = "Choose a decompiled .glb map file first."; return; }
  try {
    const glb = await gf.arrayBuffer();
    let spawns = { ctSpawns: [], tSpawns: [] };
    if (sf) spawns = JSON.parse(await sf.text());
    spawns.name = spawns.name || gf.name.replace(/\.[^.]+$/, '');
    deploySource(glb, spawns);
  } catch (e) { if (errEl) errEl.textContent = "Import failed: " + (e && e.message || e); else throw e; }
}
function deploySource(glb, spawns) {
  $("#startPanel").classList.remove("show");
  GAME.customMap = null; GAME.sourceMap = spawns.name || "imported"; GAME.phase = "idle";
  const info = loadSourceMap(glb, spawns);
  GAME.round = 1; GAME.half = 1; GAME.scoreCT = 0; GAME.scoreT = 0; GAME.lossStreak = { CT: 0, T: 0 };
  GAME.humanTeam = TEAM.CT; GAME.ctIsHuman = true;
  buildTeams(); loadConfig(); buildCheatMenu(); startRound();
  renderer.domElement.requestPointerLock(); audio();
  showHint(`Imported ${GAME.sourceMap}: ${info.triangles | 0} tris · ${info.navNodes} nav nodes`);
  return info;
}

function boot() {
  buildCrosshair();
  $("#loadStat").textContent = "Ready.";
  const btn = $("#playBtn"); btn.disabled = false; btn.textContent = "DEPLOY";
  btn.onclick = () => deploy(null);
  const eb = $("#editBtn"); if (eb) eb.onclick = () => openEditor();
  const lb = $("#loadMapBtn"); if (lb) lb.onclick = () => loadAndPlaySource();
}

/* debug/test surface */
window.HVH = {
  get GAME() { return GAME; }, get agents() { return agents; }, get human() { return refs.human; },
  WEAPONS, ECON, computeDamage, WALLS, NODES, EDGES, segAABB, losClear, penetrate, camera, scene, renderer,
  deploy, deploySource,
  fastForward(secs) { const dt = 1 / 60; let t = 0; while (t < secs) { step(dt); t += dt; } return { phase: GAME.phase, score: [GAME.scoreCT, GAME.scoreT] }; },
  computeBloom(a) { return computeBloom(a || refs.human); },
  testGrenade() { refs.human.nades = { he: 1, flash: 1 }; equipGrenade(); const eq = refs.human.equippedNade; const before = nadeProjectiles.length; const ok = throwNade(refs.human, eq); return { equipped: eq, threw: ok, projectilesBefore: before, projectilesAfter: nadeProjectiles.length, remaining: refs.human.nades[eq] }; },
  testPenetration() {
    const saved = WALLS.splice(0, WALLS.length);
    const o = new THREE.Vector3(0, 40, 0), tgt = new THREE.Vector3(0, 40, 400);
    WALLS.push({ minX: -50, maxX: 50, minZ: 190, maxZ: 204, bottom: 0, top: 200, mat: 0.45, block: true });
    const thin = penetrate(o, tgt, 'deagle');
    WALLS.length = 0;
    WALLS.push({ minX: -50, maxX: 50, minZ: 150, maxZ: 350, bottom: 0, top: 200, mat: 0.70, block: true });
    const thick = penetrate(o, tgt, 'deagle');
    WALLS.length = 0; for (const w of saved) WALLS.push(w);
    return { thinFactor: thin.factor, thinBlocked: thin.blocked, thickFactor: thick.factor, thickBlocked: thick.blocked };
  },
  testCustomMap() { deploy(blankEditorMap()); return { walls: WALLS.length, nodes: NODES.length }; },
  topdown() { GAME.phase = "frozen"; camera.fov = 60; camera.position.set(1700, 3600, 40); camera.rotation.set(-Math.PI / 2, 0, 0); camera.updateProjectionMatrix(); document.getElementById('hud').style.display = 'none'; return 'topdown set'; },
  checkNav() {
    const blocked = [], seen = new Set();
    for (const a in EDGES) for (const b of EDGES[a]) {
      const key = Math.min(a, b) + '-' + Math.max(a, b); if (seen.has(key)) continue; seen.add(key);
      const pa = NODES[+a].p.clone(); pa.y = 40; const pb = NODES[b].p.clone(); pb.y = 40;
      if (!losClear(pa, pb, false)) blocked.push(key);
    }
    return blocked;
  },
};
boot();
loop(performance.now());
