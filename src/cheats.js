/* ============================== [CHEAT] ==============================
   The player cheat menu (press I) and its localStorage/cookie config.      */
import { renderer } from './core.js';
import { refs, GAME } from './state.js';
import { defaultCheats } from './agents.js';
import { showHint, updateHUDWeapons } from './hud.js';

const $ = s => document.querySelector(s);

export function buildCheatMenu() {
  const c = refs.human.cheats; const body = $("#cheatBody");
  const tabs = [
    { title: "🎯 Ragebot / Aimbot", rows: [
      sw("Aimbot enabled", () => c.aimbot.on, v => c.aimbot.on = v, "F1"),
      sel("Target", "aimTarget", ["crosshair", "distance", "lowhp"], () => c.aimbot.target, v => c.aimbot.target = v),
      sel("Hitbox priority", "aimPrio", ["head", "body"], () => c.aimbot.priority === "head" ? "head" : "body", v => c.aimbot.priority = v === "head" ? "head" : "chest"),
      sw("Force body aim (baim)", () => c.aimbot.forceBody, v => c.aimbot.forceBody = v, "F2"),
      sw("Baim if lethal (body when it kills)", () => c.aimbot.baimLethal, v => c.aimbot.baimLethal = v),
      sw("Safepoint", () => c.aimbot.safepoint, v => c.aimbot.safepoint = v),
      rng("Hit chance %", 0, 100, () => c.aimbot.hitchance, v => c.aimbot.hitchance = v),
      rng("Min damage", 1, 101, () => c.aimbot.minDmg, v => c.aimbot.minDmg = v),
      sw("Silent aim", () => c.aimbot.silent, v => c.aimbot.silent = v),
      sw("Auto shoot (triggerbot)", () => c.aimbot.autoShoot, v => c.aimbot.autoShoot = v, "F3"),
      sw("Auto scope", () => c.aimbot.autoScope, v => c.aimbot.autoScope = v),
      sw("Auto stop (stop to shoot)", () => c.aimbot.autoStop, v => c.aimbot.autoStop = v, "F6"),
      sw("Auto knife (slash in range)", () => c.aimbot.autoKnife, v => c.aimbot.autoKnife = v),
      sw("Auto revolver (pre-cock R8)", () => c.aimbot.autoRevolver, v => c.aimbot.autoRevolver = v),
    ] },
    { title: "🧱 Autowall / Penetration", rows: [
      sw("Autowall enabled", () => c.autowall.on, v => c.autowall.on = v, "F4"),
      rng("Autowall min dmg", 1, 100, () => c.autowall.minDmg, v => c.autowall.minDmg = v),
    ] },
    { title: "🧠 Resolver", rows: [
      sw("Resolver enabled", () => c.resolver.on, v => c.resolver.on = v),   // on/off — a desyncing enemy still beats it sometimes
    ] },
    { title: "🌀 Anti-Aim", rows: [
      sw("Anti-aim enabled", () => c.antiaim.on, v => c.antiaim.on = v, "F5"),
      sel("Yaw", "aaYaw", ["back", "sideways", "spin", "jitter"], () => c.antiaim.yaw, v => c.antiaim.yaw = v),
      sel("Pitch", "aaPitch", ["down", "up", "zero"], () => c.antiaim.pitch, v => c.antiaim.pitch = v),
      sw("Desync", () => c.antiaim.desync, v => c.antiaim.desync = v),
      rng("Desync angle", 0, 58, () => c.antiaim.desyncAngle, v => c.antiaim.desyncAngle = v),
      sel("Mode", "aaMode", ["at_target", "freestanding"], () => c.antiaim.mode, v => c.antiaim.mode = v),
      sw("Fake duck", () => c.antiaim.fakeduck, v => c.antiaim.fakeduck = v),
    ] },
    { title: "⏱ Backtrack", rows: [
      rng("Backtrack (ms)", 0, 400, () => c.tickbase.backtrack, v => c.tickbase.backtrack = v),
    ] },
    { title: "👁 Visuals (Wallhack / ESP)", rows: [
      sw("ESP enabled", () => c.visuals.esp, v => c.visuals.esp = v, "F7"),
      sw("Boxes", () => c.visuals.boxes, v => c.visuals.boxes = v),
      sw("Health bar", () => c.visuals.health, v => c.visuals.health = v),
      sw("Name + weapon", () => c.visuals.name, v => c.visuals.name = v),
      sw("Distance", () => c.visuals.distance, v => c.visuals.distance = v),
      sw("Snaplines", () => c.visuals.snaplines, v => c.visuals.snaplines = v),
      sw("Chams (wallhack through walls)", () => c.visuals.chams, v => c.visuals.chams = v, "F8"),
      col("Chams: visible color", () => c.visuals.chamsVisible, v => c.visuals.chamsVisible = v),
      col("Chams: occluded color", () => c.visuals.chamsOccluded, v => c.visuals.chamsOccluded = v),
      sw("Desync ghost model (local)", () => c.visuals.desyncGhost, v => c.visuals.desyncGhost = v),
    ] },
  ];
  body.innerHTML = "";
  for (const t of tabs) {
    const d = document.createElement("div"); d.className = "ctab";
    d.innerHTML = `<div class="h">${t.title}</div>`; const b = document.createElement("div"); b.className = "b";
    t.rows.forEach(r => b.appendChild(r)); d.appendChild(b); body.appendChild(d);
  }
  const bar = document.createElement("div"); bar.className = "cbtns";
  const save = document.createElement("button"); save.textContent = "💾 Save config";
  const load = document.createElement("button"); load.textContent = "📂 Load config";
  const reset = document.createElement("button"); reset.textContent = "↺ Reset";
  save.onclick = () => { saveConfig(); showHint("Config saved"); };
  load.onclick = () => { if (loadConfig()) { buildCheatMenu(); showHint("Config loaded"); } else showHint("No saved config"); };
  reset.onclick = () => { refs.human.cheats = defaultCheats(false); buildCheatMenu(); showHint("Cheats reset"); };
  bar.appendChild(save); bar.appendChild(load); bar.appendChild(reset); body.appendChild(bar);
}
function sw(label, get, set, key) {
  const row = document.createElement("div"); row.className = "crow";
  row.innerHTML = `<span class="clabel">${label}</span>${key ? `<span class="keytag">${key}</span>` : ""}<label class="switch"><input type="checkbox"><span class="slider"></span></label>`;
  const cb = row.querySelector("input"); cb.checked = get(); cb.onchange = () => { set(cb.checked); updateHUDWeapons(); };
  row._sync = () => cb.checked = get(); return row;
}
function rng(label, min, max, get, set) {
  const row = document.createElement("div"); row.className = "crow";
  row.innerHTML = `<label>${label}</label><input type="range" min="${min}" max="${max}" value="${get()}"><span class="cval">${get()}</span>`;
  const r = row.querySelector("input"), v = row.querySelector(".cval");
  r.oninput = () => { set(+r.value); v.textContent = r.value; }; row._sync = () => { r.value = get(); v.textContent = get(); }; return row;
}
function col(label, get, set) {
  const row = document.createElement("div"); row.className = "crow";
  row.innerHTML = `<label>${label}</label><input type="color" value="${get()}">`;
  const i = row.querySelector("input"); i.oninput = () => set(i.value); row._sync = () => i.value = get(); return row;
}
function sel(label, id, opts, get, set) {
  const row = document.createElement("div"); row.className = "crow";
  row.innerHTML = `<label>${label}</label><select>${opts.map(o => `<option ${o === get() ? 'selected' : ''}>${o}</option>`).join("")}</select>`;
  const s = row.querySelector("select"); s.onchange = () => set(s.value); row._sync = () => s.value = get(); return row;
}
export function toggleCheatMenu(force) {
  const p = $("#cheatPanel"); const show = force !== undefined ? force : !p.classList.contains("show");
  p.classList.toggle("show", show);
  if (show) document.exitPointerLock(); else if (GAME.phase !== "warmup" && GAME.phase !== "editor") renderer.domElement.requestPointerLock();
}
export function syncCheatUI() { document.querySelectorAll("#cheatBody .crow").forEach(r => r._sync && r._sync()); }

/* ---- config persistence (localStorage, cookie fallback) ---- */
export function saveConfig() {
  const json = JSON.stringify(refs.human.cheats);
  try { localStorage.setItem("hvh_cfg", json); return true; } catch (e) {}
  try { document.cookie = "hvh_cfg=" + encodeURIComponent(json) + ";max-age=31536000;path=/"; return true; } catch (e) { return false; }
}
export function loadConfig() {
  let json = null;
  try { json = localStorage.getItem("hvh_cfg"); } catch (e) {}
  if (!json) { try { const m = document.cookie.match(/(?:^|;\s*)hvh_cfg=([^;]+)/); if (m) json = decodeURIComponent(m[1]); } catch (e) {} }
  if (!json) return false;
  try { deepMerge(refs.human.cheats, JSON.parse(json)); return true; } catch (e) { return false; }
}
function deepMerge(target, src) { for (const k in src) { if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k]) && target[k]) deepMerge(target[k], src[k]); else target[k] = src[k]; } }
