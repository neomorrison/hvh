/* ============================== [DATA] ==============================
   Economy, weapon stats, the CS2 inaccuracy model and damage/penetration
   constants.  Pure data + the damage function — no scene or DOM deps.     */

export const TEAM = { CT: "CT", T: "T" };

export const ECON = {
  start: 800, max: 16000,                         // round 1 is a classic $800 pistol round; the boosted win/loss rewards below carry the rest
  win: { ct_rescue: 3400, ct_elim: 3500, t_elim: 3500, t_time: 3500 },
  lossLadder: [2400, 2900, 3400, 3400, 3400],     // index = consecutiveLosses-1, capped — generous so nobody is stuck on pistols
  killReward: 300,
  hostage: { rescuerBonus: 1000, teamBonus: 600, damagePenalty: -30, killPenalty: -1000 },
};
export const ARMOR_RATIO_CONST = 0.5, ARMOR_BONUS_CONST = 0.5;
export const HITGROUP = { head: 4.0, chest: 1.0, arms: 1.0, stomach: 1.25, legs: 0.75 };

// armorPen given as community percent; flArmorRatio = pct/100 (see spec §3.5)
export const WEAPONS = {
  glock:  { name: "Glock-18",      slot: 1, side: "T",   cost: 200,  dmg: 30, penPct: 47,   rpm: 300, mag: 20, reserve: 60, reload: 2.27, run: 240, range: 0.85, kill: 300, auto: false, mode: "burst" },
  usp:    { name: "USP-S",         slot: 1, side: "CT",  cost: 200,  dmg: 35, penPct: 50.5, rpm: 300, mag: 12, reserve: 24, reload: 2.17, run: 240, range: 0.99, kill: 300, auto: false },
  duals:  { name: "Dual Berettas", slot: 1, side: "both",cost: 300,  dmg: 35, penPct: 57.5, rpm: 400, mag: 30, reserve: 60, reload: 3.77, run: 240, range: 0.75, kill: 300, auto: false },
  deagle: { name: "Desert Eagle",  slot: 1, side: "both",cost: 700,  dmg: 63, penPct: 93.2, rpm: 267, mag: 7,  reserve: 21, reload: 2.2,  run: 230, range: 0.94, kill: 300, auto: false },
  // R8 Revolver — CS2 primary is a slow, deliberate hammer-cock shot; the fan
  // (alt-fire) is faster but inaccurate.  cockTime/cycle govern the real time
  // between shots so it can no longer be spammed faster than CS2.
  r8:     { name: "R8 Revolver",   slot: 1, side: "both",cost: 600,  dmg: 86, penPct: 93.2, rpm: 120, mag: 8,  reserve: 16, reload: 2.27, run: 220, range: 0.98, kill: 300, auto: false, mode: "r8", cockTime: 0.25, cyclePrimary: 0.25, cycleFan: 0.30 },
  ssg:    { name: "SSG08",         slot: 2, side: "both",cost: 1700, dmg: 88, penPct: 85,   rpm: 48,  mag: 10, reserve: 20, reload: 3.67, run: 230, range: 0.99, kill: 300, auto: false, scope: 1, scopedRun: 230 },
  scar:   { name: "SCAR-20",       slot: 2, side: "CT",  cost: 5000, dmg: 80, penPct: 82.5, rpm: 240, mag: 20, reserve: 40, reload: 3.07, run: 215, range: 0.99, kill: 300, auto: true,  scope: 1, scopedRun: 120 },
  g3:     { name: "G3SG1",         slot: 2, side: "T",   cost: 5000, dmg: 80, penPct: 82.5, rpm: 240, mag: 20, reserve: 40, reload: 4.67, run: 215, range: 0.99, kill: 300, auto: true,  scope: 1, scopedRun: 120 },
  knife:  { name: "Knife",         slot: 3, side: "both",cost: 0, melee: true, run: 250, kill: 1500,
            slashFront: 40, slashBack: 90, stabFront: 65, stabBack: 180, knifeRange: 62, slashCd: 0.42, stabCd: 1.05 },
};

