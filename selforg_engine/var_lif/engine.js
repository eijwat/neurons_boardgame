'use strict';
/* NEURONS board game -> excitable medium.  Headless engine, zero dependencies.
 *
 * Geometry follows index.html exactly:
 *   nodes  = cell centers M(x,y)  and cell corners C(x,y)
 *   edges  = always corner <-> center   (bipartite)
 *   cards  = diag(2 orients) | vee(4) | cross(1) | dot(0 edges)
 *
 * Dynamics (signed Greenberg-Hastings):
 *   state  = rest | excited(+/-) | refractory(1..R)
 *   center = neuron, colour gives output sign (white=+ excitatory, black=- inhibitory)
 *            fires when   net >= theta_eff   (theta_eff = theta - g*faceMod)
 *   corner = passive junction, relays sign(net); net == 0 -> nothing happens
 *            (this is the game's "tie -> the circuit fizzles" rule)
 */

// ---------------------------------------------------------------- RNG
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- card geometry
// corner slots: 0=TL 1=TR 2=BL 3=BR
const SLOT_D = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]];  // centre -> corner
const SLOT_OFF = [[0, 0], [1, 0], [0, 1], [1, 1]];                     // cell (x,y) -> corner coord
const DIAG = 0, VEE = 1, CROSS = 2, DOT = 3, EMPTY = 4;
const ORIENTS = [2, 4, 1, 1];

function cardSlots(type, orient) {
  switch (type) {
    case DIAG: return orient % 2 === 0 ? [0, 3] : [1, 2];
    case VEE: {
      const o = ((orient % 4) + 4) % 4;
      if (o === 0) return [0, 1];
      if (o === 1) return [1, 3];
      if (o === 2) return [2, 3];
      return [0, 2];
    }
    case CROSS: return [0, 1, 2, 3];
    default: return [];
  }
}

// ---------------------------------------------------------------- union-find
function makeUF(n) {
  const p = new Int32Array(n); for (let i = 0; i < n; i++) p[i] = i;
  const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a === b) return false; p[a] = b; return true; };
  return { find, union };
}

// ---------------------------------------------------------------- random set (O(1) pick/remove)
function makeRandSet(rng) {
  const arr = []; const pos = new Map();
  return {
    get size() { return arr.length; },
    has(v) { return pos.has(v); },
    add(v) { if (pos.has(v)) return; pos.set(v, arr.length); arr.push(v); },
    del(v) {
      const i = pos.get(v); if (i === undefined) return;
      const last = arr.pop(); pos.delete(v);
      if (i < arr.length) { arr[i] = last; pos.set(last, i); }
    },
    pick() { return arr[(rng() * arr.length) | 0]; },
    at(i) { return arr[i]; },
  };
}

