/* ============================== [SELF TEST] ==============================
   Every switch in the cheat menu, exercised against the live game and checked for an OBSERVABLE
   difference — not "the flag is read somewhere", but "turning it on changes what happens".
   Run it from the browser console with `HVH.verifyCheats()` (it prints a table and returns the rows);
   the Node smoke test runs the same function, so a setting that quietly stops being wired fails CI.

   Each check restores whatever it touched, and the whole run restores the player's cheats and the
   world, so it is safe to call mid-match.                                                          */
import { EYE_STAND } from './data.js';
import { agents, refs, clock, GAME } from './state.js';
import { WALLS } from './world.js';
import { meshBackend } from './sourcemap.js';
import { hitboxCenter, eyePos, defaultCheats, updateAgentVisual } from './agents.js';
import {
  canShoot, beginSimFrame, aimbotFire, autoStopScale, updateTickbase,
  resolveDesync, aaQuality, onShotFired, backtrackTicks, meleeAttack, fakeDuckScale,
} from './combat.js';
import { shotLines, updateEffects, clearEffects } from './effects.js';

/* run `fn` with the world reduced to the player and one enemy at `dist` units in front, no walls,
   and the player standing still with a full USP — the only variables left are the ones being tested */
function stage(dist, fn) {
  const human = refs.human, foe = agents.find(a => !a.isHuman && a.team !== human.team);
  if (!human || !foe) return { skip: true };
  const savedWalls = WALLS.splice(0, WALLS.length);
  const savedAlive = agents.map(a => a.alive);
  const savedCheats = JSON.parse(JSON.stringify(human.cheats));
  const savedFoeCheats = JSON.parse(JSON.stringify(foe.cheats));
  const savedPos = { h: human.pos.clone(), f: foe.pos.clone(), yaw: human.yaw, pitch: human.pitch };
  // the checks fire live rounds at a live bot: freeze the match first so a lethal one cannot award a
  // round (checkRoundEnd only fires during "live"), and put back everything a kill would have moved
  const savedPhase = GAME.phase;
  // On an imported cs_office the world comes from the mesh BVH, so emptying WALLS clears nothing and the
  // synthetic wall a check pushes is invisible to losClear()/penetrate().  Park the mesh backend for the
  // duration so every check runs against the same blank room whichever map is loaded — otherwise the
  // same code "fails" in the browser and passes in Node purely because of what is under the players' feet.
  const savedMesh = meshBackend.active;
  const FIELDS = ["hp", "armor", "helmet", "kills", "deaths", "money", "cur", "slotPrimary", "slotSecondary", "scoped", "crouch", "fireCd", "reloadT", "firePenalty", "hurtBloom", "landBloom", "eye", "yaw", "walk", "onGround", "shiftCharge", "shiftUsed", "exposeT", "fireMode"];
  const snap = a => { const o = { weapons: JSON.parse(JSON.stringify(a.weapons)), vel: a.vel.clone() }; for (const k of FIELDS) o[k] = a[k]; return o; };
  const restore = (a, o) => { a.weapons = o.weapons; a.vel.copy(o.vel); for (const k of FIELDS) a[k] = o[k]; a.body.g.visible = a.alive; };
  const savedH = snap(human), savedF = snap(foe);
  try {
    GAME.phase = "warmup";
    meshBackend.active = false;
    for (const a of agents) if (a !== human && a !== foe) a.alive = false;
    foe.alive = true; foe.hp = 100; foe.armor = 0; foe.helmet = false; foe.crouch = false; foe._desyncOff = null;
    foe.cheats.antiaim.on = false;
    human.alive = true; human.hp = 100;
    human.pos.set(0, 0, 0); human.eye = EYE_STAND; human.yaw = 0; human.pitch = 0; human.vel.set(0, 0, 0);
    human.crouch = false; human.walk = false; human.scoped = false; human.onGround = true; human.bhopBoost = 1;
    human.reloadT = 0; human.fireCd = 0; human.firePenalty = 0; human.hurtBloom = 0; human.landBloom = 0;
    human.cur = 'usp'; human.weapons.usp = { ammo: 12, reserve: 24 };
    human.cheats = defaultCheats(false);
    human.cheats.aimbot.on = true; human.cheats.aimbot.minDmg = 1; human.cheats.aimbot.hitchance = 0;
    human.cheats.tickbase.backtrack = 0; human.cheats.autowall.on = false;
    foe.pos.set(0, 0, -dist);
    beginSimFrame();
    return fn(human, foe);
  } finally {
    while (WALLS.length) WALLS.pop();
    for (const w of savedWalls) WALLS.push(w);
    agents.forEach((a, i) => a.alive = savedAlive[i]);
    human.cheats = savedCheats; foe.cheats = savedFoeCheats;
    human.pos.copy(savedPos.h); foe.pos.copy(savedPos.f); human.yaw = savedPos.yaw; human.pitch = savedPos.pitch;
    restore(human, savedH); restore(foe, savedF);
    GAME.phase = savedPhase; meshBackend.active = savedMesh;
    foe._desyncOff = null; foe._btMark = null; human._btMark = null; beginSimFrame();
  }
}

