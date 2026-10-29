'use strict';
/* The slides of the TV board. Each builder returns HTML for one screen. tv.js decides which one shows and when.
 * Everything here is sized in units (U, pixels per unit, set by tv.js), so any screen size and shape works.
 * Shows team and telecaller logins, calls and score only: no rupee amounts, customers or remarks. */
const COL=['var(--c1)','var(--c2)','var(--c3)','var(--c4)','var(--c5)'];
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=n=>Math.round(n||0).toLocaleString('en-IN');
const sc1=n=>(Math.round((n||0)*10)/10).toFixed(1);
const tcol=i=>COL[(i||0)%5];
const tone=x=>x>=80?'var(--green)':x>=60?'var(--amber)':'var(--red)';
const initials=n=>String(n||'').split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase();
const dayName=d=>new Date(d+'T12:00:00').toLocaleDateString('en-IN',{weekday:'short'});
const dayLong=d=>new Date(d+'T12:00:00').toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long'});
const pctOf=(a,b)=>b?Math.round(100*a/b):0;

/* set by tv.js: DATA (the board), U (pixels per unit), SLIDES */
let DATA=null, U=10;
const PORTRAIT=()=>innerHeight>innerWidth;
const todayBlank=()=>!DATA.working_today||!!(DATA.shift&&DATA.shift.early);
const teamObj=id=>(DATA.periods.week.teams||[]).find(t=>t.team_id===id);
const teamName=id=>{const t=teamObj(id);return t?t.team_name:''};

/** How many rows fit under a list header. The list starts about 28 units down the slide; each row takes 10. */
function rowsFit(extra){const H=innerHeight/U;return Math.max(3,Math.min(12,Math.floor((H-28-(extra||0))/10)))}
/** Splits a list into pages of equal size. An empty list is still one (empty) page. */
function pages(list,cap){
  if(!list.length)return [[]];
  const n=Math.ceil(list.length/cap),size=Math.ceil(list.length/n),out=[];
  for(let i=0;i<list.length;i+=size)out.push(list.slice(i,i+size));
  return out;
}

function slideWrap(kicker,title,body,side,cls){
  return `<section class="slide ${cls||''}"><header class="sh"><div><div class="kicker">${esc(kicker)}</div><h2>${esc(title)}</h2></div>${side?`<div class="side">${side}</div>`:''}</header><div class="sb">${body}</div></section>`;
}

/* small pieces */
function spark(vals,color){
  const w=300,h=100,v=vals.map(x=>x||0),max=Math.max(1,...v),min=Math.min(0,...v);
  const pts=v.map((x,i)=>[v.length<2?w/2:i*w/(v.length-1),h-8-(x-min)/(max-min||1)*(h-16)]);
  const d=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  const id='sg'+color.replace(/[^a-z0-9]/gi,'');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="${d} L${w} ${h} L0 ${h} Z" fill="url(#${id})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="4" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function ring(pct,color,label){
  const r=42,c=2*Math.PI*r,p=Math.max(0,Math.min(100,pct||0));
  return `<div class="ringwrap"><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="${r}" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="9"/><circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c*(1-p/100)}" transform="rotate(-90 50 50)"/></svg><b>${label}</b></div>`;
}

/* welcome: the first screen */
function welcomeSlide(){
  const T=DATA.periods.today, blank=todayBlank();
  const pres=blank?'–':`${T.totals.present} <small>of ${T.totals.members}</small>`;
  return `<section class="slide welcome">
    <div class="wl">
      <svg class="logo" viewBox="0 0 30 30" aria-hidden="true"><rect width="30" height="30" rx="7" fill="#F7B740"/><path d="M4 16h5l3-8 5 14 3-6h6" fill="none" stroke="#070B10" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <div class="kicker">Floor Pulse · ${esc(DATA.branch||'')}</div>
      <h1>${esc(dayLong(DATA.today))}</h1>
      <p>Logins, calls and scores for every team and telecaller, one topic at a time. The screen moves on by itself.</p>
    </div>
    <div class="chips">
      <div class="card chip"><span>Logged in today</span><b>${pres}</b></div>
      <div class="card chip"><span>Teams</span><b>${(T.teams||[]).length}</b></div>
      <div class="card chip"><span>Working days shown</span><b>${(DATA.series||[]).length}</b></div>
      <div class="card chip"><span>Shift</span><b>${esc(DATA.shift.start)}–${esc(DATA.shift.end)}</b></div>
    </div>
  </section>`;
}

