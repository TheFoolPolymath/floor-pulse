'use strict';
/* The TV board controller. It loads the board, shows one slide at a time and moves on by itself.
 *   Live:  tv.html?k=<TV link key>      reads the board from the Floor Pulse server.
 *   Demo:  tv.html?demo                 reads public/data/tv.json (made from public/data/mock.json).
 * Optional: ?s=20 sets the seconds per slide (5 to 120, default 15).
 * Keys: Right/Left = next/previous, Space = pause or play, F = full screen. */
const Q=new URLSearchParams(location.search);
const KEY=Q.get('k')||'', DEMO=Q.has('demo');
const API=(window.FP_CONFIG&&FP_CONFIG.API_URL)||'/api';
const ROTATE_MS=Math.min(120,Math.max(5,Number(Q.get('s'))||15))*1000;
const REFRESH_MS=60000;

let SLIDES=[], IDX=0, ELAPSED=0, PAUSED=false, STOP=false, LAST_T=performance.now();

/* units: the screen is a 192 x 108 canvas (landscape) or 108 x 192 (portrait); U is the pixels in one unit */
function setUnit(){
  const w=innerWidth, h=innerHeight;
  U=h>w?Math.min(w/108,h/192):Math.min(w/192,h/108);
  document.documentElement.style.setProperty('--u',U.toFixed(3)+'px');
}

function msg(t){const m=$('msg');m.textContent=t||'';m.classList.toggle('on',!!t)}
function gone(text){STOP=true;document.body.innerHTML='<div class="gone"><div><h1>Floor Pulse</h1><p>'+esc(text)+'</p></div></div>'}

/* load the board: live from the server, or the demo file */
async function load(){
  if(STOP)return;
  try{
    let d;
    if(DEMO){
      const r=await fetch('data/tv.json',{cache:'no-store'});
      d=await r.json();
    }else{
      const r=await fetch(API,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'tv',key:KEY})});
      const text=await r.text();
      try{d=JSON.parse(text)}catch(e){
        if(!DATA){gone('Live numbers are not available from this address. Open the TV link from the Floor Pulse app, or add ?demo to this page to see the demo board.');return}
        throw e;
      }
    }
    if(d.error){gone(d.message||'The TV display is not available.');return}
    DATA=d;
    $('brand').textContent=d.branch||'';
    render();
  }catch(e){
    msg('Connection lost. Trying again…');
    setTimeout(()=>msg(''),4000);
  }
}

/* rebuild the slide list from the board and keep the screen on the same slide where possible */
function render(){
  if(!DATA)return;
  const keep=SLIDES[IDX]?SLIDES[IDX].key:'';
  SLIDES=buildSlides();
  const i=SLIDES.findIndex(s=>s.key===keep);
  IDX=i>=0?i:Math.min(IDX,SLIDES.length-1);
  paint(false);
}

/* show the current slide. enter=true plays the entrance animation and counts numbers up */
function paint(enter){
  const s=SLIDES[IDX];
  if(!s)return;
  const st=$('stage');
  st.innerHTML=s.html;
  st.classList.toggle('enter',!!enter);
  st.querySelectorAll('svg[data-chart]').forEach(drawChart);
  if(enter)countUp(st);
  $('lbl').textContent=s.label;
  $('pos').textContent=(IDX+1)+' / '+SLIDES.length;
  $('demoTag').hidden=!DATA.demo;
  $('pause').textContent=PAUSED?'Play':'Pause';
}

function countUp(root){
  root.querySelectorAll('[data-count]').forEach(el=>{
    const to=Number(el.dataset.count), dec=el.dataset.dec==='1', t0=performance.now(), dur=1100;
    (function f(now){
      const p=Math.min(1,(now-t0)/dur), v=to*(1-Math.pow(1-p,3));
      el.textContent=dec?v.toFixed(1):fmt(v);
      if(p<1)requestAnimationFrame(f);
    })(t0);
  });
}

function go(step){
  if(!SLIDES.length)return;
  IDX=(IDX+step+SLIDES.length)%SLIDES.length;
  ELAPSED=0;
  paint(true);
}

function togglePause(){PAUSED=!PAUSED;$('pause').textContent=PAUSED?'Play':'Pause'}

/* the clock and the automatic move to the next slide */
function tick(){
  if(STOP)return;
  const now=performance.now(), dt=Math.min(500,now-LAST_T);
  LAST_T=now;
  $('clk').textContent=new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Kolkata'});
  if(!PAUSED&&SLIDES.length){
    ELAPSED+=dt;
    if(ELAPSED>=ROTATE_MS)go(1);
  }
  $('prog').style.width=Math.min(100,100*ELAPSED/ROTATE_MS).toFixed(1)+'%';
}

async function keepAwake(){try{if('wakeLock' in navigator)await navigator.wakeLock.request('screen')}catch(e){}}
function toggleFs(){const el=document.documentElement;if(document.fullscreenElement)document.exitFullscreen();else if(el.requestFullscreen)el.requestFullscreen().catch(()=>{})}

$('prev').addEventListener('click',()=>go(-1));
$('next').addEventListener('click',()=>go(1));
$('pause').addEventListener('click',togglePause);
$('fs').addEventListener('click',toggleFs);
document.addEventListener('keydown',e=>{
  if(e.key==='ArrowRight'||e.key==='PageDown')go(1);
  else if(e.key==='ArrowLeft'||e.key==='PageUp')go(-1);
  else if(e.key===' '){e.preventDefault();togglePause()}
  else if(e.key==='f'||e.key==='F')toggleFs();
});
let RT=null;
window.addEventListener('resize',()=>{clearTimeout(RT);RT=setTimeout(()=>{setUnit();if(DATA)render()},150)});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){keepAwake();load()}});

setUnit();
if(!DEMO&&!KEY){gone('This screen needs a TV link. Ask your admin for one, or add ?demo to this page to see the demo board.')}
else{
  load();
  setInterval(load,REFRESH_MS);
  setInterval(tick,200);
  keepAwake();
  tick();
}
