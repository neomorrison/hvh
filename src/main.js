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
import { manualFire, aimbotFire, fireWeaponCommon, meleeAttack, moveAgent, computeBloom, startReload, finishReload, switchTo, selectBest, visibleTo, canShoot } from './combat.js';
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
import { buildDefaultMap } from './map.js';
import { loadSourceMap } from './sourcemap_load.js';
import { meshBackend } from './sourcemap.js';
import { setListener, sfxScope, unlockAudio, sfxRevolverCock } from './sfx.js';
import { toggleEditor, isEditorOpen, editorUpdate, editorRender, editorKey, loadPatches } from './editor.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const $ = s => document.querySelector(s);

// spectator camera: lock onto a player (first/third person) or free-fly (Space toggles)
const spec = { free: false, target: null, tp: false, pos: new THREE.Vector3(), yaw: 0, pitch: 0 };
function specAliveList() { return agents.filter(a => a.alive); }
function cycleSpec(dir) { const l = specAliveList(); if (!l.length) { spec.target = null; return; } let i = l.indexOf(spec.target); i = (i < 0 ? 0 : i + dir); spec.target = l[((i % l.length) + l.length) % l.length]; }
function ensureSpec() { if (!spec.target || !spec.target.alive) cycleSpec(1); }
function specUpdate() {
  if (!spec.free) { ensureSpec(); return; }
  const sp = (keys["ShiftLeft"] ? 18 : 8), cp = Math.cos(spec.pitch);
  const fwd = new THREE.Vector3(-Math.sin(spec.yaw) * cp, Math.sin(spec.pitch), -Math.cos(spec.yaw) * cp);
  const right = new THREE.Vector3(Math.cos(spec.yaw), 0, -Math.sin(spec.yaw));
  if (keys["KeyW"]) spec.pos.addScaledVector(fwd, sp);
  if (keys["KeyS"]) spec.pos.addScaledVector(fwd, -sp);
  if (keys["KeyA"]) spec.pos.addScaledVector(right, -sp);
  if (keys["KeyD"]) spec.pos.addScaledVector(right, sp);
}
let _specBanner = null;
function updateSpecBanner() {
  if (!_specBanner) { _specBanner = document.createElement('div'); _specBanner.id = 'specBanner'; _specBanner.style.cssText = 'position:fixed;left:0;right:0;bottom:84px;text-align:center;font:bold 17px "Trebuchet MS",sans-serif;color:#fff;text-shadow:0 2px 6px #000,0 0 2px #000;pointer-events:none;z-index:50;'; document.body.appendChild(_specBanner); }
  const h = refs.human;
  if (h && !h.alive && GAME.phase !== "warmup") {
    if (spec.free) _specBanner.innerHTML = '<span style="opacity:.85">◉ FREE CAMERA</span> &nbsp;·&nbsp; <span style="font-weight:normal;opacity:.7">WASD fly · Space to lock onto a player</span>';
    else if (spec.target) _specBanner.innerHTML = 'Spectating <span style="color:' + (spec.target.team === TEAM.CT ? '#7fb4ff' : '#ffb46a') + '">' + spec.target.name + '</span>' + (spec.tp ? ' <span style="opacity:.7">(3rd person)</span>' : '') + ' &nbsp;<span style="font-weight:normal;opacity:.6">click=switch · V=3rd person · Space=free cam</span>';
    else _specBanner.textContent = '';
    _specBanner.style.display = 'block';
  } else _specBanner.style.display = 'none';
}

