/* ============================== [GAME / ECON] ==============================
   Match & round flow, the CS2 economy, hostages, the buy menu (with same-buy
   sellback for misclicks) and grenades.                                      */
import * as THREE from 'three';
import { scene, renderer } from './core.js';
import { TEAM, ECON, WEAPONS, NADES, ARMOR, EYE_STAND, GRAVITY } from './data.js';
import { CT_SPAWNS, T_SPAWNS, HOSTAGE_SPAWNS, RESCUE_ZONES, losClear } from './world.js';
import { spawnAgent, applyPersona, BOT_PERSONAS, recolorAgent, eyePos, hitboxCenter, setViewmodel } from './agents.js';
import { giveWeapon, selectBest, switchTo, killAgent } from './combat.js';
import { botBuy } from './ai.js';
import { agents, refs, GAME, FREEZE_TIME, ROUND_TIME, END_TIME, BUY_TIME } from './state.js';
import { meshBackend } from './sourcemap.js';
import { clearEffects, addExplosion, smokes, fires, nadeProjectiles } from './effects.js';
import { sfxNade } from './sfx.js';
import { centerMessage, showHint, updateAllHUD, updateHUDWeapons, addKillFeedText, damageFlash, doFlash, playBeep } from './hud.js';

const $ = s => document.querySelector(s);

/* ============================== match / round flow ============================== */
export function buildTeams() {
  for (const a of agents) scene.remove(a.body.g);
  agents.length = 0;
  const t1 = GAME.humanTeam, t2 = t1 === TEAM.CT ? TEAM.T : TEAM.CT;
  refs.human = spawnAgent(t1, true, "you");
  const deck = BOT_PERSONAS.slice(); for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  let pi = 0;
  for (let i = 0; i < 11; i++) { const b = spawnAgent(t1, false, "bot"); applyPersona(b, deck[(pi++) % deck.length]); }   // human + 11 = 12
  for (let i = 0; i < 12; i++) { const b = spawnAgent(t2, false, "bot"); applyPersona(b, deck[(pi++) % deck.length]); }   // 12
}
export function liveHostages() { return GAME.hostages.filter(h => !h.rescued && !h.dead); }