// ================================================================ WIRING
/* opt: W,H,torus,p,strategy,dotFrac,q,seed,edgeOnly */
function generateWiring(opt) {
  const W = opt.W, H = opt.H, torus = !!opt.torus;
  const rng = mulberry32(opt.seed >>> 0);
  const NC = W * H;                                   // centres
  const cw = torus ? W : W + 1, ch = torus ? H : H + 1;
  const NK = cw * ch;                                 // corners
  const N = NC + NK;

  const cornerIdx = torus
    ? (cx, cy) => NC + (((cx % W) + W) % W) + (((cy % H) + H) % H) * W
    : (cx, cy) => NC + cx + cy * cw;

  const type = new Uint8Array(NC).fill(EMPTY);
  const orient = new Uint8Array(NC);
  const color = new Uint8Array(NC).fill(255);          // 0 = white/E, 1 = black/I

  // deck mix.  game deck (8:8:4:4) == dotFrac = crossFrac = 1/6, rest split evenly.
  // crossFrac sets the density of degree-4 junctions, i.e. how 2-dimensional the medium is.
  const d = opt.dotFrac;
  const cf = opt.crossFrac === undefined ? (1 - d) / 5 : opt.crossFrac;
  const rest = Math.max(0, 1 - d - cf);
  const cum = [rest / 2, rest, rest + cf, 1.0];
  const drawType = () => { const r = rng(); for (let i = 0; i < 4; i++) if (r < cum[i]) return i; return DOT; };

  const uf = makeUF(NK);
  const cornerLive = new Uint8Array(NK);               // has at least one incident edge

  const frontier = makeRandSet(rng);
  const nbrs = opt.edgeOnly ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
    : [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  const cellOK = (x, y) => torus || (x >= 0 && y >= 0 && x < W && y < H);
  const wrap = (x, y) => [((x % W) + W) % W, ((y % H) + H) % H];

  const addFrontier = (x, y) => {
    for (const dxy of nbrs) {
      let nx = x + dxy[0], ny = y + dxy[1];
      if (!cellOK(nx, ny)) continue;
      if (torus) { const w = wrap(nx, ny); nx = w[0]; ny = w[1]; }
      const k = nx + ny * W;
      if (type[k] === EMPTY) frontier.add(k);
    }
  };

  const slotCorners = (x, y, t, o) => cardSlots(t, o).map(s =>
    cornerIdx(x + SLOT_OFF[s][0], y + SLOT_OFF[s][1]));

  // cs holds GLOBAL corner ids (NC + local); the union-find is indexed by LOCAL id.
  // Passing the global id read past the end of the array, so find() returned undefined
  // and this predicate was always true.
  const closesCircuit = (cs) => {
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++)
        if (uf.find(cs[i] - NC) === uf.find(cs[j] - NC)) return true;
    return false;
  };

  const doPlace = (k, t, o, col) => {
    const x = k % W, y = (k / W) | 0;
    type[k] = t; orient[k] = o; color[k] = col;
    const cs = slotCorners(x, y, t, o);
    for (let i = 0; i < cs.length; i++) { cornerLive[cs[i] - NC] = 1; if (i) uf.union(cs[0] - NC, cs[i] - NC); }
    frontier.del(k);
    addFrontier(x, y);
  };

  // seed at centre
  const sx = (W / 2) | 0, sy = (H / 2) | 0;
  doPlace(sx + sy * W, drawType(), (rng() * 4) | 0, rng() < opt.q ? 0 : 1);

  const target = Math.max(1, Math.round(opt.p * NC));
  const S = opt.strategy;
  let placed = 1;

  while (placed < target && frontier.size > 0) {
    const col = rng() < opt.q ? 0 : 1;
    const hand = [drawType(), drawType(), drawType(), drawType(), drawType()];
    let bk = -1, bt = 0, bo = 0;

    if (S > 0 && rng() < S) {
      let best = -Infinity;
      const K = 20;
      for (let s = 0; s < K; s++) {
        const k = frontier.pick();
        const t = hand[(rng() * 5) | 0];
        const o = (rng() * ORIENTS[t]) | 0;
        const x = k % W, y = (k / W) | 0;
        let sc = 0;
        if (t !== DOT) {
          const cs = slotCorners(x, y, t, o);
          if (closesCircuit(cs)) sc += 10;
          for (const c of cs) if (cornerLive[c - NC]) sc += 1;   // prefer joining live wire
        }
        for (const dxy of nbrs) {                                 // prefer own colour around
          let nx = x + dxy[0], ny = y + dxy[1];
          if (!cellOK(nx, ny)) continue;
          if (torus) { const w = wrap(nx, ny); nx = w[0]; ny = w[1]; }
          const kk = nx + ny * W;
          if (type[kk] !== EMPTY && color[kk] === col) sc += 0.3;
        }
        sc += rng() * 0.01;
        if (sc > best) { best = sc; bk = k; bt = t; bo = o; }
      }
    } else {
      bk = frontier.pick(); bt = hand[0]; bo = (rng() * ORIENTS[bt]) | 0;
    }
    doPlace(bk, bt, bo, col);
    placed++;
  }

  return { W, H, torus, NC, NK, N, cw, ch, type, orient, color, cornerIdx, placed };
}

