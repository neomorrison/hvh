# Importing a real CS2 map (offline)

The game can load a real Counter-Strike 2 map's **exact geometry and spawns** and play
on it with the same combat/economy/AI. Textures are ignored (the geometry renders grey).

Because map files are Valve assets, nothing is bundled in this repo — you extract from
**your own** CS2 install and load the files at runtime. You need to do this once per map,
on your machine (the decompiler needs your game files).

## 1. Decompile the map geometry to `.glb`

Get **[Source2Viewer / ValveResourceFormat (VRF)](https://github.com/ValveResourceFormat/ValveResourceFormat)**
(free, open source).

CS2 maps live in `…/Counter-Strike Global Offensive/game/csgo/maps/<name>.vpk`
(workshop maps are under `…/steamapps/workshop/content/730/<id>/`).

GUI:
1. Open the map's `.vpk`, find `maps/<name>.vmap_c`.
2. Right-click the **world** → **Export** → **glTF Binary (.glb)**. Geometry only is fine.

CLI:
```bash
Decompiler -i "de_dust2.vpk" -o ./out -e "vmap_c" --gltf_export_format glb -d
```

You now have something like `de_dust2.glb`.

> Tip: very large maps export a lot of triangles. That's fine — the importer builds a BVH.
> If a map is huge and you only want a section, trim it in Blender (still ignore materials).

## 2. Get the spawns as `spawns.json`

In VRF, open the same `.vmap_c` and look at the **entity lump** (the entities list). Export
or copy it. Then convert it:

```bash
node tools/extract-spawns.mjs entities.txt spawns.json
```

The converter accepts a VRF entity-text dump, a JSON array, or a `.vmap` text and writes a
`spawns.json` with coordinates already converted Source Z-up → game Y-up. It pulls:

| CS2 entity                        | becomes        |
|-----------------------------------|----------------|
| `info_player_counterterrorist`    | `ctSpawns`     |
| `info_player_terrorist`           | `tSpawns`      |
| `info_hostage_spawn`              | `hostages`     |
| `func_hostage_rescue` / rescue    | `rescueZones`  |

You can also hand-write `spawns.json`:
```json
{
  "name": "de_dust2",
  "ctSpawns": [{ "x": 100, "y": 64, "z": -200, "yaw": 1.57 }],
  "tSpawns":  [{ "x": -100, "y": 64, "z": 200 }],
  "hostages": [],
  "rescueZones": []
}
```
Coordinates are in the game's frame: `x`, `z` are the floor plane and `y` is **up**
(the height the player stands at). If you have raw Source coordinates `(sx, sy, sz)`,
convert with `(x, y, z) = (sx, sz, -sy)`.

> If you skip `spawns.json`, the map still loads but you'll have no spawns to start a round —
> so provide at least one CT and one T spawn.

## 3. Play it

Serve the game (`python3 -m http.server`), open it, and on the start screen use
**Import a real CS2 map** → pick your `.glb` (Geometry) and `spawns.json` (Spawns) →
**Load & Play**.

## How it works in-engine

- The `.glb` is parsed to a world-space triangle soup and indexed in a BVH.
- Line-of-sight, autowall/penetration, floor height (multi-level) and wall sliding all run
  against the mesh, so the layout is used 1:1.
- A floor-following nav graph is auto-generated so bots can path the real map.
- Everything is gated on an active mesh map; cs_office and the Map Builder are unaffected.

## Offline note

The game loads three.js from a CDN by default. For **fully offline** play, download
`three.module.js` (v0.160.0) into a local `vendor/` folder and point the import map in
`index.html` at `./vendor/three.module.js` instead of the jsDelivr URL.