export function startRound() {
  GAME.phase = "buy"; GAME.freeze = FREEZE_TIME; GAME.buyTimer = BUY_TIME; GAME.timer = ROUND_TIME; GAME.winner = null; GAME.rescued = 0;
  clearEffects();
  const ctList = agents.filter(a => a.team === TEAM.CT), tList = agents.filter(a => a.team === TEAM.T);
  ctList.forEach((a, i) => resetAgentForRound(a, CT_SPAWNS[i % CT_SPAWNS.length]));
  tList.forEach((a, i) => resetAgentForRound(a, T_SPAWNS[i % T_SPAWNS.length]));
  // hostages
  GAME.hostages.forEach(h => scene.remove(h.mesh));
  GAME.hostages = HOSTAGE_SPAWNS.map((p, i) => {
    const grp = new THREE.Group();
    const b = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 46, 8), new THREE.MeshStandardMaterial({ color: 0xff8a3c, roughness: .8 }));
    b.position.y = 23; const hd = new THREE.Mesh(new THREE.SphereGeometry(9, 10, 10), new THREE.MeshStandardMaterial({ color: 0xffe0a0 })); hd.position.y = 55; grp.add(b); grp.add(hd);
    grp.position.copy(p); scene.add(grp);
    return { pos: p.clone(), mesh: grp, rescued: false, dead: false, carrier: null, id: i };
  });
  agents.forEach(a => { if (!a.isHuman) botBuy(a); });
  updateAllHUD();
  centerMessage("BUY PHASE", "Press B to buy · Round " + GAME.round, 1.6);
  showBuyAuto();
}
export function resetAgentForRound(a, spawn) {
  const survived = a.alive;
  if (!survived) { a.weapons = {}; a.slotPrimary = null; a.slotSecondary = null; a.armor = 0; a.helmet = false; a.nades = {}; a.curNade = null; a.equippedNade = null; a._wmKey = null; }
  a.alive = true; a.hp = 100; a.pos.copy(spawn); a.vel.set(0, 0, 0); a.pos.y = spawn.y || 0;
  if (meshBackend.active) { const g = meshBackend.groundHeight(a.pos.x, a.pos.z, a.pos.y, 24); if (g > -1e8) a.pos.y = g; }   // sit on the real floor (small reach so it can't snap up onto the ceiling/roof)
  a.eye = EYE_STAND + a.pos.y;
  a.crouch = false; a.scoped = false; a.reloadT = 0; a.fireCd = 0; a.carrying = null; a.flashT = 0; a.hitFlash = 0;
  a.yaw = (spawn.yaw != null) ? spawn.yaw : (a.team === TEAM.CT ? -Math.PI / 2 : Math.PI / 2); a.pitch = 0; a.realYaw = a.yaw;
  a.equippedNade = null; a.firePenalty = 0; a.hurtBloom = 0; a.landBloom = 0; a.onGround = true;
  a.boughtThisBuy = {};                                    // reset same-buy sellback tracking
  a.body.g.visible = true;
  a.weapons.knife = { melee: true }; a.slotMelee = 'knife';
  const def = a.team === TEAM.CT ? "usp" : "glock";
  if (!a.slotSecondary || !a.weapons[a.slotSecondary]) giveWeapon(a, def);
  for (const k in a.weapons) { if (WEAPONS[k].melee) continue; a.weapons[k].ammo = WEAPONS[k].mag; a.weapons[k].reserve = WEAPONS[k].reserve; }
  selectBest(a);
}

export function beginBuyToLive() { GAME.phase = "live"; closeBuy(); centerMessage("", "", 0); }

export function awardWin(side, reason) {
  if (GAME.phase === "end" || GAME.phase === "matchend") return;
  GAME.phase = "end"; GAME.timer = END_TIME; GAME.winner = side; GAME.roundResult = reason;
  if (side === TEAM.CT) GAME.scoreCT++; else GAME.scoreT++;
  const winners = agents.filter(a => a.team === side), losers = agents.filter(a => a.team !== side);
  const winReward = ECON.win[(side === TEAM.CT ? (reason === "rescue" ? "ct_rescue" : "ct_elim") : (reason === "time" ? "t_time" : "t_elim"))];
  winners.forEach(a => a.money = Math.min(ECON.max, a.money + winReward));
  GAME.lossStreak[side] = Math.max(0, GAME.lossStreak[side] - 1);
  GAME.lossStreak[loseKey(side)] = Math.min(5, GAME.lossStreak[loseKey(side)] + 1);
  const lb = ECON.lossLadder[Math.min(4, Math.max(0, GAME.lossStreak[loseKey(side)] - 1))];
  losers.forEach(a => a.money = Math.min(ECON.max, a.money + lb));
  centerMessage(side + " WIN", reasonText(side, reason) + `  ·  +$${winReward} / +$${lb}`, 3.0);
  playBeep(side === GAME.humanTeam ? 660 : 200, 0.25);
  updateAllHUD();
}
function loseKey(side) { return side === TEAM.CT ? "T" : "CT"; }
function reasonText(side, reason) {
  if (reason === "rescue") return "Hostages rescued";
  if (reason === "time") return "Time expired — hostages defended";
  return "Enemy team eliminated";
}

export function checkRoundEnd() {
  if (GAME.phase !== "live") return;
  const ctAlive = agents.some(a => a.team === TEAM.CT && a.alive);
  const tAlive = agents.some(a => a.team === TEAM.T && a.alive);
  if (!ctAlive) { awardWin(TEAM.T, "elim"); return; }
  if (!tAlive) { awardWin(TEAM.CT, "elim"); return; }
  if (GAME.hostages.length && GAME.rescued >= GAME.hostages.length) { awardWin(TEAM.CT, "rescue"); return; }
}

