'use strict';
/* Validate the headless engine's geometry + face enumeration against the real
 * implementation, extracted verbatim from index.html. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const E = require('./engine.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const a = HTML.indexOf('/* ================= core logic (tested) ================= */');
const b = HTML.indexOf('// ---- AI ----');
if (a < 0 || b < 0) throw new Error('could not locate core logic block');
const src = HTML.slice(a, b);
const ctx = { Math, Set, Map, Array, console };
vm.createContext(ctx);
vm.runInContext(src + '\n;this.__api = {Board, boundedFaces, cardEdges, faceCircles, enumerateFaces};', ctx);
const REF = ctx.__api;

const TNAME = ['diag', 'vee', 'cross', 'dot'];

function compare(seed, W, H, p, dotFrac, strategy) {
  const w = E.generateWiring({ W, H, torus: false, p, strategy, dotFrac, q: 0.5, seed, edgeOnly: false });
  const g = E.buildGraph(w);
  const mine = E.enumerateFaces(w, g);

  const bd = new REF.Board();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = x + y * W;
    if (w.type[k] === E.EMPTY) continue;
    bd.place(x, y, TNAME[w.type[k]], w.orient[k], w.color[k] === 0 ? 'white' : 'black');
  }
  const ref = REF.boundedFaces(bd);

  // edge count
  let refEdges = 0;
  const adj = bd.buildGraph();
  for (const [, s] of adj) refEdges += s.size;
  refEdges /= 2;

  const ma = mine.map(f => Math.abs(f.area).toFixed(4)).sort();
  const ra = ref.map(f => Math.abs(f.area).toFixed(4)).sort();
  const areasEq = ma.length === ra.length && ma.every((v, i) => v === ra[i]);

  // face colour balance, compared against faceCircles()
  const ff = E.faceField(w, g, mine);
  const refBal = ref.map(f => { const r = REF.faceCircles(bd, f); return r.white - r.black; }).sort((x, y) => x - y);
  const myBal = ff.stats.bal.slice().sort((x, y) => x - y);
  const balEq = refBal.length === myBal.length && refBal.every((v, i) => v === myBal[i]);

  return {
    seed, W, H, p, dotFrac, strategy,
    placed: w.placed, edges: g.E, refEdges,
    faces: mine.length, refFaces: ref.length,
    edgesEq: g.E === refEdges, facesEq: mine.length === ref.length, areasEq, balEq,
  };
}

let allOK = true;
const rows = [];
for (const seed of [1, 2, 3, 7, 11]) {
  for (const cfg of [[9, 9, 1.0, 1 / 6, 0], [13, 13, 1.0, 1 / 6, 0], [13, 13, 0.6, 1 / 6, 0],
  [11, 11, 1.0, 0.0, 0], [11, 11, 1.0, 0.35, 0], [13, 13, 1.0, 1 / 6, 1.0]]) {
    const r = compare(seed, cfg[0], cfg[1], cfg[2], cfg[3], cfg[4]);
    rows.push(r);
    if (!(r.edgesEq && r.facesEq && r.areasEq && r.balEq)) allOK = false;
  }
}
for (const r of rows) {
  console.log(
    `seed=${String(r.seed).padStart(2)} ${r.W}x${r.H} p=${r.p} dot=${r.dotFrac.toFixed(3)} S=${r.strategy}` +
    ` | cards=${String(r.placed).padStart(3)} edges=${String(r.edges).padStart(4)}/${r.refEdges}` +
    ` faces=${String(r.faces).padStart(3)}/${r.refFaces}` +
    ` | ${r.edgesEq ? 'E ok' : 'E BAD'} ${r.facesEq ? 'F ok' : 'F BAD'} ${r.areasEq ? 'A ok' : 'A BAD'} ${r.balEq ? 'B ok' : 'B BAD'}`);
}
console.log(allOK ? '\nALL MATCH' : '\nMISMATCH');
process.exit(allOK ? 0 : 1);