// CS2 inaccuracy model (community-measured units). cone_radians = inaccuracy * INACC_K
export const INACC = {
  // PISTOLS. The old numbers made a standing first shot a guaranteed headshot out to ~500u and let
  // you spam through a mag with barely any penalty. CS2 pistols are the opposite: a deliberate first
  // shot is good but never free at range, and the per-shot bloom out-paces the fire rate, so spamming
  // collapses the cone and you have to tap. `stand`/`crouch` roughly doubled; `fire` bloom raised and
  // `max` lifted so a full spam actually reaches the cap.
  // THE CS WEAPON-SCRIPT NUMBERS (inaccuracy stand / crouch / move / fire, with the static `spread`
  // folded into stand+crouch). In the engine a bullet leaves along  forward + x·inacc·right + y·inacc·up
  // with inacc = value / 1000 and x, y each the sum of two uniform(-0.5,0.5) rolls — so a value IS the
  // cone's half-width as a tangent ×1000, and INACC_K is exactly 0.001. `recov` = the recovery time.
  deagle: { stand: 26.6, crouch: 21.3, run: 46.0,  fire: 34.6, max: 160, recov: 0.37 },
  r8:     { stand: 5.7,  crouch: 4.6,  run: 22.0,  fire: 27.0, max: 120, recov: 0.44 },
  duals:  { stand: 15.5, crouch: 12.4, run: 28.5,  fire: 18.0, max: 140, recov: 0.34 },
  usp:    { stand: 7.3,  crouch: 5.9,  run: 22.5,  fire: 21.7, max: 130, recov: 0.38 },
  glock:  { stand: 9.1,  crouch: 7.3,  run: 23.2,  fire: 25.8, max: 130, recov: 0.31 },
  ssg:    { stand: 118,  crouch: 94.4, run: 155.4, fire: 8.0,  max: 60,  recov: 0.40, scopedStill: 0.35, unscoped: 118 },
  // auto-snipers: a pin-sharp first scoped shot (5.2 → 5u radius at 1000u), then `fire` stacks faster
  // than the 0.25s cycle recovers, so a spam collapses and you pause to reset. Unscoped they are a shotgun.
  scar:   { stand: 84,   crouch: 67,   run: 105,   fire: 9.3,  max: 90,  recov: 0.55, scopedStill: 5.2, unscoped: 84 },
  g3:     { stand: 84,   crouch: 67,   run: 105,   fire: 8.5,  max: 85,  recov: 0.55, scopedStill: 5.2, unscoped: 84 },
};
export const INACC_K = 0.001;       // inaccuracy units -> cone half-width (tangent ≈ radians): the engine's value / 1000
export const AIRBORNE_INACC = 130;  // jumping/in-air penalty (units)
// landing inaccuracy: you are NOT instantly accurate after touching down (CS2).
// Applied on landing (scaled by impact), then bleeds off over ~LAND_RECOVER.
export const LAND_INACC = 120;      // peak landing penalty (units)
export const LAND_RECOVER = 360;    // units shed per second after landing (~0.33s to clear)

export const NADES = {
  he:    { name: "HE Grenade", cost: 300, kind: "he" },
  smoke: { name: "Smoke",      cost: 300, kind: "smoke" },
  molly: { name: "Molotov",    cost: 400, kind: "fire", side: "T" },
  inc:   { name: "Incendiary", cost: 600, kind: "fire", side: "CT" },
};
// helmet is not its own buy-menu entry in CS2 — it's the price you pay for "Kevlar + Helmet" when the
// vest is already full.  See armorBuy() in game.js for the full rebuy rules.
export const ARMOR = { kevlar: { name: "Kevlar", cost: 650 }, kevhelm: { name: "Kevlar + Helmet", cost: 1000 }, helmet: { name: "Helmet", cost: 350 } };

// world scale: 1 three.js unit = 1 source unit. eye height ~64, distances in spec units.
export const EYE_STAND = 64, EYE_CROUCH = 46, PLAYER_RADIUS = 16, GRAVITY = 800, JUMP_VEL = 260;
export const BHOP_GAIN = 0.05, BHOP_MAX = 1.28;   // per-chained-jump speed gain (+5%), capped at +28% (CS-style bhop)

/* ---- tickbase: backtrack + hide shots ----
   Backtrack is a TICK budget, not a millisecond one — the server keeps a fixed number of ticks of
   lag-compensation history and a cheat rewinds a target to one of those recorded ticks.  At 64 tick,
   16 ticks = 250ms, which is CS2's practical unlag window. */
