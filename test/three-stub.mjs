/* Minimal but functionally-correct stub of the subset of three.js the game uses.
   Vector3 / Euler / MathUtils implement real math so collision, LoS, pathfinding
   and combat logic actually run under Node for smoke-testing.  Rendering objects
   (Mesh/Material/Geometry/Lights/Renderer) are inert. */

export const PCFSoftShadowMap = 1;
export const DoubleSide = 2, FrontSide = 0, BackSide = 1, RepeatWrapping = 1000;
export class BufferAttribute { constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array ? array.length / itemSize : 0; } }
export class Float32BufferAttribute extends BufferAttribute {}

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setY(y) { this.y = y; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  setScalar(s) { this.x = s; this.y = s; this.z = s; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() { const l = this.length() || 1e-9; return this.multiplyScalar(1 / l); }
  distanceToSquared(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
  distanceTo(v) { return Math.sqrt(this.distanceToSquared(v)); }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  cross(v) {
    const ax = this.x, ay = this.y, az = this.z;
    this.x = ay * v.z - az * v.y; this.y = az * v.x - ax * v.z; this.z = ax * v.y - ay * v.x; return this;
  }
  applyEuler(e) {
    // order 'YXZ' (the only order the game uses), matching three.js makeRotationFromEuler
    const x = e.x, y = e.y, z = e.z;
    const a = Math.cos(x), b = Math.sin(x);
    const c = Math.cos(y), d = Math.sin(y);
    const f = Math.cos(z), g = Math.sin(z);
    const ce = c * f, cf = c * g, de = d * f, df = d * g;
    const m0 = ce + df * b, m4 = de * b - cf, m8 = a * d;
    const m1 = a * g, m5 = a * f, m9 = -b;
    const m2 = cf * b - de, m6 = df + ce * b, m10 = a * c;
    const vx = this.x, vy = this.y, vz = this.z;
    this.x = m0 * vx + m4 * vy + m8 * vz;
    this.y = m1 * vx + m5 * vy + m9 * vz;
    this.z = m2 * vx + m6 * vy + m10 * vz;
    return this;
  }
  project() { /* inert: keep in NDC-ish range so worldToScreen doesn't crash */ this.z = 0.5; return this; }
  unproject() { return this; }
}

export class Euler {
  constructor(x = 0, y = 0, z = 0, order = 'XYZ') { this.x = x; this.y = y; this.z = z; this.order = order; }
  set(x, y, z, order) { this.x = x; this.y = y; this.z = z; if (order) this.order = order; return this; }
}

export class Quaternion {   // identity-ish: enough for models.js' post-mixer twist to run without throwing
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { return this.set(q.x, q.y, q.z, q.w); }
  setFromAxisAngle(axis, angle) { const s = Math.sin(angle / 2); return this.set(axis.x * s, axis.y * s, axis.z * s, Math.cos(angle / 2)); }
  multiply(q) { return this.multiplyQuaternions(this, q); } premultiply(q) { return this.multiplyQuaternions(q, this); }
  multiplyQuaternions(a, b) {
    const ax = a.x, ay = a.y, az = a.z, aw = a.w, bx = b.x, by = b.y, bz = b.z, bw = b.w;
    return this.set(ax * bw + aw * bx + ay * bz - az * by, ay * bw + aw * by + az * bx - ax * bz, az * bw + aw * bz + ax * by - ay * bx, aw * bw - ax * bx - ay * by - az * bz);
  }
  invert() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
}

export const MathUtils = {
  clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
  lerp: (a, b, t) => a + (b - a) * t,
  degToRad: d => d * Math.PI / 180,
};

export class Color { constructor(h = 0) { this.h = h; } setHex(h) { this.h = h; return this; } }

class Object3D {
  constructor() {
    this.position = new Vector3(); this.rotation = new Euler(); this.scale = new Vector3(1, 1, 1);
    this.children = []; this.parent = null; this.visible = true; this.userData = {}; this.up = new Vector3(0, 1, 0);
    this.castShadow = false; this.receiveShadow = false; this.renderOrder = 0;
  }
  add(o) { this.children.push(o); if (o) o.parent = this; return this; }
  remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); return this; }
  traverse(fn) { fn(this); for (const c of this.children) c.traverse && c.traverse(fn); }
  lookAt() {} updateMatrixWorld() {} updateWorldMatrix() {} getWorldQuaternion(q) { return q || new Quaternion(); } getWorldPosition(v) { return v ? v.copy(this.position) : this.position.clone(); } getWorldDirection(v) { return (v || new Vector3()).set(0, 0, -1); }
}
export class Group extends Object3D {}
export class Scene extends Object3D { constructor() { super(); this.background = null; this.fog = null; } }
// skinned-mesh / animation shims: the GLB model loader is browser-only; node only needs these to resolve
export class Bone extends Object3D {}
export class Skeleton { constructor(bones = []) { this.bones = bones; } }
export class SkinnedMesh extends Object3D { constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; this.isMesh = true; this.isSkinnedMesh = true; } bind(s) { this.skeleton = s; } }
export class AnimationClip { constructor(name = '', duration = 0, tracks = []) { this.name = name; this.duration = duration; this.tracks = tracks; } static findByName(clips, name) { return (clips || []).find(c => c.name === name) || null; } }
export class AnimationMixer { constructor(root) { this.root = root; } clipAction(clip) { const a = { play() { return a; }, stop() { return a; }, reset() { return a; }, fadeIn() { return a; }, fadeOut() { return a; }, crossFadeTo() { return a; }, setLoop() { return a; }, setEffectiveWeight() { return a; }, setEffectiveTimeScale() { return a; }, weight: 1, timeScale: 1, enabled: true, paused: false, clip }; return a; } update() {} stopAllAction() {} }
Object3D.prototype.clone = function (recursive = true) { const c = new this.constructor(); c.name = this.name; c.position.copy(this.position); c.visible = this.visible; c.userData = { ...this.userData }; if (recursive) for (const ch of this.children) c.add(ch.clone(true)); return c; };
Object3D.prototype.getObjectByName = function (name) { if (this.name === name) return this; for (const ch of this.children) { const f = ch.getObjectByName && ch.getObjectByName(name); if (f) return f; } return undefined; };

