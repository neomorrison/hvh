/* ============================== [VISUALS] ==============================
   World-level visual cheats: night mode — every light, the sky and the fog are scaled towards black
   by the darkness slider. Change-detected (setting, light count, or a new map sky), so the scene is
   only traversed when something actually changed, never per frame.                              */
import * as THREE from 'three';
import { scene } from './core.js';

let _key = null, _bgObj = null, _fogObj = null;
const _base = new Map();          // light → base intensity
let _bgBase = null, _fogBase = null;
const _black = new THREE.Color(0x05070c);
export function applyNightMode(vz) {
  const on = !!(vz && vz.nightMode), lvl = on ? Math.min(1, Math.max(0, (vz.nightLevel != null ? vz.nightLevel : 70) / 100)) : 0;
  let lights = 0; scene.traverse(o => { if (o.isLight) lights++; });
  const key = `${lvl.toFixed(2)}|${lights}`;
  const newSky = scene.background !== _bgObj || scene.fog !== _fogObj;
  if (key === _key && !newSky) return;
  _key = key;
  if (newSky) {   // a map (re)load handed us fresh colour objects — remember them untouched
    _bgObj = scene.background; _bgBase = (_bgObj && _bgObj.isColor) ? _bgObj.clone() : null;
    _fogObj = scene.fog; _fogBase = (_fogObj && _fogObj.color && _fogObj.color.clone) ? _fogObj.color.clone() : null;
  }
  scene.traverse(o => {
    if (!o.isLight) return;
    if (!_base.has(o)) _base.set(o, o.intensity);
    o.intensity = _base.get(o) * (1 - 0.92 * lvl);
  });
  if (_bgBase) scene.background.copy(_bgBase).lerp(_black, lvl);
  if (_fogBase) scene.fog.color.copy(_fogBase).lerp(_black, lvl);
}
