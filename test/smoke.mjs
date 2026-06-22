/* Smoke test: load all game modules under a stubbed THREE + DOM, start a match,
   and fast-forward several rounds to ensure the wiring and logic don't throw.
   Run with:  node --import ./test/register.mjs ./test/smoke.mjs            */

function makeEl() {
  const el = {
    style: {}, dataset: {}, value: '', checked: false,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { if (f === undefined) f = !this._s.has(c); f ? this._s.add(c) : this._s.delete(c); return f; }, contains(c) { return this._s.has(c); } },
    width: 1280, height: 720, _children: [],
    appendChild(c) { this._children.push(c); return c; }, prepend(c) { this._children.unshift(c); return c; },
    remove() {}, removeChild() {}, insertBefore(c) { this._children.push(c); return c; },
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
  if (HVH.agents.length !== 10) { failures++; log('✗ expected 10 agents'); }

  // nav sanity on default map
  const blocked = HVH.checkNav();
  log('  nav edges blocked by walls:', blocked.length);

  let sawLive = false;
  for (let i = 0; i < 14; i++) {                 // ~14s of sim — crosses the 12s buy → live + combat
    HVH.fastForward(1);
    if (HVH.GAME.phase === 'live') sawLive = true;
    if (i % 4 === 3) log('  …', i + 1, 's  phase:', HVH.GAME.phase, 'round:', HVH.GAME.round, 'score', HVH.GAME.scoreCT, ':', HVH.GAME.scoreT);
  }
  log('✓ fast-forwarded ~14s — phase:', HVH.GAME.phase, 'round:', HVH.GAME.round, 'score:', HVH.GAME.scoreCT, ':', HVH.GAME.scoreT);
  if (!sawLive) { failures++; log('✗ never reached live phase'); }
  const deaths = HVH.agents.filter(a => !a.alive).length, kills = HVH.agents.reduce((s, a) => s + a.kills, 0);
  log('  combat happened — deaths:', deaths, 'total kills:', kills);

  // --- combat math checks ---
  const d1 = HVH.computeDamage('deagle', 'head', 100, false, false, 0);
  const d2 = HVH.computeDamage('deagle', 'chest', 100, true, false, 100);
  log('  deagle head(no armor):', d1.damage, ' chest(armor):', d2.damage);
  if (!(d1.damage > d2.damage)) { failures++; log('✗ headshot should beat armored chest'); }

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

  if (failures === 0) { log('\n✅ SMOKE TEST PASSED'); process.exit(0); }
  else { log('\n❌ SMOKE TEST FAILED with', failures, 'assertion failure(s)'); process.exit(1); }
} catch (e) {
  console.error('\n❌ SMOKE TEST THREW:\n', e && e.stack || e);
  process.exit(1);
}