export function endRoundAdvance() {
  const need = 13;
  if (GAME.scoreCT >= need || GAME.scoreT >= need) { return matchEnd(); }
  GAME.round++;
  if (GAME.round === 13 && GAME.half === 1) {
    GAME.half = 2;
    GAME.humanTeam = GAME.humanTeam === TEAM.CT ? TEAM.T : TEAM.CT;
    agents.forEach(a => { a.team = a.team === TEAM.CT ? TEAM.T : TEAM.CT; });
    const tmp = GAME.scoreCT; GAME.scoreCT = GAME.scoreT; GAME.scoreT = tmp;
    agents.forEach(a => { a.money = ECON.start; a.weapons = {}; a.slotPrimary = null; a.slotSecondary = null; const def = a.team === TEAM.CT ? "usp" : "glock"; giveWeapon(a, def); });
    GAME.lossStreak.CT = Math.round(GAME.lossStreak.CT / 2); GAME.lossStreak.T = Math.round(GAME.lossStreak.T / 2);
    agents.forEach(a => recolorAgent(a));
    centerMessage("HALFTIME", "Switching sides", 2.5);
  }
  startRound();
}
export function matchEnd() {
  GAME.phase = "matchend";
  const winSide = GAME.scoreCT > GAME.scoreT ? TEAM.CT : TEAM.T;
  const youWon = winSide === GAME.humanTeam;
  centerMessage(youWon ? "VICTORY" : "DEFEAT", `Final ${GAME.scoreCT} : ${GAME.scoreT}  ·  Refresh to replay`, 99, true);
}

/* ============================== hostages ============================== */
export function tryRescueInteract(a) {
  if (a.team !== TEAM.CT || !a.alive) return;
  if (a.carrying) return;
  for (const h of liveHostages()) { if (!h.carrier && a.pos.distanceTo(h.pos) < 70) { h.carrier = a; a.carrying = h; showHint("Hostage following — escort to a rescue zone (green)"); return; } }
}
export function updateHostages(dt) {
  for (const h of GAME.hostages) {
    if (h.rescued || h.dead) continue;
    if (h.carrier && h.carrier.alive) {
      const back = new THREE.Vector3(Math.sin(h.carrier.yaw), 0, Math.cos(h.carrier.yaw)).multiplyScalar(40);
      const tgt = h.carrier.pos.clone().add(back);
      h.pos.lerp(tgt, Math.min(1, dt * 6)); h.pos.y = 0; h.mesh.position.copy(h.pos);
      for (const rz of RESCUE_ZONES) {
        if (Math.hypot(h.pos.x - rz.x, h.pos.z - rz.z) < rz.r) {
          h.rescued = true; GAME.rescued++; h.mesh.visible = false; h.carrier.carrying = null;
          h.carrier.money = Math.min(ECON.max, h.carrier.money + ECON.hostage.rescuerBonus);
          agents.filter(x => x.team === TEAM.CT).forEach(x => x.money = Math.min(ECON.max, x.money + ECON.hostage.teamBonus));
          addKillFeedText(`${h.carrier.name} rescued a hostage (+$${ECON.hostage.rescuerBonus})`);
          if (h.carrier === refs.human) centerMessage("HOSTAGE RESCUED", "+$" + ECON.hostage.rescuerBonus, 1.5);
          h.carrier = null; checkRoundEnd(); break;
        }
      }
    } else if (h.carrier && !h.carrier.alive) { h.carrier.carrying = null; h.carrier = null; }
  }
}

