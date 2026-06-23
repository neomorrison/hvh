/* ============================== [DATA] ==============================
   Economy, weapon stats, the CS2 inaccuracy model and damage/penetration
   constants.  Pure data + the damage function — no scene or DOM deps.     */

export const TEAM = { CT: "CT", T: "T" };

export const ECON = {
  start: 800, max: 16000,
  win: { ct_rescue: 2900, ct_elim: 3000, t_elim: 3000, t_time: 3250 },
  lossLadder: [1400, 1900, 2400, 2900, 3400],   // index = consecutiveLosses-1, capped
  killReward: 300,
  hostage: { rescuerBonus: 1000, teamBonus: 600, damagePenalty: -30, killPenalty: -1000 },
};
export const ARMOR_RATIO_CONST = 0.5, ARMOR_BONUS_CONST = 0.5;
export const HITGROUP = { head: 4.0, chest: 1.0, arms: 1.0, stomach: 1.25, legs: 0.75 };

// armorPen given as community percent; flArmorRatio = pct/100 (see spec §3.5)
export const WEAPONS = {
  glock:  { name: "Glock-18",      slot: 1, side: "T",   cost: 200,  dmg: 30, penPct: 47,   rpm: 400, mag: 20, reserve: 60, reload: 2.17, run: 240, range: 0.85, kill: 300, auto: true,  mode: "burst" },
  usp:    { name: "USP-S",         slot: 1, side: "CT",  cost: 200,  dmg: 35, penPct: 50.5, rpm: 352, mag: 12, reserve: 24, reload: 2.17, run: 240, range: 0.99, kill: 300, auto: false },
  duals:  { name: "Dual Berettas", slot: 1, side: "both",cost: 300,  dmg: 35, penPct: 57.5, rpm: 500, mag: 30, reserve: 60, reload: 3.8,  run: 240, range: 0.75, kill: 300, auto: true },
  deagle: { name: "Desert Eagle",  slot: 1, side: "both",cost: 700,  dmg: 63, penPct: 93.2, rpm: 267, mag: 7,  reserve: 21, reload: 2.2,  run: 230, range: 0.94, kill: 300, auto: false },
  // R8 Revolver — CS2 primary is a slow, deliberate hammer-cock shot; the fan
  // (alt-fire) is faster but inaccurate.  cockTime/cycle govern the real time
  // between shots so it can no longer be spammed faster than CS2.
  r8:     { name: "R8 Revolver",   slot: 1, side: "both",cost: 600,  dmg: 86, penPct: 93.2, rpm: 120, mag: 8,  reserve: 16, reload: 2.25, run: 220, range: 0.98, kill: 300, auto: false, mode: "r8", cockTime: 0.40, cyclePrimary: 0.40, cycleFan: 0.30 },
  ssg:    { name: "SSG08",         slot: 2, side: "both",cost: 1700, dmg: 88, penPct: 85,   rpm: 48,  mag: 10, reserve: 20, reload: 3.7,  run: 230, range: 0.99, kill: 300, auto: false, scope: 1, scopedRun: 230 },
  scar:   { name: "SCAR-20",       slot: 2, side: "CT",  cost: 5000, dmg: 80, penPct: 82.5, rpm: 240, mag: 20, reserve: 40, reload: 3.1,  run: 215, range: 0.99, kill: 300, auto: true,  scope: 1, scopedRun: 120 },
  g3:     { name: "G3SG1",         slot: 2, side: "T",   cost: 5000, dmg: 80, penPct: 82.5, rpm: 240, mag: 20, reserve: 40, reload: 4.7,  run: 215, range: 0.99, kill: 300, auto: true,  scope: 1, scopedRun: 120 },
  knife:  { name: "Knife",         slot: 3, side: "both",cost: 0, melee: true, run: 250, kill: 1500,
            slashFront: 40, slashBack: 90, stabFront: 65, stabBack: 180, knifeRange: 62, slashCd: 0.42, stabCd: 1.05 },
};

