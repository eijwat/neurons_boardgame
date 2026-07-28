'use strict';
/* Re-render the movie set in the exact palettes used by neurons_selforg.html.
 * One simulation pass drives both palettes, so the two versions are frame-identical.
 *   node render_all.js [name ...]      (default: all)
 */
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'selforg_movies');
const TMP = path.join(__dirname, '.frames');
const FFMPEG = '/opt/homebrew/bin/ffmpeg';

/* palettes copied verbatim from neurons_selforg.html */
const PAL = {
  glow : {bg:[10,10,14],   rest:[38,38,48],   warm:[255,196,80], cool:[86,170,255], dot:[24,24,30],    fade:.6},
  paper: {bg:[253,251,244],rest:[230,224,210],warm:[206,84,26],  cool:[40,92,166],  dot:[236,230,216], fade:.85},
};
const DMG = [255,40,190];
function nodeCol(ph, sg, R, pal){
  if(ph===0) return pal.rest;
  if(ph===1) return sg>0?pal.warm:pal.cool;
  let f = 1-(ph-1)/Math.max(1,R); if(f<0)f=0; else if(f>1)f=1;
  const b = sg>0?pal.warm:pal.cool;
  return [pal.rest[0]+(b[0]-pal.rest[0])*f*pal.fade,
          pal.rest[1]+(b[1]-pal.rest[1])*f*pal.fade,
          pal.rest[2]+(b[2]-pal.rest[2])*f*pal.fade];
}
/* the far view of the app: one filled block per cell */
function renderField(E, w, sim, cs, pal, twinPh){
  const IW = w.W*cs, IH = w.H*cs, buf = Buffer.alloc(IW*IH*3);
  for(let y=0;y<w.H;y++) for(let x=0;x<w.W;x++){
    const k = x+y*w.W;
    let c;
    if(twinPh && sim.ph[k]!==twinPh[k]) c = DMG;
    else if(w.type[k]===E.EMPTY) c = pal.bg;
    else if(w.type[k]===E.DOT)   c = pal.dot;
    else c = nodeCol(sim.ph[k], sim.sg[k], sim.R, pal);
    for(let dy=0;dy<cs;dy++){
      let o = ((y*cs+dy)*IW + x*cs)*3;
      for(let dx=0;dx<cs;dx++){ buf[o++]=c[0]|0; buf[o++]=c[1]|0; buf[o++]=c[2]|0; }
    }
  }
  return {buf, IW, IH};
}

/* ---- the close-up view of the app: the actual card line segments and neurons.
   Coverage is computed analytically from the distance to each segment/disc, so the
   edges stay smooth at any zoom without supersampling. ---- */