export const TICK_RATE = 64, TICK = 1 / TICK_RATE;
export const MAX_BACKTRACK_TICKS = 16;         // history depth every agent records (16 tk = 250ms)
export const BT_SAMPLES = 5;                   // records actually evaluated per shot (cost control)
/* Hide shots: firing normally PINS your real angles at the target for a moment, which is what makes a
   desyncing player's head readable the instant they shoot.  Hiding a shot spends banked shift ticks so
   the shot goes out while the fake angle is still up — but the bank only refills at a fraction of real
   time, so you can hide taps, never a spray. */
export const EXPOSE_TIME = 0.18;               // seconds a normal (un-hidden) shot exposes your real angles
export const SHIFT_MAX_TICKS = 16, HIDE_SHOT_COST = 8, SHIFT_REGEN = 0.25;   // bank cap (= sv_maxusrcmdprocessticks), cost per hidden shot, ticks banked per real tick

/* ---- how the three tick exploits actually relate ----
   All three spend the SAME resource: the server will only process a bounded burst of user commands
   (sv_maxusrcmdprocessticks, 16), and lag compensation will only rewind a bounded window (sv_maxunlag).
     · DOUBLE TAP shifts your tickbase FORWARD past the weapon's next-attack check, so two commands
       both pass it and two bullets land in one server frame.  It costs as many banked ticks as the
       weapon's fire cycle is long, which is why bolt-actions (SSG: 80 ticks) simply can't be doubled.
       The R8 can't either, for a different reason — see NO_DOUBLE_TAP below.
     · HIDE SHOTS shifts the tickbase BACKWARD so the shot is processed on a tick where your fake angle
       was still up.  Opposite direction — a shot cannot be shifted both ways, so you get one or the
       other per shot, never both.  Every cheat menu resolves this the same way: double tap wins, and
       a doubled shot therefore exposes you.
     · BACKTRACK spends the rewind window.  While a shift is still in flight the server is running your
       commands off-clock, so there is no window left — backtrack is suppressed until it catches up. */
export function weaponCycle(key, fireMode) {
  const w = WEAPONS[key]; if (!w || w.melee) return 0;
  if (key === "r8") return fireMode === "fan" ? (w.cycleFan || 0.30) : (w.cyclePrimary || 0.25);
  return w.rpm ? 60 / w.rpm : 0;
}
/* Weapons no cheat will double tap, whatever the tick budget says.  The R8's trigger is not a plain
   next-attack timestamp — it is a hammer-cock state machine (the shot is postponed until the cock
   completes), so shifting the tickbase forward past the attack check does not buy a second round; it
   just eats the bank.  Every HvH cheat excludes the revolver for that reason, so this one does too. */
export const NO_DOUBLE_TAP = new Set(["r8"]);
/* Ticks of forward shift needed to double-tap this weapon, or 0 if it can't be doubled.
   duals 10 · usp/glock 13 · deagle 15 · scar/g3 16 · r8 excluded · ssg 80 (over budget) · knife n/a */
export function dtTicks(key, fireMode) {
  if (NO_DOUBLE_TAP.has(key)) return 0;
  const c = weaponCycle(key, fireMode); if (!c) return 0;
  const t = Math.ceil(c / TICK);
  return t <= SHIFT_MAX_TICKS ? t : 0;
}

// bullet penetration (autowall): weapon penPct doubles as penetration power.
export const PEN = {
  maxSurfaces: 4,        // the engine gives up after four surfaces
  // CS PENETRATION POWER per weapon (the weapon-script "penetration" value): pistols 1, Deagle/R8 2,
  // SSG 2, auto-snipers 2.5. A surface can be punched if its thickness is under power × unitsPerPower
  // (≈ the engine's penetration distance against a generic concrete-like material), and every
  // surface crossed costs a flat entry loss plus a loss that grows with how much of that budget it ate.
  power: { glock: 1, usp: 1, duals: 1, deagle: 2, r8: 2, ssg: 2, scar: 2.5, g3: 2.5 },
  unitsPerPower: 24,     // power × this = max thickness one surface may be: pistols 24u (a door, a thin wall), rifles 48–60u
  loneThickness: 20,     // a single-sided (non-manifold) wall face is treated this thick
  perSurfaceLoss: 0.25,  // flat damage loss for crossing any surface
  thickLossK: 0.60,      // extra loss scaled by how much of the thickness budget the surface used
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