// CS2 inaccuracy model (community-measured units). cone_radians = inaccuracy * INACC_K
export const INACC = {
  deagle: { stand: 6.2,  crouch: 4.18, run: 54.3,   fire: 21, max: 85,   recov: 0.40 },
  r8:     { stand: 2.52, crouch: 1.52, run: 9.02,   fire: 6,  max: 18.6, recov: 0.40 },
  duals:  { stand: 9.0,  crouch: 7.25, run: 26.85,  fire: 6.8,max: 60,   recov: 0.30 },
  usp:    { stand: 6.4,  crouch: 5.18, run: 20.27,  fire: 5.8,max: 45,   recov: 0.33 },
  glock:  { stand: 7.6,  crouch: 6.2,  run: 17.6,   fire: 6.5,max: 45,   recov: 0.30 },
  ssg:    { stand: 3.23, crouch: 3.03, run: 155.43, fire: 0,  max: 10,   recov: 0.50, scopedStill: 0.35, unscoped: 48 },
  scar:   { stand: 2.3,  crouch: 1.8,  run: 176.58, fire: 3,  max: 30,   recov: 0.45, scopedStill: 0.35, unscoped: 62 },
  g3:     { stand: 2.3,  crouch: 1.8,  run: 176.58, fire: 3,  max: 30,   recov: 0.45, scopedStill: 0.35, unscoped: 62 },
};
export const INACC_K = 0.002;       // inaccuracy units -> cone half-angle radians (calibrated: USP stand ~0.013)
export const AIRBORNE_INACC = 130;  // jumping/in-air penalty (units)
// landing inaccuracy: you are NOT instantly accurate after touching down (CS2).
// Applied on landing (scaled by impact), then bleeds off over ~LAND_RECOVER.
export const LAND_INACC = 120;      // peak landing penalty (units)
export const LAND_RECOVER = 360;    // units shed per second after landing (~0.33s to clear)

export const NADES = {
  he:    { name: "HE Grenade", cost: 300, kind: "he" },
  flash: { name: "Flashbang",  cost: 200, kind: "flash" },
  smoke: { name: "Smoke",      cost: 300, kind: "smoke" },
  molly: { name: "Molotov",    cost: 400, kind: "fire", side: "T" },
  inc:   { name: "Incendiary", cost: 600, kind: "fire", side: "CT" },
};
export const ARMOR = { kevlar: { name: "Kevlar", cost: 650 }, kevhelm: { name: "Kevlar + Helmet", cost: 1000 } };

// world scale: 1 three.js unit = 1 source unit. eye height ~64, distances in spec units.
export const EYE_STAND = 64, EYE_CROUCH = 46, PLAYER_RADIUS = 16, GRAVITY = 800, JUMP_VEL = 260;

// bullet penetration (autowall): weapon penPct doubles as penetration power.
export const PEN = {
  maxSurfaces: 4,        // CS2 stops a bullet after a few surfaces
  unitsPerPower: 64,     // power(0..1) * this = max EFFECTIVE thickness one surface may be. Tuned
                         // for the watertight physics hull (two-sided walls give REAL thickness;
                         // 64 keeps ~85% of single office walls bangable, thick concrete/brick not).
  loneThickness: 20,     // a single-sided (non-manifold) wall face is treated this thick
  perSurfaceLoss: 0.10,  // flat damage loss for crossing any surface
  thickLossK: 0.55,      // extra loss scaled by how thick the surface is vs the cap
};

/* damage model — returns {damage, armor} */
export function computeDamage(wepKey, group, dist, hasArmor, hasHelmet, armorVal) {
  const w = WEAPONS[wepKey];
  let d = w.dmg * Math.pow(w.range, dist / 500);          // 1. falloff
  d *= HITGROUP[group];                                    // 2. hitgroup
  let newArmor = armorVal, applied = d;
  const armored = group === "legs" ? false : (group === "head" ? hasHelmet : hasArmor) && armorVal > 0;
  if (armored) {
    const ratio = w.penPct / 100;                          // flArmorRatio
    let toHealth = d * ratio;
    let consumed = (d - toHealth) * ARMOR_BONUS_CONST;
    if (consumed > armorVal) { consumed = armorVal; toHealth = d - armorVal / ARMOR_BONUS_CONST; }
    applied = toHealth; newArmor = Math.max(0, armorVal - consumed);
  }
  return { damage: Math.max(0, Math.round(applied)), armor: newArmor };
}
