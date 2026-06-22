# cs_office HvH

A browser-based **Counter-Strike 2 "Hack vs Hack"** game — 1 human + 4 bots vs 5 bots on an original recreation of the `cs_office` layout. Everyone cheats.

## Play

**[▶ Play it here](https://neomorrison.github.io/hvh/)** (GitHub Pages)

Or clone and open `index.html` in any modern browser (Chrome recommended). No build step — it's a single self-contained file using Three.js via CDN.

## Features

- **MR12** (best-of-24, switch sides at half, first to 13) with the exact CS2 economy — round win/loss rewards, the 1400→3400 loss-bonus ladder, kill rewards, and hostage-rescue payouts.
- **Faithful damage model** — CS2 hitgroup multipliers, the real armor formula, and the exact distance falloff (`base × range_modifier^(dist/500)`).
- **Weapons only:** R8 Revolver (with hold-to-cock hammer), Desert Eagle, Dual Berettas, USP-S / Glock-18, SSG08, SCAR-20 / G3SG1, plus a knife and grenades — all with CS2-accurate cost, damage, fire rate, and the CS2 inaccuracy/bloom model (movement, jump, crouch, spray, recovery, flinch).
- **HvH bots** with unique handles & playstyles, each running aimbot, anti-aim, resolver, autowall, body-aim, and auto-knife when out of ammo.
- **Cheat menu (press `I`)** — aimbot (FOV, hitchance, silent, triggerbot, auto-stop, auto-scope, auto-knife, auto-revolver), autowall, resolver, anti-aim, backtrack, and wallhack/ESP visuals. Config saves to your browser.

## Controls

`WASD` move · mouse look · LMB fire · RMB scope/burst/fan · `R` reload · `1/2/3` pistol/rifle/knife · `4`/`G` grenade · `B` buy · `E` rescue hostage · `V` third person · `Tab` scoreboard · `I` cheat menu · `F1`–`F8` cheat toggles.

## Notes

Original fan project for educational/entertainment purposes. Map layout, economy, and weapon stats reproduce CS2 *mechanics*; all geometry, art, and code are original — no Valve assets are used.