// ================================================================ GRAPH (CSR, angular order)
function buildGraph(w) {
  const { W, H, NC, N } = w;
  const deg = new Int32Array(N);
  const elist = [];   // [a, b, dx, dy]  (a = centre, b = corner)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = x + y * W; const t = w.type[k];
    if (t === EMPTY || t === DOT) continue;
    for (const s of cardSlots(t, w.orient[k])) {
      const c = w.cornerIdx(x + SLOT_OFF[s][0], y + SLOT_OFF[s][1]);
      elist.push([k, c, SLOT_D[s][0], SLOT_D[s][1]]);
      deg[k]++; deg[c]++;
    }
  }
  const start = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) start[i + 1] = start[i] + deg[i];
  const E2 = start[N];
  const nbr = new Int32Array(E2), dx = new Float32Array(E2), dy = new Float32Array(E2);
  const fill = start.slice(0, N);
  for (const e of elist) {
    let i = fill[e[0]]++; nbr[i] = e[1]; dx[i] = e[2]; dy[i] = e[3];
    i = fill[e[1]]++; nbr[i] = e[0]; dx[i] = -e[2]; dy[i] = -e[3];
  }
  // angular sort each adjacency list (atan2 with y down, same convention as index.html)
  for (let v = 0; v < N; v++) {
    const a = start[v], b = start[v + 1], n = b - a;
    if (n < 2) continue;
    const idx = [];
    for (let i = a; i < b; i++) idx.push({ n: nbr[i], x: dx[i], y: dy[i], ang: Math.atan2(dy[i], dx[i]) });
    idx.sort((p, q) => p.ang - q.ang);
    for (let i = 0; i < n; i++) { nbr[a + i] = idx[i].n; dx[a + i] = idx[i].x; dy[a + i] = idx[i].y; }
  }
  // reverse-half lookup: for directed edge (a -> b) the position of a inside b's list
  const revpos = new Int32Array(E2).fill(-1);
  for (let v = 0; v < N; v++) for (let i = start[v]; i < start[v + 1]; i++) {
    const u = nbr[i];
    for (let j = start[u]; j < start[u + 1]; j++) if (nbr[j] === v) { revpos[i] = j; break; }
  }
  return { start, nbr, dx, dy, revpos, E: E2 / 2 };
}

// ================================================================ FACES
/* mirrors pruneSpurs() in index.html, keeping the position arrays in step */
function pruneSpurs(walk, px, py) {
  let changed = true;
  while (changed && walk.length > 2) {
    changed = false;
    for (let i = 0; i < walk.length; i++) {
      const n = walk.length;
      if (walk[(i - 1 + n) % n] !== walk[(i + 1) % n]) continue;
      const j = (i + 1) % n;
      const rm = [i, j].sort((a, b) => b - a);
      for (const r of rm) { walk.splice(r, 1); px.splice(r, 1); py.splice(r, 1); }
      changed = true; break;
    }
  }
}

/* half-edge trace with angular rotation; positions accumulated relatively so this
 * works unchanged on a torus.  Returns bounded faces (signed area < 0, same
 * convention as boundedFaces() in index.html). */
function enumerateFaces(w, g) {
  const { start, nbr, dx, dy, revpos } = g;
  const E2 = g.E * 2;
  const seen = new Uint8Array(E2);
  const faces = [];
  for (let v = 0; v < w.N; v++) for (let e0 = start[v]; e0 < start[v + 1]; e0++) {
    if (seen[e0]) continue;
    const walk = [], px = [], py = [];
    let e = e0, cx = 0, cy = 0, guard = 0, ok = true;
    do {
      if (seen[e]) { ok = false; break; }
      seen[e] = 1;
      const from = e >= start[w.N] ? -1 : 0; // unused
      walk.push(nbr[e]); cx += dx[e]; cy += dy[e]; px.push(cx); py.push(cy);
      const rp = revpos[e];                 // position of the *source* inside target's list
      const u = nbr[e];
      const a = start[u], b = start[u + 1];
      e = a + ((rp - a + 1) % (b - a));     // next half-edge in rotation
      if (++guard > 100000) { ok = false; break; }
    } while (e !== e0);
    if (!ok || walk.length < 3) continue;
    if (Math.abs(cx) > 1e-9 || Math.abs(cy) > 1e-9) continue;   // wraps the torus -> not a face
    pruneSpurs(walk, px, py);               // drop dead-end out-and-back excursions
    if (walk.length < 3) continue;
    let area = 0;
    for (let i = 0; i < walk.length; i++) {
      const j = (i + 1) % walk.length;
      area += px[i] * py[j] - px[j] * py[i];
    }
    area /= 2;
    if (area >= -1e-9) continue;            // keep negative-area (bounded) faces only
    faces.push({ nodes: walk, px, py, area });
  }
  return faces;
}

/* face-balance field: for every bounded face count  (circles on the rim + dots inside)
 * by colour, exactly as faceCircles() does, then spread the balance onto its rim nodes. */
