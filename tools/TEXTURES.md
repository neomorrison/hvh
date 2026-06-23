# cs_office textures

This personal project bundles the real CS2 textures as `maps/cs_office.tex.glb` (decompiled from
`cs_office.vpk`). On deploy, `main.js` fetches it, loads it with `GLTFLoader`, and uses it as the
visual mesh (collision/spawns still come from the small `maps/cs_office.glb`). If it's absent the
game falls back to a procedural floor/wall/ceiling look.

These textures are Valve's IP — included only for personal/private use, not redistribution.

## Regenerate it (e.g. higher resolution)

From **your own** CS2 install, with [Source2Viewer/VRF](https://github.com/ValveResourceFormat/ValveResourceFormat)
and [`@gltf-transform/cli`](https://gltf-transform.dev/):

1. **Export the full render mesh (world + props) with materials + textures:**

   ```bash
   Source2Viewer-CLI -i "<…>/csgo/maps/cs_office.vpk" \
     -f "maps/cs_office" -e "vmap_c" -d \
     --gltf_export_format glb --gltf_export_materials -o ./tex_out
   ```

   This writes `tex_out/maps/cs_office.glb` (~74 MB) plus its textures.

2. **Shrink it.** Downscale textures (WebP) and quantize/decimate geometry. Do **not** use Draco
   (the loader has no Draco decoder); WebP + quantization load with plain `GLTFLoader`. The
   `--texture-size` and `--simplify-ratio` trade quality for file size (256 px + 0.28 ≈ 23 MB):

   ```bash
   npx @gltf-transform/cli optimize tex_out/maps/cs_office.glb cs_office.tex.glb \
     --texture-compress webp --texture-size 256 \
     --compress quantize --simplify true --simplify-ratio 0.28 --simplify-error 0.008
   ```

3. **Place it** at `app/maps/cs_office.tex.glb` and reload — the map renders with the real textures
   (coordinates auto-align: the loader scales the metres-unit export by `39.3701`). Delete the file
   to fall back to the procedural look.
