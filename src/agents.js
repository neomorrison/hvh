/* ============================== [AGENTS] ==============================
   Player & bot bodies, weapon/grenade models, the first-person viewmodel,
   cheat-config defaults, bot personas, spawning, hitboxes and the per-frame
   visual update (anti-aim twist, crouch, held weapon, chams).             */
import * as THREE from 'three';
import { scene, camera } from './core.js';
import { TEAM, WEAPONS, ECON, EYE_STAND } from './data.js';
import { agents, refs, vm, clock, GAME } from './state.js';

export function makeBody(team, isHuman) {
  const g = new THREE.Group();
  const skinC = isHuman ? 0xf2c79a : (team === TEAM.CT ? 0xe7c6a0 : 0xddb892);
  const cloth = team === TEAM.CT ? 0x2b4f86 : 0x6e5a2c;
  const pants = team === TEAM.CT ? 0x223047 : 0x3a3328;
  const vestC = team === TEAM.CT ? 0x1e2a3e : 0x4a3d22;
  const skin = new THREE.MeshStandardMaterial({ color: skinC, roughness: .75 });
  const clothM = new THREE.MeshStandardMaterial({ color: cloth, roughness: .85 });
  const pantsM = new THREE.MeshStandardMaterial({ color: pants, roughness: .9 });
  const vestM = new THREE.MeshStandardMaterial({ color: vestC, roughness: .7, metalness: .1 });
  const bootM = new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: .9 });
  const box = (w, h, d, x, y, z, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.castShadow = true; return b; };

  const legs = new THREE.Group();
  for (const sx of [-5.5, 5.5]) {
    legs.add(box(8, 20, 9, sx, 28, 0, pantsM));
    legs.add(box(7, 18, 8, sx, 10, 0.5, pantsM));
    legs.add(box(8, 5, 13, sx, 2, 2, bootM));
  }
  const chest = box(24, 16, 13, 0, 55, 0, clothM);
  const belly = box(20, 12, 12, 0, 43, 0, clothM);
  const vest = box(25, 17, 14, 0, 55, 0.4, vestM); vest.scale.set(1, 1, 1);
  const neck = box(7, 5, 7, 0, 65, 0, skin);
  const head = box(12, 12, 12, 0, 72.5, 0, skin);
  const helmet = box(13, 7, 13, 0, 76, 0, vestM);
  const face = box(9, 4, 2, 0, 72, 6.2, new THREE.MeshStandardMaterial({ color: 0x111316, roughness: .4 }));
  const armL = new THREE.Group();
  armL.add(box(6, 7, 8, -14, 58, 0, clothM));
  armL.add(box(5, 15, 6, -14, 49, 1, clothM));
  armL.add(box(5, 12, 5, -13, 38, 4, skin));
  armL.add(box(5, 5, 5, -13, 31, 6, skin));
  const armR = new THREE.Group();
  armR.add(box(6, 7, 8, 14, 58, 0, clothM));
  armR.add(box(5, 14, 6, 13, 50, 3, clothM));
  armR.add(box(5, 6, 11, 11, 44, 11, skin));
  const upper = new THREE.Group();
  [chest, belly, vest, neck, head, helmet, face, armL, armR].forEach(o => upper.add(o));
  // Pivot the torso at the WAIST, not the feet: shift every child down by WAIST and lift the group
  // back up. Otherwise anti-aim's yaw+pitch rotate the torso around the feet (lever ~55u) and it
  // visibly swings sideways off the legs instead of leaning.
  const WAIST = 44;
  upper.children.forEach(c => c.position.y -= WAIST);
  g.add(upper); g.add(legs);
  const holder = new THREE.Group(); holder.position.set(10, 46 - WAIST, 14); upper.add(holder);
  return { g, upper, head, chest, belly, legs, holder, weapon: null };
}

