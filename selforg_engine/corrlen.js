'use strict';
/* Spatial correlation length of the activity field, in cells.
 * This decides whether a regime reads as a PATTERN on a big screen or as noise.
 * A spiral state should give xi ~ the wavelength; pure speckle gives xi ~ 1. */
function measure(which, spec, label) {
  const dir = which === 'gh' ? '.' : (which === 'lif' ? './var_lif' : './var_faceback');
  const E = require(dir + '/engine.js');
  const o = Object.assign({ W:200,H:130,torus:true,dot:1/6,cross:0.55,q:0.8,R:6,theta:1,g:0,wI:1,
                            nu:0,frac:0.02,seed:202,warm:1500 }, spec);
  const w = E.generateWiring({ W:o.W,H:o.H,torus:true,p:1,strategy:0,dotFrac:o.dot,
                               crossFrac:o.cross,q:o.q,seed:o.seed,edgeOnly:false });
  const g = E.buildGraph(w);
  let mod = new Float32Array(w.N), topo = null;
  if (o.g !== 0 || o.faceA) {
    const f = E.enumerateFaces(w, g);
    if (o.g !== 0) mod = E.faceField(w, g, f).mod;
    if (o.faceA) topo = E.buildFaceTopo(w, f);
  }
  const par = { theta:o.theta,R:o.R,g:o.g,wI:o.wI,nu:0,rng:E.mulberry32(o.seed*7919+13),
                adaptA:0,adaptTau:30,RI:0,leak:o.leak,cornerLIF:o.cornerLIF,sub:o.sub,
                vreset:o.vreset,refrMode:o.refrMode,faceTopo:topo,faceA:o.faceA,faceAc:o.faceAc,
                faceDur:o.faceDur,faceRef:o.faceRef,faceWin:o.faceWin };
  const sim = (which === 'lif') ? E.makeSimLIF(w, g, mod, par) : E.makeSim(w, g, mod, par);
  if (o.seedMode === 'wave') E.seedBrokenWave(sim, w, o.R);
  else E.seedRandom(sim, w, E.mulberry32(o.seed*7919+13), o.frac);
  for (let t = 0; t < o.warm; t++) sim.step();

  // average the correlation over several snapshots
  const MAXD = 40, acc = new Float64Array(MAXD + 1); let nsnap = 0;
  const DIRS = [[1,0],[0,1],[1,1],[1,-1],[2,1],[1,2],[2,-1],[1,-2]];
  for (let snap = 0; snap < 8; snap++) {
    const s = new Float64Array(w.NC);
    let m = 0;
    for (let i = 0; i < w.NC; i++) { s[i] = sim.ph[i] === 1 ? 1 : 0; m += s[i]; }
    m /= w.NC;
    let v = 0; for (let i = 0; i < w.NC; i++) v += (s[i]-m)*(s[i]-m); v /= w.NC;
    if (v > 1e-12) {
      for (let d = 1; d <= MAXD; d++) {
        let c = 0, n = 0;
        for (const dr of DIRS) {
          const len = Math.hypot(dr[0],dr[1]);
          const dx = Math.round(dr[0]*d/len), dy = Math.round(dr[1]*d/len);
          for (let y = 0; y < w.H; y += 2) for (let x = 0; x < w.W; x += 2) {
            const j = (((x+dx)%w.W+w.W)%w.W) + (((y+dy)%w.H+w.H)%w.H)*w.W;
            c += (s[x+y*w.W]-m)*(s[j]-m); n++;
          }
        }
        acc[d] += (c/n)/v;
      }
      nsnap++;
    }
    for (let t = 0; t < 3; t++) sim.step();
  }
  for (let d = 1; d <= MAXD; d++) acc[d] /= Math.max(1,nsnap);
  let xi = 0;
  for (let d = 1; d <= MAXD; d++) if (acc[d] >= 1/Math.E) xi = d; else break;
  const prof = [1,2,3,5,8,12,20,30].map(d => `${d}:${acc[d].toFixed(2)}`).join(' ');
  console.log(`${label.padEnd(30)} xi=${String(xi).padStart(2)} cells   C(d): ${prof}`);
}

measure('gh', { cross:0.7, q:1.0, R:14, seedMode:'wave', warm:900 }, 'ORDERED spiral (GH, R=14)');
measure('gh', { cross:0.55, q:0.8, R:12, warm:1500 }, 'ORDERED bulk (GH, R=12)');
measure('lif', { cross:0.75,q:0.9,R:4,theta:1.5,leak:0.95,cornerLIF:1,sub:0,vreset:0,refrMode:0,frac:0.05,warm:1500 },
        'CHAOTIC leaky-IF (R=4)');
measure('face',{ cross:0.6,q:0.8,R:6,theta:1,faceA:2,faceAc:0,faceDur:8,faceRef:250,faceWin:12,warm:2000 },
        'CHAOTIC circuit-feedback R=6');
measure('face',{ cross:0.6,q:0.8,R:20,theta:1,faceA:2,faceAc:0,faceDur:24,faceRef:250,faceWin:12,warm:2500,seed:302 },
        'CHAOTIC circuit-feedback R=20');