/* ============================== buy menu ============================== */
export function buildBuyMenu() {
  const human = refs.human;
  const grid = $("#buyGrid"); grid.innerHTML = "";
  const items = [];
  for (const k of ["glock", "usp", "duals", "deagle", "r8"]) if (WEAPONS[k].side === "both" || sideAllows(k)) items.push({ type: "w", k });
  for (const k of ["ssg", "scar", "g3"]) if (WEAPONS[k].side === "both" || sideAllows(k)) items.push({ type: "w", k });
  items.push({ type: "armor", k: "kevlar" }); items.push({ type: "armor", k: "kevhelm" });
  for (const k of ["he", "flash", "smoke", "molly", "inc"]) { const n = NADES[k]; if (!n.side || n.side === human.team) items.push({ type: "nade", k }); }
  const keymap = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "q", "w", "e", "r", "t", "y", "u"];
  items.forEach((it, i) => {
    const el = document.createElement("div"); el.className = "buyitem";
    let nm, cost, desc;
    if (it.type === "w") { const w = WEAPONS[it.k]; nm = w.name; cost = w.cost; desc = `${w.dmg} dmg · ${w.penPct}% AP · ${w.rpm} RPM`; }
    else if (it.type === "armor") { nm = ARMOR[it.k].name; cost = ARMOR[it.k].cost; desc = it.k === "kevhelm" ? "100 armor + helmet" : "100 armor"; }
    else { const n = NADES[it.k]; nm = n.name; cost = n.cost; desc = n.kind; }
    el.innerHTML = `<div class="bn"><span><span class="key">${keymap[i] || ""}</span>${nm}</span><span class="bp">$${cost}</span></div><div class="bd">${desc}</div>`;
    el.onclick = () => buyItem(it);
    el.oncontextmenu = e => { e.preventDefault(); sellItem(it); };   // right-click sells a gun bought this round
    el.dataset.idx = i; el._it = it; grid.appendChild(el);
  });
  buildBuyMenu._items = items; buildBuyMenu._keymap = keymap;
  refreshBuyAfford();
}
export function sideAllows(k) { return WEAPONS[k].side === refs.human.team; }
export function refreshBuyAfford() {
  const human = refs.human;
  $("#buyMoney").textContent = "$" + human.money;
  [...$("#buyGrid").children].forEach(el => {
    const it = el._it; if (!it) return;
    const cost = it.type === "w" ? WEAPONS[it.k].cost : it.type === "armor" ? ARMOR[it.k].cost : NADES[it.k].cost;
    let afford;
    if (it.type === "w") { const slotName = WEAPONS[it.k].slot === 2 ? 'primary' : 'secondary'; const prev = human.boughtThisBuy[slotName]; afford = human.money + (prev ? prev.cost : 0) >= cost; el.classList.toggle("owned", !!(prev && prev.key === it.k)); }
    else afford = human.money >= cost;
    el.classList.toggle("cant", !afford);
  });
}
export function canBuyNow() { return GAME.buyTimer > 0 && (GAME.phase === "buy" || GAME.phase === "live"); }
export function sellItem(it) {                              // right-click a weapon bought this buy to sell it back
  const human = refs.human;
  if (!canBuyNow() || !it || it.type !== "w") return;
  const w = WEAPONS[it.k], slotName = w.slot === 2 ? 'primary' : 'secondary';
  const bought = human.boughtThisBuy[slotName];
  if (!bought || bought.key !== it.k) { showHint("Can only sell what you bought this round"); return; }
  human.money = Math.min(ECON.max, human.money + bought.cost);
  delete human.weapons[it.k];
  if (slotName === 'primary') human.slotPrimary = null; else { human.slotSecondary = null; giveWeapon(human, human.team === TEAM.CT ? "usp" : "glock"); }   // keep a sidearm
  delete human.boughtThisBuy[slotName];
  selectBest(human); refreshBuyAfford(); updateAllHUD(); playBeep(360, 0.06);
}
export function buyItem(it) {
  const human = refs.human;
  if (!canBuyNow()) { showHint("Buy time is over"); return; }
  if (it.type === "w") {
    const w = WEAPONS[it.k];
    const slotName = w.slot === 2 ? 'primary' : 'secondary';
    const prev = human.boughtThisBuy[slotName];            // weapon bought THIS buy period in this slot
    const refund = prev ? prev.cost : 0;
    if (human.money + refund < w.cost) { showHint("Not enough money"); return; }
    if (prev) {                                            // misclick sellback: refund prior pick, replace it (CS2)
      human.money += prev.cost;
      if (prev.key !== it.k) delete human.weapons[prev.key];
      if (slotName === 'primary') human.slotPrimary = null; else human.slotSecondary = null;
    }
    giveWeapon(human, it.k); switchTo(human, it.k);
    human.money -= w.cost;
    human.boughtThisBuy[slotName] = { key: it.k, cost: w.cost };
    refreshBuyAfford(); updateAllHUD(); playBeep(700, 0.05);
    return;
  }
  const cost = it.type === "armor" ? ARMOR[it.k].cost : NADES[it.k].cost;
  if (human.money < cost) { showHint("Not enough money"); return; }
  if (it.type === "armor") { human.armor = 100; if (it.k === "kevhelm") human.helmet = true; }
  else { human.nades[it.k] = (human.nades[it.k] || 0) + 1; human.curNade = it.k; }
  human.money -= cost; refreshBuyAfford(); updateAllHUD(); playBeep(700, 0.05);
}
export function openBuy() { if (!canBuyNow()) { showHint("Buy time is over"); return; } buildBuyMenu(); $("#buyPanel").classList.add("show"); document.exitPointerLock(); }
export function closeBuy() { $("#buyPanel").classList.remove("show"); if (GAME.phase !== "warmup" && !$("#cheatPanel").classList.contains("show")) renderer.domElement.requestPointerLock(); }
export function showBuyAuto() { showHint("BUY PHASE — press B to open buy menu"); }

