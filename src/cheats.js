/* ============================== [CHEAT] ==============================
   The player cheat menu (press I) and its localStorage/cookie config.
   Laid out the way a real HvH menu is: a nav rail of tabs down the left, one
   pane of grouped settings at a time on the right, and the config controls on
   their own tab instead of glued to the bottom of a 200-row scroll.          */
import { renderer } from './core.js';
import { MAX_BACKTRACK_TICKS, TICK_RATE, SHIFT_MAX_TICKS, HIDE_SHOT_COST } from './data.js';
import { refs, GAME } from './state.js';
import { defaultCheats } from './agents.js';
import { showHint, updateHUDWeapons } from './hud.js';

const $ = s => document.querySelector(s);

/* which tab is open survives a rebuild — toggling a switch that rebuilds the menu
   must not throw you back to the first tab */
let activeTab = "rage";

function tabs() {
  const c = refs.human.cheats;
  return [
    { id: "rage", icon: "🎯", name: "Rage", groups: [
      { title: "Aimbot", rows: [
        sw("Aimbot enabled", () => c.aimbot.on, v => c.aimbot.on = v, "F1"),
        sel("Target", ["crosshair", "distance", "lowhp"], () => c.aimbot.target, v => c.aimbot.target = v, true),
        rng("FOV", 5, 180, () => c.aimbot.fov, v => c.aimbot.fov = v, v => v >= 180 ? "360° (rage)" : v + "°", true),
        sw("Silent aim", () => c.aimbot.silent, v => c.aimbot.silent = v, null, true),
        sw("Auto shoot (triggerbot)", () => c.aimbot.autoShoot, v => c.aimbot.autoShoot = v, "F3", true),
        sw("Auto scope", () => c.aimbot.autoScope, v => c.aimbot.autoScope = v, null, true),
        sw("Auto stop (stop to shoot)", () => c.aimbot.autoStop, v => c.aimbot.autoStop = v, "F6", true),
        sw("Auto knife (slash in range)", () => c.aimbot.autoKnife, v => c.aimbot.autoKnife = v, null, true),
        sw("Auto revolver (pre-cock R8)", () => c.aimbot.autoRevolver, v => c.aimbot.autoRevolver = v, null, true),
      ] },
      { title: "Target selection", rows: [
        sel("Hitbox priority", ["head", "body"], () => c.aimbot.priority === "head" ? "head" : "body", v => c.aimbot.priority = v === "head" ? "head" : "chest"),
        sw("Force body aim (baim)", () => c.aimbot.forceBody, v => c.aimbot.forceBody = v, "F2"),
        sw("Baim if lethal (body when it kills)", () => c.aimbot.baimLethal, v => c.aimbot.baimLethal = v, null, true),
        sw("Safepoint", () => c.aimbot.safepoint, v => c.aimbot.safepoint = v),
      ] },
      { title: "Accuracy gate", rows: [
        rng("Min hit chance", 0, 100, () => c.aimbot.hitchance, v => c.aimbot.hitchance = v, v => v + "%"),
        rng("Min damage", 1, 101, () => c.aimbot.minDmg, v => c.aimbot.minDmg = v),
        note(`Hit chance is measured, not estimated: the spread cone is traced against the hitbox you're aiming at ` +
             `and scaled by how much of that hitbox is out of cover — then <b>the bullet is rolled down the same cone</b>. ` +
             `So <b>100% means 100%</b>: the whole cone has to fit inside the hitbox with the whole silhouette exposed, ` +
             `which is rare and stays rare. When it does fire, the only thing left that can beat it is the resolver.`),
      ] },
      { title: "Autowall / penetration", rows: [
        sw("Autowall enabled", () => c.autowall.on, v => c.autowall.on = v, "F4"),
        rng("Autowall min dmg", 1, 100, () => c.autowall.minDmg, v => c.autowall.minDmg = v, null, true),
      ] },
      { title: "Resolver", rows: [
        sw("Resolver enabled", () => c.resolver.on, v => c.resolver.on = v),
        sel("Mode", ["animation", "brute", "onshot"], () => c.resolver.mode || "animation", v => c.resolver.mode = v, true),
        rng("Strength", 0, 100, () => Math.round((c.resolver.strength != null ? c.resolver.strength : 0.6) * 100), v => c.resolver.strength = v / 100, v => v + "%", true),
        rng("Shot memory", 0, 150, () => Math.round((c.resolver.memory != null ? c.resolver.memory : 0.55) * 100), v => c.resolver.memory = v / 100, v => (v / 100).toFixed(2) + "s", true),
        note(`Strength is a <b>ceiling, not an answer</b>. An enemy who fires without hiding the shot pins their real ` +
             `angles and hands you the read for <b>shot memory</b> seconds — until their desync side re-rolls. With no ` +
             `read the resolver guesses, and their anti-aim cuts the guess down. ` +
             `<b>animation</b> reads the body · <b>brute</b> starts worse and narrows across repeated shots at the same ` +
             `player · <b>onshot</b> is near-blind between exposures and excellent right after one.`),
      ] },
    ] },
    { id: "aa", icon: "🌀", name: "Anti-Aim", groups: [
      { title: "Angles", rows: [
        sw("Anti-aim enabled", () => c.antiaim.on, v => c.antiaim.on = v, "F5"),
        sel("Yaw", ["back", "sideways", "spin", "jitter", "sway", "rand"], () => c.antiaim.yaw, v => c.antiaim.yaw = v, true),
        rng("Jitter / sway range", 0, 180, () => c.antiaim.jitter, v => c.antiaim.jitter = v, v => v + "°", true),
        sel("Pitch", ["down", "up", "zero"], () => c.antiaim.pitch, v => c.antiaim.pitch = v, true),
      ] },
      { title: "Desync", rows: [
        sw("Desync", () => c.antiaim.desync, v => c.antiaim.desync = v),
        rng("Desync angle", 0, 58, () => c.antiaim.desyncAngle, v => c.antiaim.desyncAngle = v, v => v + "°", true),
        sel("Side", ["at_target", "freestanding"], () => c.antiaim.mode, v => c.antiaim.mode = v, true),
        sw("Fake duck", () => c.antiaim.fakeduck, v => c.antiaim.fakeduck = v, null, true),
        note(`The desync angle is the fake body's offset made geometry — 0° really is no fake at all now, and 58° swings ` +
             `it about a body's width off you. <b>freestanding</b> looks at the map and puts the fake where the nearest ` +
             `enemy can see it, leaving the real you behind the corner, so an un-resolved shot goes into the wall. ` +
             `<b>fake duck</b> renders the stance you are not in, so the fake is at the wrong <b>height</b> too — a bad ` +
             `read goes over a crouch or under a stand.`),
      ] },
      { title: "What breaks it", rows: [
        note(`Firing <b>pins your real angles</b> for a moment — that exposure is the read every resolver actually lives ` +
             `on, and it is why <b>hide shots</b> (Tickbase) is what makes anti-aim hold up. A fast yaw and a wide desync ` +
             `cost a resolver more, so jitter/spin at 58° is the hardest read and a plain back yaw the easiest.`),
      ] },
    ] },
    { id: "tick", icon: "⏱", name: "Tickbase", groups: [
      { title: "Backtrack · hide shots · double tap", rows: [
        rng("Backtrack (ticks)", 0, MAX_BACKTRACK_TICKS, () => c.tickbase.backtrack, v => c.tickbase.backtrack = v, t => `${t} tk · ${Math.round(t * 1000 / TICK_RATE)}ms`),
        sw("Hide shots (fire without pinning your real angle)", () => c.tickbase.hideShots, v => c.tickbase.hideShots = v),
        sw("Double tap (two rounds in one server frame)", () => c.tickbase.doubleTap, v => c.tickbase.doubleTap = v),
        note(`All three spend the same ${SHIFT_MAX_TICKS}-tick command budget, and a shot can only be shifted one way — ` +
             `double tap shifts forward, hide shots shifts back (${HIDE_SHOT_COST} ticks), so you get one or the other per shot and <b>double tap wins</b> ` +
             `(a doubled shot is an exposed shot). While a shift is still catching up, backtrack is suppressed. ` +
             `Double tap costs a weapon's whole fire cycle in ticks: Duals 10 · USP/Glock 13 · Deagle 15 · SCAR/G3 16. ` +
             `The SSG's bolt is 80, far over budget. <b>The R8 can't be doubled at all</b> — its trigger is a hammer-cock ` +
             `state machine rather than a next-attack check, so there is nothing to shift past, and no HvH cheat offers it.`),
      ] },
    ] },
    { id: "visuals", icon: "👁", name: "Visuals", groups: [
      { title: "ESP", rows: [
        sw("ESP enabled", () => c.visuals.esp, v => c.visuals.esp = v, "F7"),
        sw("Boxes", () => c.visuals.boxes, v => c.visuals.boxes = v, null, true),
        sw("Health bar", () => c.visuals.health, v => c.visuals.health = v, null, true),
        sw("Name + weapon", () => c.visuals.name, v => c.visuals.name = v, null, true),
        sw("Distance", () => c.visuals.distance, v => c.visuals.distance = v, null, true),
        sw("Snaplines", () => c.visuals.snaplines, v => c.visuals.snaplines = v, null, true),
      ] },
      { title: "Chams", rows: [
        sw("Chams (wallhack through walls)", () => c.visuals.chams, v => c.visuals.chams = v, "F8"),
        col("Visible colour", () => c.visuals.chamsVisible, v => c.visuals.chamsVisible = v, true),
        col("Occluded colour", () => c.visuals.chamsOccluded, v => c.visuals.chamsOccluded = v, true),
      ] },
      { title: "Shot lines", rows: [
        sw("Draw local shot lines", () => c.visuals.shotLines, v => c.visuals.shotLines = v),
        rng("Duration", 0, 60, () => Math.round((c.visuals.shotLineTime != null ? c.visuals.shotLineTime : 1.5) * 10), v => c.visuals.shotLineTime = v / 10, v => (v / 10).toFixed(1) + "s", true),
        col("Hit colour", () => c.visuals.shotLineHit || '#ff4d6d', v => c.visuals.shotLineHit = v, true),
        col("Miss colour", () => c.visuals.shotLineMiss || '#4dc3ff', v => c.visuals.shotLineMiss = v, true),
        note(`Every round <b>you</b> fire leaves a beam from its muzzle to wherever it actually ended up, drawn through ` +
             `walls and faded out over the duration above. A tracer is gone in 0.2s; this is the one you can still look ` +
             `at afterwards to see whether a shot was spread, a backtrack, or the resolver losing to a desync.`),
      ] },
      { title: "Debug", rows: [
        sw("Hit chance indicator", () => c.visuals.hitchance, v => c.visuals.hitchance = v),
        sw("Desync ghost model (local)", () => c.visuals.desyncGhost, v => c.visuals.desyncGhost = v),
        sw("Backtrack trail (furthest tick you can be rewound to)", () => c.visuals.backtrackTrail, v => c.visuals.backtrackTrail = v),
        sw("Backtrack ghost (the tick a rewound shot landed on)", () => c.visuals.backtrackGhost, v => c.visuals.backtrackGhost = v),
      ] },
    ] },
    { id: "config", icon: "💾", name: "Config", groups: [
      { title: "Config", rows: [
        btns([
          ["💾 Save config", () => { saveConfig(); showHint("Config saved"); }],
          ["📂 Load config", () => { if (loadConfig()) { buildCheatMenu(); showHint("Config loaded"); } else showHint("No saved config"); }],
          ["↺ Reset", () => { refs.human.cheats = defaultCheats(false); buildCheatMenu(); showHint("Cheats reset"); }],
        ]),
        note(`Saved to this browser (localStorage, with a cookie fallback) and loaded automatically on boot.`),
      ] },
      { title: "Keys", rows: [
        note(`<b>F1</b> aimbot · <b>F2</b> body aim · <b>F3</b> triggerbot · <b>F4</b> autowall · <b>F5</b> anti-aim · ` +
             `<b>F6</b> auto stop · <b>F7</b> ESP · <b>F8</b> chams · <b>I</b> this menu`),
      ] },
    ] },
  ];
}

