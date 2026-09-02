# cs_office HvH

A browser-based **Counter-Strike 2 "Hack vs Hack"** game — 12 v 12 on an original recreation of the `cs_office` layout. Everyone cheats, and the bots run the same cheat you do.

## Play

**[▶ Play it here](https://neomorrison.github.io/hvh/)** (GitHub Pages)

The game is split into ES modules under `src/`, so it must be **served over HTTP** (modules can't load from `file://`). To run locally:

```bash
# from the repo root
python3 -m http.server 8000
# then open http://localhost:8000/
```

## Features

- **MR12** (best-of-24, switch sides at half, first to 13) with a CS2-inspired economy.
- **Faithful damage model** — CS2 hitgroup multipliers, the real armor formula, and the exact distance falloff (`base × range_modifier^(dist/500)`).
- **Bullet penetration (autowall)** — shooting through walls **costs damage** (scaled by surface thickness & material), and a wall too thick/dense for the weapon's penetration power **stops the bullet** entirely. 
- **Faithful inaccuracy** — movement, jump, crouch, spray, recovery, flinch and landing penalty. Pistols are deliberately unforgiving: a standing first shot is good but never free at range, and the per-shot bloom out-paces the fire rate, so spamming collapses the cone and you have to tap.
- **Hit chance is the shot, not a number next to it.** Bullets are offset the way CS offsets them — `r·(cos φ, sin φ)` with `r` scaling linearly off a uniform roll, so the cone is dense at the centre and thin at the rim — and *one* implementation of that distribution serves manual fire, the aimbot and the estimate. The menu's hit chance is measured by tracing that cone against the hitbox you are aiming at and scaling it by how much of that hitbox is out of cover, then the bullet is rolled down the same cone at the same box. **100% therefore means 100%:** it needs the whole cone inside the hitbox with the whole silhouette exposed, so at a 100 min hit chance the aimbot almost never fires — and when it does, the only thing left that can beat it is the resolver. (The old model approved a shot at the standing cone and then rolled the bullet against that cone *plus the shot's own fire penalty*, which is why a "100%" shot used to go out constantly and miss "due to inaccuracy". CS charges a shot's bloom to the next shot; so does this now.)
- **Backtrack in ticks, not milliseconds** — every agent records a rolling 16-tick (@64 tick = 250ms) lag-compensation history. When the live shot is gone and the target has actually moved, the aimbot rewinds to a recorded tick and shoots where they *were*. `Backtrack trail` draws the furthest tick back you can still be rewound into; `Backtrack ghost` marks the tick a rewound shot landed on — including one fired at *you*.
- **The three tick exploits, and how they fight each other.** All of them spend the same budget: the server only processes a bounded burst of user commands (16 ticks) and only rewinds a bounded window.
  - **Hide shots** — firing normally *pins your real angles at the target*, which is exactly what makes a desyncing player's head readable the instant they shoot. Hide shots shifts the tickbase **backward** so the round goes out on a tick where the fake angle was still up.
  - **Double tap** — shifts the tickbase **forward** past the weapon's next-attack check so two rounds land in one server frame. It costs the weapon's whole fire cycle in ticks, which decides on its own what can be doubled: Duals 10 · USP-S/Glock 13 · Deagle 15 · SCAR-20/G3SG1 16 — and the SSG08's bolt is 80 ticks, far over budget, so it can never be doubled.  **The R8 Revolver can't be doubled either**, for a different reason: its trigger is not a next-attack timestamp but a hammer-cock state machine, so there is nothing to shift past and the bank is spent for nothing.  No HvH cheat offers it on the revolver, and neither does this one.
  - A shot can only be shifted **one way**, so you get one or the other and never both; double tap wins when both are on, which means **a doubled shot is an exposed shot**. While a shift is still catching up, **backtrack is suppressed** — the rewind window has already been spent. The HUD's `DT`/`HS`/`BT` badges light one at a time so the rule is visible rather than explained.
- **Auto-stop that slows, not stops** — it sheds exactly as much speed as your configured min hit chance needs and no more, so a close shot barely slows you and only a long one plants you. Never engages on the knife.
- **Weapons:** R8 Revolver (slow hammer-cock primary + faster fan, both with real CS2 cadence), Desert Eagle, Dual Berettas, USP-S / Glock-18, SSG08, SCAR-20 / G3SG1, plus a knife and grenades — CS2-accurate cost, damage and fire rate.
- **HvH bots on equal footing** — unique handles & playstyles, each running aimbot, anti-aim, resolver, autowall, backtrack, body-aim, and auto-knife when out of ammo. Every bot commits to one tick style, hide shots *or* double tap, never both. Bots respect their own min hit chance and min damage (≈40% / 30 by default, spread by persona) and land shots at the same bloom accuracy you do — no hidden handicap, so a lone player can't hold off ten of them.
- **A resolver that has to earn the read.** It used to be one number — roll under `accuracy` (0.7–0.94) and the desync was beaten no matter what the target was doing, which made anti-aim decoration.  Now `strength` is a *ceiling*: an enemy who fires **without hiding the shot** pins their real angles and hands you a near-certain read for `shot memory` seconds, until their desync side re-rolls; with no read the resolver guesses and the target's anti-aim cuts the guess down.  Three modes that actually differ — **animation** reads the body, **brute** starts worse and narrows across repeated shots at the same player, **onshot** is near-blind between exposures and excellent right after one.  The counter-play is "make them shoot", not "buy the resolver".
- **Anti-aim that does something.** Six yaw modes (back · sideways · spin · jitter · sway · rand) with a jitter/sway range that drives the body, a desync angle that is now real geometry (0° is genuinely no fake; 58° swings it about a body's width off you), **freestanding** — which looks at the map and puts the fake where the nearest enemy can see it, leaving the real you behind the corner — and **fake duck**, which renders the stance you are *not* in so the fake is at the wrong height as well as the wrong side, bought with two thirds of your movement speed.  A faster yaw, a wider desync, a fake pitch and a fake duck each cost a resolver something.
- **Safepoint** — against a desync there are two places the target might be, and a safepoint aims at the middle of them, so a wrong read no longer whiffs; it just costs you half the desync's width.  A body shot that keeps landing instead of a head shot that lands only when the resolver wins.
- **Local shot lines** — every round *you* fire leaves a beam from its muzzle to wherever it actually ended up, drawn through walls and faded out over a configurable duration (1.5s by default).  A tracer is gone in 0.2s; this is the one you can still look at afterwards to see whether a shot was spread, a backtrack, or the resolver losing to a desync.
- **CS2 armour rules** — a full kit isn't for sale; a vest top-up with the helmet still on costs $650, not $1000; a full vest with no helmet buys the helmet alone for $350.
- **Cheat menu (press `I`)** — laid out like the real thing: an icon rail down the left with five tabs (Rage · Anti-Aim · Tickbase · Visuals · Config), two columns of grouped settings, square check boxes and sliders that draw their value on the bar.  Rage covers the aimbot (FOV, min hit chance, min damage, silent, triggerbot, auto-stop, auto-scope, auto-knife, auto-revolver, safepoint), autowall and the resolver; the rest is anti-aim, tickbase, and visuals/ESP.  Config saves to your browser.
- **`HVH.verifyCheats()`** — every switch in that menu, exercised against the live game and checked for an *observable* effect: not "the flag is read somewhere" but "turning it on changes what happens".  Run it from the browser console for a table of all 31 features; the Node smoke test runs the same function, so a setting that quietly stops being wired fails CI instead of failing you mid-round.

## Controls

`WASD` move · mouse look · LMB fire · RMB scope/burst/fan · `R` reload · `1/2/3` pistol/rifle/knife · `4`/`G` grenade · `B` buy · `E` rescue hostage · `V` third person · `Tab` scoreboard · `I` cheat menu · `F1`–`F8` cheat toggles.

The top bar carries the CS-style team readout — side badge, a pip per player and the alive count on each side of the score. The full 12-a-side table with kills, deaths, money and weapons is on `Tab`.

**Crouch** is bound to `Ctrl` **or** `C` — use `C` if your browser closes the tab on `Ctrl+W`.

In the buy menu, clicking another rifle/pistol during the same buy time **refunds the one you just bought** and replaces it (CS2-style misclick sellback).

## Project structure

```
index.html        HUD / panels / styles + the import map and module entry point
src/
  data.js         economy, weapon stats, inaccuracy & penetration constants, damage model
  core.js         Three.js scene / camera / renderer / lights
  state.js        shared mutable game state (GAME, agents, refs, input)
  effects.js      tracers, impacts, grenade smokes/fires
  world.js        materials, collision, line-of-sight, penetration, nav graph
  map.js          cs_office layout + data-driven custom maps + grid nav + persistence
  agents.js       player/bot bodies, weapon models, personas, hitboxes, visuals
  combat.js       bloom, fire, damage, aimbot, melee, movement, weapon give/switch/reload
  ai.js           bot economy + HvH behaviour
  game.js         rounds / match / economy, hostages, buy menu, grenades
  hud.js          HUD, radar, scoreboard, ESP, crosshair/bloom ring, sound
  cheats.js       cheat menu UI + config persistence
  selftest.js     HVH.verifyCheats() — every cheat feature, checked end to end
  editor.js       the Map Builder
  main.js         input, main loop, boot/deploy wiring
test/             Node smoke-test harness (stubbed Three/DOM) — see below
```

## Notes

Original fan project for personal/educational use. Economy, weapon stats, and gameplay reproduce Counter-Strike 2 *mechanics*; the engine code is original.

**The map/texture assets are Valve's intellectual property, included here only for this personal/private project — not licensed for redistribution.**