/* ============================== grenades ============================== */
export function throwNade(a, nadeKey) {
  if (!nadeKey || !(a.nades[nadeKey] > 0)) { if (a.isHuman) showHint("No grenade"); return false; }
  const kind = NADES[nadeKey].kind; a.nades[nadeKey]--;
  const o = eyePos(a); const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(a.pitch, a.yaw, 0, 'YXZ'));
  const vel = dir.multiplyScalar(900).add(new THREE.Vector3(0, 260, 0));
  const m = new THREE.Mesh(new THREE.SphereGeometry(5, 8, 8), new THREE.MeshStandardMaterial({ color: kind === "he" ? 0x3a5a2a : kind === "flash" ? 0xcccccc : kind === "smoke" ? 0x556 : 0x884422 }));
  m.position.copy(o); scene.add(m);
  nadeProjectiles.push({ m, pos: o.clone(), vel, kind, owner: a, t: 0 });
  sfxNade('throw', a.pos);
  if (a.curNade === nadeKey && a.nades[nadeKey] <= 0) { const left = Object.keys(a.nades).filter(k => a.nades[k] > 0); a.curNade = left[0] || null; }
  updateHUDWeapons();
  return true;
}
export function equipGrenade() {
  const human = refs.human;
  const left = Object.keys(human.nades).filter(k => human.nades[k] > 0);
  if (!left.length) { showHint("No grenades"); return; }
  const i = human.equippedNade ? left.indexOf(human.equippedNade) : -1;
  human.equippedNade = left[(i + 1) % left.length];
  setViewmodel(human.equippedNade, true);
  updateHUDWeapons(); showHint(NADES[human.equippedNade].name + " — left-click to throw");
}
export function updateNades(dt) {
  for (let i = nadeProjectiles.length - 1; i >= 0; i--) {
    const n = nadeProjectiles[i];
    n.vel.y -= GRAVITY * dt; n.pos.addScaledVector(n.vel, dt); n.t += dt;
    if (n.pos.y < 5) { if (n.vel.y < -120) sfxNade('bounce', n.pos); n.pos.y = 5; n.vel.y *= -0.4; n.vel.x *= 0.6; n.vel.z *= 0.6; }
    n.m.position.copy(n.pos);
    const detonate = (n.kind === "he" || n.kind === "flash") ? n.t > 1.6 : n.t > 1.2;
    if (detonate) { detonateNade(n); scene.remove(n.m); nadeProjectiles.splice(i, 1); }
  }
}
function detonateNade(n) {
  if (n.kind === "he") {
    addExplosion(n.pos, 0xff8030, 160);
    sfxNade('detonate', n.pos);
    for (const t of agents) {
      if (!t.alive) continue; const d = t.pos.distanceTo(n.pos);
      if (d < 300 && losClear(n.pos, hitboxCenter(t, "chest"), false)) {
        let dmg = Math.round(98 * (1 - d / 300));
        if (dmg > 0) { t.armor = Math.max(0, t.armor - dmg * 0.5); t.hp -= dmg; if (t.isHuman && t !== n.owner) damageFlash(dmg); if (t.hp <= 0) killAgent(n.owner, t, "chest", "he"); }
      }
    }
  } else if (n.kind === "flash") {
    addExplosion(n.pos, 0xffffff, 120);
    for (const t of agents) {
      if (!t.alive) continue; const d = t.pos.distanceTo(n.pos);
      if (d < 700 && losClear(n.pos, eyePos(t), false)) {
        const facing = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(t.pitch, t.yaw, 0, 'YXZ'));
        const to = n.pos.clone().sub(eyePos(t)).normalize(); const dot = facing.dot(to);
        const amt = THREE.MathUtils.clamp((dot + 0.3), 0, 1) * (1 - d / 700);
        t.flashT = Math.max(t.flashT, amt * 2.5); if (t === refs.human) doFlash(amt * 2.5);
      }
    }
  } else if (n.kind === "smoke") {
    const s = { pos: n.pos.clone(), r: 130, alive: true, t: 0, life: 14, mesh: null };
    const m = new THREE.Mesh(new THREE.SphereGeometry(130, 16, 16), new THREE.MeshStandardMaterial({ color: 0xbcc2cc, transparent: true, opacity: .85, roughness: 1 })); m.position.copy(n.pos); m.position.y = 90; scene.add(m); s.mesh = m; smokes.push(s);
  } else if (n.kind === "fire") {
    const f = { pos: n.pos.clone(), r: 140, alive: true, t: 0, life: 7, mesh: null, owner: n.owner };
    const m = new THREE.Mesh(new THREE.CylinderGeometry(140, 140, 10, 16), new THREE.MeshBasicMaterial({ color: 0xff5a20, transparent: true, opacity: .5 })); m.position.copy(n.pos); m.position.y = 6; scene.add(m); f.mesh = m; fires.push(f);
  }
}
export function updateAreas(dt) {
  for (let i = smokes.length - 1; i >= 0; i--) {
    const s = smokes[i]; s.t += dt;
    if (s.t > s.life) { s.alive = false; scene.remove(s.mesh); smokes.splice(i, 1); }
    else if (s.t > s.life - 2) s.mesh.material.opacity = 0.85 * (s.life - s.t) / 2;
  }
  for (let i = fires.length - 1; i >= 0; i--) {
    const f = fires[i]; f.t += dt; if (f.t > f.life) { scene.remove(f.mesh); fires.splice(i, 1); continue; }
    for (const t of agents) { if (t.alive && Math.hypot(t.pos.x - f.pos.x, t.pos.z - f.pos.z) < f.r) { t.hp -= 8 * dt; if (t.isHuman) damageFlash(8 * dt * 4); if (t.hp <= 0) killAgent(f.owner || t, t, "chest", "fire"); } }
  }
}

/* spectate on death */
export function onHumanDeath() { centerMessage("YOU DIED", "Spectating — next round soon", 2); $("#scopeOverlay").style.display = "none"; refs.human.scoped = false; }
