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
  // --- LIF variant knobs (dyn:'gh' falls back to the original Greenberg-Hastings engine)
  dyn: 'lif',
  leak: 0,          // V *= leak each step.  leak=0 (+sub=0,vreset=0,refrMode=0) == exact GH
  leakC: undefined, // corner leak; undefined -> same as leak
  thetaC: 1e-9,     // corner firing threshold on |V|; 1e-9 == the game's "net!=0" rule
  cornerLIF: 1,     // 0 -> corners stay memoryless sign relays
  sub: 0,           // 1 -> subtractive reset (V -= theta) instead of V = vreset
  vreset: 0,        // post-spike potential (negative = afterhyperpolarisation)
  refrMode: 0,      // 0 frozen V while refractory, 1 leaks, 2 leaks+integrates
  vmin: -1e9, vmax: 1e9,
  dmgKind: 'spike', // 'spike' = add/remove one spike (comparable with GH runs); 'v' = tiny V nudge
  vEps: 1e-3,       // size of the V nudge
  seedMode: 'rand', frac: 0.01, edgeOnly: false,
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
  let mod = new Float32Array(w.N), fstats = { faces: 0 };
  if (o.g !== 0) { const f = E.enumerateFaces(w, g); const ff = E.faceField(w, g, f); mod = ff.mod; fstats = ff.stats; }
  return { w, g, mod, fstats };
}

function newSim(w, g, mod, o) {
  const par = {
    theta: o.theta, R: o.R, g: o.g, wI: o.wI, nu: o.nu,
    rng: E.mulberry32(o.seed * 7919 + 13), adaptA: o.adaptA, adaptTau: o.adaptTau, RI: o.RI,
    leak: o.leak, leakC: o.leakC, thetaC: o.thetaC, cornerLIF: o.cornerLIF,
    sub: o.sub, vreset: o.vreset, refrMode: o.refrMode, vmin: o.vmin, vmax: o.vmax,
  };
  return o.dyn === 'gh' ? E.makeSim(w, g, mod, par) : E.makeSimLIF(w, g, mod, par);
}
/* the twin must copy EVERY piece of state, membrane potentials included */
function copyState(dst, src) {
  dst.ph.set(src.ph); dst.sg.set(src.sg); dst.u.set(src.u); dst.rlen.set(src.rlen);
  if (src.V && dst.V) dst.V.set(src.V);
}
/* exact-cycle hash.  For LIF the continuous V is part of the state, so it is hashed
 * bit-exactly; `phase` = true hashes only the observable spike pattern. */
const _f64 = new Float64Array(1), _i32 = new Int32Array(_f64.buffer);
function hashState(sim, phase) {
  let h1 = 2166136261, h2 = 5381;
  const ph = sim.ph, sg = sim.sg;
  for (let i = 0; i < ph.length; i++) {
    const v = ph[i] * 3 + (sg[i] + 1);
    h1 = Math.imul(h1 ^ v, 16777619);
    h2 = (Math.imul(h2, 33) + v) | 0;
  }
  if (!phase && sim.V) {
    for (let i = 0; i < sim.V.length; i++) {
      _f64[0] = sim.V[i];
      h1 = Math.imul(h1 ^ _i32[0], 16777619); h1 = Math.imul(h1 ^ _i32[1], 16777619);
      h2 = (Math.imul(h2, 33) + _i32[0]) | 0; h2 = (Math.imul(h2, 33) + _i32[1]) | 0;
    }
  }
  return (h1 >>> 0) + ':' + (h2 >>> 0);
}

/* one perturbation trial; base keeps running and acts as the reference universe */
function damageTrial(base, w, g, mod, o, kind, offset) {
  const twin = newSim(w, g, mod, o);
  copyState(twin, base);
  const start = ((o.seed * 2654435761 + offset * 40503) >>> 0) % w.NC;
  let flipped = -1;
  for (let k = 0; k < w.NC && flipped < 0; k++) {
    const j = (start + k * 7919) % w.NC;
    if (!twin.live[j]) continue;
    if (kind === 'v') {                          // infinitesimal membrane nudge (LIF only)
      if (twin.ph[j] !== 0 || !twin.V) continue;
      twin.V[j] += o.vEps; flipped = j;
    } else if (kind === 'add') {
      if (twin.ph[j] !== 0) continue;
      let free = 0;
      for (let e = g.start[j]; e < g.start[j + 1]; e++) if (twin.ph[g.nbr[e]] === 0) free++;
      if (!free) continue;                       // a sterile injection proves nothing
      twin.ph[j] = 1; twin.sg[j] = twin.outSign[j]; flipped = j;
      if (twin.V) twin.V[j] = o.vreset;          // a real spike also resets the membrane
    } else {
      if (twin.ph[j] !== 1) continue;            // remove an excitation: punch a hole in a front
      twin.ph[j] = 0; flipped = j;
      if (twin.V) twin.V[j] = 0;
    }
  }
  if (flipped < 0) return null;
  const D = [], DV = [];
  for (let t = 0; t < o.TD; t++) {
    base.step(); twin.step();
    let d = 0, dv = 0;
    for (let i = 0; i < w.N; i++) {
      const pd = base.ph[i] !== twin.ph[i];
      if (pd) d++;
      if (pd || (base.V && Math.abs(base.V[i] - twin.V[i]) > 1e-9)) dv++;
    }
    D.push(d); DV.push(dv);
  }
  const dEnd = D[D.length - 1], dMax = D.reduce((a, b) => a > b ? a : b, 0);
  const dvEnd = DV[DV.length - 1];
  // exponential growth rate over the first quarter of the window
  const i1 = Math.max(1, (o.TD / 4) | 0);
  const lam = D[i1] > 0 && D[0] > 0 ? Math.log(D[i1] / D[0]) / i1 : 0;
  return { kind, dEnd, dMax, lam, dFrac: dEnd / base.nLive, dvFrac: dvEnd / base.nLive };
}

