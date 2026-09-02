/* ============================== [CHEAT] ==============================
   The player cheat menu (press I) and its localStorage/cookie config.
   Laid out the way a real HvH menu is: a nav rail of tabs down the left, one
   pane of grouped settings at a time on the right, and the config controls on
   their own tab instead of glued to the bottom of a 200-row scroll.          */
import { renderer } from './core.js';
import { MAX_BACKTRACK_TICKS, TICK_RATE, SHIFT_MAX_TICKS, HIDE_SHOT_COST, WEAPONS } from './data.js';
import { refs, GAME } from './state.js';
import { defaultCheats } from './agents.js';
import { showHint, updateHUDWeapons } from './hud.js';

const $ = s => document.querySelector(s);

/* ---- nav rail icons ----
   Inline SVG rather than emoji: emoji render as the platform's own coloured glyphs, which on a dark
   rail came out near-black and vanished.  These are drawn in `currentColor`, so the rail's own colour
   and opacity decide how they look, and they scale cleanly at any size.
   The anti-aim icon is the crouching-operator silhouette from the CS sticker — the pose is the whole
   point of the tab it opens. */
const ICONS = {
  rage: `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7.6"/><path d="M12 1.4v4.2M12 18.4v4.2M1.4 12h4.2M18.4 12h4.2"/></g><circle cx="12" cy="12" r="2.1"/></svg>`,
  aa: `<svg viewBox="0 0 64 84" aria-hidden="true"><g fill="currentColor" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <rect x="47.5" y="36" width="4.2" height="42" rx="1.4" stroke="none"/><rect x="45" y="21" width="9.5" height="21" rx="2" stroke="none"/><rect x="42.5" y="74.5" width="12" height="5" rx="2" stroke="none"/>
    <path d="M24 47 L13 60 L9 70" stroke-width="11" fill="none"/><path d="M6 71.5 L16 71.5" stroke-width="9" fill="none"/>
    <path d="M30 47 L35 60 L34 70" stroke-width="11" fill="none"/><path d="M30 71.5 L41 71.5" stroke-width="9" fill="none"/>
    <path d="M20 49 C12 39 11 21 24 13 C31 8 41 7 47 10 L46 24 C39 25 33 30 29 38 L28 50 Z" stroke-width="1"/>
    <path d="M15 20 C7 23 6 34 10 41 L18 37 Z" stroke-width="1"/>
    <path d="M42 5 C51 2 58 7 58 14 C58 21 52 25 46 23 C41 21 39 16 39 12 Z" stroke="none"/>
    <path d="M38 27 L45 33" stroke-width="6.5" fill="none"/></g></svg>`,
  tick: `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13.5" r="8.2"/><path d="M12 9v4.5l3 2"/><path d="M9.2 1.6h5.6M12 1.6v3.3"/></g></svg>`,
  vis: `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M1.7 12S5.9 5.2 12 5.2 22.3 12 22.3 12 18.1 18.8 12 18.8 1.7 12 1.7 12Z"/><circle cx="12" cy="12" r="3.1"/></g></svg>`,
  cfg: `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3.2 4.7A1.5 1.5 0 0 1 4.7 3.2h10.6l5.5 5.5v10.6a1.5 1.5 0 0 1-1.5 1.5H4.7a1.5 1.5 0 0 1-1.5-1.5Z"/><path d="M7.4 3.2v6h8V3.4"/><path d="M7.4 20.8v-7.4h9.2v7.4"/></g></svg>`,
};

/* Which weapon the Rage tab is editing. "global" edits the master values; picking a gun edits that
   gun's overrides of them. UI state only — nothing here is saved with the config. */
const WEP_KEYS = Object.keys(WEAPONS).filter(k => !WEAPONS[k].melee);
let selWeapon = "global";

/* which tab is open survives a rebuild — toggling a switch that rebuilds the menu
   must not throw you back to the first tab */
let activeTab = "rage";