function blend(buf,IW,IH,x,y,c,a){
  if(a<=0||x<0||y<0||x>=IW||y>=IH)return;
  if(a>1)a=1;
  const o=(y*IW+x)*3;
  buf[o]  =buf[o]  *(1-a)+c[0]*a;
  buf[o+1]=buf[o+1]*(1-a)+c[1]*a;
  buf[o+2]=buf[o+2]*(1-a)+c[2]*a;
}
function segment(buf,IW,IH,x0,y0,x1,y1,hw,c){
  const dx=x1-x0, dy=y1-y0, L2=dx*dx+dy*dy;
  const x_0=Math.floor(Math.min(x0,x1)-hw-1), x_1=Math.ceil(Math.max(x0,x1)+hw+1);
  const y_0=Math.floor(Math.min(y0,y1)-hw-1), y_1=Math.ceil(Math.max(y0,y1)+hw+1);
  for(let y=y_0;y<=y_1;y++)for(let x=x_0;x<=x_1;x++){
    let t=L2?((x-x0)*dx+(y-y0)*dy)/L2:0; if(t<0)t=0; else if(t>1)t=1;
    const px=x0+t*dx-x, py=y0+t*dy-y;
    blend(buf,IW,IH,x,y,c,hw+0.5-Math.sqrt(px*px+py*py));
  }
}
function disc(buf,IW,IH,cx,cy,r,c){
  for(let y=Math.floor(cy-r-1);y<=Math.ceil(cy+r+1);y++)
  for(let x=Math.floor(cx-r-1);x<=Math.ceil(cx+r+1);x++){
    const d=Math.hypot(x-cx,y-cy);
    blend(buf,IW,IH,x,y,c,r+0.5-d);
  }
}
function ring(buf,IW,IH,cx,cy,r,wdt,c){
  const o=r+wdt;
  for(let y=Math.floor(cy-o-1);y<=Math.ceil(cy+o+1);y++)
  for(let x=Math.floor(cx-o-1);x<=Math.ceil(cx+o+1);x++){
    const d=Math.abs(Math.hypot(x-cx,y-cy)-r);
    blend(buf,IW,IH,x,y,c,wdt/2+0.5-d);
  }
}
function renderWire(E, w, sim, o, pal, twinPh, paper){
  const cs=o.cs, VW=o.vw, VH=o.vh;
  const IW=VW*cs, IH=VH*cs, buf=Buffer.alloc(IW*IH*3);
  for(let i=0;i<IW*IH;i++){buf[i*3]=pal.bg[0];buf[i*3+1]=pal.bg[1];buf[i*3+2]=pal.bg[2];}
  const X0=o.vx|0, Y0=o.vy|0;
  const cell=(x,y)=>(((x%w.W)+w.W)%w.W)+(((y%w.H)+w.H)%w.H)*w.W;
  const face=paper?[255,253,247]:[20,20,26];
  const edge=paper?[0,0,0]:[255,255,255];
  for(let vy=0;vy<VH;vy++)for(let vx=0;vx<VW;vx++){
    const k=cell(X0+vx,Y0+vy); if(w.type[k]===E.EMPTY)continue;
    const px=vx*cs, py=vy*cs;
    for(let y=py+1;y<py+cs-1;y++)for(let x=px+1;x<px+cs-1;x++) blend(buf,IW,IH,x,y,face,1);
    for(let x=px+1;x<px+cs-1;x++){blend(buf,IW,IH,x,py+1,edge,.10);blend(buf,IW,IH,x,py+cs-2,edge,.10);}
    for(let y=py+1;y<py+cs-1;y++){blend(buf,IW,IH,px+1,y,edge,.10);blend(buf,IW,IH,px+cs-2,y,edge,.10);}
  }
  const col=(n)=>(twinPh&&sim.ph[n]!==twinPh[n])?DMG:nodeCol(sim.ph[n],sim.sg[n],sim.R,pal);
  const hw=Math.max(.6,cs/14);                       // half of cs/7, the app's line width
  for(let vy=0;vy<VH;vy++)for(let vx=0;vx<VW;vx++){
    const gx=X0+vx, gy=Y0+vy, k=cell(gx,gy), t=w.type[k];
    if(t===E.EMPTY||t===E.DOT)continue;
    const cA=col(k);
    for(const sl of E.cardSlots(t,w.orient[k])){
      const c=w.cornerIdx(gx+E.SLOT_OFF[sl][0],gy+E.SLOT_OFF[sl][1]);
      const cB=col(c);
      const cc=[(cA[0]+cB[0])/2,(cA[1]+cB[1])/2,(cA[2]+cB[2])/2];
      segment(buf,IW,IH,(vx+.5)*cs,(vy+.5)*cs,
              (vx+E.SLOT_OFF[sl][0])*cs,(vy+E.SLOT_OFF[sl][1])*cs,hw,cc);
    }
  }
  for(let vy=0;vy<VH;vy++)for(let vx=0;vx<VW;vx++){
    const k=cell(X0+vx,Y0+vy), t=w.type[k]; if(t===E.EMPTY)continue;
    const cx=(vx+.5)*cs, cy=(vy+.5)*cs, r=cs*.16;
    disc(buf,IW,IH,cx,cy,r, w.color[k]===0?(paper?[255,253,247]:[242,239,232]):(paper?[43,39,35]:[21,21,27]));
    ring(buf,IW,IH,cx,cy,r,Math.max(1,cs*.05),col(k));
  }
  return {buf,IW,IH};
}

