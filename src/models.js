/* ============================== [MODELS] ==============================
   GLB model library: rigged+animated player, weapons, grenades — built in Blender by
   tools/blender/hvh_models.py and exported to /models/*.glb.  Every getter returns null
   when its GLB isn't loaded so callers fall back to the procedural box builders.
   Contract shared with the Blender script (names must match exactly):
     player.glb  : SkinnedMesh "Player" + armature; bones Hips, Spine, Chest, Neck, Head,
                   UpperArm.L/R, Forearm.L/R, Hand.L/R, Thigh.L/R, Shin.L/R, Foot.L/R;
                   clips idle, walk, run, crouch_idle, crouch_walk.  1 unit = 1 source unit,
                   feet at y=0, ~78u tall (hitboxes: head 66 / chest 53 / stomach 40 / legs 17).
     weapons.glb : one root per key (glock usp duals deagle r8 ssg scar g3 knife), barrel +Z,
                   grip origin at (0,0,0); r8 has a child named "Hammer" (rotates on x to cock).
     nades.glb   : roots he, flash, smoke, molly.                                            */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';   // r160 exports clone/retarget as named functions, no namespace object

export const MODELS = { player: null, playerClips: null, weapons: null, nades: null, ready: false };
export const CLIPS = ['idle', 'walk', 'run', 'crouch_idle', 'crouch_walk'];
export const WAIST_BONES = { hips: 'Hips', spine: 'Spine', head: 'Head' };

async function loadGLB(url) {
  try {
    const r = await fetch(url); if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    return await new Promise(res => new GLTFLoader().parse(buf, '', g => res(g), () => res(null)));
  } catch (e) { return null; }
}
/* Load all three libraries; missing files are fine (fallbacks stay). Call once at boot. */
export async function preloadModels(base = './models/') {
  const [p, w, n] = await Promise.all([loadGLB(base + 'player.glb'), loadGLB(base + 'weapons.glb'), loadGLB(base + 'nades.glb')]);
  if (p) { MODELS.player = p.scene; MODELS.playerClips = p.animations || []; p.scene.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } }); }
  if (w) { MODELS.weapons = w.scene; w.scene.traverse(o => { if (o.isMesh) o.castShadow = true; }); }
  if (n) { MODELS.nades = n.scene; }
  MODELS.ready = !!(p || w || n);
  return MODELS;
}

/* ---- player ---- */
// team/skin recolour: the GLB carries materials named cloth / pants / vest / skin / boot;
// we clone them per body so two agents never share a colour swap.
const TEAM_COL = { CT: { cloth: 0x2b4f86, pants: 0x223047, vest: 0x1e2a3e }, T: { cloth: 0x6e5a2c, pants: 0x3a3328, vest: 0x4a3d22 } };
export function makeBodyGLB(team, isHuman) {
  if (!MODELS.player) return null;
  const g = SkeletonUtils.clone(MODELS.player);
  const cols = TEAM_COL[team] || TEAM_COL.CT, mats = {};
  g.traverse(o => {
    if (!o.isMesh) return;
    const arr = Array.isArray(o.material) ? o.material : [o.material];
    const out = arr.map(m => { const key = (m.name || '').toLowerCase(); if (!mats[key]) { mats[key] = m.clone(); if (cols[key]) mats[key].color.setHex(cols[key]); if (key === 'skin') mats[key].color.setHex(isHuman ? 0xf2c79a : (team === 'CT' ? 0xe7c6a0 : 0xddb892)); } return mats[key]; });
    o.material = Array.isArray(o.material) ? out : out[0];
  });
  // GLTFLoader sanitises node names (PropertyBinding: strips [ ] . : /) so "Hand.R" arrives as "HandR"
  const bone = n => g.getObjectByName(n) || g.getObjectByName(n.replace(/[\[\]\.:\/]/g, '')) || null;
  const hips = bone('Hips'), spine = bone('Spine'), head = bone('Head'), handR = bone('Hand.R') || bone('Hand.L');
  // weapon holder hangs off the right hand so the gun follows the arm through animations
  const holder = new THREE.Group(); if (handR) { handR.add(holder); holder.position.set(0, 3, 0); } else g.add(holder);   // 3u along the hand bone = palm; orientation is re-solved every frame (updateBodyGLB)
  const mixer = new THREE.AnimationMixer(g), actions = {};
  for (const c of CLIPS) { const clip = THREE.AnimationClip.findByName(MODELS.playerClips || [], c); if (clip) { actions[c] = mixer.clipAction(clip); actions[c].enabled = true; actions[c].setEffectiveWeight(0); actions[c].play(); } }
  if (actions.idle) actions.idle.setEffectiveWeight(1);
  // fake "chest"/"belly" handles so recolorAgent() keeps working: they just point at the cloth material owner
  const clothHolder = { material: mats.cloth || mats[Object.keys(mats)[0]] || new THREE.MeshStandardMaterial() };
  return { g, upper: spine || g, legs: hips || g, head: head || clothHolder, chest: clothHolder, belly: clothHolder, holder, weapon: null,
           glb: true, mixer, actions, cur: 'idle', bones: { hips, spine, head }, hand: handR,
           realYaw: 0, aimYaw: 0, lean: 0, pitch: 0 };   // filled by updateAgentVisual each frame, applied after the mixer below
}
/* Drive a GLB body: blend to the right clip from movement state, then compose the anti-aim on top of the
   clip pose (the mixer rewrites every bone quaternion each frame, so the twist must come after it):
   Hips = real yaw (legs), Spine = fake-real delta (torso faces the fake angle) + pitch lean about the torso's
   own right axis; the gun sits in the right hand but is re-aimed to the torso facing/pitch every frame. */
