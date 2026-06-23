/* Unit test for the CS2 map importer geometry math (no THREE/DOM needed).
   Builds a synthetic glTF (floor + interior wall + raised platform) and checks
   parsing, the BVH, line-of-sight, penetration, floor height, wall sliding and
   the Source→game spawn conversion.   Run:  node ./test/sourcemap.test.mjs      */
import { parseGLB, TriBVH, meshBackend, convSource, spawnsFromEntities } from '../src/sourcemap.js';

let fails = 0;
const approx = (a, b, e = 1) => Math.abs(a - b) <= e;
function ok(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) fails++; }

/* ---- build a synthetic glTF in memory ---- */
const verts = [];
const tri = (a, b, c) => verts.push(...a, ...b, ...c);
const quad = (p0, p1, p2, p3) => { tri(p0, p1, p2); tri(p0, p2, p3); };
function box(x0, x1, y0, y1, z0, z1) {
  const v000 = [x0, y0, z0], v100 = [x1, y0, z0], v110 = [x1, y1, z0], v010 = [x0, y1, z0];
  const v001 = [x0, y0, z1], v101 = [x1, y0, z1], v111 = [x1, y1, z1], v011 = [x0, y1, z1];
  quad(v000, v100, v110, v010); quad(v001, v101, v111, v011);   // z faces
  quad(v000, v010, v011, v001); quad(v100, v110, v111, v101);   // x faces
  quad(v000, v100, v101, v001); quad(v010, v110, v111, v011);   // y faces
}
quad([-1000, 0, -1000], [1000, 0, -1000], [1000, 0, 1000], [-1000, 0, 1000]); // floor (y=0)
box(-10, 10, 0, 200, -500, 500);   // thin interior wall across z, separating x<-10 from x>10
box(300, 600, 0, 200, -100, 100);  // solid raised platform, top at y=200

const f32 = new Float32Array(verts);
const b64 = Buffer.from(f32.buffer).toString('base64');
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < f32.length; i += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], f32[i + a]); max[a] = Math.max(max[a], f32[i + a]); }
const gltf = {
  asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ bufferView: 0, componentType: 5126, count: f32.length / 3, type: "VEC3", min, max }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: f32.byteLength }],
  buffers: [{ byteLength: f32.byteLength, uri: "data:application/octet-stream;base64," + b64 }],
};
const bytes = new TextEncoder().encode(JSON.stringify(gltf));

/* ---- parse + build ---- */
const tris = parseGLB(bytes);
ok('parseGLB returns triangles', tris.length === verts.length);
const bvh = new TriBVH(tris);
ok('BVH bounds X', approx(bvh.bounds.min[0], -1000) && approx(bvh.bounds.max[0], 1000));
ok('BVH bounds Y up to 200', approx(bvh.bounds.max[1], 200));
meshBackend.bvh = bvh; meshBackend.bounds = bvh.bounds; meshBackend.active = true;

/* ---- line of sight ---- */
ok('LoS blocked through the interior wall', meshBackend.losClear({ x: -200, y: 60, z: 0 }, { x: 200, y: 60, z: 0 }) === false);
ok('LoS clear where there is no wall', meshBackend.losClear({ x: -200, y: 60, z: 700 }, { x: 200, y: 60, z: 700 }) === true);

/* ---- penetration ---- */
const pen = meshBackend.penetrate({ x: -100, y: 60, z: 0 }, { x: 100, y: 60, z: 0 }, 'deagle');
ok('penetration reduces damage (0<factor<1)', pen.factor > 0 && pen.factor < 1 && !pen.blocked);
const penWeak = meshBackend.penetrate({ x: -100, y: 60, z: 0 }, { x: 100, y: 60, z: 0 }, 'glock');
ok('weaker gun penetrates less than deagle', penWeak.factor <= pen.factor);

/* ---- floor height (multi-level) ---- */
ok('ground on the open floor ≈ 0', approx(meshBackend.groundHeight(200, 0, 300), 0, 1));
ok('ground on the platform ≈ 200', approx(meshBackend.groundHeight(450, 0, 300), 200, 1));
ok('no ground off the map', meshBackend.groundHeight(5000, 5000, 300) < -1e7);

/* ---- wall slide / collision ---- */
const [sx] = meshBackend.slideXZ(-100, 0, 100, 0, 60, 16);   // walk +x into wall at x=-10
ok('movement is stopped short of the wall', sx > -40 && sx < -18);

/* ---- spawn conversion (Source Z-up → game Y-up) ---- */
const c = convSource(100, 200, 64);
ok('convSource maps (x,y,z)→(x,z,-y)', c.x === 100 && c.y === 64 && c.z === -200);
const sp = spawnsFromEntities([
  { classname: 'info_player_counterterrorist', origin: '100 200 64', angles: '0 90 0' },
  { classname: 'info_player_terrorist', origin: [-100, -200, 64] },
  { classname: 'info_hostage_spawn', origin: '0 0 0' },
]);
ok('spawnsFromEntities sorts CT/T/hostage', sp.ctSpawns.length === 1 && sp.tSpawns.length === 1 && sp.hostages.length === 1);
ok('CT spawn converted', sp.ctSpawns[0].x === 100 && sp.ctSpawns[0].y === 64 && sp.ctSpawns[0].z === -200);

meshBackend.clear();
if (fails) { console.log(`\n❌ ${fails} assertion(s) failed`); process.exit(1); }
console.log('\n✅ SOURCEMAP TEST PASSED'); process.exit(0);
