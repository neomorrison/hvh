import { readFileSync } from 'node:fs';
import { readBsp, CONTENTS } from './bsp.js';
import { unpackEntry } from './pakdecode.mjs';
import { readStaticProps } from './props.mjs';
const raw = readFileSync('C:/Program Files (x86)/Steam/steamapps/common/Counter-Strike Source/cstrike/maps/cs_office.bsp');
const bsp = readBsp(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const all = bsp.brushes(0xffffffff), kept = bsp.brushes(CONTENTS.SOLID | CONTENTS.PLAYERCLIP | CONTENTS.WINDOW | CONTENTS.GRATE);
const flags = {}; for (const b of all) { const k = '0x' + b.contents.toString(16); flags[k] = (flags[k] || 0) + 1; }
console.log('brushes total(any contents):', all.length, 'kept:', kept.length); console.log('contents histogram:', JSON.stringify(flags));
const ents = bsp.entities(); const cls = {}; for (const e of ents) cls[e.classname] = (cls[e.classname] || 0) + 1;
console.log('entities:', JSON.stringify(Object.fromEntries(Object.entries(cls).sort((a, b) => b[1] - a[1]).slice(0, 30))));
const propEnts = ents.filter(e => /^prop_/.test(e.classname || '') && e.model); const pm = {}; for (const e of propEnts) pm[e.classname] = (pm[e.classname] || 0) + 1;
console.log('entity props with models:', JSON.stringify(pm)); console.log('sample:', propEnts.slice(0, 5).map(e => e.classname + ' ' + e.model + ' solid=' + e.solid));
const { offset, nonSolid } = bsp.modelPlacement(); console.log('models:', offset.length, 'nonSolid models:', [...nonSolid].length);
const brushEnts = ents.filter(e => /^\*\d+$/.test(e.model || '')); const be = {}; for (const e of brushEnts) be[e.classname] = (be[e.classname] || 0) + 1; console.log('brush entities:', JSON.stringify(be));
const sp = readStaticProps(bsp); const sol = {}; for (const p of sp.props) sol[p.solid] = (sol[p.solid] || 0) + 1; console.log('static props:', sp.props.length, 'solid flags:', JSON.stringify(sol));