/* ============================== input ============================== */
addEventListener('keydown', e => {
  if (e.code === "Backquote") { toggleEditor(); e.preventDefault(); return; }     // ~ opens/closes the map patch editor
  if (isEditorOpen()) { keys[e.code] = true; editorKey(e.code); e.preventDefault(); return; }   // editor swallows input
  if (e.code === "KeyI" && GAME.phase !== "editor") { toggleCheatMenu(); e.preventDefault(); return; }
  if (GAME.phase === "warmup" || GAME.phase === "editor") return;
  const human = refs.human;
  keys[e.code] = true;
  if (e.code === "KeyB") { const p = $("#buyPanel"); p.classList.contains("show") ? closeBuy() : openBuy(); }
  if (e.code === "Tab") { $("#sbPanel").classList.add("show"); renderScoreboard(); e.preventDefault(); }
  if (e.code === "Digit1") { human.equippedNade = null; if (human.slotPrimary) switchTo(human, human.slotPrimary); }    // 1 = rifle/primary
  if (e.code === "Digit2") { human.equippedNade = null; if (human.slotSecondary) switchTo(human, human.slotSecondary); } // 2 = pistol/secondary
  if (e.code === "Digit3") { human.equippedNade = null; switchTo(human, 'knife'); }                                    // 3 = knife
  if (e.code === "Digit4" || e.code === "KeyG") { equipGrenade(); }                                                    // 4 = grenade
  if (e.code === "KeyR") { startReload(human); }
  if (e.code === "KeyE") { tryRescueInteract(human); }
  if (e.code === "KeyV") {
    if (human.alive) { GAME.thirdPerson = !GAME.thirdPerson; showHint("Third person " + (GAME.thirdPerson ? "ON" : "OFF")); }
    else { spec.tp = !spec.tp; showHint("Spectator " + (spec.tp ? "third" : "first") + " person"); }     // V while spectating a player
  }
  if (e.code === "Space" && !human.alive && !e.repeat) {                                                  // spectate: Space toggles free-fly cam
    spec.free = !spec.free;
    if (spec.free) { spec.pos.copy(camera.position); const t = spec.target; if (t) { spec.yaw = t.yaw; spec.pitch = t.pitch; } }
    showHint(spec.free ? "Free cam — WASD/Shift to fly, mouse to look, Space to lock onto a player" : "Locked — click to switch player, V for third person");
  }
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
  if (["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "KeyC", "Tab"].includes(e.code)) e.preventDefault();
  if (e.ctrlKey) e.preventDefault();
});
addEventListener('keyup', e => { keys[e.code] = false; if (e.code === "Tab") $("#sbPanel").classList.remove("show"); });

renderer.domElement.addEventListener('mousedown', e => { if (isEditorOpen()) return; if (e.button === 0) { input.mouseDown = true; if (refs.human && refs.human.cur === "r8") refs.human.fireMode = "primary"; } if (e.button === 2) { input.rmbDown = true; onRMB(); } });
addEventListener('mouseup', e => { if (isEditorOpen()) return; if (e.button === 0) input.mouseDown = false; if (e.button === 2) input.rmbDown = false; });
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('mousemove', e => {
  if (isEditorOpen() || document.pointerLockElement !== renderer.domElement || !refs.human) return;   // the editor manages its own pointer
  const sens = 0.0022;
  if (refs.human.alive) { refs.human.yaw -= e.movementX * sens; refs.human.pitch = THREE.MathUtils.clamp(refs.human.pitch - e.movementY * sens, -1.5, 1.5); }
  else if (spec.free) { spec.yaw -= e.movementX * sens; spec.pitch = THREE.MathUtils.clamp(spec.pitch - e.movementY * sens, -1.5, 1.5); }   // spectator free-cam look
});
function onRMB() {
  const human = refs.human; if (!human.alive) return;
  const w = WEAPONS[human.cur];
  if (w.scope) { human.scoped = !human.scoped; sfxScope(); }
  else if (human.cur === "glock") { human.glockBurst = !human.glockBurst; showHint("Glock " + (human.glockBurst ? "burst" : "semi")); }
  else if (human.cur === "r8") human.fireMode = "fan";
}
renderer.domElement.addEventListener('click', () => {
  unlockAudio();   // a user gesture lets the WebAudio context start
  if (isEditorOpen()) return;   // editor uses a visible cursor (no pointer lock) and its own handlers
  if (GAME.phase === "warmup" || GAME.phase === "editor" || anyPanelOpen()) return;
  if (refs.human && !refs.human.alive && !spec.free) cycleSpec(1);   // spectating locked: click switches player
  renderer.domElement.requestPointerLock();
});

/* ============================== human control ============================== */
function humanMove(dt) {
  const human = refs.human;
  // crouch is C, NOT Ctrl: Ctrl+W (duck + forward) closes the browser tab and a web page can't block it
  human.crouch = !!keys["KeyC"];
  human.walk = !!keys["ShiftLeft"];
  let f = 0, s = 0; if (keys["KeyW"]) f++; if (keys["KeyS"]) f--; if (keys["KeyA"]) s--; if (keys["KeyD"]) s++;
  const fwd = new THREE.Vector3(-Math.sin(human.yaw), 0, -Math.cos(human.yaw));
  const right = new THREE.Vector3(Math.cos(human.yaw), 0, -Math.sin(human.yaw));
  const dir = fwd.multiplyScalar(f).add(right.multiplyScalar(s));
  if (keys["Space"] && human.onGround) human.vel.y = JUMP_VEL;
  human.realYaw = human.yaw;
  human.speedScale = 1;
  const c = human.cheats;
  // auto-stop: fully stop the instant a shot WOULD qualify if we were stopped — same
  // min-damage + min-hit-chance + firable predicate as auto-shoot (canShoot). We judge it
  // with velocity zeroed so the moving-bloom doesn't keep it from ever engaging while running.
  if (c.aimbot.on && c.aimbot.autoStop && human.onGround) {
    const w = WEAPONS[human.cur];
    // don't keep planting between shots on a slow non-auto (SSG/scout bolt cycle) — only stop when actually able to fire now
    const fireReady = human.fireCd <= 0 || (w && w.auto);
    const vx = human.vel.x, vz = human.vel.z; human.vel.x = 0; human.vel.z = 0;
    if (fireReady && canShoot(human).ok) human.speedScale = 0;
    human.vel.x = vx; human.vel.z = vz;
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
      if (human.fireCd <= 0) { if (wp8.ammo <= 0) { startReload(human); return; } human.fireMode = "fan"; sfxRevolverCock(); fireWeaponCommon(human); manualFire(human); updateHUDWeapons(); }   // fan: cock + fire each shot (spams the cock)
      return;
    }
    if (c8.aimbot.on && c8.aimbot.autoRevolver) {
      // CONSTANT auto-cock: the hammer cycles every ~0.2s and never holds — the cock sound plays
      // EVERY cycle. On each completed cock it fires ONLY if the target is firable right then
      // (aimbotFire re-checks canShoot), and the 0.2s cock cadence — not the R8's normal cooldown —
      // is the fire-rate limit, so it shoots faster than a manual cock.
      const AUTO_COCK = 0.2;
      human.r8Charge = (human.r8Charge || 0) + dt / AUTO_COCK;
      if (human.r8Charge >= 1) {
        human.r8Charge -= 1;                                   // immediately re-cock for the next cycle
        sfxRevolverCock();                                     // cock sound every cycle
        if (wp8.ammo <= 0) { startReload(human); return; }
        human.fireMode = "primary";
        if (aimbotFire(human)) human.fireCd = 0;               // fired (target was firable) → cock cadence paces it
        updateHUDWeapons();
      }
      return;
    }
    if (c8.aimbot.on) {
      if (md || c8.aimbot.autoShoot) {
        human.r8Charge = Math.min(1, (human.r8Charge || 0) + dt / COCK);
        if (human.r8Charge >= 0.95 && !human.r8Cocked) { human.r8Cocked = true; sfxRevolverCock(); }
        if (human.r8Charge >= 1 && human.fireCd <= 0) { if (wp8.ammo <= 0) { startReload(human); return; } human.fireMode = "primary"; if (aimbotFire(human)) { human.r8Charge = 0; human.r8Cocked = false; } updateHUDWeapons(); }
      } else { human.r8Charge = Math.max(0, (human.r8Charge || 0) - dt / COCK * 2); human.r8Cocked = false; }
      return;
    }
    if (md) {
      human.r8Charge = Math.min(1, (human.r8Charge || 0) + dt / COCK);
      if (human.r8Charge >= 0.95 && !human.r8Cocked) { human.r8Cocked = true; sfxRevolverCock(); }
      if (human.r8Charge >= 1 && human.fireCd <= 0) { if (wp8.ammo <= 0) { startReload(human); human.r8Charge = 0; human.r8Cocked = false; return; } human.fireMode = "primary"; fireWeaponCommon(human); manualFire(human); human.r8Charge = 0; human.r8Cocked = false; updateHUDWeapons(); }
    } else { human.r8Charge = Math.max(0, (human.r8Charge || 0) - dt / COCK * 2); human.r8Cocked = false; }
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
  const glockBurst = human.cur === "glock" && human.glockBurst;
  if (md || r8fan || (glockBurst && human.burstQ > 0)) {
    if (wp.ammo <= 0) { startReload(human); return; }
    human.fireMode = r8fan ? "fan" : "primary";
    fireWeaponCommon(human); manualFire(human);
    if (glockBurst) {
      human.burstQ = human.burstQ > 0 ? human.burstQ - 1 : 2;     // 3-round burst (this shot + 2 queued)
      human.fireCd = human.burstQ > 0 ? 0.07 : 0.4;               // rapid within the burst, then a gap before the next
      input.mouseDown = false;                                     // one click = one burst (the queue fires the rest)
    } else if (!WEAPONS[human.cur].auto && !r8fan) input.mouseDown = false;  // semi-auto: one click one shot
    updateHUDWeapons();
  }
}

/* ============================== main loop ============================== */
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  let dt = Math.min(0.05, (now - last) / 1000); last = now; clock.t += dt;
  if (GAME.phase !== "warmup" && GAME.phase !== "editor") step(dt);
  else if (isEditorOpen()) editorUpdate();
  render();
}
export function step(dt) {
  if (GAME.phase === "buy") { GAME.freeze -= dt; if (GAME.freeze <= 0) beginBuyToLive(); }
  else if (GAME.phase === "live") { GAME.timer -= dt; if (GAME.timer <= 0) awardWin(TEAM.T, "time"); }
  else if (GAME.phase === "end") { GAME.timer -= dt; if (GAME.timer <= 0) endRoundAdvance(); }
  if (GAME.buyTimer > 0 && (GAME.phase === "buy" || GAME.phase === "live")) { GAME.buyTimer -= dt; if (GAME.buyTimer <= 0 && $("#buyPanel").classList.contains("show")) closeBuy(); }   // buying allowed past freeze, then auto-close

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
  } else if (!human.alive) specUpdate();   // spectator camera (free-fly / locked)
  const canAct = GAME.phase === "live";
  for (const a of agents) {
    if (a.isHuman) continue;
    if (GAME.phase === "buy") a.body.g.position.copy(a.pos);
    else if (canAct) botThink(a, dt);
  }
  updateHostages(dt); updateNades(dt); updateAreas(dt); updateEffects(dt);
  for (const a of agents) updateAgentVisual(a);
  updateESP(); updateReloadRing(); updateBloomRing(); updateScopeOverlay(); updateR8Hammer(); updateSpecBanner();
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
    setListener(human.pos.x, human.eye, human.pos.z, human.yaw, human);
    const scopedNow = human.scoped && WEAPONS[human.cur] && WEAPONS[human.cur].scope;
    const tp = GAME.thirdPerson;
    const fov = (scopedNow && !tp) ? 40 : 74;
    if (Math.abs(camera.fov - fov) > 0.5) { camera.fov += (fov - camera.fov) * 0.4; camera.updateProjectionMatrix(); }
    if (tp) {
      // orbit BEHIND the player along -view so looking up/down keeps them centered (instead of
      // panning to the floor). Pull in if a wall is between the camera and the player.
      const dist = 150, ex = human.pos.x, ey = human.eye, ez = human.pos.z;
      const cp = Math.cos(human.pitch);
      let ux = Math.sin(human.yaw) * cp, uy = -Math.sin(human.pitch) + 0.18, uz = Math.cos(human.yaw) * cp;
      const vl = Math.hypot(ux, uy, uz); ux /= vl; uy /= vl; uz /= vl;
      let allow = dist;
      if (meshBackend.active && meshBackend.bvh) {
        const h = meshBackend.bvh.raycast(ex, ey, ez, ux, uy, uz, dist); if (h) allow = Math.max(18, h.t - 12);
      } else {
        const o = new THREE.Vector3(ex, ey, ez), d = new THREE.Vector3(ux, uy, uz);
        for (const wl of WALLS) { if (!wl.block) continue; const r = segAABB(o, d, dist, wl); if (r && r.enter > 1 && r.enter < allow) allow = Math.max(18, r.enter - 12); }
      }
      camera.position.set(ex + ux * allow, ey + uy * allow, ez + uz * allow);
      camera.rotation.set(human.pitch, human.yaw, 0, 'YXZ');
      if (vm.current) vm.current.visible = false;
    } else {
      camera.position.set(human.pos.x, human.eye, human.pos.z);
      camera.rotation.set(human.pitch, human.yaw, 0, 'YXZ');
      if (vm.current) vm.current.visible = !scopedNow;
    }
  } else {
    if (vm.current) vm.current.visible = false;
    if (Math.abs(camera.fov - 74) > 0.5) { camera.fov = 74; camera.updateProjectionMatrix(); }
    if (spec.free) {                                          // free-fly spectator
      setListener(spec.pos.x, spec.pos.y, spec.pos.z, spec.yaw, null);
      camera.position.copy(spec.pos); camera.rotation.set(spec.pitch, spec.yaw, 0, 'YXZ');
    } else {                                                  // locked on a player
      ensureSpec(); const t = spec.target;
      if (t) {
        setListener(t.pos.x, t.eye, t.pos.z, t.yaw, t);
        t.body.g.visible = spec.tp;                           // first-person spectate hides the spectated player's own model (shown only in 3p)
        if (spec.tp) {                                        // third person of the spectated player (orbit + wall-aware pull-in)
          const dist = 150, ex = t.pos.x, ey = t.eye, ez = t.pos.z, cp = Math.cos(t.pitch);
          let ux = Math.sin(t.yaw) * cp, uy = -Math.sin(t.pitch) + 0.18, uz = Math.cos(t.yaw) * cp; const vl = Math.hypot(ux, uy, uz); ux /= vl; uy /= vl; uz /= vl;
          let allow = dist; if (meshBackend.active && meshBackend.bvh) { const h = meshBackend.bvh.raycast(ex, ey, ez, ux, uy, uz, dist); if (h) allow = Math.max(18, h.t - 12); }
          camera.position.set(ex + ux * allow, ey + uy * allow, ez + uz * allow); camera.rotation.set(t.pitch, t.yaw, 0, 'YXZ');
        } else { camera.position.set(t.pos.x, t.eye, t.pos.z); camera.rotation.set(t.pitch, t.yaw, 0, 'YXZ'); }
      }
    }
  }
}
function render() { if (isEditorOpen()) { editorRender(); return; } renderer.render(scene, camera); }