/* ---- weapon models (held + viewmodel); barrel points +Z ---- */
export function buildWeaponModel(key) {
  const g = new THREE.Group();
  const black = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: .5, metalness: .45 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: .6, metalness: .3 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x9aa3ae, roughness: .3, metalness: .8 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4724, roughness: .7 });
  const tan = new THREE.MeshStandardMaterial({ color: 0xb59b6e, roughness: .75 });
  const box = (w, h, d, x, y, z, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m || black); b.position.set(x, y, z); b.castShadow = true; g.add(b); return b; };
  const cyl = (r, len, x, y, z, m, along) => { const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), m || black); c.position.set(x, y, z); if (along === 'z') c.rotation.x = Math.PI / 2; c.castShadow = true; g.add(c); return c; };
  const pistol = (slideZ, body) => { box(4, 7, 5, 0, -5, -4, black); box(4.6, 4.6, 16, 0, 0, slideZ, body || black); box(4, 2, 8, 0, -2.6, -1, black); };
  if (key === "knife") {
    box(2.5, 3, 9, 0, -3, -2, dark); box(1, 4, 1.5, 0, -1, 4, black);
    const blade = box(0.6, 5, 14, 0.3, 1, 11, metal); blade.rotation.x = -0.12;
    box(0.7, 1.5, 5, 0.3, 3, 16, metal); return g;
  }
  if (key === "ssg") {
    cyl(1.3, 70, 0, 1, 18, metal, 'z'); box(5, 6, 30, 0, -1, -4, dark); box(5, 4, 9, 0, -3, -13, dark);
    box(5, 7, 22, 0, -2, -30, tan); box(6, 2, 12, 0, -6, -28, tan);
    cyl(2.6, 20, 0, 7, 0, dark, 'z'); box(4, 3, 6, 0, 4, -6, metal); box(4, 3, 6, 0, 4, 8, metal);
  } else if (key === "scar" || key === "g3") {
    cyl(1.6, 60, 0, 2, 22, metal, 'z'); box(7, 9, 42, 0, -1, 2, dark); box(6, 15, 9, 0, -13, -4, black);
    box(5, 9, 8, 0, -10, -16, black); box(6, 8, 26, 0, -2, -36, key === "g3" ? black : tan); box(7, 3, 13, 0, -7, -34, key === "g3" ? black : tan);
    cyl(3, 24, 0, 9, 2, dark, 'z'); box(5, 4, 7, 0, 5, -6, metal); box(5, 4, 7, 0, 5, 10, metal);
  } else if (key === "duals") {
    for (const sx of [-7, 7]) { box(4, 7, 5, sx, -5, -4, black); box(4.4, 4.4, 15, sx, 0, 6, metal); box(4, 2, 8, sx, -2.6, -1, black); cyl(1.1, 8, sx, 0.4, 15, metal, 'z'); }
  } else if (key === "r8") {
    box(4.5, 8, 6, 0, -5, -5, wood); box(5, 5, 12, 0, 0, 2, black); cyl(3.4, 8, 0, 0, 1, metal, 'z');
    cyl(1.5, 24, 0, 0.6, 17, metal, 'z'); box(4, 2, 8, 0, -2.6, -2, black);
    const hammer = new THREE.Group(); hammer.position.set(0, 2.6, -6);
    const hb = new THREE.Mesh(new THREE.BoxGeometry(1.6, 5, 2.4), metal); hb.position.set(0, 2.5, 0); hb.castShadow = true; hammer.add(hb);
    g.add(hammer); g.userData.hammer = hammer;
  } else if (key === "deagle") {
    box(5, 9, 6, 0, -5, -5, black); box(6, 7, 24, 0, 0.5, 7, metal); cyl(1.7, 12, 0, 0.6, 21, metal, 'z'); box(5, 2, 9, 0, -3, -2, black);
  } else {
    pistol(5, key === "glock" ? dark : black);
    if (key === "usp") cyl(2.2, 16, 0, 0.4, 22, dark, 'z'); else cyl(1.3, 6, 0, 0.4, 15, metal, 'z');
  }
  return g;
}
export function buildNadeModel() { const g = new THREE.Group(); const b = new THREE.Mesh(new THREE.SphereGeometry(5, 10, 8), new THREE.MeshStandardMaterial({ color: 0x3a4a2a, roughness: .7 })); b.scale.y = 1.3; g.add(b); return g; }

