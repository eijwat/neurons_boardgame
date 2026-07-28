'use strict';
/* render a run to an mp4 (and a contact sheet) so a regime can actually be judged by eye.
 *   node movie.js '<json spec>'
 * spec extras:  out (dir), every (steps per frame), nFrames, cs, view ('field'|'wire'),
 *               damageAt (fork the twin here; the difference is drawn in magenta), fps
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('./engine.js');
const X = require('./explore.js');

const FFMPEG = '/opt/homebrew/bin/ffmpeg';

function render(spec) {
  const o = Object.assign({}, X.DEF, {
    W: 200, H: 130, cs: 5, view: 'field', every: 2, nFrames: 300, fps: 30,
    warm: 600, damageAt: -1, seed: 5,
  }, spec);

  const w = E.generateWiring({
    W: o.W, H: o.H, torus: o.torus, p: o.p, strategy: o.S,
    dotFrac: o.dot, crossFrac: o.cross, q: o.q, seed: o.seed, edgeOnly: o.edgeOnly,
  });
  const g = E.buildGraph(w);
  let mod = new Float32Array(w.N);
  if (o.g !== 0) { const f = E.enumerateFaces(w, g); mod = E.faceField(w, g, f).mod; }
  const mk = () => E.makeSim(w, g, mod, {
    theta: o.theta, R: o.R, g: o.g, wI: o.wI, nu: o.nu,
    rng: E.mulberry32(o.seed * 7919 + 13), adaptA: o.adaptA, adaptTau: o.adaptTau, RI: o.RI,
  });
  const sim = mk();
  const rng = E.mulberry32(o.seed * 7919 + 13);
  if (o.seedMode === 'wave') E.seedBrokenWave(sim, w, o.R);
  else if (o.seedMode === 'point') {
    const cx = (o.W / 2) | 0, cy = (o.H / 2) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = (cx + dx) + (cy + dy) * o.W;
      if (sim.live[k]) { sim.ph[k] = 1; sim.sg[k] = sim.outSign[k]; }
    }
  } else E.seedRandom(sim, w, rng, o.frac);

  const dir = o.out || path.join(__dirname, 'mov', 'run');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  for (let t = 0; t < o.warm; t++) sim.step();

  let twin = null;
  if (o.damageAt >= 0) {
    twin = mk();
    twin.ph.set(sim.ph); twin.sg.set(sim.sg); twin.u.set(sim.u); twin.rlen.set(sim.rlen);
    const start = ((o.seed * 2654435761) >>> 0) % w.NC;
    for (let k = 0; k < w.NC; k++) {
      const j = (start + k * 7919) % w.NC;
      if (!twin.live[j] || twin.ph[j] !== 0) continue;
      let free = 0;
      for (let e = g.start[j]; e < g.start[j + 1]; e++) if (twin.ph[g.nbr[e]] === 0) free++;
      if (!free) continue;
      twin.ph[j] = 1; twin.sg[j] = twin.outSign[j]; break;
    }
  }

  const dmg = [];
  for (let f = 0; f < o.nFrames; f++) {
    const im = o.view === 'wire'
      ? E.renderPPM(w, g, sim, o.cs, twin ? twin.ph : null)
      : E.renderField(w, sim, o.cs, twin ? twin.ph : null);
    fs.writeFileSync(path.join(dir, `f${String(f).padStart(5, '0')}.png`), E.encodePNG(im.buf, im.IW, im.IH));
    for (let s = 0; s < o.every; s++) {
      sim.step(); if (twin) twin.step();
    }
    if (twin) { let d = 0; for (let i = 0; i < w.N; i++) if (sim.ph[i] !== twin.ph[i]) d++; dmg.push(d); }
  }

  const mp4 = dir + '.mp4';
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-framerate', String(o.fps),
    '-i', path.join(dir, 'f%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', mp4]);
  return { dir, mp4, nLive: sim.nLive, dmg, activity: sim.activity() };
}

if (require.main === module) {
  const r = render(JSON.parse(process.argv[2]));
  console.log(`mp4: ${r.mp4}\nframes: ${r.dir}\nlive nodes: ${r.nLive}  activity: ${r.activity}`);
  if (r.dmg.length) console.log(`damage: start ${r.dmg[0]} -> end ${r.dmg[r.dmg.length - 1]} (${(r.dmg[r.dmg.length - 1] / r.nLive * 100).toFixed(2)}% of live)`);
}
module.exports = { render };