export function buildCheatMenu() {
  const body = $("#cheatBody");
  const list = tabs();
  if (!list.some(t => t.id === activeTab)) activeTab = list[0].id;
  body.innerHTML = "";
  const nav = document.createElement("div"); nav.className = "cnav";
  const panes = document.createElement("div"); panes.className = "cpanes";
  panes.setAttribute("data-tab", (list.find(t => t.id === activeTab) || list[0]).name);
  for (const t of list) {
    const b = document.createElement("button");
    b.className = "cnavb" + (t.id === activeTab ? " on" : "");
    b.innerHTML = `<span class="ci">${t.icon}</span>`;      // icon only, the way a real menu's rail is
    b.title = t.name;
    b.onclick = () => { activeTab = t.id; buildCheatMenu(); };
    nav.appendChild(b);

    const pane = document.createElement("div"); pane.className = "cpane";
    if (t.id !== activeTab) pane.style.display = "none";
    for (const g of t.groups) {
      const d = document.createElement("div"); d.className = "cgrp";
      d.innerHTML = `<div class="h">${g.title}</div>`;
      const inner = document.createElement("div"); inner.className = "b";
      g.rows.forEach(r => inner.appendChild(r));
      d.appendChild(inner); pane.appendChild(d);
    }
    panes.appendChild(pane);
  }
  body.appendChild(nav); body.appendChild(panes);
}
/* ---- row builders ----
   Every row exposes `_sync()` so syncCheatUI() can pull the whole menu back into line after a hotkey
   changes something behind its back. */
