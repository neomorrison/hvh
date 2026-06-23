# Real cs_office textures (optional, local)

By default the imported cs_office map renders with a procedural floor/wall/ceiling look — **no
Valve texture art is bundled in this repo** (it's public-facing). If you want the map to render
with its actual CS2 textures, generate the textured map from **your own** CS2 install and drop it
in next to the geometry. The game loads it at runtime; it is git-ignored and never committed.

The engine already supports this: on deploy, `main.js` fetches `./maps/cs_office.tex.glb`, and if
it's present it's loaded with `GLTFLoader` and used as the visual mesh (collision/spawns still come
from the small `cs_office.glb`). If it's absent, you get the procedural look.

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