class Mat { constructor(o = {}) { Object.assign(this, o); this.color = new Color(o.color || 0); this.emissive = new Color(o.emissive || 0); this.emissiveIntensity = o.emissiveIntensity ?? 1; } dispose() {} clone() { return new Mat(this); } }
export class MeshStandardMaterial extends Mat {}
export class MeshBasicMaterial extends Mat {}
export class LineBasicMaterial extends Mat {}

class Geo { dispose() {} setFromPoints() { return this; } setAttribute() { return this; } setIndex() { return this; } computeVertexNormals() {} }
export class BoxGeometry extends Geo { constructor(w, h, d) { super(); this.w = w; this.h = h; this.d = d; } }
export class SphereGeometry extends Geo {}
export class CylinderGeometry extends Geo {}
export class BufferGeometry extends Geo {}
export class EdgesGeometry extends Geo { constructor(geo) { super(); this.geo = geo; } }

export class Mesh extends Object3D { constructor(geometry, material) { super(); this.geometry = geometry || new Geo(); this.material = material || new Mat(); this.isMesh = true; } }
export class Line extends Object3D { constructor(geometry, material) { super(); this.geometry = geometry || new Geo(); this.material = material || new Mat(); } }
export class LineSegments extends Line {}

class Light extends Object3D { constructor(color, intensity) { super(); this.color = new Color(color); this.intensity = intensity ?? 1; this.shadow = { mapSize: { set() {} }, camera: {} }; } }
export class HemisphereLight extends Light {}
export class DirectionalLight extends Light {}
export class PointLight extends Light {}
export class AmbientLight extends Light {}

export class PerspectiveCamera extends Object3D {
  constructor(fov = 60, aspect = 1, near = 1, far = 1000) { super(); this.fov = fov; this.aspect = aspect; this.near = near; this.far = far; }
  updateProjectionMatrix() {}
}
export class OrthographicCamera extends Object3D {
  constructor(left = -1, right = 1, top = 1, bottom = -1, near = 1, far = 1000) { super(); this.left = left; this.right = right; this.top = top; this.bottom = bottom; this.near = near; this.far = far; }
  updateProjectionMatrix() {}
}
export class Raycaster { setFromCamera() {} intersectObject() { return []; } intersectObjects() { return []; } }
export class Fog { constructor(c, n, f) { this.color = c; this.near = n; this.far = f; } }

function makeDomElement() {
  const el = {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    width: 1280, height: 720, children: [],
    appendChild() {}, prepend() {}, remove() {}, removeChild() {},
    addEventListener() {}, removeEventListener() {}, requestPointerLock() {},
    querySelector() { return makeDomElement(); }, querySelectorAll() { return []; },
    getContext() { return makeCtx(); }, getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 }; },
    setAttribute() {}, focus() {},
    set innerHTML(v) {}, get innerHTML() { return ''; },
    set textContent(v) {}, get textContent() { return ''; },
  };
  return el;
}
function makeCtx() {
  return new Proxy({}, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && /^[a-z]/.test(k) ? () => {} : undefined)), set: () => true });
}

export class WebGLRenderer {
  constructor() { this.domElement = makeDomElement(); this.shadowMap = { enabled: false, type: 0 }; this.autoClear = true; }
  setSize() {} setPixelRatio() {} render() {} setScissorTest() {} setScissor() {} setViewport() {} setClearColor() {} clear() {}
}