/* ============================== boot / deploy ============================== */
// the human spawns on a RANDOM team each match; buildTeams keeps both sides 12-strong regardless
function assignHumanTeam() { const ct = Math.random() < 0.5; GAME.humanTeam = ct ? TEAM.CT : TEAM.T; GAME.ctIsHuman = ct; }
function deploy() {
  $("#startPanel").classList.remove("show");
  GAME.customMap = null; GAME.sourceMap = null;
  GAME.phase = "idle";
  buildDefaultMap();
  GAME.round = 1; GAME.half = 1; GAME.scoreCT = 0; GAME.scoreT = 0; GAME.lossStreak = { CT: 0, T: 0 };
  assignHumanTeam();
  buildTeams();
  loadConfig();
  buildCheatMenu();
  startRound();
  renderer.domElement.requestPointerLock();
  audio();
}

function deploySource(glb, spawns, texturedScene) {
  $("#startPanel").classList.remove("show");
  GAME.customMap = null; GAME.sourceMap = spawns.name || "imported"; GAME.phase = "idle";
  const info = loadSourceMap(glb, spawns, texturedScene);
  loadPatches(GAME.sourceMap, texturedScene);   // re-apply saved map patches (collision + hidden surfaces)
  GAME.round = 1; GAME.half = 1; GAME.scoreCT = 0; GAME.scoreT = 0; GAME.lossStreak = { CT: 0, T: 0 };
  assignHumanTeam();
  buildTeams(); loadConfig(); buildCheatMenu(); startRound();
  renderer.domElement.requestPointerLock(); audio();
  showHint(`Imported ${GAME.sourceMap}: ${info.triangles | 0} tris · ${info.navNodes} nav nodes`);
  return info;
}

