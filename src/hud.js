/* ============================== [HUD] ==============================
   HUD, radar, killfeed, hit log, scoreboard, ESP/wallhack, the dynamic
   crosshair/bloom ring, scope overlay, reload ring, R8 hammer anim and the
   tiny WebAudio SFX.  Also the small message/marker helpers everyone uses.  */
import * as THREE from 'three';
import { camera } from './core.js';
import { WEAPONS, NADES, TEAM } from './data.js';
import { WALLS, RESCUE_ZONES, MAP_BOUNDS, losClear } from './world.js';
import { hitboxCenter, eyePos } from './agents.js';
import { agents, refs, GAME, vm } from './state.js';
import { computeBloom, visibleTo } from './combat.js';
import { liveHostages } from './game.js';

const $ = s => document.querySelector(s);

export function centerMessage(main, sub, secs, persist) {
  const cm = $("#centerMsg"); cm.querySelector(".main").textContent = main; cm.querySelector(".sub").textContent = sub;
  cm.classList.toggle("matchend", !!persist);
  cm.style.opacity = main ? "1" : "0";
  if (!persist) { clearTimeout(centerMessage._t); centerMessage._t = setTimeout(() => { cm.style.opacity = "0"; }, secs * 1000); }
}
export function showHint(txt) { const h = $("#hint"); h.textContent = txt; h.style.opacity = "1"; clearTimeout(showHint._t); showHint._t = setTimeout(() => h.style.opacity = "0", 2200); }
let _hintOnce = 0;
export function showHintOnce(t) { if (performance.now() - _hintOnce > 3000) { showHint(t); _hintOnce = performance.now(); } }
export function hitmarker(hs) { const h = $("#hitmarker"); h.style.color = hs ? "#ff5a5a" : "#fff"; h.style.opacity = "1"; clearTimeout(hitmarker._t); hitmarker._t = setTimeout(() => h.style.opacity = "0", 120); }
export function damageFlash(amt) { const f = $("#dmgflash"); const a = Math.min(.7, amt / 60); f.style.boxShadow = `inset 0 0 160px 40px rgba(255,0,0,${a})`; setTimeout(() => f.style.boxShadow = "inset 0 0 160px 40px rgba(255,0,0,0)", 120); }
export function doFlash(dur) { const f = $("#flashbang"); f.style.transition = "none"; f.style.opacity = "1"; setTimeout(() => { f.style.transition = `opacity ${dur}s`; f.style.opacity = "0"; }, 30); }

const kfEl = $("#killfeed");
export function addKillFeed(killer, victim, wkey, hs) {
  const div = document.createElement("div"); div.className = "kf";
  const kc = killer.team === TEAM.CT ? "a-ct" : "a-t", vc = victim.team === TEAM.CT ? "a-ct" : "a-t";
  div.innerHTML = `<span class="${kc}">${killer.name}</span> <span class="wpn">▸ ${WEAPONS[wkey]?.name || ""}${hs ? ' <span class="hs">⊕</span>' : ''} ▸</span> <span class="${vc}">${victim.name}</span>`;
  kfEl.prepend(div); setTimeout(() => div.remove(), 5000); while (kfEl.children.length > 6) kfEl.lastChild.remove();
}
export function addKillFeedText(t) { const div = document.createElement("div"); div.className = "kf"; div.textContent = t; kfEl.prepend(div); setTimeout(() => div.remove(), 5000); }
const hlEl = $("#hitlog");
export function addHitLog(text, kind) { const d = document.createElement("div"); d.className = "hl " + (kind || "hit"); d.textContent = text; hlEl.appendChild(d); setTimeout(() => d.remove(), 2200); while (hlEl.children.length > 7) hlEl.firstChild.remove(); }

