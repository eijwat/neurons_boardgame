'use strict';
/* Verify the browser port inside neurons_selforg.html is numerically identical to the
 * headless engine that was validated against index.html. Same seed, same parameters,
 * compare wiring, graph, faces and the whole activity time series. */
const fs = require('fs'), vm = require('vm'), path = require('path');
const REF = require('./var_faceback/engine.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'neurons_selforg.html'), 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const engineSrc = js.slice(0, js.indexOf('/* ==================================================================== app */'));
const ctx = { Math, Set, Map, Uint8Array, Int8Array, Int32Array, Float32Array, console };
vm.createContext(ctx);
vm.runInContext(engineSrc + '\n;this.__api={generateWiring,buildGraph,enumerateFaces,faceField,buildFaceTopo,makeSim,mulberry32};', ctx);
const A = ctx.__api;

const CFG = { W: 90, H: 58, torus: true, p: 1, S: 0, dot: 1/6, cross: 0.6, q: 0.8, seed: 7,
              theta: 1, R: 20, g: 0, wI: 1, faceA: 2, faceDur: 24, faceRef: 250, faceWin: 12 };
let fails = 0;
function chk(name, a, b) {
  const ok = a === b;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(28)} port=${a}  ref=${b}`);
}

for (const [S, FA] of [[0,2],[1,2],[0,0],[0,2]]) {
  const c = Object.assign({}, CFG, { S, faceA: FA });
  console.log(`\n--- strategy S=${S}, faceA=${FA} ---`);

  const wA = A.generateWiring({ W:c.W,H:c.H,torus:c.torus,p:c.p,S:c.S,dot:c.dot,cross:c.cross,q:c.q,seed:c.seed,edgeOnly:false });
  const wB = REF.generateWiring({ W:c.W,H:c.H,torus:c.torus,p:c.p,strategy:c.S,dotFrac:c.dot,crossFrac:c.cross,q:c.q,seed:c.seed,edgeOnly:false });
  chk('cards placed', wA.placed, wB.placed);
  let td = 0; for (let i = 0; i < wA.NC; i++) if (wA.type[i] !== wB.type[i] || wA.orient[i] !== wB.orient[i] || wA.color[i] !== wB.color[i]) td++;
  chk('cells differing', td, 0);

  const gA = A.buildGraph(wA), gB = REF.buildGraph(wB);
  chk('edges', gA.E, gB.E);
  const fA = A.enumerateFaces(wA, gA), fB = REF.enumerateFaces(wB, gB);
  chk('bounded faces', fA.length, fB.length);
  const mA = A.faceField(wA, gA, fA), mB = REF.faceField(wB, gB, fB).mod;
  let md = 0; for (let i = 0; i < wA.N; i++) if (Math.abs(mA[i] - mB[i]) > 1e-6) md++;
  chk('face-field nodes differing', md, 0);

  const tA = A.buildFaceTopo(wA, fA), tB = REF.buildFaceTopo(wB, fB);
  chk('face topo entries', tA.fNodes.length, tB.fNodes.length);

  const par = { theta:c.theta, R:c.R, g:c.g, wI:c.wI, faceTopo:tA, faceA:c.faceA,
                faceDur:c.faceDur, faceRef:c.faceRef, faceWin:c.faceWin };
  const sA = A.makeSim(wA, gA, mA, par);
  const sB = REF.makeSim(wB, gB, mB, Object.assign({}, par, { faceTopo:tB, nu:0, adaptA:0, adaptTau:30, RI:0,
                rng: REF.mulberry32(1), faceAc:0, faceMode:'all', faceFrac:1 }));
  const rA = A.mulberry32(c.seed*7919+13), rB = REF.mulberry32(c.seed*7919+13);
  for (let i = 0; i < wA.NC; i++) if (sA.live[i] && rA() < 0.01) { sA.ph[i]=1; sA.sg[i]=sA.outSign[i]; }
  REF.seedRandom(sB, wB, rB, 0.01);
  let sd0 = 0; for (let i = 0; i < sA.N; i++) if (sA.ph[i] !== sB.ph[i]) sd0++;
  chk('initial state differing', sd0, 0);

  let firstDiff = -1, actA = [], actB = [];
  for (let t = 0; t < 1200; t++) {
    sA.step(); sB.step();
    const a = sA.activity(), b = sB.activity();
    actA.push(a); actB.push(b);
    if (firstDiff < 0) { for (let i = 0; i < sA.N; i++) if (sA.ph[i] !== sB.ph[i]) { firstDiff = t; break; } }
  }
  chk('first differing step (-1=never)', firstDiff, -1);
  chk('final activity', actA[1199], actB[1199]);
  /* With faceA = 0 the reference compiles the circuit bookkeeping out entirely and reports
     zero, while the port keeps counting so the demo can display circuit firings in Act 1
     too. The trajectories are identical either way, which is what actually matters. */
  if (c.faceA !== 0) chk('circuits fired', sA.faceFires, sB.faceFires);
  else console.log(`  note circuits counted while feedback off: port=${sA.faceFires} ref=${sB.faceFires} (readout only, dynamics identical)`);
}
console.log(fails ? `\n${fails} MISMATCH` : '\nPORT IS IDENTICAL TO THE VALIDATED ENGINE');
process.exit(fails ? 1 : 0);