function tabs() {
  const c = refs.human.cheats;
  return [
    { id: "rage", icon: ICONS.rage, name: "Rage", groups: [
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
        sw("Force body aim (baim)", () => c.aimbot.forceBody, v => c.aimbot.forceBody = v, "F2"),
        sw("Baim if lethal (body when it kills)", () => c.aimbot.baimLethal, v => c.aimbot.baimLethal = v, null, true),
        sw("Safepoint", () => c.aimbot.safepoint, v => c.aimbot.safepoint = v),
      ] },
      { title: "Accuracy gate · per weapon", rows: accuracyRows(c) },
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
    { id: "aa", icon: ICONS.aa, name: "Anti-Aim", groups: [
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
        keybind("Fake duck key", () => c.antiaim.fakeduckKey || "KeyX", v => c.antiaim.fakeduckKey = v, true),
        sel("Fake duck mode", ["hold", "toggle"], () => c.antiaim.fakeduckMode || "hold", v => c.antiaim.fakeduckMode = v, true),
        note(`The desync angle is the fake body's offset made geometry — 0° really is no fake at all now, and 58° swings ` +
             `it about a body's width off you. <b>freestanding</b> looks at the map and puts the fake where the nearest ` +
             `enemy can see it, leaving the real you behind the corner, so an un-resolved shot goes into the wall. ` +
             `<b>fake duck</b> needs neither of those: it holds you really ` +
             `ducked while the model keeps standing, so your hitboxes sit a stance-height <b>below</b> whatever ` +
             `anyone is aiming at. It is a <b>bind</b> — the switch above only arms it, and it engages while the key ` +
             `is held — because while it is on you are genuinely crouched and genuinely slow. Press it for a peek; ` +
             `don't leave it on and wonder why you are walking through treacle.`),
      ] },
      { title: "What breaks it", rows: [
        note(`Firing <b>pins your real angles</b> for a moment — that exposure is the read every resolver actually lives ` +
             `on, and it is why <b>hide shots</b> (Tickbase) is what makes anti-aim hold up. A fast yaw and a wide desync ` +
             `cost a resolver more, so jitter/spin at 58° is the hardest read and a plain back yaw the easiest.`),
      ] },
    ] },
    { id: "tick", icon: ICONS.tick, name: "Tickbase", groups: [
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
    { id: "visuals", icon: ICONS.vis, name: "Visuals", groups: [
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
    { id: "config", icon: ICONS.cfg, name: "Config", groups: [
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

/* Hit chance, min damage and hitbox priority, for whichever weapon the selector is on.
   "global" edits the master. A gun shows an override switch per setting: off, the row displays the
   master value greyed out and follows it; on, the weapon gets its own copy and stops following.
   Only overridden keys are stored, so the master still moves everything you have not pinned. */
function accuracyRows(c) {
  const wep = () => (c.aimbot.weapons || (c.aimbot.weapons = {}));
  const pick = sel("Weapon", ["global", ...WEP_KEYS], () => selWeapon, v => { selWeapon = v; buildCheatMenu(); });
  const hc = (get, set, sub, dim) => rng("Min hit chance", 0, 100, get, set, v => v + "%", sub, dim);
  const md = (get, set, sub, dim) => rng("Min damage", 1, 101, get, set, null, sub, dim);
  const pr = (get, set, sub, dim) => sel("Hitbox priority", ["head", "body"], get, set, sub, dim);
  const explain = note(`Hit chance is measured, not estimated: the spread cone is traced against the hitbox you're aiming ` +
    `at and scaled by how much of that hitbox is out of cover — then <b>the bullet is rolled down the same cone</b>. ` +
    `So <b>100% means 100%</b>: the whole cone has to fit inside the hitbox with the whole silhouette exposed, which is ` +
    `rare and stays rare. When it does fire, the only thing left that can beat it is the resolver.`);
  if (selWeapon === "global") return [
    pick,
    hc(() => c.aimbot.hitchance, v => c.aimbot.hitchance = v),
    md(() => c.aimbot.minDmg, v => c.aimbot.minDmg = v),
    pr(() => c.aimbot.priority === "head" ? "head" : "body", v => c.aimbot.priority = v === "head" ? "head" : "chest"),
    note(`These are the <b>master</b> values — every weapon uses them until you pick a gun above and override it.`),
    explain,
  ];
  const W = selWeapon, name = WEAPONS[W] ? WEAPONS[W].name : W;
  const bag = () => (wep()[W] || (wep()[W] = {}));
  const has = k => !!(wep()[W] && wep()[W][k] != null);
  const masters = { hitchance: () => c.aimbot.hitchance, minDmg: () => c.aimbot.minDmg, priority: () => c.aimbot.priority };
  const setOvr = (k, on) => {
    if (on) bag()[k] = masters[k]();
    else { const o = wep()[W]; if (o) { delete o[k]; if (!Object.keys(o).length) delete wep()[W]; } }
    buildCheatMenu();
  };
  const val = k => (has(k) ? wep()[W][k] : masters[k]());
  return [
    pick,
    sw(`Min hit chance override`, () => has("hitchance"), v => setOvr("hitchance", v)),
    hc(() => val("hitchance"), v => { if (has("hitchance")) bag().hitchance = v; }, true, !has("hitchance")),
    sw(`Min damage override`, () => has("minDmg"), v => setOvr("minDmg", v)),
    md(() => val("minDmg"), v => { if (has("minDmg")) bag().minDmg = v; }, true, !has("minDmg")),
    sw(`Hitbox priority override`, () => has("priority"), v => setOvr("priority", v)),
    pr(() => val("priority") === "head" ? "head" : "body", v => { if (has("priority")) bag().priority = v === "head" ? "head" : "chest"; }, true, !has("priority")),
    note(`Editing <b>${name}</b>. A setting with its override off is greyed out and simply follows the master, so ` +
         `raising the master still raises every gun you have not pinned. Turn one on and this weapon keeps its own ` +
         `value from then on.`),
    explain,
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
function rng(label, min, max, get, set, fmt, sub, dim) {
  const show = v => String(fmt ? fmt(v) : v);
  const row = document.createElement("div"); row.className = "crow col" + (sub ? " sub" : "") + (dim ? " dim" : "");
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
function sel(label, opts, get, set, sub, dim) {
  const row = document.createElement("div"); row.className = "crow col" + (sub ? " sub" : "") + (dim ? " dim" : "");
  row.innerHTML = `<div class="slab">${label}</div><div class="selwrap"><select>${opts.map(o => `<option ${o === get() ? 'selected' : ''}>${o}</option>`).join("")}</select></div>`;
  const s = row.querySelector("select"); s.onchange = () => set(s.value); row._sync = () => s.value = get(); return row;
}
/* A key bind: click it, press the key you want. The capture listener runs in the CAPTURE phase and
   stops the event, so the game's own keydown handler never sees the key you are binding. */
function keybind(label, get, set, sub) {
  const row = document.createElement("div"); row.className = "crow" + (sub ? " sub" : "");
  row.innerHTML = `<span class="clabel">${label}</span><button class="kbind"></button>`;
  const btn = row.querySelector("button");
  const show = () => { btn.textContent = keyName(get()); btn.classList.remove("cap"); };
  btn.onclick = () => {
    btn.textContent = "press a key…"; btn.classList.add("cap");
    const grab = e => {
      e.preventDefault(); e.stopPropagation();
      removeEventListener("keydown", grab, true);
      if (e.code !== "Escape") set(e.code);
      show();
    };
    addEventListener("keydown", grab, true);
  };
  row._sync = show; show(); return row;
}
function keyName(code) {
  if (!code) return "—";
  return String(code).replace(/^Key/, "").replace(/^Digit/, "").replace(/^Arrow/, "").replace(/^Numpad/, "Num ")
    .replace(/^Control/, "Ctrl ").replace(/^(Shift|Alt|Meta)/, "$1 ").replace(/Left$/, "L").replace(/Right$/, "R") || String(code);
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
