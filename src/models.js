/* ============================== [MODELS] ==============================
   GLB model library: rigged+animated player, weapons, grenades — built in Blender by
   tools/blender/hvh_models.py and exported to /models/*.glb.  Every getter returns null
   when its GLB isn't loaded so callers fall back to the procedural box builders.
   Contract shared with the Blender script (names must match exactly):
     player.glb  : SkinnedMesh "Player" + armature; bones Hips, Spine, Chest, Neck, Head,
                   UpperArm.L/R, Forearm.L/R, Hand.L/R, Thigh.L/R, Shin.L/R, Foot.L/R;
                   clips idle, walk, run, crouch_idle, crouch_walk.  1 unit = 1 source unit,
                   feet at y=0, ~78u tall (hitboxes: head 66 / chest 53 / stomach 40 / legs 17).
                   REST POSE IS THE AIM POSE: both hands are already on the gun, which hangs off the
                   Chest bone at GUN_OFFSET; pitching the gun = pitching both upper arms the same way.
     weapons.glb : one root per key (glock usp duals deagle r8 ssg scar g3 knife), barrel +Z,
                   grip origin at (0,0,0); r8 has a child named "Hammer" (rotates on x to cock).
     nades.glb   : roots he, flash, smoke, molly.
   FACING: a three.js object with rotation.y = yaw points its +Z at (sin yaw, 0, cos yaw), which is the
   OPPOSITE of where the camera looks at that yaw (-sin, 0, -cos). The models are built facing +Z, so
   every body yaw below carries a half turn (FACE) — without it the whole team stands with its back to
   the enemy and the gun points at the floor behind them.                                            */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';   // r160 exports clone/retarget as named functions, no namespace object

export const MODELS = { player: null, playerClips: null, weapons: null, nades: null, ready: false };
export const CLIPS = ['idle', 'walk', 'run', 'crouch_idle', 'crouch_walk'];
export const FACE = Math.PI;
// gun grip relative to the shoulder-line pivot (Blender GRIP (4,-22,52) vs pivot (0,0,61) → game x, y, z)
const GUN_PIVOT_Y = 61 - 56;               // pivot sits on the shoulder line, 5u up the Chest bone (Chest head at 56)
const GUN_OFFSET = new THREE.Vector3(4, 52 - 61, 22);

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
  if (p) {
    MODELS.player = p.scene; MODELS.playerClips = p.animations || [];
    // only the Hips translate in our clips (feet grounding); every other translation track is a constant
    // rest offset that would fight the joint pivots makeBodyGLB() inserts, so drop them
    for (const clip of MODELS.playerClips) clip.tracks = clip.tracks.filter(t => !/\.position$/.test(t.name) || /^Hips\./.test(t.name));
    p.scene.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
  }
  if (w) { MODELS.weapons = w.scene; w.scene.traverse(o => { if (o.isMesh) o.castShadow = true; }); }
  if (n) { MODELS.nades = n.scene; }
  MODELS.ready = !!(p || w || n);
  return MODELS;
}