/* today at a glance: four tiles with their trend or ring */
function kpiSlide(){
  const T=DATA.periods.today, L=T.totals, blank=todayBlank(), last=(DATA.series||[]).map(x=>x.totals);
  const tile=(lab,num,sub,extra)=>`<div class="card kt"><div><div class="kicker">${lab}</div><div class="kv">${num}</div><div class="ks">${sub}</div></div><div class="kr">${extra}</div></div>`;
  const cnt=v=>blank?'–':`<span data-count="${v||0}">${fmt(v)}</span>`;
  const score=blank?'–':`<span data-count="${L.score||0}" data-dec="1">${sc1(L.score)}</span><small>/100</small>`;
  return slideWrap('Today','At a glance',`<div class="kpis">
    ${tile('Logins',cnt(L.logins),'customer files logged in so far',spark(last.map(t=>t.logins),'#5C9CF5'))}
    ${tile('Calls',cnt(L.calls),'dialled across the floor so far',spark(last.map(t=>t.calls),'#F2B040'))}
    ${tile('Branch score',score,'against the target for this time of day',ring(blank?0:L.score,blank?'var(--mute)':tone(L.score),blank?'–':sc1(L.score)))}
    ${tile('Logged in',blank?'–':`<span data-count="${T.totals.present}">${T.totals.present}</span><small>of ${fmt(T.totals.members)}</small>`,'telecallers logged in today',ring(pctOf(T.totals.present,T.totals.members),'var(--green)',pctOf(T.totals.present,T.totals.members)+'%'))}
  </div>`,'','');
}

/* team race: teams ranked by score, today or over the last 7 working days */
function raceSlide(period){
  const P=DATA.periods[period], today=period==='today', blank=today&&todayBlank();
  const rows=P.teams.map((t,k)=>{
    const w=blank||!t.present?0:Math.min(100,t.score);
    return `<div class="tm${k===0?' first':''}" style="--tc:${tcol(t.index)}"><div class="rk">${t.rank}</div><div class="nm"><b>${esc(t.team_name)}</b><small>${esc(t.leader||'')} · ${fmt(t.members)} telecallers</small><div class="track"><div class="fill" style="width:${w}%"></div></div></div><div class="sc"><b style="color:${blank?'var(--mute)':tone(t.score)}">${blank||!t.present?'–':sc1(t.score)}</b><small>${fmt(t.logins)} logins · ${fmt(t.calls)} calls</small></div></div>`;
  }).join('');
  return slideWrap(today?'Today':'Last 7 working days','Team race',`<div class="race">${rows||'<div class="note">No teams yet.</div>'}</div>`,
    `<span>${today?'Score out of 100 so far':'Score out of 100, over 7 days'}</span>`);
}

/* top three telecallers today */
function podiumSlide(){
  const top=DATA.periods.today.people.slice(0,3);
  const order=[top[1],top[0],top[2]], hts=['82%','100%','66%'], ranks=[2,1,3];
  const cols=order.map((p,i)=>{
    if(!p)return '<div></div>';
    return `<div class="pod${ranks[i]===1?' one':''}" style="--h:${hts[i]}"><div class="prank">${p.rank}</div><div class="av" style="--tc:${tcol(p.team_index)}">${esc(initials(p.name))}</div><div><b>${esc(p.name)}</b><small>${esc(teamName(p.team_id))}</small></div><div class="psc" style="color:${tone(p.score)}">${sc1(p.score)}</div><div class="pst">${fmt(p.logins)} logins · ${fmt(p.calls)} calls</div></div>`;
  }).join('');
  return slideWrap('Today','Top three',`<div class="podium">${cols}</div>`,'<span>Ranked by score so far</span>');
}

/* telecaller board rows */
const boardHead=()=>`<div class="bcols thead"><span></span><span></span><span>Telecaller</span><span>Logins</span><span>Calls</span><span>Score</span></div>`;
function personRow(p,period){
  const today=period==='today', off=today&&!p.present;
  const sub=today?teamName(p.team_id):teamName(p.team_id)+' · '+p.present+' of '+DATA.series.length+' days';
  return `<div class="pr bcols${p.rank===1&&!off?' gold':''}${off?' off':''}"><span class="r">${p.rank}</span><span class="av" style="--tc:${tcol(p.team_index)}">${esc(initials(p.name))}</span><span class="nm"><b>${esc(p.name)}</b><small>${esc(sub)}</small></span>${off?'<span class="abs">Absent</span>':`<span class="n">${fmt(p.logins)}<small>logins</small></span><span class="n">${fmt(p.calls)}<small>calls</small></span><span class="sc" style="color:${tone(p.score)}">${sc1(p.score)}</span>`}</div>`;
}
function boardSlide(period,people,pg,total){
  const today=period==='today';
  return slideWrap(today?'Today':'Last 7 working days','Telecallers',
    `<div class="card pad">${boardHead()}<div class="list">${people.map(p=>personRow(p,period)).join('')}</div></div>`,
    `<span>${today?'Ranked by score so far':'Ranked by score, last 7 days'}</span><span>Page ${pg} of ${total}</span>`);
}