const _qy = new THREE.Quaternion(), _qx = new THREE.Quaternion(), _qw = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0), _X = new THREE.Vector3(1, 0, 0);
export function updateBodyGLB(a, dt) {
  const b = a.body; if (!b || !b.glb) return;
  const sp = Math.hypot(a.vel.x, a.vel.z), moving = sp > 30;
  const crouch = b.crouchShown != null ? b.crouchShown : a.crouch;   // fake duck shows the stance you are NOT in
  const want = crouch ? (moving ? 'crouch_walk' : 'crouch_idle') : (moving ? (sp > 150 ? 'run' : 'walk') : 'idle');
  if (want !== b.cur && b.actions[want]) {
    const from = b.actions[b.cur], to = b.actions[want];
    to.reset().setEffectiveWeight(1); to.timeScale = 1;
    if (from) from.setEffectiveWeight(0); b.cur = want;
  }
  const act = b.actions[b.cur]; if (act && (b.cur === 'walk' || b.cur === 'run' || b.cur === 'crouch_walk')) act.timeScale = THREE.MathUtils.clamp(sp / (b.cur === 'run' ? 220 : 120), 0.4, 1.8);
  b.mixer.update(dt);
  const { hips, spine } = b.bones, dy = b.aimYaw - b.realYaw;
  if (hips) hips.quaternion.premultiply(_qy.setFromAxisAngle(_Y, b.realYaw));
  if (spine) spine.quaternion.premultiply(_qx.setFromAxisAngle(_X, b.lean)).premultiply(_qy.setFromAxisAngle(_Y, dy));
  if (b.hand) {   // holder local = handWorld⁻¹ · desiredWorld  (body root carries no rotation, only position)
    b.hand.updateWorldMatrix(true, false); b.hand.getWorldQuaternion(_qw);
    b.holder.quaternion.copy(_qw).invert().multiply(_qy.setFromAxisAngle(_Y, b.aimYaw)).multiply(_qx.setFromAxisAngle(_X, -b.pitch));
  }
}

/* ---- weapons ---- */
export function buildWeaponModelGLB(key) {
  if (!MODELS.weapons) return null;
  const src = MODELS.weapons.getObjectByName(key); if (!src) return null;
  const g = src.clone(true); g.position.set(0, 0, 0); g.rotation.set(0, 0, 0); g.visible = true;
  const hammer = g.getObjectByName('Hammer'); if (hammer) g.userData.hammer = hammer;
  return g;
}

/* ---- grenades ---- */
export function nadeMeshGLB(kind) {
  if (!MODELS.nades) return null;
  const src = MODELS.nades.getObjectByName(kind) || MODELS.nades.getObjectByName(kind === 'inc' ? 'molly' : kind); if (!src) return null;
  const g = src.clone(true); g.position.set(0, 0, 0); g.rotation.set(0, 0, 0); g.visible = true; return g;
}