function faceField(w, g, faces) {
  const { W, H, NC } = w;
  const mod = new Float32Array(w.N);
  const cnt = new Int32Array(w.N);
  const stats = { faces: faces.length, sizes: [], bal: [], dotsIn: 0 };

  // dot lookup by cell
  const isDot = new Uint8Array(NC);
  for (let i = 0; i < NC; i++) if (w.type[i] === DOT) isDot[i] = 1;

  for (const f of faces) {
    let white = 0, black = 0;
    const rim = [...new Set(f.nodes)];        // a walk may touch a node twice; count it once
    for (const n of rim) if (n < NC && w.type[n] !== DOT && w.type[n] !== EMPTY) {
      if (w.color[n] === 0) white++; else black++;
    }
    // interior dots: walk the integer cells inside the polygon bbox
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (let i = 0; i < f.px.length; i++) {
      if (f.px[i] < minx) minx = f.px[i]; if (f.px[i] > maxx) maxx = f.px[i];
      if (f.py[i] < miny) miny = f.py[i]; if (f.py[i] > maxy) maxy = f.py[i];
    }
    // absolute origin: first node of the walk
    const n0 = f.nodes[0];
    let ox, oy;
    if (n0 < NC) { ox = (n0 % W) + 0.5; oy = ((n0 / W) | 0) + 0.5; }
    else { const c = n0 - NC; ox = c % w.cw; oy = (c / w.cw) | 0; }
    // relative coords of walk[0] are (f.px[0], f.py[0]); shift so absolute = rel + base
    const bx = ox - f.px[0], by = oy - f.py[0];
    for (let gy = Math.floor(miny + by); gy <= Math.ceil(maxy + by); gy++)
      for (let gx = Math.floor(minx + bx); gx <= Math.ceil(maxx + bx); gx++) {
        let cxi = gx, cyi = gy;
        if (w.torus) { cxi = ((cxi % W) + W) % W; cyi = ((cyi % H) + H) % H; }
        else if (cxi < 0 || cyi < 0 || cxi >= W || cyi >= H) continue;
        const kk = cxi + cyi * W;
        if (!isDot[kk]) continue;
        // point-in-polygon on relative coords
        const qx = gx + 0.5 - bx, qy = gy + 0.5 - by;
        let inside = false;
        for (let i = 0, j = f.px.length - 1; i < f.px.length; j = i++) {
          const xi = f.px[i], yi = f.py[i], xj = f.px[j], yj = f.py[j];
          if (((yi > qy) !== (yj > qy)) && (qx < (xj - xi) * (qy - yi) / (yj - yi) + xi)) inside = !inside;
        }
        if (inside) { if (w.color[kk] === 0) white++; else black++; stats.dotsIn++; }
      }
    const bal = white - black;
    stats.sizes.push(rim.length); stats.bal.push(bal);
    for (const n of rim) { mod[n] += bal; cnt[n]++; }
  }
  for (let i = 0; i < w.N; i++) if (cnt[i]) mod[i] /= cnt[i];
  return { mod, stats };
}

