# cs_office textures

This personal project bundles the real CS2 textures as `maps/cs_office.tex.glb` (decompiled from
`cs_office.vpk`). On deploy, `main.js` fetches it, loads it with `GLTFLoader`, and uses it as the
visual mesh (collision/spawns still come from the small `maps/cs_office.glb`). If it's absent the
game falls back to a procedural floor/wall/ceiling look.

These textures are Valve's IP — included only for personal/private use, not redistribution. To
regenerate (e.g. higher resolution) from **your own** CS2 install:

## Generate it (once, on your machine)

You need [Source2Viewer/VRF](https://github.com/ValveResourceFormat/ValveResourceFormat) and
[`@gltf-transform/cli`](https://gltf-transform.dev/) (`npx @gltf-transform/cli`).

1. **Export the world with materials + textures** from your `cs_office.vpk`:

   ```bash
   Source2Viewer-CLI -i "<…>/csgo/maps/cs_office.vpk" \
     -f "maps/cs_office/world" -e "vwrld_c" -d \
     --gltf_export_format glb --gltf_export_materials -o ./tex_out
   ```

   This writes `tex_out/maps/cs_office/world.glb` (~74 MB) plus its textures.

2. **Shrink it** so it loads quickly — downscale textures to 256 px (WebP) and quantize geometry.
   Do **not** use Draco (the loader has no Draco decoder); WebP + quantization load with plain
   `GLTFLoader`:

   ```bash
   npx @gltf-transform/cli optimize tex_out/maps/cs_office/world.glb cs_office.tex.glb \
     --texture-compress webp --texture-size 256 \
     --compress quantize --simplify true --simplify-ratio 0.6 --simplify-error 0.005
   ```

3. **Place it** at `app/maps/cs_office.tex.glb`. Reload the game and DEPLOY — the map now uses the
   real textures. (Coordinates auto-align: the loader scales the metres-unit export by `39.3701`.)

To go back to the procedural look, just delete `cs_office.tex.glb`.

> The textures are Valve's copyrighted assets. Extract and use them from your own CS2 install only;
> don't commit/redistribute `cs_office.tex.glb` to a public repo.