function evaluate(spec) {
  const o = Object.assign({}, DEF, spec);
  const { w, g, mod, fstats } = buildAll(o);
  const sim = newSim(w, g, mod, o);
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
  // full  = exact recurrence of the WHOLE state (V included) -> definitively not chaotic
  // phase = recurrence of the spike pattern only (V may still be drifting)
  const A = []; const seen = new Map(), seenP = new Map(); let period = 0, pperiod = 0;
  for (let t = 0; t < o.T; t++) {
    sim.step(); A.push(sim.activity());
    if (t > o.T * 0.4 && t < o.T * 0.4 + o.periodWin) {
      if (!period) { const h = hashState(sim, false); if (seen.has(h)) period = t - seen.get(h); else seen.set(h, t); }
      if (!pperiod) { const h = hashState(sim, true); if (seenP.has(h)) pperiod = t - seenP.get(h); else seenP.set(h, t); }
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
      const kind = o.dmgKind === 'v' ? 'v'
        : o.dmgKind === 'both' ? ['add', 'del', 'v'][k % 3]
          : (k % 2 === 0 ? 'add' : 'del');
      const tr = damageTrial(sim, w, g, mod, o, kind, k);
      if (tr) trials.push(tr);
      for (let t = 0; t < o.gap; t++) sim.step();
    }
  }
  const fr = trials.map(t => t.dFrac).sort((a, b) => a - b);
  const med = fr.length ? fr[(fr.length / 2) | 0] : 0;
  const frv = trials.map(t => t.dvFrac).sort((a, b) => a - b);
  const medV = frv.length ? frv[(frv.length / 2) | 0] : 0;
  const sustained = trials.length && trials.every(t => t.dEnd >= 0.5 * t.dMax);
  let cls;
  if (!alive) cls = 'dead';
  else if (!trials.length) cls = 'no-inject';
  else if (trials.every(t => t.dEnd === 0)) cls = 'ORDERED';
  else if (med > 0.005 && sustained) cls = 'CHAOTIC';
  else cls = 'marginal';

  return {
    params: o, cls, alive, A: mean, cv: mean > 0 ? sd / mean : 0,
    restFrac: nl ? rest / nl : 1, nLive: sim.nLive, faces: fstats.faces, period, pperiod,
    trials, dFracMed: med, dvFracMed: medV,
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
      dFracMed: avg(r => r.dFracMed), dvFracMed: avg(r => r.dvFracMed),
      lam: avg(r => r.trials.length ? r.trials[0].lam : 0),
      period: per.map(r => r.period), pperiod: per.map(r => r.pperiod), cls: per.map(r => r.cls),
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
    '  alive  chaos |   A_tail   CV   rest%   dmg%  dmgV%    lam   period   pper  verdict';
  const lines = [head];
  for (const r of rows) {
    lines.push(
      gridKeys.map(k => String(typeof r.combo[k] === 'number' ? +r.combo[k].toFixed(4) : r.combo[k]).padStart(7)).join('') +
      `  ${String(r.nAlive)}/${r.nSeeds}    ${String(r.nChaotic)}/${r.nSeeds} |` +
      ` ${r.A.toFixed(0).padStart(8)} ${r.cv.toFixed(3)} ${(r.restFrac * 100).toFixed(1).padStart(6)}` +
      ` ${(r.dFracMed * 100).toFixed(2).padStart(6)} ${(r.dvFracMed * 100).toFixed(2).padStart(6)}` +
      ` ${r.lam.toFixed(4).padStart(7)}` +
      ` ${String(r.period[0] || 0).padStart(7)} ${String(r.pperiod[0] || 0).padStart(6)}  ${r.verdict}`);
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