// ================================================================ DYNAMICS
/* ph: 0 = rest, 1 = excited, 2..R+1 = refractory.   sg: +1 / -1 (valid while ph > 0) */
function makeSim(w, g, mod, par) {
  const N = w.N, R = par.R;
  const ph = new Uint8Array(N), sg = new Int8Array(N);
  // use-dependent fatigue: each spike lengthens that node's own refractory period,
  // the trace u relaxing back with time constant tau.  adaptA = 0 -> plain GH.
  const u = new Float32Array(N), rlen = new Uint8Array(N).fill(R);
  const adaptA = par.adaptA || 0, decay = Math.exp(-1 / (par.adaptTau || 1));
  // RI lets inhibitory neurons carry a different refractory period from excitatory ones
  const rbase = new Uint8Array(N).fill(R);
  const nph = new Uint8Array(N), nsg = new Int8Array(N);
  const net = new Float32Array(N), hit = new Uint8Array(N);
  const isCenter = new Uint8Array(N);
  const live = new Uint8Array(N);
  for (let i = 0; i < w.NC; i++) isCenter[i] = 1;
  let nLive = 0;
  for (let i = 0; i < N; i++) if (g.start[i + 1] > g.start[i]) { live[i] = 1; nLive++; }
  // output sign of a centre = its colour (white -> +1, black -> -1)
  const outSign = new Int8Array(N);
  for (let i = 0; i < w.NC; i++) outSign[i] = w.color[i] === 0 ? 1 : -1;
  if (par.RI) for (let i = 0; i < w.NC; i++) if (w.color[i] === 1) { rbase[i] = par.RI; rlen[i] = par.RI; }

  const touched = new Int32Array(N); let nTouched = 0;
  const fire = (i) => { rlen[i] = Math.min(250, rbase[i] + Math.round(adaptA * u[i])); u[i] += 1; };

  function step() {
    nTouched = 0;
    // 1. deliver input from currently excited nodes
    for (let i = 0; i < N; i++) {
      if (ph[i] !== 1) continue;
      const contrib = sg[i] > 0 ? 1 : -par.wI;
      for (let e = g.start[i], b = g.start[i + 1]; e < b; e++) {
        const j = g.nbr[e];
        if (ph[j] !== 0) continue;
        if (!hit[j]) { hit[j] = 1; touched[nTouched++] = j; net[j] = 0; }
        net[j] += contrib;
      }
    }
    // 2. advance existing states
    for (let i = 0; i < N; i++) {
      const p = ph[i];
      if (p === 0) { nph[i] = 0; nsg[i] = sg[i]; }
      else if (p === 1) { nph[i] = R > 0 ? 2 : 0; nsg[i] = sg[i]; }
      else if (p >= rlen[i] + 1) { nph[i] = 0; nsg[i] = sg[i]; }
      else { nph[i] = p + 1; nsg[i] = sg[i]; }
    }
    // 3. firing decisions for nodes that received input
    for (let t = 0; t < nTouched; t++) {
      const i = touched[t]; hit[i] = 0;
      const s = net[i];
      if (isCenter[i]) {
        let th = par.theta - par.g * mod[i];
        if (th < 0.25) th = 0.25;
        if (s >= th) { nph[i] = 1; nsg[i] = outSign[i]; fire(i); }
      } else {
        const se = s + par.g * mod[i];
        if (se > 1e-9) { nph[i] = 1; nsg[i] = 1; fire(i); }
        else if (se < -1e-9) { nph[i] = 1; nsg[i] = -1; fire(i); }
      }
    }
    // 4. spontaneous firing
    if (par.nu > 0) {
      for (let i = 0; i < w.NC; i++)
        if (live[i] && nph[i] === 0 && par.rng() < par.nu) { nph[i] = 1; nsg[i] = outSign[i]; fire(i); }
    }
    if (adaptA > 0) for (let i = 0; i < N; i++) u[i] *= decay;
    ph.set(nph); sg.set(nsg);
  }

  function activity() { let c = 0; for (let i = 0; i < N; i++) if (ph[i] === 1) c++; return c; }
  function anyAlive() { for (let i = 0; i < N; i++) if (ph[i] !== 0) return true; return false; }

  // u and rlen are part of the state: a twin universe must copy them too, or the
  // comparison is between two different systems rather than a one-node perturbation.
  return { ph, sg, u, rlen, step, activity, anyAlive, nLive, live, isCenter, outSign, N, R };
}

// ================================================================ DYNAMICS -- LEAKY INTEGRATE & FIRE
/* Same wiring, colours, Dale's law and corner tie-rule as makeSim(), but each node
 * carries a CONTINUOUS membrane potential V that survives between spikes:
 *
 *     resting node:   V <- leak * V + (signed synaptic input this step)
 *     centre fires when  V >= theta_eff        (theta_eff = theta - g*faceMod, floored at 0.25)
 *                        and emits its OWN colour's sign  (Dale)
 *     corner fires when |V + g*faceMod| >= thetaC  and emits sign(V + g*faceMod)
 *                        (thetaC -> 0+ is exactly the game's "net==0 -> fizzle" rule)
 *     after a spike:   V <- vreset            (sub=1: V <- V -/+ threshold, i.e. subtractive reset)
 *     then ph runs 1 -> 2..rlen+1 -> 0 exactly as in GH.
 *
 * EXACT GH LIMIT:  leak=0, sub=0, vreset=0, refrMode=0, cornerLIF=1, thetaC=1e-9.
 *   With leak=0 a resting node's V is just this step's net input, so the rule collapses
 *   to signed Greenberg-Hastings term for term.  leak is therefore the single knob that
 *   measures the departure from GH.
 *
 * par: theta R g wI nu leak leakC thetaC cornerLIF sub vreset refrMode vmin RI adaptA adaptTau rng
 *   refrMode 0 = V frozen while excited/refractory (classic absolute refractory)
 *            1 = V keeps leaking but receives no input
 *            2 = V leaks AND integrates input while refractory (no firing though)
 *   cornerLIF 0 = corner is a memoryless sign relay (pure GH corner) even when centres are LIF
 */