/* ------------------------------------------------------------------ configs */
const BASE_FACE = {W:220,H:140,torus:true,p:1,S:0,dot:1/6,cross:0.6,q:0.8,theta:1,nu:0,g:0,wI:1,
                   faceA:2,faceAc:0,faceDur:24,faceRef:250,faceWin:12,R:20,seedMode:'rand',
                   cs:5,every:1,nFrames:260,fps:25,warm:2500,seed:302,site:0,damage:false};
const BASE_LIF  = {W:220,H:140,torus:true,p:1,S:0,dot:1/6,cross:0.75,q:0.9,R:4,theta:1.5,nu:0,g:0,wI:1,
                   frac:0.05,sub:0,vreset:0,refrMode:0,cornerLIF:1,leak:0.95,seedMode:'rand',
                   cs:5,every:1,nFrames:260,fps:25,warm:1500,seed:202,site:0,damage:false};

/* plain Greenberg-Hastings, no circuit feedback */
const BASE_GH = {W:220,H:140,torus:true,p:1,S:0,dot:1/6,cross:0.6,q:0.8,theta:1,nu:0,g:0,wI:1,
                 faceA:0,cs:5,every:1,nFrames:240,fps:25,warm:1500,seed:5,site:0,damage:false};

const CONFIGS = {
  spiral:      {eng:'base', o:Object.assign({},BASE_GH,{W:180,H:115,cross:0.7,q:1.0,R:14,
                               seedMode:'wave',cs:6,every:2,nFrames:200,warm:500,seed:5})},
  chaos:       {eng:'face', o:Object.assign({},BASE_FACE,{nFrames:240})},
  damage:      {eng:'face', o:Object.assign({},BASE_FACE,{seed:303,site:2,damage:true,every:6,nFrames:300})},
  ordered:     {eng:'face', o:Object.assign({},BASE_FACE,{faceA:0,nFrames:240})},
  chaos_short: {eng:'face', o:Object.assign({},BASE_FACE,{R:6,faceDur:8,warm:1500,seed:202,nFrames:240})},
  chaos_lif:   {eng:'lif',  o:Object.assign({},BASE_LIF,{})},
  damage_lif:  {eng:'lif',  o:Object.assign({},BASE_LIF,{damage:true,nFrames:300})},

  /* close-ups: 32x18 cells at 60 px, so every card and its lines are readable */
  wire_spiral: {eng:'face', o:Object.assign({},BASE_FACE,{faceA:0,q:0.90,seedMode:'wave',
                               view:'wire',cs:60,vw:32,vh:18,vx:94,vy:61,
                               every:1,fps:20,nFrames:240,warm:2400,seed:302})},
  wire_chaos:  {eng:'face', o:Object.assign({},BASE_FACE,{faceA:2,q:0.90,seedMode:'wave',
                               view:'wire',cs:60,vw:32,vh:18,vx:94,vy:61,
                               every:1,fps:20,nFrames:240,warm:2400,seed:302})},
  /* the printed deck, where the wiring is sparse and the card mix is the real one */
  wire_deck:   {eng:'face', o:Object.assign({},BASE_FACE,{cross:1/6,q:0.5,S:1,g:2,R:6,faceA:0,
                               view:'wire',cs:60,vw:32,vh:18,vx:94,vy:61,every:1,fps:20,
                               nFrames:240,warm:900,seed:302,seedMode:'rand',frac:0.005})},
};