/* ---- the bundled real cs_office map (mesh geometry + spawns) is the main map ---- */
const MAIN_MAP = { glb: "./maps/cs_office.glb", spawns: "./maps/cs_office.spawns.json", name: "cs_office" };
let mainMapAssets = null;
function preloadMainMap() {
  mainMapAssets = Promise.all([
    fetch(MAIN_MAP.glb).then(r => { if (!r.ok) throw new Error("map geometry " + r.status); return r.arrayBuffer(); }),
    fetch(MAIN_MAP.spawns).then(r => r.ok ? r.json() : {}),
  ]);
  return mainMapAssets;
}
// Load the user's own textured map (./maps/cs_office.tex.glb) if they've placed one — never
// bundled (it's Valve art); see tools/TEXTURES.md to generate it from your CS2 install.
// Returns the parsed scene, or null to fall back to the procedural look.
async function loadTexturedMap(url) {
  try {
    const r = await fetch(url); if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    return await new Promise(res => new GLTFLoader().parse(buf, '', g => res(g.scene), () => res(null)));
  } catch (e) { return null; }
}
async function deployMainMap() {
  const ls = $("#loadStat");
  try {
    if (ls) ls.textContent = "Loading cs_office…";
    const [glb, spawns] = await (mainMapAssets || preloadMainMap());
    spawns.name = spawns.name || MAIN_MAP.name;
    const tex = await loadTexturedMap("./maps/cs_office.tex.glb");   // optional, user-supplied real textures
    deploySource(glb, spawns, tex);
  } catch (e) {                                          // bundled map unreachable → procedural blockout
    console.warn("cs_office mesh map unavailable, using procedural layout:", e);
    if (ls) ls.textContent = "";
    deploy();
  }
}

function boot() {
  buildCrosshair();
  $("#loadStat").textContent = "Ready.";
  const btn = $("#playBtn"); btn.disabled = false; btn.textContent = "DEPLOY";
  btn.onclick = () => deployMainMap();
  preloadMainMap().catch(() => {});                      // warm the download while on the start screen
}

/* debug/test surface */
window.HVH = {
  get GAME() { return GAME; }, get agents() { return agents; }, get human() { return refs.human; },
  WEAPONS, ECON, computeDamage, WALLS, NODES, EDGES, segAABB, losClear, penetrate, camera, scene, renderer, meshBackend,
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