export function setViewmodel(key, isNade) {
  if (vm.current) { camera.remove(vm.current); vm.current = null; }
  if (!key && !isNade) return;
  const m = isNade ? buildNadeModel() : buildWeaponModel(key);
  m.scale.setScalar(0.45); m.position.set(7, -7, -20); m.rotation.set(0.04, Math.PI + 0.16, 0.04);
  camera.add(m); vm.current = m;
}

export function defaultCheats(aggressive) {
  return {
    aimbot: { on: aggressive, fov: aggressive ? 180 : 30, hitchance: aggressive ? 78 : 50, minDmg: 1, silent: true,
      autoShoot: aggressive, autoScope: true, autoStop: aggressive, autoKnife: aggressive, autoRevolver: true, target: "crosshair", priority: "head", forceBody: false, safepoint: false },
    autowall: { on: aggressive, minDmg: 30 },
    resolver: { on: aggressive, accuracy: aggressive ? 0.8 : 0.0, mode: "animation" },
    antiaim: { on: aggressive, yaw: "jitter", jitter: 55, pitch: "down", desync: true, desyncAngle: 58, mode: "at_target", fakeduck: false },
    tickbase: { backtrack: aggressive ? 200 : 0 },
    visuals: { esp: false, boxes: true, health: true, name: true, distance: false, snaplines: false, chams: false },
  };
}

