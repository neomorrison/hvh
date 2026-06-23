/* Stub for three/addons/* under the node smoke test. GLTFLoader is only used at runtime in
   the browser (optional textured map); the test never calls it, it just needs to resolve. */
export class GLTFLoader {
  parse(buf, path, onLoad) { if (onLoad) onLoad({ scene: { scale: { setScalar() {} }, traverse() {} } }); }
}