function makeSimLIF(w, g, mod, par) {
  const N = w.N, R = par.R;
  const ph = new Uint8Array(N), sg = new Int8Array(N);
  const V = new Float64Array(N);
  const u = new Float32Array(N), rlen = new Uint8Array(N).fill(R);
  const adaptA = par.adaptA || 0, adecay = Math.exp(-1 / (par.adaptTau || 1));
  const rbase = new Uint8Array(N).fill(R);
  const nph = new Uint8Array(N), nsg = new Int8Array(N);
  const inp = new Float64Array(N);
  const isCenter = new Uint8Array(N);
  const live = new Uint8Array(N);
  for (let i = 0; i < w.NC; i++) isCenter[i] = 1;
  let nLive = 0;
  for (let i = 0; i < N; i++) if (g.start[i + 1] > g.start[i]) { live[i] = 1; nLive++; }
  const outSign = new Int8Array(N);
  for (let i = 0; i < w.NC; i++) outSign[i] = w.color[i] === 0 ? 1 : -1;
  if (par.RI) for (let i = 0; i < w.NC; i++) if (w.color[i] === 1) { rbase[i] = par.RI; rlen[i] = par.RI; }

  const leak = par.leak === undefined ? 0 : par.leak;
  const leakC = par.leakC === undefined ? leak : par.leakC;
  const thetaC = par.thetaC === undefined ? 1e-9 : par.thetaC;
  const cornerLIF = par.cornerLIF === undefined ? 1 : (par.cornerLIF ? 1 : 0);
  const sub = par.sub ? 1 : 0;
  const vreset = par.vreset === undefined ? 0 : par.vreset;
  const refrMode = par.refrMode || 0;
  const vmin = par.vmin === undefined ? -Infinity : par.vmin;
  const vmax = par.vmax === undefined ? Infinity : par.vmax;

  const fire = (i) => { rlen[i] = Math.min(250, rbase[i] + Math.round(adaptA * u[i])); u[i] += 1; };

  function step() {
    inp.fill(0);
    // 1. deliver signed input from currently excited nodes
    for (let i = 0; i < N; i++) {
      if (ph[i] !== 1) continue;
      const contrib = sg[i] > 0 ? 1 : -par.wI;
      for (let e = g.start[i], b = g.start[i + 1]; e < b; e++) {
        const j = g.nbr[e];
        if (ph[j] !== 0 && refrMode !== 2) continue;   // absolute refractory ignores input
        inp[j] += contrib;
      }
    }
    // 2. advance phase counters
    for (let i = 0; i < N; i++) {
      const p = ph[i];
      if (p === 0) nph[i] = 0;
      else if (p === 1) nph[i] = R > 0 ? 2 : 0;
      else if (p >= rlen[i] + 1) nph[i] = 0;
      else nph[i] = p + 1;
      nsg[i] = sg[i];
    }
    // 3. membrane update + firing
    for (let i = 0; i < N; i++) {
      if (!live[i]) continue;
      if (ph[i] !== 0) {                               // excited or refractory: cannot fire
        if (refrMode === 1) V[i] *= isCenter[i] ? leak : leakC;
        else if (refrMode === 2) V[i] = V[i] * (isCenter[i] ? leak : leakC) + inp[i];
        continue;                                      // refrMode 0: frozen
      }
      if (inp[i] === 0 && V[i] === 0) continue;        // nothing to integrate, nothing to decay
      let v;
      if (isCenter[i]) {
        v = V[i] * leak + inp[i];
        let th = par.theta - par.g * mod[i];
        if (th < 0.25) th = 0.25;
        if (v >= th) { nph[i] = 1; nsg[i] = outSign[i]; fire(i); v = sub ? v - th : vreset; }
      } else if (cornerLIF) {
        v = V[i] * leakC + inp[i];
        // the face field modulates the corner's threshold (symmetrically, opposite senses),
        // exactly as it modulates a centre's.  g=0 -> plain |V| >= thetaC.
        let thP = thetaC - par.g * mod[i], thN = thetaC + par.g * mod[i];
        if (thP < 1e-9) thP = 1e-9; if (thN < 1e-9) thN = 1e-9;
        if (v >= thP) { nph[i] = 1; nsg[i] = 1; fire(i); v = sub ? v - thP : vreset; }
        else if (v <= -thN) { nph[i] = 1; nsg[i] = -1; fire(i); v = sub ? v + thN : -vreset; }
      } else {                                         // pure GH sign relay, no memory
        v = 0;
        const ve = inp[i] + par.g * mod[i];
        if (ve > 1e-9) { nph[i] = 1; nsg[i] = 1; fire(i); }
        else if (ve < -1e-9) { nph[i] = 1; nsg[i] = -1; fire(i); }
      }
      if (v < vmin) v = vmin; else if (v > vmax) v = vmax;
      V[i] = v;
    }
    // 4. spontaneous firing (keep nu = 0 for determinism claims)
    if (par.nu > 0) {
      for (let i = 0; i < w.NC; i++)
        if (live[i] && nph[i] === 0 && par.rng() < par.nu) { nph[i] = 1; nsg[i] = outSign[i]; fire(i); V[i] = vreset; }
    }
    if (adaptA > 0) for (let i = 0; i < N; i++) u[i] *= adecay;
    ph.set(nph); sg.set(nsg);
  }

  function activity() { let c = 0; for (let i = 0; i < N; i++) if (ph[i] === 1) c++; return c; }
  function anyAlive() {
    for (let i = 0; i < N; i++) if (ph[i] !== 0) return true;
    return false;
  }
  /* a LIF medium can be phase-silent but still charged; "alive" must include that */
  function anyCharged(eps) {
    const e = eps === undefined ? 1e-9 : eps;
    for (let i = 0; i < N; i++) if (ph[i] !== 0 || Math.abs(V[i]) > e) return true;
    return false;
  }

  return { ph, sg, V, u, rlen, step, activity, anyAlive, anyCharged, nLive, live, isCenter, outSign, N, R, lif: true };
}

