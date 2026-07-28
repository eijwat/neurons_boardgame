'use strict';
/* Parameter-space explorer with trustworthy chaos diagnostics.
 *
 *   node explore.js '<json spec>'      or      node explore.js spec.json
 *
 * spec = { base:{...}, grid:{ q:[...], R:[...] }, seeds:[1,2,3], out:"file.jsonl" }
 * grid keys are cartesian-producted over; anything not in grid comes from base.
 *
 * Classification of a parameter point:
 *   dead      - activity extinguishes
 *   ORDERED   - every single-node perturbation heals back to zero difference
 *   CHAOTIC   - perturbations grow and stay large (median damage > 0.5% of live nodes,
 *               and still >= half its peak at the end of the window)
 *   marginal  - in between
 *
 * The twin universe copies the FULL state (ph, sg, u, rlen).  Copying only ph/sg
 * compares two different systems and produces spurious "chaos".
 */
const fs = require('fs');
const E = require('./engine.js');

const DEF = {
  W: 120, H: 80, torus: true, p: 1, S: 0, dot: 1 / 6, cross: 1 / 6, q: 0.8,
  theta: 1, R: 6, g: 0, wI: 1, nu: 0, adaptA: 0, adaptTau: 30, RI: 0,
  seedMode: 'rand', frac: 0.01, edgeOnly: false,
  // circuit-level feedback (this variant): faces = the game's closed circuits
  faceA: 0,          // threshold shift on rim nodes of a circuit that just fired (>0 fatigue)
  faceAc: undefined, // corner gate; defaults to faceA
  faceDur: 40,       // how long a rim node stays marked
  faceRef: 10,       // a circuit cannot re-fire within this many steps
  faceWin: 6,        // recency window for "the rim was active"
  faceFrac: 1,       // fraction of rim nodes that must be recently active
  faceMode: 'all',   // 'all' | 'circ' (strict circulation around the rim)
  T: 1200,          // transient before measuring
  TD: 500,          // damage window
  nDamage: 3,       // perturbation trials, spaced through the attractor
  gap: 150,         // steps between trials
  periodWin: 4000,  // steps searched for an exact cycle
};

function buildAll(o) {
  const w = E.generateWiring({
    W: o.W, H: o.H, torus: o.torus, p: o.p, strategy: o.S,
    dotFrac: o.dot, crossFrac: o.cross, q: o.q, seed: o.seed, edgeOnly: o.edgeOnly,
  });
  const g = E.buildGraph(w);
  let mod = new Float32Array(w.N), fstats = { faces: 0 }, faceTopo = null;
  if (o.g !== 0 || o.faceA !== 0) {
    const f = E.enumerateFaces(w, g);
    fstats = { faces: f.length };
    if (o.g !== 0) { const ff = E.faceField(w, g, f); mod = ff.mod; fstats = ff.stats; }
    if (o.faceA !== 0) faceTopo = E.buildFaceTopo(w, f);
  }
  return { w, g, mod, fstats, faceTopo };
}

function newSim(w, g, mod, o, faceTopo) {
  return E.makeSim(w, g, mod, {
    theta: o.theta, R: o.R, g: o.g, wI: o.wI, nu: o.nu,
    rng: E.mulberry32(o.seed * 7919 + 13), adaptA: o.adaptA, adaptTau: o.adaptTau, RI: o.RI,
    faceTopo, faceA: o.faceA, faceAc: o.faceAc, faceDur: o.faceDur, faceRef: o.faceRef,
    faceWin: o.faceWin, faceFrac: o.faceFrac, faceMode: o.faceMode,
  });
}
function copyState(dst, src) { dst.copyFrom(src); }
function hashState(sim) { return sim.stateHash(); }