export function updateAllHUD() { updateTopHUD(); updatePlayerHUD(); updateBotBars(); updateHUDWeapons(); }
export function updateTopHUD() {
  $("#scoreCT").textContent = GAME.scoreCT; $("#scoreT").textContent = GAME.scoreT;
  $("#roundInfo").textContent = `Round ${GAME.round} · ${GAME.half === 1 ? "First" : "Second"} Half · You: ${GAME.humanTeam}`;
}
export function updatePlayerHUD() {
  const human = refs.human; if (!human) return;
  $("#hpStat").querySelector(".val").textContent = Math.max(0, Math.ceil(human.hp));
  $("#armorStat").querySelector(".val").textContent = Math.max(0, Math.ceil(human.armor)) + "";
  $("#money").textContent = "$" + human.money;
}
export function updateHUDWeapons() {
  const human = refs.human; if (!human || !human.cur) return;
  if (human.equippedNade) {
    const n = NADES[human.equippedNade];
    $("#wepName").textContent = n.name;
    $("#ammo").innerHTML = `<span class="mag">💣 ${human.nades[human.equippedNade] || 0}</span>`;
  } else {
    const w = WEAPONS[human.cur], wp = human.weapons[human.cur] || { ammo: 0, reserve: 0 };
    $("#wepName").textContent = w.name;
    $("#ammo").innerHTML = w.melee ? `<span class="mag">🔪</span>` : `<span class="mag">${wp.ammo}</span> <span class="reserve">/ ${wp.reserve}</span>`;
  }
  const list = []; if (human.slotPrimary) list.push(human.slotPrimary); if (human.slotSecondary) list.push(human.slotSecondary); list.push('knife');
  const heldNades = Object.keys(human.nades || {}).filter(k => human.nades[k] > 0);
  $("#wepList").innerHTML = list.map(k => `<span class="${(!human.equippedNade && k === human.cur) ? 'sel' : ''}">${WEAPONS[k].name}</span>`).join("  ·  ")
    + (heldNades.length ? `  ·  <span class="${human.equippedNade ? 'sel' : ''}">💣${heldNades.map(k => NADES[k].name).join(',')}</span>` : "");
}
export function updateBotBars() {
  const colCT = $("#colCT"), colT = $("#colT"); colCT.innerHTML = ""; colT.innerHTML = "";
  for (const a of agents) {
    const chip = document.createElement("div"); chip.className = "pchip" + (a.alive ? "" : " dead");
    const side = a.team === TEAM.CT ? "ct" : "t";
    chip.innerHTML = `<span class="dot ${side}"></span><span class="nm ${a.isHuman ? 'you' : ''}">${a.name}</span><span class="hpbar"><span class="hpfill" style="width:${Math.max(0, a.hp)}%"></span></span>`;
    (a.team === TEAM.CT ? colCT : colT).appendChild(chip);
  }
}

/* radar */
const radar = $("#radar"), rctx = radar.getContext("2d");
export function drawRadar() {
  rctx.clearRect(0, 0, 190, 150);
  rctx.fillStyle = "#0c1119"; rctx.fillRect(0, 0, 190, 150);
  const { minX, maxX, minZ, maxZ } = MAP_BOUNDS;
  const sx = x => (x - minX) / (maxX - minX) * 190, sz = z => (z - minZ) / (maxZ - minZ) * 150;
  rctx.fillStyle = "#1c2530";
  for (const w of WALLS) { if (!w.block || w.top < 150) continue; rctx.fillRect(sx(w.minX), sz(w.minZ), Math.max(1, sx(w.maxX) - sx(w.minX)), Math.max(1, sz(w.maxZ) - sz(w.minZ))); }
  rctx.fillStyle = "rgba(60,200,90,.4)"; for (const rz of RESCUE_ZONES) { rctx.beginPath(); rctx.arc(sx(rz.x), sz(rz.z), 5, 0, 7); rctx.fill(); }
  rctx.fillStyle = "#ff8a3c"; for (const h of liveHostages()) { rctx.fillRect(sx(h.pos.x) - 2, sz(h.pos.z) - 2, 4, 4); }
  for (const a of agents) {
    if (!a.alive) continue;
    rctx.fillStyle = a.isHuman ? "#fff" : (a.team === TEAM.CT ? "#7db9ff" : "#ffce6b");
    rctx.beginPath(); rctx.arc(sx(a.pos.x), sz(a.pos.z), a.isHuman ? 3.4 : 2.6, 0, 7); rctx.fill();
    if (a.isHuman) { rctx.strokeStyle = "#fff"; rctx.beginPath(); rctx.moveTo(sx(a.pos.x), sz(a.pos.z)); rctx.lineTo(sx(a.pos.x) - Math.sin(a.yaw) * 8, sz(a.pos.z) - Math.cos(a.yaw) * 8); rctx.stroke(); }
  }
}

/* scoreboard */
export function renderScoreboard() {
  const mapName = GAME.sourceMap || (GAME.customMap ? GAME.customMap.name : 'cs_office');
  $("#sbTitle").textContent = `${mapName} · MR12 · CT ${GAME.scoreCT} : ${GAME.scoreT} T · Round ${GAME.round}`;
  for (const [side, el] of [[TEAM.CT, $("#sbCT")], [TEAM.T, $("#sbT")]]) {
    const list = agents.filter(a => a.team === side).sort((a, b) => b.kills - a.kills);
    el.innerHTML = `<div class="hd"><span></span><span>${side}</span><span>K</span><span>D</span><span>$</span><span>Weapon</span></div>` +
      list.map(a => `<div class="sbrow ${side === TEAM.CT ? 'ct' : 't'} ${a.alive ? '' : 'dead'} ${a.isHuman ? 'me' : ''}">
        <span>${a.alive ? '●' : '✕'}</span><span class="${a.isHuman ? 'you' : ''}">${a.name}</span><span>${a.kills}</span><span>${a.deaths}</span><span>$${a.money}</span><span>${WEAPONS[a.cur]?.name || '-'}</span></div>`).join("");
  }
}