/* one team: its numbers on the left, its telecallers on the right */
function teamSlide(t,period,people,pg,total){
  const today=period==='today', P=DATA.periods[period], days=DATA.series.length;
  const stat=(lab,val,sub)=>`<div class="card tstat"><div class="kicker">${lab}</div><div class="kv">${val}</div><div class="ks">${sub}</div></div>`;
  const stats=today
    ?stat('Logins',fmt(t.logins),'customer files, so far')+stat('Calls',fmt(t.calls),'dialled, so far')+stat('Logged in',`${t.present}<small>of ${t.members}</small>`,'telecallers today')+stat('Score',`<span style="color:${tone(t.score)}">${sc1(t.score)}</span>`,'out of 100, so far')
    :stat('Logins',fmt(t.logins),'customer files, 7 days')+stat('Calls',fmt(t.calls),'dialled, 7 days')+stat('Present days',`${t.present}<small>of ${t.members*days}</small>`,'telecaller-days')+stat('Score',`<span style="color:${tone(t.score)}">${sc1(t.score)}</span>`,'out of 100, 7 days');
  return slideWrap(today?'Team · today':'Team · last 7 days',t.team_name,
    `<div class="teamgrid"><div class="tstats">${stats}</div><div class="card pad teamlist">${boardHead()}<div class="list">${people.map(p=>personRow(p,period)).join('')}</div></div></div>`,
    `<span>Leader ${esc(t.leader||'–')}</span><span>Branch rank #${t.rank}</span><span>Page ${pg} of ${total}</span>`);
}

/* who is logged in today, by team (counts only, no names) */
function presenceSlide(){
  const T=DATA.periods.today;
  const rows=T.teams.map(t=>`<div class="card prow"><div><b>${esc(t.team_name)}</b><small>Leader ${esc(t.leader||'–')}</small></div><div class="track"><div class="fill" style="width:${pctOf(t.present,t.members)}%;--tc:${tcol(t.index)}"></div></div><div class="pv">${t.present}<small> of ${t.members}</small></div></div>`).join('');
  return slideWrap('Today','Logged in',`<div class="pres">${rows}</div>`,`<span class="big">${T.totals.present} of ${T.totals.members}</span><span>telecallers logged in</span>`);
}

/* charts: the SVG is drawn after it is in the page, so it takes the real size of the screen */
function chartSlide(kind,kicker,title,side){
  return slideWrap(kicker,title,`<div class="card chartcard"><svg data-chart="${kind}" role="img" aria-label="${esc(title)}"></svg></div>`,side);
}
function trendSlide(){
  const legend=(DATA.periods.week.teams||[]).map(t=>`<span><i style="background:${tcol(t.index)}"></i>${esc(t.team_name)}</span>`).join('');
  return chartSlide('trend','Last 7 working days','Team scores',`<div class="legend">${legend}</div>`);
}
function barSlide(key){
  const S=DATA.series||[], total=S.reduce((a,d)=>a+(d.totals[key]||0),0);
  const title=key==='calls'?'Calls per day':'Logins per day';
  return chartSlide(key,'Branch · last 7 working days',title,`<span class="big">${fmt(total)}</span><span>${key==='calls'?'calls':'logins'} in 7 days</span>`);
}