/* one perturbation trial; base keeps running and acts as the reference universe */
function damageTrial(base, w, g, mod, o, kind, offset, faceTopo) {
  const twin = newSim(w, g, mod, o, faceTopo);
  copyState(twin, base);
  const start = ((o.seed * 2654435761 + offset * 40503) >>> 0) % w.NC;
  let flipped = -1;
  for (let k = 0; k < w.NC && flipped < 0; k++) {
    const j = (start + k * 7919) % w.NC;
    if (!twin.live[j]) continue;
    if (kind === 'add') {
      if (twin.ph[j] !== 0) continue;
      let free = 0;
      for (let e = g.start[j]; e < g.start[j + 1]; e++) if (twin.ph[g.nbr[e]] === 0) free++;
      if (!free) continue;                       // a sterile injection proves nothing
      twin.ph[j] = 1; twin.sg[j] = twin.outSign[j]; flipped = j;
    } else {
      if (twin.ph[j] !== 1) continue;            // remove an excitation: punch a hole in a front
      twin.ph[j] = 0; flipped = j;
    }
  }
  if (flipped < 0) return null;
  const D = [];
  for (let t = 0; t < o.TD; t++) {
    base.step(); twin.step();
    let d = 0;
    for (let i = 0; i < w.N; i++) if (base.ph[i] !== twin.ph[i]) d++;
    D.push(d);
  }
  const dEnd = D[D.length - 1], dMax = D.reduce((a, b) => a > b ? a : b, 0);
  // exponential growth rate over the first quarter of the window
  const i1 = Math.max(1, (o.TD / 4) | 0);
  const lam = D[i1] > 0 && D[0] > 0 ? Math.log(D[i1] / D[0]) / i1 : 0;
  return { kind, dEnd, dMax, lam, dFrac: dEnd / base.nLive };
}

function evaluate(spec) {
  const o = Object.assign({}, DEF, spec);
  const { w, g, mod, fstats, faceTopo } = buildAll(o);
  const sim = newSim(w, g, mod, o, faceTopo);
  const rng = E.mulberry32(o.seed * 7919 + 13);
  if (o.seedMode === 'wave') E.seedBrokenWave(sim, w, o.R);
  else if (o.seedMode === 'point') {
    const cx = (o.W / 2) | 0, cy = (o.H / 2) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = (cx + dx) + (cy + dy) * o.W;
      if (sim.live[k]) { sim.ph[k] = 1; sim.sg[k] = sim.outSign[k]; }
    }
  } else E.seedRandom(sim, w, rng, o.frac);

  // transient + activity statistics + exact-cycle detection
  const A = []; const seen = new Map(); let period = 0;
  for (let t = 0; t < o.T; t++) {
    sim.step(); A.push(sim.activity());
    if (t > o.T * 0.4 && t < o.T * 0.4 + o.periodWin && !period) {
      const h = hashState(sim);
      if (seen.has(h)) period = t - seen.get(h); else seen.set(h, t);
    }
  }
  const alive = A[A.length - 1] > 0 || sim.anyAlive();
  const tail = A.slice(Math.floor(A.length * 0.7));
  const mean = tail.reduce((s, v) => s + v, 0) / Math.max(1, tail.length);
  const sd = Math.sqrt(tail.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, tail.length));
  let rest = 0, nl = 0;
  for (let i = 0; i < w.N; i++) if (sim.live[i]) { nl++; if (sim.ph[i] === 0) rest++; }

  const trials = [];
  if (alive) {
    for (let k = 0; k < o.nDamage; k++) {
      const tr = damageTrial(sim, w, g, mod, o, k % 2 === 0 ? 'add' : 'del', k, faceTopo);
      if (tr) trials.push(tr);
      for (let t = 0; t < o.gap; t++) sim.step();
    }
  }
  const fr = trials.map(t => t.dFrac).sort((a, b) => a - b);
  const med = fr.length ? fr[(fr.length / 2) | 0] : 0;
  const sustained = trials.length && trials.every(t => t.dEnd >= 0.5 * t.dMax);
  let cls;
  if (!alive) cls = 'dead';
  else if (!trials.length) cls = 'no-inject';
  else if (trials.every(t => t.dEnd === 0)) cls = 'ORDERED';
  else if (med > 0.005 && sustained) cls = 'CHAOTIC';
  else cls = 'marginal';

  return {
    params: o, cls, alive, A: mean, cv: mean > 0 ? sd / mean : 0,
    restFrac: nl ? rest / nl : 1, nLive: sim.nLive, faces: fstats.faces, period,
    trials, dFracMed: med, ffRate: sim.faceFires / Math.max(1, o.T), mark: sim.markedFrac(),
  };
}