function seedRandom(sim, w, rng, frac) {
  for (let i = 0; i < w.NC; i++)
    if (sim.live[i] && rng() < frac) { sim.ph[i] = 1; sim.sg[i] = sim.outSign[i]; }
}
/* broken plane wave: excited bar with refractory tail behind, truncated at mid-height
 * -> the free end curls, the classic spiral initiator */
function seedBrokenWave(sim, w, R) {
  const W = w.W, H = w.H;
  const x0 = (W * 0.5) | 0;
  const nd = Math.ceil((R + 1) / 2) + 1;
  const set = (k, age) => { if (k >= 0 && sim.ph[k] === 0) { sim.ph[k] = age; sim.sg[k] = sim.outSign[k] || 1; } };
  for (let y = 0; y < (H / 2) | 0; y++) {
    for (let dc = 0; dc <= nd; dc++) {
      const x = x0 + dc; if (x >= W) continue;
      const k = x + y * W; if (!sim.live[k]) continue;
      // a front moves one cell per two steps, so refractory age grows as 2*distance
      const age = dc === 0 ? 1 : Math.min(R + 1, 2 * dc);
      sim.ph[k] = age; sim.sg[k] = sim.outSign[k];
      // the front travels towards -x, so only corners strictly behind it are refractory;
      // the corners ahead of the excited column must stay at rest or the wave is blocked.
      if (dc >= 1) for (const sl of cardSlots(w.type[k], w.orient[k]))
        set(w.cornerIdx(x + SLOT_OFF[sl][0], y + SLOT_OFF[sl][1]), Math.min(R + 1, age + 1));
    }
  }
}

// ================================================================ RENDER (PPM)
const COL_BG = [10, 10, 14], COL_REST = [42, 42, 52];
const COL_EXP = [255, 196, 80], COL_EXM = [86, 170, 255];
function nodeColor(ph, sg, R) {
  if (ph === 0) return COL_REST;
  if (ph === 1) return sg > 0 ? COL_EXP : COL_EXM;
  // fatigue can push ph past R+1, so clamp or the interpolation goes negative
  // and wraps around when written into the byte buffer
  let f = 1 - (ph - 1) / Math.max(1, R);       // 1 -> 0 through refractory
  if (f < 0) f = 0; else if (f > 1) f = 1;
  const base = sg > 0 ? COL_EXP : COL_EXM;
  return [COL_REST[0] + (base[0] - COL_REST[0]) * f * 0.55,
  COL_REST[1] + (base[1] - COL_REST[1]) * f * 0.55,
  COL_REST[2] + (base[2] - COL_REST[2]) * f * 0.55];
}

