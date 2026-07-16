# cs_office HvH

A browser-based **Counter-Strike 2 "Hack vs Hack"** game — 1 human and bots on an original recreation of the `cs_office` layout. Everyone cheats.

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
- **Faithful inaccuracy** — movement, jump, crouch, spray, recovery, flinch and landing penalty.
- **Weapons:** R8 Revolver (slow hammer-cock primary + faster fan, both with real CS2 cadence), Desert Eagle, Dual Berettas, USP-S / Glock-18, SSG08, SCAR-20 / G3SG1, plus a knife and grenades — CS2-accurate cost, damage and fire rate.
- **HvH bots** with unique handles & playstyles, each running aimbot, anti-aim, resolver, autowall, body-aim, and auto-knife when out of ammo.
- **Cheat menu (press `I`)** — aimbot (FOV, hitchance, silent, triggerbot, auto-stop, auto-scope, auto-knife, auto-revolver), autowall, resolver, anti-aim, backtrack, and wallhack/ESP. Config saves to your browser.

## Controls

`WASD` move · mouse look · LMB fire · RMB scope/burst/fan · `R` reload · `1/2/3` pistol/rifle/knife · `4`/`G` grenade · `B` buy · `E` rescue hostage · `V` third person · `Tab` scoreboard · `I` cheat menu · `F1`–`F8` cheat toggles.

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
  editor.js       the Map Builder
  main.js         input, main loop, boot/deploy wiring
test/             Node smoke-test harness (stubbed Three/DOM) — see below
```

## Notes

Original fan project for personal/educational use. Economy, weapon stats, and gameplay reproduce Counter-Strike 2 *mechanics*; the engine code is original.

**The map/texture assets are Valve's intellectual property, included here only for this personal/private project — not licensed for redistribution.**