/* ---------------- grid driver ---------------- */
function product(grid) {
  const keys = Object.keys(grid);
  let out = [{}];
  for (const k of keys) {
    const next = [];
    for (const o of out) for (const v of grid[k]) next.push(Object.assign({}, o, { [k]: v }));
    out = next;
  }
  return out;
}

function runSpec(spec) {
  const base = spec.base || {};
  const combos = product(spec.grid || {});
  const seeds = spec.seeds || [1, 2, 3];
  const rows = [];
  for (const c of combos) {
    const per = [];
    for (const sd of seeds) per.push(evaluate(Object.assign({}, base, c, { seed: sd })));
    const nCha = per.filter(r => r.cls === 'CHAOTIC').length;
    const nAlive = per.filter(r => r.alive).length;
    const avg = (f) => per.reduce((s, r) => s + f(r), 0) / per.length;
    rows.push({
      combo: c, nSeeds: seeds.length, nAlive, nChaotic: nCha,
      A: avg(r => r.A), cv: avg(r => r.cv), restFrac: avg(r => r.restFrac),
      dFracMed: avg(r => r.dFracMed), lam: avg(r => r.trials.length ? r.trials[0].lam : 0),
      ffRate: avg(r => r.ffRate), mark: avg(r => r.mark), faces: avg(r => r.faces),
      period: per.map(r => r.period), cls: per.map(r => r.cls),
      verdict: nCha >= Math.ceil(seeds.length / 2) ? 'CHAOTIC'
        : nCha > 0 ? 'chaotic-sometimes'
          : nAlive === 0 ? 'dead'
            : per.every(r => r.cls === 'ORDERED') ? 'ORDERED' : 'marginal',
    });
  }
  return rows;
}

function fmt(rows, gridKeys) {
  const head = gridKeys.map(k => k.padStart(7)).join('') +
    '  alive  chaos |   A_tail   CV   rest%   dmg%    lam   period   ffR  mark%  verdict';
  const lines = [head];
  for (const r of rows) {
    lines.push(
      gridKeys.map(k => String(typeof r.combo[k] === 'number' ? +r.combo[k].toFixed(3) : r.combo[k]).padStart(7)).join('') +
      `  ${String(r.nAlive)}/${r.nSeeds}    ${String(r.nChaotic)}/${r.nSeeds} |` +
      ` ${r.A.toFixed(0).padStart(8)} ${r.cv.toFixed(3)} ${(r.restFrac * 100).toFixed(1).padStart(6)}` +
      ` ${(r.dFracMed * 100).toFixed(2).padStart(6)} ${r.lam.toFixed(4).padStart(7)}` +
      ` ${String(r.period[0] || 0).padStart(7)} ${r.ffRate.toFixed(1).padStart(5)} ${(r.mark * 100).toFixed(1).padStart(5)}  ${r.verdict.padEnd(18)} ${r.cls.map(c => c[0] + (c === 'CHAOTIC' ? '!' : '')).join('')} p:${r.period.join(',')}`);
  }
  return lines.join('\n');
}

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: node explore.js \'<json>\' | spec.json'); process.exit(2); }
  const spec = arg.trim().startsWith('{') ? JSON.parse(arg) : JSON.parse(fs.readFileSync(arg, 'utf8'));
  const rows = runSpec(spec);
  console.log(fmt(rows, Object.keys(spec.grid || {})));
  const cha = rows.filter(r => r.verdict === 'CHAOTIC' || r.verdict === 'chaotic-sometimes');
  console.log(`\n${rows.length} points, ${cha.length} with any chaos`);
  if (spec.out) fs.writeFileSync(spec.out, rows.map(r => JSON.stringify(r)).join('\n'));
}

module.exports = { evaluate, runSpec, fmt, DEF };
