'use strict';
/* single-point runner: dynamics + damage spreading + frame rendering */
const fs = require('fs');
const path = require('path');

const E = require('./engine.js');

function build(o) {
  const w = E.generateWiring({
    W: o.W, H: o.H, torus: o.torus !== false, p: o.p, strategy: o.S,
    dotFrac: o.dot, crossFrac: o.cross, q: o.q, seed: o.seed, edgeOnly: false,
  });
  const g = E.buildGraph(w);
  let ff = { mod: new Float32Array(w.N), stats: { faces: 0, sizes: [], bal: [] } };
  if (o.g !== 0) { const faces = E.enumerateFaces(w, g); ff = E.faceField(w, g, faces); }
  return { w, g, ff };
}

function makeSimFor(w, g, ff, o, rngSeed) {
  const rng = E.mulberry32(rngSeed);
  return E.makeSim(w, g, ff.mod, { theta: o.theta, R: o.R, g: o.g, wI: o.wI, nu: o.nu || 0, rng,
    adaptA: o.adaptA || 0, adaptTau: o.adaptTau || 30 });
}

/* returns metrics; optionally writes frames */
function run(o) {
  const { w, g, ff } = build(o);
  const rng = E.mulberry32(o.seed * 7919 + 13);
  const sim = makeSimFor(w, g, ff, o, o.seed * 7919 + 13);
  if (o.seedMode === 'wave') E.seedBrokenWave(sim, w, o.R);
  else if (o.seedMode === 'point') {
    const cx = (o.W / 2) | 0, cy = (o.H / 2) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = (cx + dx) + (cy + dy) * o.W;
      if (sim.live[k]) { sim.ph[k] = 1; sim.sg[k] = sim.outSign[k]; }
    }
  }
  else E.seedRandom(sim, w, rng, o.frac || 0.02);

  let twin = null, injected = false;
  const A = [], D = [];
  const t0 = o.damageAt || -1;
  const frames = o.frames || [];
  const outDir = o.outDir;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });

  for (let t = 0; t <= o.T; t++) {
    if (t === t0) {                       // fork the twin universe, flip one node
      twin = makeSimFor(w, g, ff, o, o.seed * 7919 + 13);
      twin.ph.set(sim.ph); twin.sg.set(sim.sg); twin.u.set(sim.u); twin.rlen.set(sim.rlen);
      let flipped = -1;
      // inject where the perturbation can actually do something: a resting node
      // with at least one resting neighbour (otherwise it is sterile by construction)
      const start = ((o.seed * 2654435761) >>> 0) % w.NC;
      for (let tries = 0; tries < w.NC && flipped < 0; tries++) {
        const j = (start + tries * 7919) % w.NC;
        if (!twin.live[j] || twin.ph[j] !== 0) continue;
        let free = 0;
        for (let e = g.start[j]; e < g.start[j + 1]; e++) if (twin.ph[g.nbr[e]] === 0) free++;
        if (!free) continue;
        twin.ph[j] = 1; twin.sg[j] = twin.outSign[j]; flipped = j;
      }
      injected = flipped >= 0;
    }
    if (frames.includes(t) && outDir) {
      const im = (o.view === 'field' ? E.renderField(w, sim, o.cs || 6, twin ? twin.ph : null)
                                     : E.renderPPM(w, g, sim, o.cs || 6, twin ? twin.ph : null));
      fs.writeFileSync(path.join(outDir, `f${String(t).padStart(5, '0')}.png`),
        E.encodePNG(im.buf, im.IW, im.IH));
    }
    if (t === o.T) break;
    sim.step();
    if (twin) twin.step();
    A.push(sim.activity());
    if (twin) { let d = 0; for (let i = 0; i < w.N; i++) if (sim.ph[i] !== twin.ph[i]) d++; D.push(d); }
  }

  const tail = A.slice(Math.floor(A.length * 0.7));
  const mean = tail.reduce((s, v) => s + v, 0) / Math.max(1, tail.length);
  const sd = Math.sqrt(tail.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, tail.length));
  return {
    w, g, ff, sim, A, D, nLive: sim.nLive, faces: ff.stats.faces,
    mean, cv: mean > 0 ? sd / mean : 0,
    alive: A[A.length - 1] > 0 || sim.anyAlive(),
    damageFinal: D.length ? D[D.length - 1] : null,
    damageFrac: D.length ? D[D.length - 1] / sim.nLive : null,
    injected, D1: D.length ? D[0] : null,
    restFrac: (() => { let r = 0, n = 0; for (let i = 0; i < w.N; i++) if (sim.live[i]) { n++; if (sim.ph[i] === 0) r++; } return r / n; })(),
  };
}

module.exports = { build, run, makeSimFor };

