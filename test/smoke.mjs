/* Smoke test: load all game modules under a stubbed THREE + DOM, start a match,
   and fast-forward several rounds to ensure the wiring and logic don't throw.
   Run with:  node --import ./test/register.mjs ./test/smoke.mjs            */

function makeEl() {
  const el = {
    style: {}, dataset: {}, value: '', checked: false,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { if (f === undefined) f = !this._s.has(c); f ? this._s.add(c) : this._s.delete(c); return f; }, contains(c) { return this._s.has(c); } },
    width: 1280, height: 720, _children: [],
    appendChild(c) { if (c) c._parent = this; this._children.push(c); return c; }, prepend(c) { if (c) c._parent = this; this._children.unshift(c); return c; },
    remove() { const p = this._parent; if (p) { const i = p._children.indexOf(this); if (i >= 0) p._children.splice(i, 1); } },   // real removal so trim loops (kill feed/hit log) terminate
    removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); return c; },
    insertBefore(c) { if (c) c._parent = this; this._children.push(c); return c; },
    addEventListener() {}, removeEventListener() {}, requestPointerLock() {},
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    getContext() { return makeCtx(); }, getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 }; },
    setAttribute() {}, focus() {}, click() {},
    get children() { return this._children; }, get firstChild() { return this._children[0]; }, get lastChild() { return this._children[this._children.length - 1]; },
    set innerHTML(v) { this._children = []; }, get innerHTML() { return ''; },
    set textContent(v) {}, get textContent() { return ''; },
    set onclick(f) { this._onclick = f; }, get onclick() { return this._onclick; },
    set oninput(f) {}, set onchange(f) {}, set onmousedown(f) {}, set onwheel(f) {},
  };
  return el;
}
function makeCtx() {
  return new Proxy({}, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined)), set: () => true });
}

globalThis.innerWidth = 1280; globalThis.innerHeight = 720; globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.setTimeout = (() => { const r = () => 0; return r; })();
globalThis.clearTimeout = () => {};
globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };

const _els = {};
globalThis.document = {
  _cookie: '',
  getElementById(id) { return _els[id] || (_els[id] = makeEl()); },
  querySelector(s) { const id = s.replace(/^#/, ''); return _els[id] || (_els[id] = makeEl()); },
  querySelectorAll() { return []; },
  createElement() { return makeEl(); },
  createElementNS() { return makeEl(); },
  addEventListener() {}, exitPointerLock() {},
  body: makeEl(), pointerLockElement: null, hidden: false,
  get cookie() { return this._cookie; }, set cookie(v) { this._cookie = v; },
};
globalThis.window = globalThis;

let failures = 0;
const log = (...a) => console.log(...a);

try {
  const main = await import('../src/main.js');
  log('✓ all modules loaded');
  const HVH = globalThis.HVH;
  if (!HVH) throw new Error('window.HVH not exposed');

  // --- default map: start a match and simulate several rounds ---
  HVH.deploy();
  log('✓ deploy() ran — phase:', HVH.GAME.phase, 'agents:', HVH.agents.length);
  if (HVH.agents.length !== 24) { failures++; log('✗ expected 24 agents (12v12)'); }

  // nav sanity on default map
  const blocked = HVH.checkNav();
  log('  nav edges blocked by walls:', blocked.length);

  let sawLive = false;
  // 45s: the 5s freeze plus enough live time for a 12v12 to actually meet and trade. Bots hold fire
  // until their min hit chance is met now, so a 14s window lands before the first contact and proves
  // nothing about whether combat works.
  for (let i = 0; i < 45; i++) {
    HVH.fastForward(1);
    if (HVH.GAME.phase === 'live') sawLive = true;
    if (i % 10 === 9) log('  …', i + 1, 's  phase:', HVH.GAME.phase, 'round:', HVH.GAME.round, 'score', HVH.GAME.scoreCT, ':', HVH.GAME.scoreT);
  }
  log('✓ fast-forwarded ~45s — phase:', HVH.GAME.phase, 'round:', HVH.GAME.round, 'score:', HVH.GAME.scoreCT, ':', HVH.GAME.scoreT);
  if (!sawLive) { failures++; log('✗ never reached live phase'); }
  const kills = HVH.agents.reduce((s, a) => s + a.kills, 0);
  log('  combat happened — total kills:', kills);
  if (kills < 8) { failures++; log('✗ a 12v12 should have traded plenty of kills in 45s — bots are not shooting'); }
  if (HVH.GAME.round < 2) { failures++; log('✗ no round resolved in 45s — the match is stalling'); }

  // --- combat math checks ---
  const d1 = HVH.computeDamage('deagle', 'head', 100, false, false, 0);
  const d2 = HVH.computeDamage('deagle', 'chest', 100, true, false, 100);
  log('  deagle head(no armor):', d1.damage, ' chest(armor):', d2.damage);
  if (!(d1.damage > d2.damage)) { failures++; log('✗ headshot should beat armored chest'); }

  // --- tickbase: backtrack records, hide shots, exposure ---
  {
    const combat = await import('../src/combat.js');
    const data = await import('../src/data.js');
    const bot = HVH.agents.find(a => !a.isHuman && a.alive);
    if (bot) {
      if (!(bot.trail.length > 0)) { failures++; log('✗ agents should be recording backtrack ticks'); }
      if (bot.trail.length > data.MAX_BACKTRACK_TICKS) { failures++; log('✗ backtrack history exceeded the tick window'); }
      if (!(combat.backtrackTicks(bot) > 0)) { failures++; log('✗ bots should carry a backtrack config of their own'); }
      log('  backtrack: window', data.MAX_BACKTRACK_TICKS, 'ticks @', data.TICK_RATE, '=', Math.round(1000 / data.TICK_RATE * data.MAX_BACKTRACK_TICKS) + 'ms · sample bot holds', bot.trail.length, 'records');
      // --- which weapons can be double tapped falls out of cycle-vs-command-budget, not a hand-list ---
      const dtWant = { duals: 10, usp: 13, glock: 13, deagle: 15, scar: 16, g3: 16, r8: 0, ssg: 0, knife: 0 };
      for (const k in dtWant) {
        const got = data.dtTicks(k);
        if (got !== dtWant[k]) { failures++; log(`✗ dtTicks(${k}) = ${got}, expected ${dtWant[k]}`); }
      }
      if (data.dtTicks('r8', 'fan') !== 0) { failures++; log("✗ the R8 fan must not be double tappable either"); }
      if (!data.NO_DOUBLE_TAP.has('r8')) { failures++; log("✗ the revolver has to be on the double-tap exclusion list, not merely over budget"); }
      log('  double tap cost: duals 10 · usp/glock 13 · deagle 15 · scar/g3 16 ticks · r8 excluded · ssg over budget (bolt)');

      const reset = (hide, dt, wep) => { bot.cur = wep || 'deagle'; bot.fireMode = 'primary'; bot.weapons[bot.cur] = { ammo: 8, reserve: 8 };
        bot.cheats.antiaim.on = true; bot.cheats.antiaim.desync = true; bot.cheats.tickbase.hideShots = hide; bot.cheats.tickbase.doubleTap = dt;
        bot.exposeT = 0; bot.shiftUsed = 0; bot.shiftMode = null; bot._dtPending = false; bot.shiftCharge = data.SHIFT_MAX_TICKS; };

      reset(false, false);
      if (combat.onShotFired(bot) !== 'exposed' || !(bot.exposeT > 0)) { failures++; log('✗ an unhidden shot must expose the shooter'); }

      reset(true, false);
      if (combat.onShotFired(bot) !== 'hidden' || bot.exposeT !== 0 || bot.shiftCharge !== data.SHIFT_MAX_TICKS - data.HIDE_SHOT_COST) { failures++; log('✗ hide shots should suppress the exposure and spend shift ticks'); }

      reset(true, false); bot.shiftCharge = 1;
      if (combat.onShotFired(bot) !== 'exposed' || !(bot.exposeT > 0)) { failures++; log('✗ an empty shift bank must not be able to hide a shot'); }

      // --- the exclusion rule: one shift per shot, double tap outranks hide shots ---
      reset(true, true);                                   // BOTH enabled on a deagle (15 ticks)
      const mode = combat.onShotFired(bot);
      if (mode !== 'dt') { failures++; log(`✗ double tap must win when both are enabled (got ${mode})`); }
      if (!(bot.exposeT > 0)) { failures++; log('✗ a double-tapped shot cannot also be hidden — it must expose'); }
      if (bot.shiftCharge !== data.SHIFT_MAX_TICKS - 15 || bot.shiftUsed !== 15) { failures++; log('✗ double tap should spend the deagle cycle (15 ticks) and leave that shift in flight'); }
      if (!bot._dtPending) { failures++; log('✗ double tap should arm a second round'); }
      // a shift still in flight suppresses backtrack outright
      bot.cheats.tickbase.backtrack = data.MAX_BACKTRACK_TICKS;
      if (combat.backtrackTicks(bot) !== Math.max(0, data.MAX_BACKTRACK_TICKS - 15)) { failures++; log('✗ an in-flight tickbase shift must eat the backtrack window'); }
      // ...and no second exploit until it lands
      if (combat.onShotFired(bot) !== 'exposed') { failures++; log('✗ no second tick exploit while a shift is still in flight'); }
      // the second round is real ammo
      reset(false, true); combat.onShotFired(bot);
      const ammoBefore = bot.weapons[bot.cur].ammo;
      let fired2 = 0;
      if (!combat.fireDoubleTap(bot, () => fired2++)) { failures++; log('✗ fireDoubleTap should fire the armed second round'); }
      if (fired2 !== 1 || bot.weapons[bot.cur].ammo !== ammoBefore - 1) { failures++; log('✗ the second round should cost a bullet and resolve once'); }
      if (combat.fireDoubleTap(bot, () => fired2++)) { failures++; log('✗ double tap must not repeat without a fresh shift'); }
      // a bolt-action can never double tap however full the bank is
      reset(false, true, 'ssg');
      if (combat.onShotFired(bot) !== 'exposed' || bot._dtPending) { failures++; log('✗ the SSG bolt cycle is over budget — it must not double tap'); }
      // ...and neither can the revolver, whatever the bank holds: its hammer cock is not a next-attack check
      for (const mode of ['primary', 'fan']) {
        reset(false, true, 'r8'); bot.fireMode = mode;
        if (combat.onShotFired(bot) !== 'exposed' || bot._dtPending) { failures++; log(`✗ the R8 (${mode}) must not double tap`); }
        if (bot.shiftCharge !== data.SHIFT_MAX_TICKS) { failures++; log('✗ a weapon that cannot double tap must not spend shift ticks trying'); }
        let fired = 0; combat.fireDoubleTap(bot, () => fired++);
        if (fired !== 0) { failures++; log('✗ the R8 fired a second round'); }
      }
      bot.fireMode = 'primary';
      bot.cheats.tickbase.doubleTap = false; bot.cheats.tickbase.hideShots = false; bot.shiftUsed = 0;
    }
  }

  // --- armour rebuy pricing (CS2 rules) ---
  {
    const game = await import('../src/game.js');
    const cases = [
      [{ armor: 0, helmet: false }, 'kevhelm', 1000], [{ armor: 100, helmet: true }, 'kevhelm', null],
      [{ armor: 40, helmet: true }, 'kevhelm', 650], [{ armor: 100, helmet: false }, 'kevhelm', 350],
      [{ armor: 100, helmet: true }, 'kevlar', null], [{ armor: 0, helmet: false }, 'kevlar', 650],
    ];
    for (const [who, key, want] of cases) {
      const deal = game.armorBuy(who, key), got = deal ? deal.cost : null;
      if (got !== want) { failures++; log(`✗ armorBuy(${JSON.stringify(who)}, ${key}) = ${got}, expected ${want}`); }
    }
    log('  armour rebuy priced the CS2 way (full kit unbuyable, helmet kept → $650, vest full → $350)');
  }

  // --- auto-stop sheds only as much speed as the hit chance needs ---
  {
    const combat = await import('../src/combat.js');
    const human = HVH.human, world = await import('../src/world.js');
    const saved = world.WALLS.splice(0, world.WALLS.length);
    const foe = HVH.agents.find(a => !a.isHuman && a.team !== human.team);
    const aliveSaved = HVH.agents.map(a => a.alive);
    for (const a of HVH.agents) if (a !== human && a !== foe) a.alive = false;
    foe.alive = true; foe.crouch = false; foe.armor = 0; foe.helmet = false;
    human.cheats.aimbot.on = true; human.cheats.aimbot.autoStop = true; human.cheats.aimbot.hitchance = 50;
    human.cheats.aimbot.minDmg = 1; human.cheats.autowall.on = false; human.cheats.tickbase.backtrack = 0;
    human.cur = 'usp'; human.weapons.usp = { ammo: 12, reserve: 24 };
    human.reloadT = 0; human.firePenalty = 0; human.hurtBloom = 0; human.landBloom = 0;
    human.crouch = false; human.scoped = false; human.onGround = true; human.walk = false; human.bhopBoost = 1;
    human.pos.set(0, 0, 0); human.eye = 64; human.yaw = 0; human.pitch = 0; human.vel.set(0, 0, 0);
    const seen = [];
    for (const dist of [100, 400, 550]) {
      foe.pos.set(0, 0, -dist); human.vel.set(0, 0, 0);
      combat.beginSimFrame(); seen.push(+combat.autoStopScale(human, false).toFixed(2));
    }
    log('  auto-stop speed scale at 100u/400u/550u:', JSON.stringify(seen));
    if (seen[0] !== 1) { failures++; log('✗ auto-stop should not slow a point-blank shot at all'); }
    if (!seen.some(v => v > 0 && v < 1)) { failures++; log('✗ auto-stop should slow proportionally, not hard-stop'); }
    // Past the range the hit chance is reachable at all it must PLANT, not quietly hand back full speed:
    // returning 1 there switched auto-stop off in exactly the situations you turned it on for.
    human.cheats.aimbot.hitchance = 99; foe.pos.set(0, 0, -1600); human.vel.set(0, 0, 0); combat.beginSimFrame();
    if (combat.autoStopScale(human, false) !== 0) { failures++; log('✗ an unreachable hit chance should plant the player, not return full speed'); }
    if (combat.autoStopScale(human, false, true) !== 1) { failures++; log('✗ keepClosing should let a bot close the gap instead of rooting on an impossible shot'); }
    human.cheats.aimbot.hitchance = 50;
    human.cur = 'knife';
    combat.beginSimFrame();
    if (combat.autoStopScale(human, false) !== 1) { failures++; log('✗ auto-stop must never engage on the knife'); }
    while (world.WALLS.length) world.WALLS.pop();
    for (const w of saved) world.WALLS.push(w);
    HVH.agents.forEach((a, i) => a.alive = aliveSaved[i]);
  }

  // --- hit chance IS the shot: the estimate and the bullet sample the same cone ---
  {
    const combat = await import('../src/combat.js');
    const agentsMod = await import('../src/agents.js');
    const human = HVH.human, world = await import('../src/world.js');
    const saved = world.WALLS.splice(0, world.WALLS.length);          // open ground: exposure is 1, only spread is in play
    const foe = HVH.agents.find(a => !a.isHuman && a.team !== human.team);
    const aliveSaved = HVH.agents.map(a => a.alive);
    for (const a of HVH.agents) if (a !== human && a !== foe) a.alive = false;
    foe.alive = true; foe.crouch = false; foe.armor = 0; foe.helmet = false; foe.hp = 100;
    foe.cheats.antiaim.on = false; foe._desyncOff = null;             // no desync — inaccuracy is the only thing that can miss
    human.cheats.aimbot.on = true; human.cheats.aimbot.autoStop = false; human.cheats.aimbot.silent = true;
    human.cheats.aimbot.priority = 'head'; human.cheats.aimbot.forceBody = false; human.cheats.aimbot.baimLethal = false;
    human.cheats.aimbot.minDmg = 1; human.cheats.autowall.on = false; human.cheats.tickbase.backtrack = 0;
    human.cheats.tickbase.doubleTap = false; human.cheats.tickbase.hideShots = false;
    human.cur = 'usp'; human.weapons.usp = { ammo: 12, reserve: 24 };
    human.reloadT = 0; human.firePenalty = 0; human.hurtBloom = 0; human.landBloom = 0;
    human.crouch = false; human.scoped = false; human.onGround = true; human.walk = false; human.bhopBoost = 1;
    human.pos.set(0, 0, 0); human.eye = 64; human.yaw = 0; human.pitch = 0; human.vel.set(0, 0, 0);

    // 1. the estimator predicts the sampler. Both walk the same CS spread distribution, so a big
    //    Monte-Carlo run of real bullets has to land on the number the menu gates on.
    foe.pos.set(0, 0, -420); combat.beginSimFrame();
    const from = agentsMod.eyePos(human), aim = agentsMod.hitboxCenter(foe, 'head');
    const dir = aim.clone().sub(from).normalize(), cone = combat.computeBloom(human);
    const predicted = combat.computeAccuracy(human, aim, foe, 'head', 1);
    let land = 0; const N = 20000;
    for (let i = 0; i < N; i++) {
      const d = combat.coneRay(dir, cone, Math.random(), Math.random() * Math.PI * 2);
      const h = combat.traceHitbox(from, d, foe);
      if (h && h.group === 'head') land++;
    }
    const measured = land / N;
    log('  hit chance at 420u on the head: predicted', (predicted * 100).toFixed(1) + '%', '· measured over', N, 'bullets', (measured * 100).toFixed(1) + '%');
    if (Math.abs(predicted - measured) > 0.05) { failures++; log('✗ the hit chance the aimbot gates on is not the hit chance the bullet has'); }
    if (!(predicted > 0.02 && predicted < 0.98)) { failures++; log('✗ this range was meant to be a genuinely uncertain shot — the test proves nothing'); }

    // 2. 100% has to MEAN 100%: it only fires when the whole cone is inside the hitbox, and then it hits.
    human.cheats.aimbot.hitchance = 100;
    foe.pos.set(0, 0, -900); combat.beginSimFrame();
    if (combat.canShoot(human).ok) { failures++; log('✗ a 900u pistol headshot is not a certainty — 100% hit chance must hold fire'); }
    foe.pos.set(0, 0, -120); combat.beginSimFrame();
    if (!combat.canShoot(human).ok) { failures++; log('✗ a point-blank standing headshot IS a certainty — 100% hit chance should take it'); }
    let fired = 0, missed = 0;
    for (let i = 0; i < 250; i++) {
      human.fireCd = 0; human.firePenalty = 0; human.hurtBloom = 0; human.weapons.usp.ammo = 12; foe.hp = 100; foe.alive = true;
      combat.beginSimFrame();
      const before = foe.hp;
      if (combat.aimbotFire(human)) { fired++; if (foe.hp >= before) missed++; }
    }
    log('  100% hit chance:', fired, 'shots fired,', missed, 'missed');
    if (fired !== 250) { failures++; log('✗ every one of those shots qualified — the gate should have fired all of them'); }
    if (missed !== 0) { failures++; log('✗ a 100% hit chance shot missed: the bullet is being rolled against a cone the gate never approved'); }

    // 3. ...and the fire penalty still lands on the NEXT shot, not this one (that is what used to break it)
    human.fireCd = 0; human.firePenalty = 0; human.weapons.usp.ammo = 12; foe.hp = 100; foe.alive = true; combat.beginSimFrame();
    combat.aimbotFire(human);
    if (!(human.firePenalty > 0)) { failures++; log('✗ firing should still cost bloom — for the shot after it'); }

    human.cheats.aimbot.hitchance = 50;
    while (world.WALLS.length) world.WALLS.pop();
    for (const w of saved) world.WALLS.push(w);
    HVH.agents.forEach((a, i) => a.alive = aliveSaved[i]);
  }

  // --- the resolver has to earn its read; anti-aim is what takes it away ---
  {
    const combat = await import('../src/combat.js');
    const { clock } = await import('../src/state.js');
    const human = HVH.human;
    const foe = HVH.agents.find(a => !a.isHuman && a.team !== human.team);
    const savedRes = JSON.parse(JSON.stringify(human.cheats.resolver)), savedAA = JSON.parse(JSON.stringify(foe.cheats.antiaim));
    human.cheats.resolver = { on: true, mode: 'animation', strength: 0.6, memory: 0.55 };
    foe.cheats.antiaim = { on: true, yaw: 'back', jitter: 55, pitch: 'down', desync: true, desyncAngle: 8, mode: 'at_target', fakeduck: false };
    foe._desyncOff = { x: 12, y: 0, z: 0 };                     // a fake is up; only the resolver decides now
    foe._lastExpose = null; foe._sideStamp = 0;
    const rate = () => { let n = 0; for (let i = 0; i < 6000; i++) if (combat.resolveDesync(human, foe)) n++; return n / 6000; };
    const naked = rate();
    foe.cheats.antiaim.yaw = 'jitter'; foe.cheats.antiaim.desyncAngle = 58; foe.cheats.antiaim.fakeduck = true;
    const dressed = rate();
    foe._lastExpose = clock.t;                                   // ...but a shot fired without hiding it gives the read back
    const afterShot = rate();
    foe._lastExpose = null;
    human.cheats.resolver.on = false;
    const off = rate();
    log('  resolver vs desync — naked', (naked * 100) | 0, '%· full anti-aim', (dressed * 100) | 0, '%· right after their shot', (afterShot * 100) | 0, '%· resolver off', (off * 100) | 0, '%');
    if (!(naked > dressed + 0.1)) { failures++; log('✗ anti-aim should visibly cost the resolver — it barely did'); }
    if (!(dressed < 0.45)) { failures++; log('✗ a maxed anti-aim should beat the resolver more often than not'); }
    if (!(naked < 0.75)) { failures++; log('✗ the resolver is still doing too much work on its own'); }
    if (!(afterShot > 0.85)) { failures++; log('✗ an un-hidden shot pins the real angles — that read should be near-certain'); }
    if (off !== 0) { failures++; log('✗ resolver off must never beat a desync'); }
    if (combat.aaQuality(human) !== 0 && !human.cheats.antiaim.on) { failures++; log('✗ anti-aim that is switched off cannot be protecting anyone'); }
    human.cheats.resolver = savedRes; foe.cheats.antiaim = savedAA; foe._desyncOff = null;
  }

  // --- local shot lines fade over the configured duration and clean themselves up ---
  {
    const fx = await import('../src/effects.js');
    const THREE = await import('three');
    fx.clearEffects();                       // the 250 shots above left their own lines behind — start from nothing
    fx.addShotLine(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -100), 1.5, '#ff4d6d');
    if (fx.shotLines.length !== 1) { failures++; log('✗ addShotLine should add a line'); }
    fx.updateEffects(0.75);
    const half = fx.shotLines[0] && fx.shotLines[0].l.material.opacity;
    if (!(half > 0.4 && half < 0.6)) { failures++; log('✗ a shot line should be half faded at half its lifetime, got ' + half); }
    fx.updateEffects(0.8);
    if (fx.shotLines.length !== 0) { failures++; log('✗ a shot line should be gone once its duration is up'); }
    log('  shot lines: added, faded to', Number(half).toFixed(2), 'at 0.75s of 1.5s, removed at the end');
  }

  // --- every switch in the cheat menu, checked for an observable effect ---
  {
    const rows = HVH.verifyCheats({ log: false });
    for (const r of rows) log(`  ${r.ok ? '✓' : '✗'} ${r.feature} — ${r.detail}`);
    const bad = rows.filter(r => !r.ok);
    if (bad.length) { failures += bad.length; log(`✗ ${bad.length}/${rows.length} cheat features are not wired up`); }
    else log(`✓ all ${rows.length} cheat features verified end to end`);
  }

  // --- bots draw distinct roles and lanes rather than sharing one plan ---
  {
    const roles = {};
    for (const a of HVH.agents) roles[a.aiRole] = (roles[a.aiRole] || 0) + 1;
    const lanes = new Set(HVH.agents.map(a => a.aiLane));
    log('  bot roles:', JSON.stringify(roles), '· distinct lanes:', lanes.size);
    if (!(roles.push > 0 && roles.hold > 0 && roles.flank > 0)) { failures++; log('✗ every round should field pushers, holders and flankers'); }
    if (lanes.size < 8) { failures++; log('✗ bots should hold distinct lanes, not stack on one'); }
  }

  // penetration: thin wall reduces, absurdly thick wall blocks
  if (HVH.testPenetration) {
    const r = HVH.testPenetration();
    log('  penetration test:', JSON.stringify(r));
    if (!(r.thinFactor > 0 && r.thinFactor < 1)) { failures++; log('✗ thin wall should reduce (0<f<1)'); }
    if (r.thickBlocked !== true) { failures++; log('✗ very thick wall should block'); }
  }

  // --- custom map build + grid nav ---
  if (HVH.testCustomMap) {
    const res = HVH.testCustomMap();
    log('  custom map: walls=', res.walls, 'navNodes=', res.nodes, 'phase=', HVH.GAME.phase);
    if (!(res.nodes > 4)) { failures++; log('✗ grid nav should produce nodes'); }
    for (let i = 0; i < 8; i++) HVH.fastForward(1);   // buy phase — validates build + nav + no crash
    log('✓ custom map simulated ~8s — phase:', HVH.GAME.phase, 'round:', HVH.GAME.round);
  }

  // --- imported CS2 mesh map: build a tiny synthetic .glb, deploy, simulate ---
  if (HVH.deploySource) {
    const verts = [];
    const tri = (a, b, c) => verts.push(...a, ...b, ...c);
    const quad = (p0, p1, p2, p3) => { tri(p0, p1, p2); tri(p0, p2, p3); };
    const boxg = (x0, x1, y0, y1, z0, z1) => {
      const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
      quad(c[0], c[1], c[2], c[3]); quad(c[4], c[5], c[6], c[7]); quad(c[0], c[3], c[7], c[4]); quad(c[1], c[2], c[6], c[5]); quad(c[0], c[1], c[5], c[4]); quad(c[3], c[2], c[6], c[7]);
    };
    quad([-900, 0, -900], [900, 0, -900], [900, 0, 900], [-900, 0, 900]);   // floor
    boxg(-300, -286, 0, 200, -600, 600);   // a wall
    boxg(400, 700, 0, 120, -200, 200);     // a raised platform (top y=120)
    const f32 = new Float32Array(verts); const b64 = Buffer.from(f32.buffer).toString('base64');
    const gltf = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ bufferView: 0, componentType: 5126, count: f32.length / 3, type: "VEC3" }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: f32.byteLength }], buffers: [{ byteLength: f32.byteLength, uri: "data:base64," + b64 }] };
    const glb = new TextEncoder().encode(JSON.stringify(gltf)).buffer;
    const spawns = { name: 'synth', ctSpawns: [{ x: -700, y: 0, z: 0 }, { x: -700, y: 0, z: 100 }], tSpawns: [{ x: 550, y: 120, z: 0 }, { x: 700, y: 0, z: 400 }] };
    const info = HVH.deploySource(glb, spawns);
    log('  imported mesh map: tris=', info.triangles | 0, 'navNodes=', info.navNodes, 'phase=', HVH.GAME.phase);
    if (!(info.navNodes > 4)) { failures++; log('✗ mesh nav should produce nodes'); }
    // an agent spawned on the platform should sit at its height, not y=0
    const onPlat = HVH.agents.find(a => a.pos.x > 380 && a.pos.x < 720);
    if (onPlat) log('  platform spawn feet Y =', onPlat.pos.y.toFixed(1), '(expected ~120)');
    // ...and while it runs, watch how much time the bots spend in the air. The ledge hop used to fire
    // on EVERY frame a bot was wedged, which turned one bad angle into continuous bunny-hopping in a
    // corner; it is one hop per cooldown now, so airborne time has to stay low.
    const wasAir = new Map(); let jumps = 0, airFrames = 0, botFrames = 0;
    for (let i = 0; i < 14 * 60; i++) {
      HVH.fastForward(1 / 60);
      for (const a of HVH.agents) {
        if (a.isHuman || !a.alive) continue;
        botFrames++;
        if (!wasAir.get(a) && !a.onGround) jumps++;
        wasAir.set(a, !a.onGround);
        if (!a.onGround) airFrames++;
      }
    }
    const pctAir = botFrames ? 100 * airFrames / botFrames : 0, jps = botFrames ? jumps / (botFrames / 60) : 0;
    log('  bot hopping: airborne', pctAir.toFixed(1) + '% of the time ·', jps.toFixed(2), 'jumps per bot per second');
    if (pctAir > 20 || jps > 0.6) { failures++; log('✗ bots are hopping on the spot again — the ledge hop needs its cooldown'); }
    const fell = HVH.agents.filter(a => a.alive && a.pos.y < -50).length;
    log('✓ mesh map simulated ~14s — phase:', HVH.GAME.phase, 'agents below floor:', fell);
    if (fell > 0) { failures++; log('✗ agents fell through the mesh floor'); }
  }

  if (failures === 0) { log('\n✅ SMOKE TEST PASSED'); process.exit(0); }
  else { log('\n❌ SMOKE TEST FAILED with', failures, 'assertion failure(s)'); process.exit(1); }
} catch (e) {
  console.error('\n❌ SMOKE TEST THREW:\n', e && e.stack || e);
  process.exit(1);
}
