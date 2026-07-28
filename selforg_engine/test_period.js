'use strict';
/* Independent check of the hash-based period detector: store full states and
 * find the true cycle by exact byte comparison, then compare the two answers. */
const E = require('./engine.js');
const X = require('./explore.js');

function trueperiod(o) {
  const w = E.generateWiring({ W:o.W,H:o.H,torus:true,p:1,strategy:0,dotFrac:o.dot,crossFrac:o.cross,q:o.q,seed:o.seed,edgeOnly:false });
  const g = E.buildGraph(w);
  let mod = new Float32Array(w.N);
  if (o.g) { mod = E.faceField(w, g, E.enumerateFaces(w, g)).mod; }
  const sim = E.makeSim(w, g, mod, { theta:o.theta,R:o.R,g:o.g,wI:1,nu:0,rng:E.mulberry32(o.seed*7919+13),adaptA:o.adaptA||0,adaptTau:30,RI:0 });
  E.seedRandom(sim, w, E.mulberry32(o.seed*7919+13), 0.01);
  for (let t = 0; t < o.warm; t++) sim.step();
  const snaps = [];
  const NS = o.snaps;
  for (let t = 0; t < NS; t++) {
    const b = Buffer.alloc(sim.ph.length * 2);
    Buffer.from(sim.ph.buffer, sim.ph.byteOffset, sim.ph.length).copy(b, 0);
    Buffer.from(new Uint8Array(sim.sg.buffer, sim.sg.byteOffset, sim.sg.length)).copy(b, sim.ph.length);
    snaps.push(b);
    sim.step();
  }
  // earliest exact repeat
  for (let i = 0; i < NS; i++) for (let j = i + 1; j < NS; j++)
    if (snaps[i].equals(snaps[j])) return { period: j - i, at: i };
  return { period: 0, at: -1 };
}

const cases = [
  { W:80,H:52, dot:1/6, cross:0.55, q:0.8,  theta:1, R:6,  g:0, seed:1, warm:800, snaps:400 },
  { W:80,H:52, dot:1/6, cross:0.55, q:0.8,  theta:1, R:6,  g:0, seed:2, warm:800, snaps:400 },
  { W:80,H:52, dot:1/6, cross:0.35, q:0.85, theta:1, R:12, g:0, seed:1, warm:800, snaps:400 },
  { W:80,H:52, dot:1/6, cross:0.7,  q:0.7,  theta:1, R:4,  g:0, seed:3, warm:800, snaps:400 },
  { W:80,H:52, dot:1/6, cross:0.55, q:0.8,  theta:1, R:6,  g:0, seed:1, warm:800, snaps:400, adaptA:5 },
];
console.log('case                              brute-force   harness   agree');
for (const c of cases) {
  const bf = trueperiod(c);
  const r = X.evaluate({ W:c.W,H:c.H,dot:c.dot,cross:c.cross,q:c.q,theta:c.theta,R:c.R,g:c.g,seed:c.seed,
                         adaptA:c.adaptA||0, T:c.warm+c.snaps, periodWin:c.snaps, nDamage:0, TD:1 });
  const tag = `cross=${c.cross} q=${c.q} R=${c.R} a=${c.adaptA||0} s=${c.seed}`;
  const ok = bf.period === r.period || (bf.period && r.period % bf.period === 0) || (r.period && bf.period % r.period === 0);
  console.log(tag.padEnd(34) + String(bf.period).padStart(10) + String(r.period).padStart(10) + '   ' + (ok ? 'yes' : 'NO'));
}
