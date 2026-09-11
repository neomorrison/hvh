import { readFileSync } from 'node:fs';
import { readBsp, CONTENTS } from './bsp.js';
import { brushTriangles, brushVertices } from './hull.mjs';
const raw = readFileSync('C:/Program Files (x86)/Steam/steamapps/common/Counter-Strike Source/cstrike/maps/cs_office.bsp');
const bsp = readBsp(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const kept = bsp.brushes(CONTENTS.SOLID | CONTENTS.PLAYERCLIP | CONTENTS.WINDOW | CONTENTS.GRATE);
let bad = 0, zero = 0, few = 0, total = 0; const samples = [];
for (const b of kept) { const out = []; const n = brushTriangles(b.planes, out); const v = brushVertices(b.planes); total += n; if (n === 0) { zero++; if (samples.length < 4) samples.push({ planes: b.planes.length, verts: v.length, c: b.contents.toString(16) }); } else if (n < 2 * b.planes.length - 4) few++; }
console.log('brushes', kept.length, 'tris', total, 'zero-tri brushes', zero, 'under-triangulated', few, JSON.stringify(samples));