/* ---- player ---- */
// team/skin recolour: the GLB carries materials named cloth / pants / vest / skin / boot / visor;
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
  const hips = bone('Hips'), spine = bone('Spine'), chest = bone('Chest'), head = bone('Head'), armL = bone('UpperArm.L'), armR = bone('UpperArm.R');
  // Pivots: identity Groups slipped in above Hips / Spine / both upper arms. Their rotation is SET every
  // frame (never composed onto the bones — the mixer only rewrites a bone when its animated value
  // changes, so an additive twist would accumulate). Extra identity parents leave skinning unchanged.
  // `atJoint` pivots take over the bone's rest offset so they rotate about the JOINT (the shoulders); that
  // only works because preloadModels() strips every non-Hips translation track — the sampled clips would
  // otherwise write the offset back onto the bone every frame and double it.
  const pivot = (bn, name, atJoint) => { if (!bn || !bn.parent) return null; const p = bn.parent, piv = new THREE.Group(); piv.name = name; if (atJoint) { piv.position.copy(bn.position); bn.position.set(0, 0, 0); } p.add(piv); piv.add(bn); return piv; };
  const hipsPiv = pivot(hips, 'HipsTwist', false), spinePiv = pivot(spine, 'SpineTwist', false);
  const armPivL = pivot(armL, 'ArmPivotL', true), armPivR = pivot(armR, 'ArmPivotR', true);
  const headPiv = pivot(head, 'HeadPivot', true);   // the head nods with the shown pitch (looking down really looks down)
  // the gun: on the chest, at the shoulder line, grip where the right hand rests. Pitch rotates this pivot
  // and the two arm pivots by the same angle about the same axis; the shoulders sit on that axis, so the
  // hands stay on the grip at every pitch (the offset from the axis to each shoulder is pure x).
  const holder = new THREE.Group(); holder.name = 'GunPivot';
  if (chest) { chest.add(holder); holder.position.set(0, GUN_PIVOT_Y, 0); } else g.add(holder);
  const gunMount = new THREE.Group(); gunMount.position.copy(GUN_OFFSET); holder.add(gunMount);
  // knife mount: in the right hand, blade (+Z) along the hand bone (+Y) — used when the knife is out
  const handR = bone('Hand.R'), handHolder = new THREE.Group(); handHolder.rotation.x = -Math.PI / 2; handHolder.position.set(0, 2, 0);
  if (handR) handR.add(handHolder); else holder.add(handHolder);
  const mixer = new THREE.AnimationMixer(g), actions = {};
  for (const c of CLIPS) { const clip = THREE.AnimationClip.findByName(MODELS.playerClips || [], c); if (clip) { actions[c] = mixer.clipAction(clip); actions[c].enabled = true; actions[c].setEffectiveWeight(0); actions[c].play(); } }
  if (actions.idle) actions.idle.setEffectiveWeight(1);
  // fake "chest"/"belly" handles so recolorAgent() keeps working: they just point at the cloth material owner
  const clothHolder = { material: mats.cloth || mats[Object.keys(mats)[0]] || new THREE.MeshStandardMaterial() };
  return { g, upper: spine || g, legs: hips || g, head: head || clothHolder, chest: clothHolder, belly: clothHolder, holder: gunMount, weapon: null,
           glb: true, mixer, actions, cur: 'idle', bones: { hips, spine, chest, head }, hipsPiv, spinePiv, armPivL, armPivR, headPiv, gunPiv: holder, handHolder, knifeOut: false,
           realYaw: 0, aimYaw: 0, lean: 0, pitch: 0, kick: 0 };   // filled by updateAgentVisual each frame, applied after the mixer below
}
/* Drive a GLB body: blend to the right clip from movement state, then set the anti-aim / aim pose on the
   pivots after the mixer: Hips = real yaw (legs), Spine = fake-real delta (torso faces the fake angle) +
   pitch lean, gun + both arms = pitch about the shoulder line. */
const _qy = new THREE.Quaternion(), _qx = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0), _X = new THREE.Vector3(1, 0, 0);
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
  const act = b.actions[b.cur];
  if (act && (b.cur === 'walk' || b.cur === 'run' || b.cur === 'crouch_walk')) {
    // moonwalk: the stride plays backwards while you move forwards (legs say "away", body goes "toward")
    const moon = a.cheats && a.cheats.antiaim && a.cheats.antiaim.on && a.cheats.antiaim.moonwalk;
    act.timeScale = THREE.MathUtils.clamp(sp / (b.cur === 'run' ? 220 : 120), 0.4, 1.8) * (moon ? -1 : 1);
  }
  b.mixer.update(dt);
  const dy = b.aimYaw - b.realYaw, look = -(b.pitch || 0);   // shown pitch: up is +; rotating about +X by a NEGATIVE angle lifts +Z
  if (b.hipsPiv) b.hipsPiv.quaternion.setFromAxisAngle(_Y, b.realYaw + FACE);
  // the look is split down the chain so it reads as a person looking: torso 30%, head +55% on top of
  // that, gun + arms the remaining 70% on top of the torso (chest already carries 30%)
  if (b.spinePiv) b.spinePiv.quaternion.copy(_qy.setFromAxisAngle(_Y, dy)).multiply(_qx.setFromAxisAngle(_X, look * 0.3));
  if (b.headPiv) b.headPiv.quaternion.setFromAxisAngle(_X, look * 0.55);
  const kick = b.kick > 0 ? b.kick * 0.18 : 0;
  if (b.knifeOut) {   // knife idle: arms hang, blade in the right hand (the chest gun mount is empty)
    _qx.setFromAxisAngle(_X, 1.15);
    if (b.armPivL) b.armPivL.quaternion.copy(_qx); if (b.armPivR) b.armPivR.quaternion.copy(_qx);
    if (b.gunPiv) b.gunPiv.quaternion.identity();
  } else {
    _qx.setFromAxisAngle(_X, look * 0.7 - kick);
    if (b.gunPiv) b.gunPiv.quaternion.copy(_qx);
    if (b.armPivL) b.armPivL.quaternion.copy(_qx);
    if (b.armPivR) b.armPivR.quaternion.copy(_qx);
  }
  if (b.kick > 0) b.kick = Math.max(0, b.kick - dt * 8);
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