/* highlights of the week */
function highlightsSlide(){
  const W=DATA.periods.week, S=DATA.series||[];
  const bestTeam=(W.teams||[])[0], top=(W.people||[])[0];
  const busy=S.slice().sort((a,b)=>b.totals.calls-a.totals.calls)[0];
  const bestDay=S.slice().sort((a,b)=>b.totals.score-a.totals.score)[0];
  const calls=S.reduce((a,d)=>a+(d.totals.calls||0),0), logins=S.reduce((a,d)=>a+(d.totals.logins||0),0);
  const card=(lab,big,num,sub)=>`<div class="card hcard"><div><div class="kicker">${lab}</div><div class="hbig">${big}</div></div><div><div class="hnum">${num}</div><div class="ks">${sub}</div></div></div>`;
  const body=`<div class="hl">
    ${card('Best team this week',bestTeam?esc(bestTeam.team_name):'–',bestTeam?sc1(bestTeam.score):'–','score out of 100, 7 days')}
    ${card('Top telecaller this week',top?esc(top.name):'–',top?sc1(top.score):'–',top?esc(teamName(top.team_id))+' · score out of 100':'')}
    ${card('Busiest day',busy?dayLong(busy.date):'–',busy?fmt(busy.totals.calls):'–','calls that day')}
    ${card('Best day for score',bestDay?dayLong(bestDay.date):'–',bestDay?sc1(bestDay.totals.score):'–','branch score that day')}
    ${card('Calls, 7 days',fmt(calls),'','dialled across the branch')}
    ${card('Logins, 7 days',fmt(logins),'','customer files logged in')}
  </div>`;
  return slideWrap('Last 7 working days','Highlights',body,'');
}

/* a plain screen for a day with no shift yet, or a Sunday */
function waitSlide(){
  const sunday=!DATA.working_today;
  const title=sunday?'No shift today':'Waiting for the shift';
  const line=sunday?'Enjoy the day off.':'The shift starts at '+esc(DATA.shift.start)+'.';
  return slideWrap('Today',title,`<div class="card wait"><h3>${line}</h3><p>Today's boards appear once people start logging in. The last 7 working days follow.</p></div>`,'');
}

/* Builds the whole list of slides from the current board. Keys let tv.js keep its place on refresh. */
function buildSlides(){
  const T=DATA.periods.today, W=DATA.periods.week;
  const out=[{key:'welcome',label:'Welcome',html:welcomeSlide()}];
  if(todayBlank()){
    out.push({key:'today-wait',label:'Today',html:waitSlide()});
  }else{
    out.push({key:'kpi-today',label:'Today at a glance',html:kpiSlide()});
    out.push({key:'race-today',label:'Team race · today',html:raceSlide('today')});
    out.push({key:'podium',label:'Top three · today',html:podiumSlide()});
    const pg=pages(T.people,rowsFit(0));
    pg.forEach((p,i)=>out.push({key:'board-'+(i+1),label:'Telecallers · today, page '+(i+1)+' of '+pg.length,html:boardSlide('today',p,i+1,pg.length)}));
    T.teams.forEach(t=>{
      const mem=T.people.filter(p=>p.team_id===t.team_id), tp=pages(mem,rowsFit(PORTRAIT()?42:0));
      tp.forEach((p,i)=>out.push({key:'team-'+t.team_id+'-'+(i+1),label:t.team_name+' · today',html:teamSlide(t,'today',p,i+1,tp.length)}));
    });
    out.push({key:'presence',label:'Logged in · today',html:presenceSlide()});
  }
  out.push({key:'race-week',label:'Team race · 7 days',html:raceSlide('week')});
  out.push({key:'trend',label:'Team scores · 7 days',html:trendSlide()});
  out.push({key:'calls',label:'Calls per day',html:barSlide('calls')});
  out.push({key:'logins',label:'Logins per day',html:barSlide('logins')});
  const wp=pages(W.people,rowsFit(0));
  wp.forEach((p,i)=>out.push({key:'week-board-'+(i+1),label:'Telecallers · 7 days, page '+(i+1)+' of '+wp.length,html:boardSlide('week',p,i+1,wp.length)}));
  out.push({key:'highlights',label:'Highlights · 7 days',html:highlightsSlide()});
  return out;
}

/* ---- chart drawing (called after the slide is in the page) ---- */
function svgT(x,y,s,anchor,css){return `<text x="${x}" y="${y}" text-anchor="${anchor||'middle'}" style="font:700 ${css.size}px var(--mono);fill:var(--mute)">${s}</text>`}

function drawChart(svg){
  const kind=svg.dataset.chart, S=DATA.series||[];
  const W=svg.clientWidth, H=svg.clientHeight;
  if(!W||!H||!S.length){svg.innerHTML='';return}
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
  const fs=U*2.4;
  if(kind==='trend')return trendDraw(svg,S,W,H,fs);
  return barDraw(svg,S,W,H,fs,kind);
}

