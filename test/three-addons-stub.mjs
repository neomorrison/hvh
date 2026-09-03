/* Stub for three/addons/* under the node smoke test. GLTFLoader/SkeletonUtils are only used at
   runtime in the browser (textured map + GLB player/weapon/grenade models); the test never
   exercises them, it just needs the imports to resolve and the fallbacks to run. */
export class GLTFLoader {
  parse(buf, path, onLoad) { if (onLoad) onLoad({ scene: { scale: { setScalar() {} }, traverse() {} }, animations: [] }); }
  load(url, onLoad, onProgress, onError) { if (onError) onError(new Error('stub: no GLB in node')); }
  async loadAsync() { throw new Error('stub: no GLB in node'); }
}
// SkeletonUtils.js exports these as named functions (imported via `import * as SkeletonUtils`)
export function clone(o) { return o && o.clone ? o.clone(true) : o; }