function renderPPM(w, g, sim, cs, damagePh) {
  const IW = w.W * cs, IH = w.H * cs;
  const buf = Buffer.alloc(IW * IH * 3);
  for (let i = 0; i < IW * IH; i++) { buf[i * 3] = COL_BG[0]; buf[i * 3 + 1] = COL_BG[1]; buf[i * 3 + 2] = COL_BG[2]; }
  const put = (x, y, c) => {
    x = ((x % IW) + IW) % IW; y = ((y % IH) + IH) % IH;
    const o = (y * IW + x) * 3;
    if (c[0] > buf[o]) buf[o] = c[0] | 0;
    if (c[1] > buf[o + 1]) buf[o + 1] = c[1] | 0;
    if (c[2] > buf[o + 2]) buf[o + 2] = c[2] | 0;
  };
  const line = (x0, y0, x1, y1, c) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) | 0;
    for (let i = 0; i <= n; i++) put(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), c);
  };
  const { W, H, NC } = w;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = x + y * W, t = w.type[k];
    if (t === EMPTY || t === DOT) continue;
    const mx = (x + 0.5) * cs, my = (y + 0.5) * cs;
    const cA = nodeColor(sim.ph[k], sim.sg[k], sim.R);
    for (const s of cardSlots(t, w.orient[k])) {
      const c = w.cornerIdx(x + SLOT_OFF[s][0], y + SLOT_OFF[s][1]);
      const cB = nodeColor(sim.ph[c], sim.sg[c], sim.R);
      const mid = [(cA[0] + cB[0]) / 2, (cA[1] + cB[1]) / 2, (cA[2] + cB[2]) / 2];
      line(mx, my, (x + SLOT_OFF[s][0]) * cs, (y + SLOT_OFF[s][1]) * cs, mid);
    }
  }
  if (damagePh) {                                  // magenta overlay where the twin differs
    const MG = [255, 40, 190];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = x + y * W, t = w.type[k];
      if (t === EMPTY || t === DOT) continue;
      const mx = (x + 0.5) * cs, my = (y + 0.5) * cs;
      const dA = sim.ph[k] !== damagePh[k];
      for (const s of cardSlots(t, w.orient[k])) {
        const c = w.cornerIdx(x + SLOT_OFF[s][0], y + SLOT_OFF[s][1]);
        if (!dA && sim.ph[c] === damagePh[c]) continue;
        line(mx, my, (x + SLOT_OFF[s][0]) * cs, (y + SLOT_OFF[s][1]) * cs, MG);
      }
    }
  }
  return { buf, IW, IH };
}

/* coarse "field" view: one filled block per cell, coloured by that neuron's state.
 * far more legible than the wire view when the lattice is large. */
function renderField(w, sim, cs, damagePh) {
  const IW = w.W * cs, IH = w.H * cs;
  const buf = Buffer.alloc(IW * IH * 3);
  for (let y = 0; y < w.H; y++) for (let x = 0; x < w.W; x++) {
    const k = x + y * w.W;
    let c;
    if (damagePh && sim.ph[k] !== damagePh[k]) c = [255, 40, 190];
    else if (w.type[k] === EMPTY) c = COL_BG;
    else if (w.type[k] === DOT) c = [24, 24, 30];
    else c = nodeColor(sim.ph[k], sim.sg[k], sim.R);
    for (let dy = 0; dy < cs; dy++) {
      let o = ((y * cs + dy) * IW + x * cs) * 3;
      for (let dx = 0; dx < cs; dx++) { buf[o++] = c[0] | 0; buf[o++] = c[1] | 0; buf[o++] = c[2] | 0; }
    }
  }
  return { buf, IW, IH };
}

// ---------------------------------------------------------------- PNG (zlib only)
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgb, W, H) {
  const zlib = require('zlib');
  const raw = Buffer.alloc(H * (W * 3 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = {
  mulberry32, cardSlots, SLOT_D, SLOT_OFF, DIAG, VEE, CROSS, DOT, EMPTY, ORIENTS,
  generateWiring, buildGraph, enumerateFaces, faceField, makeSim, makeSimLIF,
  seedRandom, seedBrokenWave, renderPPM, renderField, encodePNG,
};
