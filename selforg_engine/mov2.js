'use strict';
/* render a variant's chaotic regime to mp4, with a damage-overlay version */
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const which = process.argv[2], tag = process.argv[3] || which;
const dir = which === 'lif' ? './var_lif' : './var_faceback';
const E = require(dir + '/engine.js');
const X = require(dir + '/explore.js');
const OPT = JSON.parse(process.argv[4] || '{}');

const SPEC = which === 'lif'
  ? { W:220,H:140,torus:true,dot:0.16667,cross:0.75,q:0.9,R:4,theta:1.5,nu:0,g:0,wI:1,frac:0.05,
      sub:0,vreset:0,refrMode:0,cornerLIF:1,leak:0.95,dyn:'lif' }
  : { W:220,H:140,torus:true,dot:0.16667,cross:0.6,q:0.8,R:6,theta:1,nu:0,g:0,wI:1,
      faceA:2,faceAc:0,faceDur:8,faceRef:250,faceWin:12 };
const o = Object.assign({}, X.DEF, SPEC, { seed: 202, cs: 5, every: 1, nFrames: 260, fps: 25,
  warm: 1500, damageAt: -1 }, OPT);

const w = E.generateWiring({ W:o.W,H:o.H,torus:o.torus,p:1,strategy:0,
  dotFrac:o.dot, crossFrac:o.cross, q:o.q, seed:o.seed, edgeOnly:false });
const g = E.buildGraph(w);
let mod = new Float32Array(w.N), topo = null;
if (o.g !== 0 || o.faceA) {
  const f = E.enumerateFaces(w, g);
  if (o.g !== 0) mod = E.faceField(w, g, f).mod;
  if (o.faceA) topo = E.buildFaceTopo(w, f);
}
const mk = () => which === 'lif'
  ? E.makeSimLIF(w, g, mod, { theta:o.theta,R:o.R,g:o.g,wI:o.wI,nu:0,rng:E.mulberry32(o.seed*7919+13),
      adaptA:0,adaptTau:30,RI:0,leak:o.leak,cornerLIF:o.cornerLIF,sub:o.sub,vreset:o.vreset,refrMode:o.refrMode })
  : E.makeSim(w, g, mod, { theta:o.theta,R:o.R,g:o.g,wI:o.wI,nu:0,rng:E.mulberry32(o.seed*7919+13),
      adaptA:0,adaptTau:30,RI:0, faceTopo:topo, faceA:o.faceA,faceAc:o.faceAc,faceDur:o.faceDur,
      faceRef:o.faceRef,faceWin:o.faceWin,faceFrac:o.faceFrac,faceMode:o.faceMode });

const sim = mk();
E.seedRandom(sim, w, E.mulberry32(o.seed*7919+13), o.frac || 0.01);
for (let t = 0; t < o.warm; t++) sim.step();

let twin = null;
if (o.damageAt >= 0) {
  twin = mk();
  if (twin.copyFrom) twin.copyFrom(sim);
  else { twin.ph.set(sim.ph); twin.sg.set(sim.sg); twin.u.set(sim.u); twin.rlen.set(sim.rlen); if (sim.V) twin.V.set(sim.V); }
  const start = ((o.seed * 2654435761 + (o.site||0) * 40503) >>> 0) % w.NC;
  for (let k = 0; k < w.NC; k++) {
    const j = (start + k * 7919) % w.NC;
    if (!twin.live[j] || twin.ph[j] !== 0) continue;
    let free = 0;
    for (let e = g.start[j]; e < g.start[j+1]; e++) if (twin.ph[g.nbr[e]] === 0) free++;
    if (!free) continue;
    twin.ph[j] = 1; twin.sg[j] = twin.outSign[j]; break;
  }
}

// visual post-processing: an afterglow trace with its own decay, plus optional box blur.
// this is how one would actually watch such a medium (calcium-imaging style), and it
// reveals mesoscale structure that the instantaneous spike field hides.
const GD = o.glow || 0, BL = o.blur || 0;
const glow = new Float32Array(w.NC), gtmp = new Float32Array(w.NC);
function glowFrame() {
  for (let i = 0; i < w.NC; i++) {
    const s = sim.ph[i] === 1 ? 1 : 0;
    glow[i] = Math.max(glow[i] * GD, s);
  }
  let src = glow;
  for (let b = 0; b < BL; b++) {
    for (let y = 0; y < w.H; y++) for (let x = 0; x < w.W; x++) {
      let a = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = ((x+dx)%w.W+w.W)%w.W, yy = ((y+dy)%w.H+w.H)%w.H;
        a += src[xx+yy*w.W]; n++;
      }
      gtmp[x+y*w.W] = a/n;
    }
    src.set(gtmp);
  }
  const IW = w.W*o.cs, IH = w.H*o.cs, buf = Buffer.alloc(IW*IH*3);
  for (let y = 0; y < w.H; y++) for (let x = 0; x < w.W; x++) {
    const v = Math.min(1, glow[x+y*w.W] * (o.gain || 1));
    const r = 16 + 239*Math.pow(v,0.7), gg = 16 + 180*Math.pow(v,1.1), bb = 22 + 60*Math.pow(v,2.2);
    for (let dy = 0; dy < o.cs; dy++) {
      let of = ((y*o.cs+dy)*IW + x*o.cs)*3;
      for (let dx = 0; dx < o.cs; dx++) { buf[of++]=r|0; buf[of++]=gg|0; buf[of++]=bb|0; }
    }
  }
  return { buf, IW, IH };
}

const out = path.join(__dirname, 'mov', tag);
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
if (GD) for (let t = 0; t < 120; t++) { glowFrame(); sim.step(); }   // prime the trace
for (let f = 0; f < o.nFrames; f++) {
  const im = GD ? glowFrame() : E.renderField(w, sim, o.cs, twin ? twin.ph : null);
  fs.writeFileSync(path.join(out, `f${String(f).padStart(5,'0')}.png`), E.encodePNG(im.buf, im.IW, im.IH));
  for (let s = 0; s < o.every; s++) { sim.step(); if (twin) twin.step(); }
}
execFileSync('/opt/homebrew/bin/ffmpeg', ['-y','-loglevel','error','-framerate',String(o.fps),
  '-i', path.join(out,'f%05d.png'),'-c:v','libx264','-pix_fmt','yuv420p',
  '-vf','scale=trunc(iw/2)*2:trunc(ih/2)*2', out + '.mp4']);
let d = 0; if (twin) for (let i = 0; i < w.N; i++) if (sim.ph[i] !== twin.ph[i]) d++;
console.log(`${tag}: ${out}.mp4   live=${sim.nLive} activity=${sim.activity()}` + (twin ? `  damage=${(d/sim.nLive*100).toFixed(1)}%` : ''));