function sw(label, get, set, key, sub) {
  const row = document.createElement("div"); row.className = "crow" + (sub ? " sub" : "");
  row.innerHTML = `<label class="chk"><input type="checkbox"><span class="box"></span></label><span class="clabel">${label}</span>${key ? `<span class="keytag">[${key}]</span>` : ""}`;
  const cb = row.querySelector("input"); cb.checked = get();
  cb.onchange = () => { set(cb.checked); updateHUDWeapons(); };
  row.querySelector(".clabel").onclick = () => { cb.checked = !cb.checked; set(cb.checked); updateHUDWeapons(); };
  row._sync = () => cb.checked = get(); return row;
}
/* A slider that draws its own value on the bar, the way cheat menus do — the number rides the edge of
   the fill instead of taking a column of its own, so a 30-row pane still fits two to a screen. */
function rng(label, min, max, get, set, fmt, sub) {
  const show = v => String(fmt ? fmt(v) : v);
  const row = document.createElement("div"); row.className = "crow col" + (sub ? " sub" : "");
  row.innerHTML = `<div class="slab">${label}</div><div class="sl"><div class="fill"></div><span class="sv"></span></div>`;
  const track = row.querySelector(".sl"), fill = row.querySelector(".fill"), sv = row.querySelector(".sv");
  const paint = () => {
    const t = max > min ? (get() - min) / (max - min) : 0;
    fill.style.width = (t * 100) + "%";
    sv.style.left = Math.max(t * 100, 0) + "%";
    sv.style.transform = t < 0.12 ? "translateX(0)" : "translateX(-100%)";   // near empty, put the number to the RIGHT of the fill or it lands off the bar
    sv.style.padding = t < 0.12 ? "0 0 0 4px" : "0 4px 0 0";
    sv.textContent = show(get());
  };
  const at = e => {
    const r = track.getBoundingClientRect(); if (!r.width) return;
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    set(Math.round(min + t * (max - min))); paint();
  };
  let dragging = false;
  track.onpointerdown = e => { dragging = true; if (track.setPointerCapture) track.setPointerCapture(e.pointerId); at(e); };
  track.onpointermove = e => { if (dragging) at(e); };
  track.onpointerup = track.onpointercancel = () => { dragging = false; };
  row._sync = paint; paint(); return row;
}
function note(html) { const row = document.createElement("div"); row.className = "cnote"; row.innerHTML = html; return row; }
function col(label, get, set, sub) {
  const row = document.createElement("div"); row.className = "crow" + (sub ? " sub" : "");
  row.innerHTML = `<span class="clabel">${label}</span><input type="color" value="${get()}">`;
  const i = row.querySelector("input"); i.oninput = () => set(i.value); row._sync = () => i.value = get(); return row;
}
function sel(label, opts, get, set, sub) {
  const row = document.createElement("div"); row.className = "crow col" + (sub ? " sub" : "");
  row.innerHTML = `<div class="slab">${label}</div><div class="selwrap"><select>${opts.map(o => `<option ${o === get() ? 'selected' : ''}>${o}</option>`).join("")}</select></div>`;
  const s = row.querySelector("select"); s.onchange = () => set(s.value); row._sync = () => s.value = get(); return row;
}
function btns(defs) {
  const bar = document.createElement("div"); bar.className = "cbtns";
  for (const [label, fn] of defs) { const b = document.createElement("button"); b.textContent = label; b.onclick = fn; bar.appendChild(b); }
  return bar;
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
  try {
    const cfg = JSON.parse(json);
    // backtrack used to be a millisecond slider (0-400). Anything above the tick cap is an old config —
    // convert it rather than silently clamping a "200" that meant 200ms down to the 16-tick maximum.
    if (cfg.tickbase && cfg.tickbase.backtrack > MAX_BACKTRACK_TICKS) cfg.tickbase.backtrack = Math.min(MAX_BACKTRACK_TICKS, Math.round(cfg.tickbase.backtrack * TICK_RATE / 1000));
    // the resolver used to be one flat probability called `accuracy`. It is a ceiling called `strength`
    // now and the old numbers were tuned against a resolver that always won, so cap what we carry over.
    if (cfg.resolver && cfg.resolver.strength == null && cfg.resolver.accuracy != null) cfg.resolver.strength = Math.min(0.75, cfg.resolver.accuracy);
    if (cfg.resolver) delete cfg.resolver.accuracy;
    deepMerge(refs.human.cheats, cfg);
    return true;
  } catch (e) { return false; }
}
function deepMerge(target, src) { for (const k in src) { if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k]) && target[k]) deepMerge(target[k], src[k]); else target[k] = src[k]; } }