export const BOT_PERSONAS = [
  { name: "lucky", style: "rage", aim: { priority: "head", hitchance: 90, forceBody: false }, res: 0.92, aa: { yaw: "jitter", pitch: "down", desyncAngle: 58 }, wepBias: "deagle" },
  { name: "vapor", style: "peek", aim: { priority: "head", hitchance: 82, forceBody: false }, res: 0.8, aa: { yaw: "sideways", pitch: "down", desyncAngle: 52 }, wepBias: "ssg" },
  { name: "ghoul", style: "rage", aim: { priority: "stomach", hitchance: 86, forceBody: true }, res: 0.7, aa: { yaw: "jitter", pitch: "down", desyncAngle: 58 }, wepBias: "scar" },
  { name: "nyx", style: "passive", aim: { priority: "head", hitchance: 88, forceBody: false }, res: 0.85, aa: { yaw: "spin", pitch: "down", desyncAngle: 58 }, wepBias: "ssg" },
  { name: "hex", style: "peek", aim: { priority: "head", hitchance: 80, forceBody: false }, res: 0.78, aa: { yaw: "back", pitch: "up", desyncAngle: 48 }, wepBias: "r8" },
  { name: "prism", style: "rage", aim: { priority: "stomach", hitchance: 84, forceBody: true }, res: 0.74, aa: { yaw: "jitter", pitch: "zero", desyncAngle: 55 }, wepBias: "duals" },
  { name: "wraith", style: "passive", aim: { priority: "head", hitchance: 91, forceBody: false }, res: 0.9, aa: { yaw: "sideways", pitch: "down", desyncAngle: 58 }, wepBias: "g3" },
  { name: "jolt", style: "rush", aim: { priority: "head", hitchance: 76, forceBody: false }, res: 0.68, aa: { yaw: "jitter", pitch: "down", desyncAngle: 50 }, wepBias: "deagle" },
  { name: "cinder", style: "peek", aim: { priority: "head", hitchance: 83, forceBody: false }, res: 0.82, aa: { yaw: "jitter", pitch: "down", desyncAngle: 56 }, wepBias: "deagle" },
  { name: "onyx", style: "rage", aim: { priority: "stomach", hitchance: 88, forceBody: true }, res: 0.8, aa: { yaw: "spin", pitch: "down", desyncAngle: 58 }, wepBias: "scar" },
  { name: "dezync", style: "passive", aim: { priority: "head", hitchance: 93, forceBody: false }, res: 0.94, aa: { yaw: "sideways", pitch: "zero", desyncAngle: 58 }, wepBias: "ssg" },
  { name: "mirage", style: "rush", aim: { priority: "head", hitchance: 79, forceBody: false }, res: 0.72, aa: { yaw: "jitter", pitch: "down", desyncAngle: 54 }, wepBias: "r8" },
];
// extra personas so a full 12v12 (23 bots) gets distinct names + varied behaviour
const _EXTRA_NAMES = ["zephyr", "quartz", "blaze", "specter", "vortex", "raven", "cobalt", "phantom", "glitch", "static", "ember", "fang", "drift", "havoc", "pulse", "rogue"];
const _STYLES = ["rage", "peek", "passive", "rush"], _YAWS = ["jitter", "sideways", "spin", "back"], _PITCHES = ["down", "down", "up", "zero"], _BIASES = ["deagle", "ssg", "scar", "g3", "r8", "duals"];
for (let i = 0; i < _EXTRA_NAMES.length; i++) {
  const head = Math.random() < 0.7;
  BOT_PERSONAS.push({
    name: _EXTRA_NAMES[i], style: _STYLES[i % _STYLES.length],
    aim: { priority: head ? "head" : "stomach", hitchance: 74 + Math.floor(Math.random() * 20), forceBody: !head },
    res: 0.68 + Math.random() * 0.26,
    aa: { yaw: _YAWS[i % _YAWS.length], pitch: _PITCHES[i % _PITCHES.length], desyncAngle: 48 + Math.floor(Math.random() * 11) },
    wepBias: _BIASES[i % _BIASES.length],
  });
}
export function applyPersona(a, p) {
  a.persona = p; a.name = p.name;
  const c = a.cheats;
  c.aimbot.priority = p.aim.priority; c.aimbot.hitchance = p.aim.hitchance; c.aimbot.forceBody = p.aim.forceBody;
  c.resolver.accuracy = p.res;
  c.antiaim.yaw = p.aa.yaw; c.antiaim.pitch = p.aa.pitch; c.antiaim.desyncAngle = p.aa.desyncAngle;
}

export function spawnAgent(team, isHuman, name) {
  const body = makeBody(team, isHuman);
  scene.add(body.g);
  const a = {
    name, team, isHuman, body,
    pos: new THREE.Vector3(), vel: new THREE.Vector3(),
    yaw: 0, pitch: 0, realYaw: 0, fakeYaw: 0,
    desyncSide: 1, eye: EYE_STAND, crouch: false,
    hp: 100, armor: 0, helmet: false, alive: true,
    money: ECON.start, weapons: {}, cur: null, slotPrimary: null, slotSecondary: null,
    nades: {}, curNade: null, equippedNade: null,
    fireCd: 0, reloadT: 0, scoped: false, lastShot: 0, burstQ: 0, r8Charge: 0,
    kills: 0, deaths: 0, assists: 0,
    cheats: defaultCheats(!isHuman),
    boughtThisBuy: {},
    aiPath: [], aiGoal: null, aiNode: 0, aiTimer: 0, aiTarget: null, aiState: "roam", aiStrafe: 1, aiNextStrafe: 0,
    aiLastPos: new THREE.Vector3(), aiStuck: 0,
    carrying: null, flashT: 0, lastDamageFrom: null, hitFlash: 0,
    landBloom: 0, onGround: true,
  };
  agents.push(a);
  return a;
}

