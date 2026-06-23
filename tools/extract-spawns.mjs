#!/usr/bin/env node
/* Convert a CS2/Source entity dump into the spawns.json the game's importer wants.
 *
 * Usage:
 *   node tools/extract-spawns.mjs <entities.(txt|vmap|json)> [spawns.json]
 *
 * Accepts:
 *   - a JSON array of { classname, origin:[x,y,z]|"x y z", angles:[p,y,r]|"p y r" }
 *   - a JSON object with an `entities` array of the same
 *   - a raw KeyValues/VMAP text dump (it scans { … } blocks for classname/origin/angles)
 *
 * Coordinates are converted Source Z-up → game Y-up automatically.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnsFromEntities } from '../src/sourcemap.js';

const inFile = process.argv[2], outFile = process.argv[3] || 'spawns.json';
if (!inFile) { console.error('usage: node tools/extract-spawns.mjs <entities.(txt|vmap|json)> [spawns.json]'); process.exit(1); }

const raw = readFileSync(inFile, 'utf8');
let ents;
try { const j = JSON.parse(raw); ents = Array.isArray(j) ? j : (j.entities || []); }
catch { ents = parseKV(raw); }

const spawns = spawnsFromEntities(ents);
spawns.name = inFile.replace(/.*[\\/]/, '').replace(/\.[^.]+$/, '');
writeFileSync(outFile, JSON.stringify(spawns, null, 2));
console.log(`Wrote ${outFile}`);
console.log(`  ${spawns.ctSpawns.length} CT spawns, ${spawns.tSpawns.length} T spawns, ${spawns.hostages.length} hostages, ${spawns.rescueZones.length} rescue zones`);
if (!spawns.ctSpawns.length || !spawns.tSpawns.length) console.warn('  ⚠ No CT/T spawns found — check the dump contains info_player_counterterrorist / info_player_terrorist');

// tolerant scanner for KeyValues / VMAP-ish entity text
function parseKV(text) {
  const out = [];
  for (const block of text.match(/\{[^{}]*\}/g) || []) {
    const cls = (block.match(/classname"?\s*[="]\s*"?([a-z_0-9]+)/i) || [])[1];
    const org = (block.match(/origin"?\s*[="]\s*"?(-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+)/i) || [])[1];
    const ang = (block.match(/angles"?\s*[="]\s*"?(-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+)/i) || [])[1];
    if (cls && org) out.push({ classname: cls, origin: org, angles: ang || '0 0 0' });
  }
  return out;
}