/* ESP + reload ring + bloom ring + scope */
const espCanvas = document.getElementById('esp'), espCtx = espCanvas.getContext('2d');
function worldToScreen(v, W, H) { const p = v.clone().project(camera); if (p.z > 1) return null; return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H, behind: p.z > 1 }; }
export function updateESP() {
  if (espCanvas.width !== innerWidth) { espCanvas.width = innerWidth; espCanvas.height = innerHeight; }
  espCtx.clearRect(0, 0, espCanvas.width, espCanvas.height);
  const human = refs.human; const v = human && human.cheats.visuals;
  const W = espCanvas.width, H = espCanvas.height;
  // SPECTATING (human dead): a name tag above every alive player's head, coloured by team
  if (human && !human.alive && GAME.phase !== "warmup") {
    espCtx.font = "bold 12px 'Trebuchet MS',sans-serif"; espCtx.textAlign = "center";
    for (const e of agents) {
      if (!e.alive) continue;
      const head = hitboxCenter(e, "head"); head.y += 16;
      const ph = worldToScreen(head, W, H); if (!ph || ph.behind) continue;
      espCtx.lineWidth = 3; espCtx.strokeStyle = "rgba(0,0,0,.6)"; espCtx.strokeText(e.name, ph.x, ph.y);
      espCtx.fillStyle = e.team === TEAM.CT ? "#7fb4ff" : "#ffb46a"; espCtx.fillText(e.name, ph.x, ph.y);
    }
    return;
  }
  if (!v || !v.esp || !human || !human.alive || GAME.phase === "warmup") return;
  for (const e of agents) {
    if (!e.alive || e.isHuman || e.team === human.team) continue;
    const head = hitboxCenter(e, "head"); head.y += 10; const feet = new THREE.Vector3(e.pos.x, 0, e.pos.z);
    const ph = worldToScreen(head, W, H), pf = worldToScreen(feet, W, H);
    if (!ph || !pf || ph.behind || pf.behind) continue;
    const h = Math.max(8, pf.y - ph.y), w = h * 0.42, x = ph.x - w / 2, y = ph.y;
    const vis = visibleTo(human, e);
    espCtx.lineWidth = 1.5; espCtx.strokeStyle = vis ? "#39ff5a" : "#ff6464";
    if (v.snaplines) { espCtx.beginPath(); espCtx.moveTo(W / 2, H); espCtx.lineTo(ph.x, ph.y); espCtx.strokeStyle = "rgba(255,90,90,.45)"; espCtx.stroke(); espCtx.strokeStyle = vis ? "#39ff5a" : "#ff6464"; }
    if (v.boxes) espCtx.strokeRect(x, y, w, h);
    if (v.health) { const hp = Math.max(0, Math.min(1, e.hp / 100)); espCtx.fillStyle = "#000"; espCtx.fillRect(x - 6, y, 3, h); espCtx.fillStyle = `hsl(${hp * 120},85%,50%)`; espCtx.fillRect(x - 6, y + h * (1 - hp), 3, h * hp); }
    if (v.name) { espCtx.fillStyle = vis ? "#d6f5d6" : "#f2c4c4"; espCtx.font = "11px 'Trebuchet MS',sans-serif"; espCtx.textAlign = "center"; espCtx.fillText(e.name + (e.cur ? " · " + (WEAPONS[e.cur] ? WEAPONS[e.cur].name : "") : ""), ph.x, y - 5); }
    if (v.distance) { espCtx.fillStyle = "#cdd6e4"; espCtx.font = "9px sans-serif"; espCtx.textAlign = "center"; espCtx.fillText(Math.round(human.pos.distanceTo(e.pos) / 40) + "m", ph.x, pf.y + 11); }
  }
}
const RELOAD_C = 2 * Math.PI * 20;
export function updateReloadRing() {
  const human = refs.human; const ring = document.getElementById('reloadRing');
  if (human && human.alive && human.reloadT > 0 && human.reloadTotal > 0 && !GAME.thirdPerson) {
    ring.style.display = "block";
    const prog = 1 - (human.reloadT / human.reloadTotal);
    const fg = ring.querySelector('.fg'); fg.style.strokeDasharray = RELOAD_C; fg.style.strokeDashoffset = RELOAD_C * (1 - prog);
  } else ring.style.display = "none";
}
export function anyPanelOpen() {
  return $("#buyPanel").classList.contains("show") || $("#cheatPanel").classList.contains("show") || $("#startPanel").classList.contains("show");
}
export function updateBloomRing() {
  const human = refs.human; const ring = document.getElementById('bloomRing');
  if (!human || !human.alive || human.scoped || human.equippedNade || anyPanelOpen()) { ring.style.display = "none"; return; }
  ring.style.display = "block";
  const bloom = computeBloom(human);
  const focal = (innerHeight / 2) / Math.tan((camera.fov * Math.PI / 180) / 2);
  let dia = THREE.MathUtils.clamp(bloom * focal * 1.3, 6, 340);
  ring.style.width = dia + "px"; ring.style.height = dia + "px";
  setCrosshairGap(THREE.MathUtils.clamp(dia * 0.22, 2, 80));
}
export function updateScopeOverlay() {
  const human = refs.human; const ov = document.getElementById('scopeOverlay');
  const scoped = human && human.alive && human.scoped && WEAPONS[human.cur] && WEAPONS[human.cur].scope;
  ov.style.display = scoped ? "block" : "none";
  ov.classList.toggle('tpscope', !!(scoped && GAME.thirdPerson));
}
export function updateR8Hammer() {
  const human = refs.human;
  if (vm.current && vm.current.userData && vm.current.userData.hammer) { vm.current.userData.hammer.rotation.x = (human.cur === "r8") ? -(human.r8Charge || 0) * 1.25 : 0; }
  for (const a of agents) {
    const w = a.body.weapon; if (!w || !w.userData || !w.userData.hammer) continue;
    const c = a.isHuman ? (a.r8Charge || 0) : (a.fireCd > 0 ? 1 - Math.min(1, a.fireCd / 0.25) : 0.9);
    w.userData.hammer.rotation.x = -c * 1.25;
  }
}