function trendDraw(svg,S,W,H,fs){
  const teams=DATA.periods.week.teams||[], n=S.length;
  const pl=U*9, pr=U*34, pt=U*5, pb=U*7;
  const all=[];S.forEach(d=>d.teams.forEach(t=>{if(t.present&&(t.logins||t.calls))all.push(t.score)}));
  const minv=all.length?Math.min(...all):0;
  const lo=Math.max(0,Math.floor(minv/10)*10-10), span=100-lo;
  const x=i=>pl+(n<2?(W-pl-pr)/2:i*((W-pl-pr)/(n-1)));
  // the score axis runs from lo (a little below the lowest score) up to 100
  const yv=v=>pt+(H-pt-pb)*(1-(Math.max(lo,Math.min(100,v))-lo)/span);
  let g='';
  for(let k=0;k<=4;k++){
    const v=Math.round(lo+span*k/4), yy=yv(v);
    g+=`<line x1="${pl}" x2="${W-pr+U*12}" y1="${yy}" y2="${yy}" stroke="rgba(255,255,255,.08)" stroke-width="2"/>`+svgT(pl-U*1.5,yy+fs*.35,v,'end',{size:fs});
  }
  S.forEach((d,i)=>{g+=svgT(x(i),H-U*2.5,dayName(d.date),'middle',{size:fs})});
  const ends=[];
  teams.forEach(t=>{
    const pts=S.map((d,i)=>{const tt=d.teams.find(q=>q.team_id===t.team_id);return tt&&tt.present&&(tt.logins||tt.calls)?[x(i),yv(tt.score)]:null});
    const runs=[];let cur=[];
    pts.forEach(p=>{if(p)cur.push(p);else if(cur.length){runs.push(cur);cur=[]}});
    if(cur.length)runs.push(cur);
    if(!runs.length)return;
    const c=tcol(t.index);
    runs.forEach(run=>{
      g+=`<path d="${run.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ')}" fill="none" stroke="${c}" stroke-width="${(U*.45).toFixed(2)}" stroke-linejoin="round" stroke-linecap="round"/>`;
      run.forEach(p=>{g+=`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${(U*.7).toFixed(2)}" fill="#070B10" stroke="${c}" stroke-width="${(U*.35).toFixed(2)}"/>`});
    });
    const last=runs[runs.length-1][runs[runs.length-1].length-1];
    ends.push({name:t.team_name,c,x:last[0],y:last[1]});
  });
  ends.sort((a,b)=>a.y-b.y);
  for(let i=1;i<ends.length;i++){if(ends[i].y-ends[i-1].y<fs*1.7)ends[i].y=ends[i-1].y+fs*1.7}
  ends.forEach(e=>{g+=`<text x="${(e.x+U*1.4).toFixed(1)}" y="${(e.y+fs*.35).toFixed(1)}" style="font:800 ${(fs*1.25).toFixed(1)}px var(--font);fill:${e.c}">${esc(e.name)}</text>`});
  svg.innerHTML=g;
}

function barDraw(svg,S,W,H,fs,key){
  const pl=U*9, pr=U*3, pt=U*6, pb=U*7;
  const vals=S.map(d=>d.totals[key]||0), max=Math.max(1,...vals), n=S.length;
  const slot=(W-pl-pr)/n, bw=Math.min(U*14,slot*.6);
  let g='';
  [0,.5,1].forEach(f=>{
    const yy=pt+(H-pt-pb)*(1-f);
    g+=`<line x1="${pl}" x2="${W-pr}" y1="${yy}" y2="${yy}" stroke="rgba(255,255,255,.08)" stroke-width="2"/>`+svgT(pl-U*1.2,yy+fs*.35,fmt(max*f),'end',{size:fs});
  });
  S.forEach((d,i)=>{
    const v=vals[i], h=(H-pt-pb)*(v/max), cx=pl+slot*i+slot/2, y0=H-pb-h, last=i===n-1;
    g+=`<defs><linearGradient id="bg${key}${i}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${last?'#FFD27A':'#F2B040'}"/><stop offset="1" stop-color="${last?'#F7B740':'#B9781A'}" stop-opacity=".75"/></linearGradient></defs>`;
    g+=`<rect x="${(cx-bw/2).toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(2,h).toFixed(1)}" rx="${U.toFixed(1)}" fill="url(#bg${key}${i})"/>`;
    g+=`<text x="${cx.toFixed(1)}" y="${(y0-U).toFixed(1)}" text-anchor="middle" style="font:800 ${(fs*1.2).toFixed(1)}px var(--mono);fill:${last?'#FFD27A':'#EEF3F8'}">${fmt(v)}</text>`;
    g+=svgT(cx.toFixed(1),H-U*2.5,dayName(d.date),'middle',{size:fs});
  });
  svg.innerHTML=g;
}