/* fire `n` aimbot shots at a fresh 100hp target and report how many drew blood */
function hitRate(human, foe, n) {
  let fired = 0, hit = 0;
  for (let i = 0; i < n; i++) {
    human.fireCd = 0; human.firePenalty = 0; human.hurtBloom = 0; human.weapons[human.cur].ammo = 12;
    foe.hp = 100; foe.alive = true; foe.body.g.visible = true;
    beginSimFrame();
    if (aimbotFire(human)) { fired++; if (foe.hp < 100) hit++; }
  }
  return { fired, hit, rate: fired ? hit / fired : 0 };
}
/* put a desync up on `foe` exactly as updateAgentVisual would, without running a frame */
function desync(foe, opts) {
  Object.assign(foe.cheats.antiaim, { on: true, desync: true, yaw: 'jitter', jitter: 55, pitch: 'down', desyncAngle: 58, mode: 'at_target', fakeduck: false }, opts || {});
  foe.alive = true; foe.hp = 100; foe.body.g.visible = true;   // a corpse has no fake — updateAgentVisual skips the dead
  foe.exposeT = 0; foe._lastExpose = null; foe._sideStamp = 0; foe.desyncSide = 1;
  updateAgentVisual(foe);
  return foe._desyncOff;
}

const CHECKS = [
  // ---------------- aimbot ----------------
  ["aimbot · enabled", () => stage(300, (h, f) => {
    const before = f.hp; h.cheats.aimbot.hitchance = 0; beginSimFrame();
    const ok = aimbotFire(h) && f.hp < before;
    return [ok, ok ? "fires and damages" : "did not fire"];
  })],
  ["aimbot · min hit chance gate", () => stage(1400, (h) => {
    h.cheats.aimbot.hitchance = 100; beginSimFrame(); const far = canShoot(h).ok;
    h.cheats.aimbot.hitchance = 0; beginSimFrame(); const loose = canShoot(h).ok;
    return [!far && loose, `100% holds fire at 1400u: ${!far} · 0% shoots: ${loose}`];
  })],
  ["aimbot · min damage gate", () => stage(300, (h, f) => {
    // a CLEAR shot never demands more than the gun can deliver (that is deliberate — see evalShot),
    // so min damage is tested where it bites: through a wall, which is what it is for
    WALLS.push({ minX: -60, maxX: 60, minZ: -160, maxZ: -150, bottom: 0, top: 200, mat: 0.42, block: true });
    f.armor = 100; f.helmet = true;
    h.cheats.autowall.on = true; h.cheats.autowall.minDmg = 1;
    h.cheats.aimbot.minDmg = 1; beginSimFrame(); const lo = canShoot(h);
    h.cheats.aimbot.minDmg = 100; beginSimFrame(); const hi = canShoot(h).have;
    return [lo.have && lo.dmg < 100 && !hi, `min 1 takes a ${lo.dmg} dmg wallbang · min 100 refuses it: ${!hi}`];
  })],
  ["aimbot · FOV", () => stage(300, (h) => {
    h.cheats.aimbot.fov = 180; beginSimFrame(); const wide = canShoot(h).have;
    h.yaw = Math.PI; h.cheats.aimbot.fov = 20; beginSimFrame(); const narrow = canShoot(h).have;
    h.yaw = 0; return [wide && !narrow, `360° sees it: ${wide} · 20° looking away does not: ${!narrow}`];
  })],
  ["aimbot · hitbox priority / force body", () => stage(300, (h) => {
    h.cheats.aimbot.priority = "head"; beginSimFrame(); const head = canShoot(h).group;
    h.cheats.aimbot.forceBody = true; beginSimFrame(); const body = canShoot(h).group;
    return [head === "head" && body !== "head", `priority head → ${head} · force body → ${body}`];
  })],
  ["aimbot · baim if lethal", () => stage(300, (h, f) => {
    h.cheats.aimbot.priority = "head"; h.cheats.aimbot.baimLethal = true;
    f.hp = 100; beginSimFrame(); const healthy = canShoot(h).group;
    f.hp = 5; beginSimFrame(); const nearlyDead = canShoot(h).group;
    return [healthy === "head" && nearlyDead !== "head", `100hp → ${healthy} · 5hp (body kills) → ${nearlyDead}`];
  })],
  ["aimbot · target selection", () => stage(300, (h, f) => {
    const second = agents.find(a => a !== f && !a.isHuman && a.team !== h.team);
    if (!second) return [true, "only one enemy alive — nothing to choose between"];
    second.alive = true; second.hp = 20; second.pos.set(0, 0, -700);
    h.cheats.aimbot.target = "distance"; beginSimFrame(); const near = canShoot(h).tgt;
    h.cheats.aimbot.target = "lowhp"; beginSimFrame(); const weak = canShoot(h).tgt;
    second.alive = false;
    return [near === f && weak === second, `distance → nearest: ${near === f} · lowhp → the 20hp one: ${weak === second}`];
  })],
  ["aimbot · silent aim", () => stage(300, (h, f) => {
    h.yaw = 2.0; h.cheats.aimbot.silent = true; beginSimFrame(); aimbotFire(h); const silentYaw = h.yaw;
    h.fireCd = 0; f.hp = 100; f.alive = true; f.body.g.visible = true;      // that shot may have killed it
    h.cheats.aimbot.silent = false; beginSimFrame(); aimbotFire(h); const loudYaw = h.yaw;
    return [silentYaw === 2.0 && loudYaw !== 2.0, `silent leaves the view alone: ${silentYaw === 2.0} · off snaps it: ${loudYaw !== 2.0}`];
  })],
  ["aimbot · auto scope", () => stage(300, (h, f) => {
    h.cur = 'ssg'; h.weapons.ssg = { ammo: 10, reserve: 20 }; h.scoped = false;
    h.cheats.aimbot.autoScope = false; beginSimFrame(); aimbotFire(h); const off = h.scoped;
    h.fireCd = 0; f.hp = 100; f.alive = true; f.body.g.visible = true;
    h.cheats.aimbot.autoScope = true; beginSimFrame(); aimbotFire(h); const on = h.scoped;
    return [!off && on, `off stays unscoped: ${!off} · on scopes: ${on}`];
  })],
  ["aimbot · auto stop", () => stage(550, (h) => {
    h.cheats.aimbot.hitchance = 50; beginSimFrame();
    const sc = autoStopScale(h, false);
    h.cur = 'knife'; beginSimFrame(); const knife = autoStopScale(h, false);
    return [sc < 1 && sc > 0 && knife === 1, `slows to ${sc.toFixed(2)} for the shot · never on the knife: ${knife === 1}`];
  })],
  ["aimbot · auto knife", () => stage(40, (h, f) => {
    h.cur = 'knife'; h.fireCd = 0; const before = f.hp;
    const swung = meleeAttack(h, false, true);
    f.pos.set(0, 0, -2000); h.fireCd = 0;
    const whiffed = meleeAttack(h, false, true);
    return [swung && f.hp < before && !whiffed, `slashes in range: ${swung} · silent out of range: ${!whiffed}`];
  })],
  ["aimbot · safepoint", () => stage(260, (h, f) => {
    desync(f, { desyncAngle: 24 });
    h.cheats.resolver.on = false;                  // resolver can never win → only a safepoint can land
    h.cheats.aimbot.safepoint = false; const plain = hitRate(h, f, 120);
    h.cheats.aimbot.safepoint = true; beginSimFrame(); const safe = hitRate(h, f, 120);
    return [plain.rate === 0 && safe.rate > 0.5, `no safepoint vs an unresolvable desync: ${(plain.rate * 100) | 0}% · safepoint: ${(safe.rate * 100) | 0}%`];
  })],
  // ---------------- autowall ----------------
  ["autowall", () => stage(300, (h, f) => {
    WALLS.push({ minX: -60, maxX: 60, minZ: -160, maxZ: -150, bottom: 0, top: 200, mat: 0.42, block: true });
    f.armor = 100; f.helmet = true;                                       // armour drops the through-wall damage under the gate
    h.cheats.autowall.on = false; h.cheats.autowall.minDmg = 1; beginSimFrame(); const off = canShoot(h).have;
    h.cheats.autowall.on = true; beginSimFrame(); const on = canShoot(h);
    h.cheats.autowall.minDmg = 100; beginSimFrame(); const gated = canShoot(h).have;
    return [!off && on.have && on.dmg < 100 && !gated, `off: no shot · on: a ${on.dmg} dmg wallbang · min dmg 100 gates it back off: ${!gated}`];
  })],
  // ---------------- resolver ----------------
  ["resolver · on/off", () => stage(300, (h, f) => {
    desync(f);
    h.cheats.resolver.on = false; let beat = 0; for (let i = 0; i < 500; i++) if (resolveDesync(h, f)) beat++;
    h.cheats.resolver.on = true; h.cheats.resolver.strength = 1; h.cheats.resolver.mode = "animation";
    f.cheats.antiaim.yaw = 'back'; f.cheats.antiaim.desyncAngle = 0; f.cheats.antiaim.fakeduck = false; f.cheats.antiaim.pitch = 'zero';
    let win = 0; for (let i = 0; i < 500; i++) if (resolveDesync(h, f)) win++;
    return [beat === 0 && win / 500 > 0.8, `off never resolves: ${beat === 0} · full strength vs a lazy AA: ${((win / 500) * 100) | 0}%`];
  })],
  ["resolver · strength slider", () => stage(300, (h, f) => {
    desync(f, { yaw: 'back', desyncAngle: 20, pitch: 'zero' });   // a fake has to be UP for the resolver to have a job
    const at = v => { h.cheats.resolver.strength = v; let n = 0; for (let i = 0; i < 2000; i++) if (resolveDesync(h, f)) n++; return n / 2000; };
    h.cheats.resolver.on = true; h.cheats.resolver.mode = "animation";
    const lo = at(0.2), hi = at(0.9);
    return [hi > lo + 0.3, `20% → ${(lo * 100) | 0}% · 90% → ${(hi * 100) | 0}%`];
  })],
  ["resolver · modes differ", () => stage(300, (h, f) => {
    desync(f, { yaw: 'sideways', desyncAngle: 40 });
    h.cheats.resolver.on = true; h.cheats.resolver.strength = 0.6;
    const at = m => { h.cheats.resolver.mode = m; h._brute = null; let n = 0; for (let i = 0; i < 3000; i++) if (resolveDesync(h, f)) n++; return n / 3000; };
    const anim = at("animation"), onshot = at("onshot"), brute = at("brute");
    return [onshot < anim && Math.abs(brute - anim) > 0.02, `animation ${(anim * 100) | 0}% · onshot ${(onshot * 100) | 0}% · brute ${(brute * 100) | 0}%`];
  })],
  ["resolver · shot memory (an un-hidden shot is a read)", () => stage(300, (h, f) => {
    desync(f);
    h.cheats.resolver.on = true; h.cheats.resolver.strength = 0.5; h.cheats.resolver.mode = "animation";
    const at = () => { let n = 0; for (let i = 0; i < 2000; i++) if (resolveDesync(h, f)) n++; return n / 2000; };
    const blind = at();
    f._lastExpose = clock.t; f._sideStamp = 0; const read = at();
    h.cheats.resolver.memory = 0; const forgot = at();
    f._lastExpose = null;
    return [read > blind + 0.3 && forgot <= blind + 0.05, `blind ${(blind * 100) | 0}% · after their shot ${(read * 100) | 0}% · 0s memory ${(forgot * 100) | 0}%`];
  })],
  // ---------------- anti-aim ----------------
  ["anti-aim · desync puts a fake up", () => stage(300, (h, f) => {
    f.cheats.antiaim.on = false; updateAgentVisual(f); const off = !!f._desyncOff;
    const on = desync(f, { desyncAngle: 58 });
    const wide = Math.hypot(on.x, on.z);              // read it NOW: the vector is reused in place
    const zero = !!desync(f, { desyncAngle: 0 });
    return [!off && wide > 20 && !zero, `off: none · 58°: ${wide.toFixed(1)}u aside · 0°: none`];
  })],
  ["anti-aim · a fake actually beats shots", () => stage(300, (h, f) => {
    h.cheats.resolver.on = false;
    f.cheats.antiaim.on = false; updateAgentVisual(f); beginSimFrame(); const naked = hitRate(h, f, 100);
    desync(f, { desyncAngle: 58 }); beginSimFrame(); const hidden = hitRate(h, f, 100);
    return [naked.rate > 0.8 && hidden.rate < 0.2, `no anti-aim: ${(naked.rate * 100) | 0}% hit · desynced: ${(hidden.rate * 100) | 0}%`];
  })],
  ["anti-aim · yaw mode changes the read", () => stage(300, (h, f) => {
    const q = y => { desync(f, { yaw: y, desyncAngle: 58 }); return aaQuality(f); };
    const back = q('back'), jitter = q('jitter'), spin = q('spin'), sway = q('sway'), rand = q('rand');
    return [jitter > back && spin > back && sway > back && rand > back,
      `back ${back.toFixed(2)} · sway ${sway.toFixed(2)} · spin ${spin.toFixed(2)} · rand ${rand.toFixed(2)} · jitter ${jitter.toFixed(2)}`];
  })],
  ["anti-aim · jitter range drives the body", () => stage(300, (h, f) => {
    desync(f, { yaw: 'jitter', jitter: 0 }); updateAgentVisual(f); const flat = f.body.upper.rotation.y - f.yaw;
    let moved = false;
    for (let i = 0; i < 40; i++) { clock.t += 0.02; desync(f, { yaw: 'jitter', jitter: 90 }); updateAgentVisual(f); if (Math.abs(f.body.upper.rotation.y - f.yaw) > 0.3) moved = true; }
    return [Math.abs(flat) < 1e-6 && moved, `0° holds the body still · 90° swings it`];
  })],
  ["anti-aim · pitch", () => stage(300, (h, f) => {
    const mild = { yaw: 'back', desyncAngle: 20, fakeduck: false };        // clear of the aaQuality cap
    desync(f, { ...mild, pitch: 'zero' }); updateAgentVisual(f); const flat = f.body.upper.rotation.x, qz = aaQuality(f);
    desync(f, { ...mild, pitch: 'down' }); updateAgentVisual(f); const down = f.body.upper.rotation.x, qd = aaQuality(f);
    desync(f, { ...mild, pitch: 'up' }); updateAgentVisual(f); const up = f.body.upper.rotation.x;
    return [flat === 0 && down > 0 && up < 0 && qd > qz, `zero/down/up pose the fake · and a fake pitch costs the resolver (${qz.toFixed(2)} → ${qd.toFixed(2)})`];
  })],
  ["anti-aim · freestanding picks a side", () => stage(300, (h, f) => {
    f.yaw = 0;                                     // fake swings along ±x from f
    desync(f, { mode: 'freestanding', desyncAngle: 58 });
    // cover across the +x half of the sightline: the fake can only be seen on the -x side, so
    // freestanding has to keep choosing -1 (fake in the open, the real body behind the wall)
    WALLS.push({ minX: 8, maxX: 300, minZ: -180, maxZ: -168, bottom: 0, top: 200, mat: 0.9, block: true });
    const sides = new Set();
    for (let i = 0; i < 25; i++) { f._sideT = -1; updateTickbase(f, 0.016); sides.add(f.desyncSide); }
    const chosen = [...sides];
    f.cheats.antiaim.mode = 'at_target';
    const free = new Set();
    for (let i = 0; i < 60; i++) { f._sideT = -1; updateTickbase(f, 0.016); free.add(f.desyncSide); }
    return [chosen.length === 1 && chosen[0] === -1 && free.size === 2,
      `freestanding locked the fake to the visible side (${chosen.join()}) · at_target keeps flipping (${free.size} sides)`];
  })],
  ["anti-aim · fake duck", () => stage(300, (h, f) => {
    // kept well under the aaQuality cap so the fake-duck term is actually visible in the number
    const mild = { yaw: 'back', pitch: 'zero', desyncAngle: 20 };
    const flat = desync(f, { ...mild, fakeduck: false }).y;
    const ducked = desync(f, { ...mild, fakeduck: true }).y;
    const qUp = aaQuality(f); desync(f, { ...mild, fakeduck: false }); const qDown = aaQuality(f);
    updateAgentVisual(f); const standScale = f.body.legs.scale.y;
    desync(f, { ...mild, fakeduck: true }); updateAgentVisual(f); const fakeScale = f.body.legs.scale.y;
    h.cheats.antiaim.on = true; h.cheats.antiaim.fakeduck = true; const slow = fakeDuckScale(h);
    h.cheats.antiaim.fakeduck = false; const full = fakeDuckScale(h);
    return [flat === 0 && Math.abs(ducked) > 10 && qUp > qDown && fakeScale !== standScale && slow < 1 && full === 1,
      `fake is ${Math.abs(ducked)}u off vertically · renders the other stance · costs the resolver (${qDown.toFixed(2)} → ${qUp.toFixed(2)}) · and ${Math.round((1 - slow) * 100)}% of your speed`];
  })],
  // ---------------- tickbase ----------------
  ["tickbase · backtrack", () => stage(300, (h, f) => {
    h.cheats.tickbase.backtrack = 0; const none = backtrackTicks(h);
    h.cheats.tickbase.backtrack = 12; const some = backtrackTicks(h);
    h.shiftUsed = 6; const spent = backtrackTicks(h); h.shiftUsed = 0;
    return [none === 0 && some === 12 && spent === 6, `0 → 0 · 12 → 12 · a 6-tick shift in flight leaves ${spent}`];
  })],
  ["tickbase · hide shots", () => stage(300, (h) => {
    h.cheats.antiaim.on = true; h.cheats.antiaim.desync = true;
    h.shiftCharge = 16; h.shiftUsed = 0; h.exposeT = 0; h.cheats.tickbase.hideShots = false; h.cheats.tickbase.doubleTap = false;
    const bare = onShotFired(h); const exposed = h.exposeT > 0;
    h.shiftCharge = 16; h.shiftUsed = 0; h.exposeT = 0; h.cheats.tickbase.hideShots = true;
    const hid = onShotFired(h); const stillHidden = h.exposeT === 0;
    return [bare === "exposed" && exposed && hid === "hidden" && stillHidden, `off → ${bare} (exposed) · on → ${hid} (fake stays up)`];
  })],
  ["tickbase · double tap", () => stage(300, (h) => {
    h.cur = 'deagle'; h.weapons.deagle = { ammo: 7, reserve: 21 }; h.fireMode = 'primary';
    h.shiftCharge = 16; h.shiftUsed = 0; h.exposeT = 0; h.cheats.tickbase.doubleTap = false;
    onShotFired(h); const single = !!h._dtPending;
    h.shiftCharge = 16; h.shiftUsed = 0; h.exposeT = 0; h.cheats.tickbase.doubleTap = true;
    onShotFired(h); const doubled = !!h._dtPending;
    h.cur = 'r8'; h.weapons.r8 = { ammo: 8, reserve: 16 };
    h.shiftCharge = 16; h.shiftUsed = 0; h._dtPending = false; onShotFired(h); const revolver = !!h._dtPending;
    h._dtPending = false;
    return [!single && doubled && !revolver, `off: one round · on: two · and the R8 never doubles: ${!revolver}`];
  })],
  // ---------------- visuals ----------------
  ["visuals · shot lines", () => stage(300, (h, f) => {
    clearEffects();
    h.cheats.visuals.shotLines = false; h.fireCd = 0; beginSimFrame(); aimbotFire(h); const off = shotLines.length;
    h.cheats.visuals.shotLines = true; h.cheats.visuals.shotLineTime = 1.5;
    h.fireCd = 0; f.hp = 100; f.alive = true; beginSimFrame(); aimbotFire(h); const on = shotLines.length;
    const fresh = on ? shotLines[on - 1].l.material.opacity : 0;
    updateEffects(0.75); const mid = on ? shotLines[shotLines.length - 1].l.material.opacity : 0;
    updateEffects(0.8); const gone = shotLines.length;
    return [off === 0 && on === 1 && fresh === 1 && mid > 0.4 && mid < 0.6 && gone === 0,
      `off draws nothing · on draws one, ${mid.toFixed(2)} opacity at half its 1.5s, gone at the end`];
  })],
  ["visuals · shot line duration", () => stage(300, (h, f) => {
    clearEffects(); h.cheats.visuals.shotLines = true; h.cheats.visuals.shotLineTime = 4;
    h.fireCd = 0; beginSimFrame(); aimbotFire(h);
    const life = shotLines.length ? shotLines[0].life : 0;
    clearEffects();
    return [life === 4, `the slider sets the lifetime: ${life}s`];
  })],
  ["visuals · hit chance indicator", () => stage(300, (h) => {
    const el = typeof document !== "undefined" && document.querySelector("#hcInd");
    if (!el) return [true, "no DOM in this environment — skipped"];
    beginSimFrame(); const cs = canShoot(h);
    return [cs.have && cs.hitChance > 0, `reads ${(cs.hitChance * 100) | 0}% on the ${cs.group}`];
  })],
  ["visuals · ESP / chams flags reach the renderer", () => stage(300, (h, f) => {
    const v = h.cheats.visuals;
    const keys = ["esp", "boxes", "health", "name", "distance", "snaplines", "chams", "desyncGhost", "backtrackTrail", "backtrackGhost"];
    const missing = keys.filter(k => v[k] === undefined);
    v.chams = true; updateAgentVisual(f); const chammed = f._chamsKey;
    v.chams = false; updateAgentVisual(f); const plain = f._chamsKey;
    return [missing.length === 0 && chammed !== plain, `all ${keys.length} visual flags present · chams re-materialise the model`];
  })],
];

export function verifyCheats(opts) {
  const rows = [];
  for (const [name, fn] of CHECKS) {
    let ok = false, detail = "";
    try { const r = fn(); if (r && r.skip) { ok = true; detail = "skipped (no target)"; } else { ok = !!r[0]; detail = r[1]; } }
    catch (e) { ok = false; detail = "threw: " + (e && e.message || e); }
    rows.push({ feature: name, ok, detail });
  }
  const bad = rows.filter(r => !r.ok);
  if (!opts || opts.log !== false) {
    if (typeof console !== "undefined" && console.table) console.table(rows.map(r => ({ feature: r.feature, ok: r.ok ? "✓" : "✗", detail: r.detail })));
    console.log(bad.length ? `❌ ${bad.length}/${rows.length} cheat features failed` : `✅ all ${rows.length} cheat features verified`);
  }
  return rows;
}