function build(name){
  const cfg = CONFIGS[name], o = cfg.o;
  const dir = cfg.eng==='base' ? './engine.js'
            : cfg.eng==='lif'  ? './var_lif/engine.js' : './var_faceback/engine.js';
  const E = require(dir);
  const w = E.generateWiring({W:o.W,H:o.H,torus:true,p:o.p,strategy:o.S,dotFrac:o.dot,
                              crossFrac:o.cross,q:o.q,seed:o.seed,edgeOnly:false});
  const g = E.buildGraph(w);
  let mod = new Float32Array(w.N), topo = null;
  if(o.g!==0 || o.faceA){
    const f = E.enumerateFaces(w,g);
    if(o.g!==0) mod = E.faceField(w,g,f).mod;
    if(o.faceA && E.buildFaceTopo) topo = E.buildFaceTopo(w,f);
  }
  const par = {theta:o.theta,R:o.R,g:o.g,wI:o.wI,nu:0,rng:E.mulberry32(o.seed*7919+13),
               adaptA:0,adaptTau:30,RI:0,leak:o.leak,cornerLIF:o.cornerLIF,sub:o.sub,
               vreset:o.vreset,refrMode:o.refrMode,faceTopo:topo,faceA:o.faceA,faceAc:o.faceAc,
               faceDur:o.faceDur,faceRef:o.faceRef,faceWin:o.faceWin};
  const mk = () => cfg.eng==='lif' ? E.makeSimLIF(w,g,mod,par) : E.makeSim(w,g,mod,par);
  const sim = mk();
  if(o.seedMode==='rand') E.seedRandom(sim,w,E.mulberry32(o.seed*7919+13),o.frac||0.01);
  else E.seedBrokenWave(sim,w,o.R);
  for(let t=0;t<o.warm;t++) sim.step();

  let twin = null;
  if(o.damage){
    twin = mk();
    if(twin.copyFrom) twin.copyFrom(sim);
    else { twin.ph.set(sim.ph); twin.sg.set(sim.sg); twin.u.set(sim.u); twin.rlen.set(sim.rlen);
           if(sim.V) twin.V.set(sim.V); }
    const start = ((o.seed*2654435761 + o.site*40503)>>>0) % w.NC;
    for(let k=0;k<w.NC;k++){
      const j = (start + k*7919) % w.NC;
      if(!twin.live[j] || twin.ph[j]!==0) continue;
      let free=0;
      for(let e=g.start[j];e<g.start[j+1];e++) if(twin.ph[g.nbr[e]]===0) free++;
      if(!free) continue;
      twin.ph[j]=1; twin.sg[j]=twin.outSign[j]; break;
    }
  }
  return {E,w,g,sim,twin,o};
}

function render(name){
  const {E,w,sim,twin,o} = build(name);
  const dirs = {};
  for(const p of ['paper','glow']){
    dirs[p] = path.join(TMP, name+'_'+p);
    fs.rmSync(dirs[p],{recursive:true,force:true}); fs.mkdirSync(dirs[p],{recursive:true});
  }
  for(let f=0; f<o.nFrames; f++){
    for(const p of ['paper','glow']){
      const im = o.view==='wire'
        ? renderWire(E, w, sim, o, PAL[p], twin?twin.ph:null, p==='paper')
        : renderField(E, w, sim, o.cs, PAL[p], twin?twin.ph:null);
      fs.writeFileSync(path.join(dirs[p], `f${String(f).padStart(5,'0')}.png`),
                       E.encodePNG(im.buf, im.IW, im.IH));
    }
    for(let s=0;s<o.every;s++){ sim.step(); if(twin) twin.step(); }
  }
  let d = 0; if(twin) for(let i=0;i<w.N;i++) if(sim.ph[i]!==twin.ph[i]) d++;
  for(const p of ['paper','glow']){
    const od = path.join(OUT,p); fs.mkdirSync(od,{recursive:true});
    execFileSync(FFMPEG,['-y','-loglevel','error','-framerate',String(o.fps),
      '-i',path.join(dirs[p],'f%05d.png'),'-c:v','libx264','-pix_fmt','yuv420p','-crf','20',
      '-vf','scale=trunc(iw/2)*2:trunc(ih/2)*2', path.join(od,name+'.mp4')]);
    fs.rmSync(dirs[p],{recursive:true,force:true});
  }
  console.log(`${name.padEnd(13)} live=${String(sim.nLive).padStart(6)} activity=${String(sim.activity()).padStart(5)}` +
    (twin?`  damage=${(d/sim.nLive*100).toFixed(1)}%`:''));
}

const want = process.argv.slice(2);
const names = want.length ? want : Object.keys(CONFIGS);
fs.mkdirSync(TMP,{recursive:true});
for(const n of names) render(n);
fs.rmSync(TMP,{recursive:true,force:true});
console.log('\nwrote', OUT+'/paper', 'and', OUT+'/glow');
