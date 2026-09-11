/* Minimal glTF 2.0 binary writer. */
export class GLB {
  constructor() {
    this.json = { asset: { version: '2.0', generator: 'hvh bsp2map' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], textures: [], images: [],
      samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }] };
    this.parts = []; this.len = 0;
  }
  pad() { while (this.len % 4) { this.parts.push(Buffer.alloc(1)); this.len++; } }
  view(arr, target) {
    this.pad(); const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    const bv = { buffer: 0, byteOffset: this.len, byteLength: buf.length }; if (target) bv.target = target;
    this.json.bufferViews.push(bv); this.parts.push(buf); this.len += buf.length; return this.json.bufferViews.length - 1;
  }
  accessor(arr, type, comp = 5126, minmax = false) {
    const nc = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    const acc = { bufferView: this.view(arr, (comp === 5125 || comp === 5123) ? 34963 : 34962), componentType: comp, count: arr.length / nc, type };
    if (minmax) { const mn = Array(nc).fill(Infinity), mx = Array(nc).fill(-Infinity); for (let i = 0; i < arr.length; i++) { const c = i % nc; if (arr[i] < mn[c]) mn[c] = arr[i]; if (arr[i] > mx[c]) mx[c] = arr[i]; } acc.min = mn; acc.max = mx; }
    this.json.accessors.push(acc); return this.json.accessors.length - 1;
  }
  image(png, mime = 'image/png') { const bv = this.view(png); this.json.images.push({ bufferView: bv, mimeType: mime }); this.json.textures.push({ sampler: 0, source: this.json.images.length - 1 }); return this.json.textures.length - 1; }
  material(m) { this.json.materials.push(m); return this.json.materials.length - 1; }
  mesh(prims) { this.json.meshes.push({ primitives: prims }); return this.json.meshes.length - 1; }
  node(n) { this.json.nodes.push(n); return this.json.nodes.length - 1; }
  root(ni) { this.json.scenes[0].nodes.push(ni); }
  build() {
    this.pad(); this.json.buffers[0].byteLength = this.len;
    let js = Buffer.from(JSON.stringify(this.json)); while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
    const bin = Buffer.concat(this.parts), hdr = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
    hdr.writeUInt32LE(0x46546c67, 0); hdr.writeUInt32LE(2, 4); hdr.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
    jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([hdr, jh, js, bh, bin]);
  }
}