export function hitboxes(a) {
  const s = a.crouch ? 0.72 : 1, fy = a.pos.y;            // fy = feet height (0 on flat maps; floor Y on mesh maps / when airborne)
  const x = a.pos.x, z = a.pos.z;
  return [
    { group: "head", minX: x - 7, maxX: x + 7, minY: fy + 60 * s, maxY: fy + 73 * s, minZ: z - 7, maxZ: z + 7 },
    { group: "chest", minX: x - 11, maxX: x + 11, minY: fy + 46 * s, maxY: fy + 60 * s, minZ: z - 7, maxZ: z + 7 },
    { group: "stomach", minX: x - 10, maxX: x + 10, minY: fy + 34 * s, maxY: fy + 46 * s, minZ: z - 6, maxZ: z + 6 },
    { group: "legs", minX: x - 9, maxX: x + 9, minY: fy, maxY: fy + 34 * s, minZ: z - 6, maxZ: z + 6 },
  ];
}
export function hitboxCenter(a, group) {
  const s = a.crouch ? 0.72 : 1;
  const y = a.pos.y + { head: 66, chest: 53, stomach: 40, legs: 17 }[group] * s;
  return new THREE.Vector3(a.pos.x, y, a.pos.z);
}
export function eyePos(a) { return new THREE.Vector3(a.pos.x, a.eye, a.pos.z); }

export function recolorAgent(a) {
  const cloth = a.team === TEAM.CT ? 0x274a82 : 0x6a5a2a;
  a.body.chest.material.color.setHex(cloth); a.body.belly.material.color.setHex(cloth);
}

/* ---- per-frame visual: anti-aim twist, crouch, held weapon, chams ---- */
export function updateAgentVisual(a) {
  const human = refs.human;
  if (a.isHuman && !GAME.thirdPerson) { a.body.g.visible = false; return; }
  if (!a.alive) { a.body.g.visible = false; return; }
  a.body.g.visible = true;
  if (human && !a.isHuman && a.team !== human.team) applyChams(a, !!(human.cheats.visuals && human.cheats.visuals.chams));
  a.body.g.position.set(a.pos.x, a.pos.y, a.pos.z);
  a.body.legs.rotation.y = a.realYaw || a.yaw;
  const aa = a.cheats.antiaim;
  let upperYaw = a.yaw;
  if (aa.on) {
    if (aa.yaw === "back") upperYaw = a.yaw + Math.PI;
    else if (aa.yaw === "sideways") upperYaw = a.yaw + Math.PI / 2 * a.desyncSide;
    else if (aa.yaw === "spin") upperYaw = clock.t * 10;
    else if (aa.yaw === "jitter") upperYaw = a.yaw + Math.sin(clock.t * 22 + a.pos.x) * (aa.jitter * Math.PI / 180);
  }
  a.body.upper.rotation.y = upperYaw;
  const aimP = aa.on ? (aa.pitch === "down" ? 0.5 : aa.pitch === "up" ? -0.5 : 0) : 0;
  a.body.upper.rotation.x = aimP * 0.4;
  const sc = a.crouch ? 0.72 : 1; a.body.upper.position.y = a.crouch ? 44 - 12 : 44; a.body.legs.scale.y = sc;   // 44 = waist pivot (see body build)
  if (a._wmKey !== a.cur) {
    a._wmKey = a.cur;
    if (a.body.weapon) a.body.holder.remove(a.body.weapon);
    a.body.weapon = buildWeaponModel(a.cur); a.body.weapon.scale.setScalar(1.0); a.body.holder.add(a.body.weapon);
  }
  a.body.holder.rotation.x = -a.pitch;
}
export function applyChams(a, on) {
  if (a._chams === on) return; a._chams = on;
  a.body.g.traverse(o => { if (o.isMesh) { o.material.depthTest = !on; o.renderOrder = on ? 990 : 0; if (o.material.emissive) { o.material.emissive.setHex(on ? 0xff2a44 : 0x000000); o.material.emissiveIntensity = on ? 0.6 : 1; } } });
}