/* ---- sound (tiny WebAudio) ---- */
let actx = null;
export function audio() { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } return actx; }
let beepMute = false;
export function setBeepMute(on) { beepMute = on; }   // silence beeps during fast-forward extra steps
export function playBeep(freq, dur, type = "square", vol = 0.05) { if (beepMute) return; const c = audio(); if (!c) return; const o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.value = freq; g.gain.value = vol; o.connect(g); g.connect(c.destination); o.start(); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur); o.stop(c.currentTime + dur); }
export function playHitmarker(headshot) {
  const c = audio(); if (!c) return;
  const tick = (f, t0, dur, vol) => { const o = c.createOscillator(), g = c.createGain(); o.type = "square"; o.frequency.value = f; g.gain.setValueAtTime(vol, c.currentTime + t0); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + t0 + dur); o.connect(g); g.connect(c.destination); o.start(c.currentTime + t0); o.stop(c.currentTime + t0 + dur); };
  if (headshot) { tick(1400, 0, 0.04, 0.07); tick(2000, 0.045, 0.06, 0.06); } else { tick(1050, 0, 0.045, 0.06); }
}
export function playShot(key) { const c = audio(); if (!c) return; const o = c.createOscillator(), g = c.createGain(); o.type = "sawtooth"; const base = WEAPONS[key].scope ? 180 : 120; o.frequency.setValueAtTime(base * 4, c.currentTime); o.frequency.exponentialRampToValueAtTime(base, c.currentTime + 0.08); g.gain.setValueAtTime(0.07, c.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.12); o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + 0.13); }

export function formatTime(s) { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, '0'); }

/* ---- crosshair ---- */
let chLines = null;
export function buildCrosshair() {
  const c = $("#crosshair"); c.innerHTML = "";
  const mk = () => { const d = document.createElement("div"); d.className = "ch-line"; c.appendChild(d); return d; };
  chLines = { t: mk(), b: mk(), l: mk(), r: mk(), dot: mk() };
  setCrosshairGap(3);
}
export function setCrosshairGap(gap) {
  if (!chLines) return; const len = 7, th = 2, s = (el, w, h, x, y) => { el.style.width = w + "px"; el.style.height = h + "px"; el.style.left = x + "px"; el.style.top = y + "px"; };
  s(chLines.t, th, len, -th / 2, -(gap + len));
  s(chLines.b, th, len, -th / 2, gap);
  s(chLines.l, len, th, -(gap + len), -th / 2);
  s(chLines.r, len, th, gap, -th / 2);
  s(chLines.dot, 2, 2, -1, -1);
}
