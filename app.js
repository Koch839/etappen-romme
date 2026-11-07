/* Spielhafen – Etappen-Rommé & Schiffe versenken: Spiellogik, Online-Modus (verschlüsselt über MQTT) und Oberfläche */
(function(){
'use strict';
const APP_VERSION='1.10.1';
const PROTO=8;                  // Netzwerk-Protokoll; Gastgeber und Mitspieler müssen gleich sein
const CODE_LEN=8;                    // Raum-Code, angezeigt als XXXX-XXXX
const MAX_CONNS=12;                  // Spieler + Zuschauer pro Raum
const MAX_MSG_PER_SEC=25;
// Öffentliche MQTT-Server. Beide werden gleichzeitig genutzt; fällt einer aus, läuft es über den anderen.
// Sie sehen nur verschlüsselte Daten.
const BROKERS=['wss://broker.hivemq.com:8884/mqtt','wss://broker.emqx.io:8084/mqtt'];
const TOPIC_ROOT='etappen-romme/v3/';

const COLOR_NAMES=['Rot','Blau','Grün','Gelb'];
const COLOR_SYM=['●','■','▲','◆'];
const PHASES=[
  {t:'2 Drillinge',                    g:[['set',3],['set',3]]},
  {t:'1 Folge von 5 + 1 Zwilling',     g:[['run',5],['set',2]]},
  {t:'3 Zwillinge',                    g:[['set',2],['set',2],['set',2]]},
  {t:'1 Vierling + 1 Folge von 4',     g:[['set',4],['run',4]]},
  {t:'6 Karten einer Farbe',           g:[['color',6]]},
  {t:'1 Folge von 7',                  g:[['run',7]]},
  {t:'1 Drilling + 5 Karten einer Farbe', g:[['set',3],['color',5]]},
  {t:'2 Vierlinge',                    g:[['set',4],['set',4]]},
  {t:'1 Folge von 8',                  g:[['run',8]]},
  {t:'1 Fünfling + 1 Folge von 5',     g:[['set',5],['run',5]]},
];
const GNAME={set:n=>({2:'Zwilling',3:'Drilling',4:'Vierling',5:'Fünfling'}[n]||n+' Gleiche'), run:n=>'Folge von '+n, color:n=>n+' einer Farbe'};
const $=id=>document.getElementById(id);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const LS_KEYS=['etappen-name','etappen-token','etappen-setup','etappen-host','etappen-last','etappen-avatar','etappen-theme','etappen-anim','etappen-setup-sv','etappen-setup-mm','etappen-mmrules','etappen-mmsel'];
const lsGet=k=>{try{return localStorage.getItem(k);}catch(e){return null;}};
const lsSet=(k,v)=>{try{localStorage.setItem(k,v);}catch(e){}};
const lsDel=k=>{try{localStorage.removeItem(k);}catch(e){}};

/* ---------- sicherer Zufall ---------- */
function randInt(n){ // gleichverteilt 0..n-1 aus crypto
  const max=Math.floor(0x100000000/n)*n, buf=new Uint32Array(1);
  let x; do{ crypto.getRandomValues(buf); x=buf[0]; }while(x>=max);
  return x%n;
}
function randHex(bytes){ const b=new Uint8Array(bytes); crypto.getRandomValues(b); return Array.from(b,x=>x.toString(16).padStart(2,'0')).join(''); }

/* ---------- Eingaben bereinigen (alles, was übers Netz kommt) ---------- */
const int=(x,lo,hi,d)=>{ x=Math.trunc(Number(x)); return Number.isFinite(x)&&x>=lo&&x<=hi?x:d; };
const str=(s,max)=>String(s==null?'':s).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g,'').trim().slice(0,max);
function cleanCard(c){
  if(!c||typeof c!=='object'||!['n','j','s','x'].includes(c.k)) return null;
  const o={id:int(c.id,0,1e6,0),k:c.k};
  if(c.k==='n'){ o.n=int(c.n,1,12,1); o.c=int(c.c,0,3,0); }
  return o;
}
function cleanGroup(g){
  if(!g||typeof g!=='object'||!['set','run','color'].includes(g.type)) return null;
  const o={type:g.type,cards:(Array.isArray(g.cards)?g.cards:[]).slice(0,40).map(cleanCard).filter(Boolean)};
  if(g.type==='run'){ o.lo=int(g.lo,1,12,1); o.hi=int(g.hi,1,12,12); } else o.val=int(g.val,0,12,0);
  return o;
}
function sanitizeView(v){
  if(!v||typeof v!=='object'||!Array.isArray(v.players)||!v.players.length) return null;
  const players=v.players.slice(0,6).map(p=>{ p=p&&typeof p==='object'?p:{}; return {
    name:str(p.name,16)||'?', ai:!!p.ai, off:!!p.off, av:cleanAv(p.av), phase:int(p.phase,0,10,0), score:int(p.score,0,1e6,0), skip:int(p.skip,0,10,0),
    hand:(Array.isArray(p.hand)?p.hand:[]).slice(0,60).map(cleanCard).filter(Boolean),
    laid:Array.isArray(p.laid)?p.laid.slice(0,3).map(cleanGroup).filter(Boolean):null }; });
  const n=players.length, s=v.summary&&typeof v.summary==='object'?v.summary:null;
  return {
    players, deck:[], deckN:int(v.deckN,0,200,0),
    disc:(Array.isArray(v.disc)?v.disc:[]).slice(-150).map(cleanCard).filter(Boolean),
    cur:int(v.cur,0,n-1,0), dealer:int(v.dealer,0,n-1,0), round:int(v.round,0,1e4,1),
    stage:['draw','play','over'].includes(v.stage)?v.stage:'draw',
    log:(Array.isArray(v.log)?v.log:[]).slice(-40).map(t=>str(t,200)),
    over:!!v.over,
    summary:s?{wi:int(s.wi,0,n-1,0), winner:s.winner==null?null:int(s.winner,0,n-1,null),
      rows:(Array.isArray(s.rows)?s.rows:[]).slice(0,6).map(r=>{ r=r&&typeof r==='object'?r:{}; return {name:str(r.name,16),done:!!r.done,add:int(r.add,0,1e4,0),phase:int(r.phase,0,10,0),total:int(r.total,0,1e6,0)}; })}:null
  };
}
function sanitizeAction(a){
  if(!a||typeof a!=='object') return null;
  const type=str(a.type,10);
  return {type, ids:Array.isArray(a.ids)?a.ids.slice(0,12).map(x=>int(x,0,1e6,-1)):[],
    groups:Array.isArray(a.groups)?a.groups.slice(0,3).map(g=>Array.isArray(g)?g.slice(0,12).map(x=>int(x,0,1e6,-1)):[]):null, id:int(a.id,0,1e6,-1), pi:int(a.pi,0,5,-1), gi:int(a.gi,0,2,-1), target:int(a.target,0,5,-1)};
}

/* ---------- state ----------
   mode 'local'  : alles auf diesem Gerät
   mode 'host'   : dieses Gerät ist Gastgeber und hat den vollen Spielstand
   mode 'client' : G ist nur die Sicht, die der Gastgeber schickt (fremde Hände verdeckt) */
let G=null, mode='local';
let sel=new Set(), viewer=null, covered=false, sortMode='num', aiBusy=false, ovKey='';
let myName=str(lsGet('etappen-name'),16);
let myAv=null; // wird nach den Hilfsfunktionen geladen (siehe loadAvatar)
let myTok=lsGet('etappen-token'); if(!myTok||!/^[0-9a-f]{32}$/.test(myTok)){ myTok=randHex(16); lsSet('etappen-token',myTok); }
let HOST=null;     // {code, keys, ecdh, status, seats:[{tok,name,ai}], clients:Map}
let CLIENT=null;   // {code, keys, ecdh, cid, key, you, lobby, hostName, lastHost, sn, seq, pending}
let NET=null;      // Verbindung zu den MQTT-Servern
let hostTimer=null, clientTimer=null;

/* ---------- cards ---------- */
function makeDeck(){
  const d=[]; let id=0;
  for(let c=0;c<4;c++) for(let n=1;n<=12;n++) for(let k=0;k<2;k++) d.push({id:++id,k:'n',n,c});
  for(let i=0;i<8;i++) d.push({id:++id,k:'j'});
  for(let i=0;i<4;i++) d.push({id:++id,k:'s'});
  return shuffle(d);
}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=randInt(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
const pts=c=>c.k==='j'?25:c.k==='s'?15:(c.n<=9?5:10);
const ckey=c=>c.k==='n'?('n'+c.n+'-'+c.c):c.k;
function cardHTML(c,cls='',attrs=''){
  if(!c) return `<div class="card empty ${cls}" ${attrs}></div>`;
  if(c.k==='j') return `<button class="card j ${cls}" ${attrs} aria-label="Joker"><span class="n">★</span><span class="lbl">Joker</span></button>`;
  if(c.k==='s') return `<button class="card sk ${cls}" ${attrs} aria-label="Aussetzen"><span class="n">⊘</span><span class="lbl">Aussetzen</span></button>`;
  const n=int(c.n,1,12,1), col=int(c.c,0,3,0);
  return `<button class="card c${col} ${cls}" ${attrs} aria-label="${n} ${COLOR_NAMES[col]}"><span class="tl">${n}</span><span class="n">${n}</span><span class="s">${COLOR_SYM[col]}</span></button>`;
}

/* ---------- Charaktere (eigene Figuren, alles selbst gezeichnet) ---------- */
const AV_PARTS={b:8,c:10,e:7,m:6,h:10,g:8,k:8};
const AV_ORDER=['b','c','e','m','h','g','k'];
const AV_LABEL={b:'Figur',c:'Farbe',e:'Augen',m:'Mund',h:'Extra',g:'Hintergrund',k:'Kartenrücken'};
const AV_NAMES={b:['Blob','Katze','Bär','Roboter','Geist','Monster','Frosch','Pinguin'],
  c:['Rot','Orange','Gelb','Grün','Türkis','Blau','Indigo','Lila','Rosa','Grau'],
  e:['Kulleraugen','Fröhlich','Müde','Sterne','Sonnenbrille','Zwinkern','Staunen'],
  m:['Lächeln','Grinsen','Oh!','Zunge','Ernst','Vampir'],
  h:['Nichts','Krone','Partyhut','Kappe','Kopfhörer','Schleife','Zauberhut','Hörner','Blume','Heiligenschein'],
  g:['Nachtblau','Wald','Beere','Kirsche','Kürbis','Lagune','Schiefer','Wolke'],
  k:['Spieltisch','Kirsche','Ozean','Galaxie','Gold','Carbon','Regenbogen','Bonbon']};
/* Kartenrücken im eigenen Design (andere sehen deine Karten so) */
const backOf=(av,cls='')=>`<div class="card back bk${int(av&&av.k,0,7,0)} ${cls}"></div>`;
/* Fächer aus Rückseiten – zeigt, wie viele Karten jemand hat */
function backFanHTML(n,av){
  const shown=Math.min(n,10);
  return `<div class="bfan" data-n="${shown}">${Array.from({length:shown},()=>backOf(av,'fc')).join('')}<span class="bcnt">${n}</span></div>`;
}
/* Sitzplätze im Halbkreis um den Tisch anordnen und die Fächer auffächern (per CSSOM, ohne Inline-Styles) */
function layoutTable(root){
  if(!root) return;
  root.querySelectorAll('.seat.me').forEach(el=>{ el.style.left='50%'; el.style.top='100%'; });
  const seats=[...root.querySelectorAll('.seat:not(.me)')], m=seats.length;
  seats.forEach((el,i)=>{
    const a=(m===1?270:(m===2?[215,325][i]:200+i*(140/(m-1))))*Math.PI/180;
    el.style.left=(50+44*Math.cos(a)).toFixed(1)+'%';
    el.style.top=(56+47*Math.sin(a)).toFixed(1)+'%';
  });
  root.querySelectorAll('.bfan').forEach(f=>{
    const cs=[...f.querySelectorAll('.fc')], k=cs.length, step=k>1?Math.min(11,70/(k-1)):0;
    cs.forEach((c,i)=>{ const o=i-(k-1)/2; c.style.transform=`translateX(${(o*7).toFixed(1)}px) rotate(${(o*step).toFixed(1)}deg)`; c.style.zIndex=i; });
  });
}
/* Reihenfolge der Gegner: der nächste Spieler sitzt links, dann im Uhrzeigersinn */
function opponents(n,me){ const out=[]; for(let k=1;k<=n;k++){ const i=me==null?k-1:(me+k)%n; if(i!==me) out.push(i); } return me==null?out.slice(0,n):out; }
const AV_BODY=['#ff6b6b','#ffa94d','#ffd43b','#69db7c','#38d9a9','#4dabf7','#748ffc','#da77f2','#f783ac','#ced4da'];
const AV_BG=['#1e3a5f','#2b8a3e','#862e9c','#c92a2a','#e67700','#0b7285','#343a40','#dbe4ff'];
function cleanAv(a){ a=a&&typeof a==='object'?a:{}; const o={}; for(const k of AV_ORDER) o[k]=int(a[k],0,AV_PARTS[k]-1,0); return o; }
function randomAv(){ const o={}; for(const k of AV_ORDER) o[k]=randInt(AV_PARTS[k]); return o; }
function starPath(cx,cy,R,r){ let d=''; for(let i=0;i<10;i++){ const a=Math.PI/5*i-Math.PI/2, rr=i%2?r:R; d+=(i?'L':'M')+(cx+rr*Math.cos(a)).toFixed(1)+' '+(cy+rr*Math.sin(a)).toFixed(1); } return d+'Z'; }
function avatarSVG(av,size=40,cls='av'){
  const a=cleanAv(av), col=AV_BODY[a.c], ink='#1d1b26', S=`stroke="${ink}" stroke-width="2.5" stroke-linejoin="round"`;
  const line=(d,w=3,c=ink)=>`<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`;
  let body='';
  switch(a.b){
    case 0: body=`<path d="M22 70 C18 44 32 30 50 30 C68 30 82 44 78 70 C76 84 24 84 22 70Z" fill="${col}" ${S}/>`; break;
    case 1: body=`<path d="M28 42 L29 18 L46 32 Z M72 42 L71 18 L54 32 Z" fill="${col}" ${S}/><circle cx="50" cy="58" r="27" fill="${col}" ${S}/>`; break;
    case 2: body=`<circle cx="29" cy="36" r="10" fill="${col}" ${S}/><circle cx="71" cy="36" r="10" fill="${col}" ${S}/><circle cx="50" cy="58" r="27" fill="${col}" ${S}/><ellipse cx="50" cy="70" rx="12" ry="8" fill="#fff" opacity=".5"/>`; break;
    case 3: body=`${line('M50 30 L50 20',2.5)}<circle cx="50" cy="17" r="4" fill="#ff6b6b" ${S}/><rect x="18" y="48" width="8" height="14" rx="2" fill="${col}" ${S}/><rect x="74" y="48" width="8" height="14" rx="2" fill="${col}" ${S}/><rect x="24" y="30" width="52" height="50" rx="10" fill="${col}" ${S}/>`; break;
    case 4: body=`<path d="M24 84 L24 56 C24 38 36 30 50 30 C64 30 76 38 76 56 L76 84 L67 77 L59 84 L50 77 L41 84 L33 77 Z" fill="${col}" ${S}/>`; break;
    case 5: body=`<path d="M26 46 L31 30 L38 40 L44 25 L50 37 L56 25 L62 40 L69 30 L74 46 Z" fill="${col}" ${S}/><circle cx="50" cy="60" r="26" fill="${col}" ${S}/>`; break;
    case 6: body=`<circle cx="36" cy="42" r="11" fill="${col}" ${S}/><circle cx="64" cy="42" r="11" fill="${col}" ${S}/><ellipse cx="50" cy="63" rx="30" ry="21" fill="${col}" ${S}/>`; break;
    case 7: body=`<ellipse cx="50" cy="58" rx="27" ry="28" fill="${col}" ${S}/><ellipse cx="50" cy="66" rx="16" ry="17" fill="#fff"/>`; break;
  }
  const frog=a.b===6, ey=frog?42:54, lx=frog?36:40, rx=frog?64:60, my=frog?68:70;
  const dot=x=>`<circle cx="${x}" cy="${ey}" r="6" fill="#fff" ${S}/><circle cx="${x+1}" cy="${ey+1}" r="3" fill="${ink}"/>`;
  const arc=x=>line(`M${x-6} ${ey+2} Q${x} ${ey-6} ${x+6} ${ey+2}`);
  let eyes='';
  switch(a.e){
    case 0: eyes=dot(lx)+dot(rx); break;
    case 1: eyes=arc(lx)+arc(rx); break;
    case 2: eyes=[lx,rx].map(x=>line(`M${x-6} ${ey} L${x+6} ${ey}`)+line(`M${x-6} ${ey} Q${x} ${ey+6} ${x+6} ${ey}`,2)).join(''); break;
    case 3: eyes=[lx,rx].map(x=>`<path d="${starPath(x,ey,7.5,3.2)}" fill="#ffd43b" ${S}/>`).join(''); break;
    case 4: eyes=`<rect x="${lx-9}" y="${ey-6}" width="18" height="11" rx="4" fill="${ink}"/><rect x="${rx-9}" y="${ey-6}" width="18" height="11" rx="4" fill="${ink}"/>${line(`M${lx+9} ${ey-2} L${rx-9} ${ey-2}`)}${line(`M${lx-5} ${ey-3} L${lx-1} ${ey-3}`,2,'#fff')}${line(`M${rx-5} ${ey-3} L${rx-1} ${ey-3}`,2,'#fff')}`; break;
    case 5: eyes=dot(lx)+arc(rx); break;
    case 6: eyes=[lx,rx].map(x=>`<circle cx="${x}" cy="${ey}" r="8" fill="#fff" ${S}/><circle cx="${x}" cy="${ey-2}" r="4" fill="${ink}"/><circle cx="${x+1.5}" cy="${ey-3.5}" r="1.4" fill="#fff"/>`).join(''); break;
  }
  const smile=line(`M42 ${my} Q50 ${my+8} 58 ${my}`);
  let mouth='';
  switch(a.m){
    case 0: mouth=smile; break;
    case 1: mouth=`<path d="M40 ${my-2} Q50 ${my+13} 60 ${my-2} Z" fill="${ink}"/><path d="M43 ${my-1} L57 ${my-1} L56 ${my+2} L44 ${my+2} Z" fill="#fff"/>`; break;
    case 2: mouth=`<ellipse cx="50" cy="${my+2}" rx="5" ry="6" fill="${ink}"/>`; break;
    case 3: mouth=smile+`<path d="M46 ${my+4} Q50 ${my+13} 54 ${my+4} Z" fill="#ff8fab" stroke="${ink}" stroke-width="2"/>`; break;
    case 4: mouth=line(`M43 ${my+2} L57 ${my+2}`); break;
    case 5: mouth=smile+`<path d="M44 ${my+2.5} L46 ${my+7.5} L48 ${my+3.8} Z M52 ${my+3.8} L54 ${my+7.5} L56 ${my+2.5} Z" fill="#fff" stroke="${ink}" stroke-width="1.5"/>`; break;
  }
  let hat='';
  switch(a.h){
    case 1: hat=`<path d="M34 31 L36 16 L43 24 L50 12 L57 24 L64 16 L66 31 Z" fill="#ffd43b" ${S}/>`; break;
    case 2: hat=`<path d="M38 33 L50 7 L62 33 Z" fill="#4dabf7" ${S}/>${line('M43 24 L57 24',3,'#fff')}${line('M46 16 L54 16',3,'#fff')}<circle cx="50" cy="7" r="4.5" fill="#ff6b6b" ${S}/>`; break;
    case 3: hat=`<path d="M28 37 C28 16 72 16 72 37 Z" fill="#ff6b6b" ${S}/><path d="M66 35 L88 37 L86 42 L64 40 Z" fill="#e03131" ${S}/>`; break;
    case 4: hat=`${line('M21 58 C19 24 81 24 79 58',5)}<rect x="14" y="50" width="12" height="20" rx="5" fill="#ff6b6b" ${S}/><rect x="74" y="50" width="12" height="20" rx="5" fill="#ff6b6b" ${S}/>`; break;
    case 5: hat=`<path d="M64 30 L52 21 L52 39 Z M64 30 L76 21 L76 39 Z" fill="#f783ac" ${S}/><circle cx="64" cy="30" r="4.5" fill="#f783ac" ${S}/>`; break;
    case 6: hat=`<path d="M32 34 L55 2 L68 34 Z" fill="#5f3dc4" ${S}/>${line('M25 34 L75 34',5)}<path d="${starPath(54,21,5.5,2.3)}" fill="#ffd43b"/>`; break;
    case 7: hat=`<path d="M33 38 Q20 28 25 12 Q31 26 41 33 Z M67 38 Q80 28 75 12 Q69 26 59 33 Z" fill="#f1f3f5" ${S}/>`; break;
    case 8: hat=[0,72,144,216,288].map(d=>{const r=d*Math.PI/180; return `<circle cx="${(66+7*Math.cos(r)).toFixed(1)}" cy="${(28+7*Math.sin(r)).toFixed(1)}" r="5" fill="#fff" ${S}/>`;}).join('')+`<circle cx="66" cy="28" r="4.5" fill="#ffd43b" ${S}/>`; break;
    case 9: hat=`<ellipse cx="50" cy="17" rx="17" ry="5" fill="none" stroke="#ffd43b" stroke-width="4.5"/>`; break;
  }
  return `<svg class="${cls}" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true" focusable="false"><circle cx="50" cy="50" r="50" fill="${AV_BG[a.g]}"/>${body}${eyes}${mouth}${hat}</svg>`;
}
myAv=(()=>{ try{ const s=lsGet('etappen-avatar'); if(s) return cleanAv(JSON.parse(s)); }catch(e){} const a=randomAv(); lsSet('etappen-avatar',JSON.stringify(a)); return a; })();
function saveAv(){ lsSet('etappen-avatar',JSON.stringify(myAv)); }

/* ---------- groups ---------- */
function makeGroup(type,cards){
  if(cards.some(c=>c.k==='s')) return null;
  const nat=cards.filter(c=>c.k==='n'), jok=cards.filter(c=>c.k==='j');
  if(!nat.length) return null;
  if(type==='set'){const v=nat[0].n; if(nat.some(c=>c.n!==v)) return null; return {type,cards:[...nat,...jok],val:v};}
  if(type==='color'){const v=nat[0].c; if(nat.some(c=>c.c!==v)) return null; return {type,cards:[...nat.sort((a,b)=>a.n-b.n),...jok],val:v};}
  if(type==='run'){
    const L=cards.length; if(L>12) return null;
    const ns=nat.map(c=>c.n); if(new Set(ns).size!==ns.length) return null;
    const mn=Math.min(...ns), mx=Math.max(...ns); if(mx-mn>L-1) return null;
    const s=Math.min(mn,13-L); if(s<1) return null;
    const ord=[]; let ji=0;
    for(let v=s;v<s+L;v++){const c=nat.find(x=>x.n===v); ord.push(c||jok[ji++]);}
    return {type,cards:ord,lo:s,hi:s+L-1};
  }
  return null;
}
function canAdd(g,c){
  if(c.k==='s'||c.k==='x') return false;
  if(g.type==='set') return c.k==='j'||c.n===g.val;
  if(g.type==='color') return c.k==='j'||c.c===g.val;
  if(c.k==='j') return g.hi<12||g.lo>1;
  return c.n===g.hi+1||c.n===g.lo-1;
}
function addTo(g,c){
  if(g.type!=='run'){ if(c.k==='j') g.cards.push(c); else { const i=g.cards.findIndex(x=>x.k==='j'); i<0?g.cards.push(c):g.cards.splice(i,0,c); if(g.type==='color') g.cards.sort((a,b)=>(a.k==='j')-(b.k==='j')||(a.n||0)-(b.n||0)); } return; }
  if(c.k==='j'){ if(g.hi<12){g.cards.push(c);g.hi++;} else {g.cards.unshift(c);g.lo--;} return; }
  if(c.n===g.hi+1){g.cards.push(c);g.hi++;} else {g.cards.unshift(c);g.lo--;}
}
function findPhase(cards,specs){
  const order=specs.map((_,i)=>i).sort((a,b)=>specs[b][1]-specs[a][1]||(specs[a][0]==='run'?-1:1));
  const res=new Array(specs.length);
  function rec(k,rem){
    if(k===order.length) return true;
    const [type,n]=specs[order[k]];
    if(rem.length<n) return false;
    const idx=[], seen=new Set();
    function comb(start){
      if(idx.length===n){
        const pick=idx.map(i=>rem[i]);
        const key=pick.map(ckey).sort().join('|'); if(seen.has(key)) return false; seen.add(key);
        const g=makeGroup(type,pick); if(!g) return false;
        res[order[k]]=g;
        return rec(k+1,rem.filter((_,i)=>!idx.includes(i)));
      }
      for(let i=start;i<=rem.length-(n-idx.length);i++){idx.push(i); if(comb(i+1)) return true; idx.pop();}
      return false;
    }
    return comb(0);
  }
  return rec(0,cards)?res:null;
}

/* ---------- computer heuristics ---------- */
function progress(hand,specs){
  let nat=hand.filter(c=>c.k==='n'), jok=hand.filter(c=>c.k==='j').length, score=0;
  const sorted=[...specs].sort((a,b)=>b[1]-a[1]);
  for(const [type,n] of sorted){
    let best=[];
    if(type==='set'||type==='color'){
      const by={}; nat.forEach(c=>{const k=type==='set'?c.n:c.c;(by[k]=by[k]||[]).push(c);});
      for(const k in by) if(by[k].length>best.length) best=by[k];
    } else {
      for(let s=1;s<=13-n;s++){const pick=[]; for(let v=s;v<s+n;v++){const c=nat.find(x=>x.n===v); if(c) pick.push(c);} if(pick.length>best.length) best=pick;}
    }
    best=best.slice(0,n);
    const ids=new Set(best.map(c=>c.id)); nat=nat.filter(c=>!ids.has(c.id));
    let have=best.length; const use=Math.min(n-have,jok); jok-=use; have+=use;
    score+=have+(have===n?1.5:0);
  }
  return score;
}
function bestDiscard(hand,specs){
  let best=null,bs=-1e9;
  for(const c of hand){
    if(c.k==='j' && hand.some(x=>x.k!=='j')) continue;
    const rest=hand.filter(x=>x!==c);
    const s=progress(rest,specs)*100+pts(c)+(c.k==='s'?40:0)+Math.random()*0.5;
    if(s>bs){bs=s;best=c;}
  }
  return {card:best, score:best?progress(hand.filter(x=>x!==best),specs):0};
}

/* ---------- game engine (nur lokal / Gastgeber) ---------- */
function newGameState(cfg){
  return {players:cfg.map(p=>({name:p.name,ai:!!p.ai,tok:p.tok||null,av:cleanAv(p.av),phase:0,score:0,hand:[],laid:null,skip:0})),deck:[],disc:[],cur:0,dealer:-1,round:0,stage:'draw',log:[],over:false,summary:null};
}
function humans(){return G.players.map((p,i)=>p.ai?-1:i).filter(i=>i>=0);}
function P(){return G.players[G.cur];}
function log(t){G.log.push(t); if(G.log.length>40) G.log.shift();}
function startRound(){
  G.round++; G.dealer=(G.dealer+1)%G.players.length; G.summary=null;
  G.deck=makeDeck(); G.disc=[];
  G.players.forEach(p=>{p.hand=[];p.laid=null;p.skip=0;});
  for(let r=0;r<10;r++) G.players.forEach(p=>p.hand.push(G.deck.pop()));
  G.disc.push(G.deck.pop());
  G.log=[`Runde ${G.round} beginnt.`];
  G.cur=(G.dealer+1)%G.players.length;
  beginTurn();
}
function beginTurn(){
  G.stage='draw'; sel.clear();
  if(mode==='local'){ const p=P(); if(!p.ai){ if(humans().length>1 && viewer!==G.cur) covered=true; else viewer=G.cur; } }
}
function nextPlayer(){
  let i=G.cur, guard=0;
  do{ i=(i+1)%G.players.length; const p=G.players[i];
    if(p.skip>0){p.skip--; log(`${p.name} muss aussetzen.`); continue;}
    break;
  }while(++guard<50);
  G.cur=i; beginTurn();
}
function refill(){
  if(G.deck.length) return true;
  if(G.disc.length<=1) return false;
  const top=G.disc.pop(); G.deck=shuffle(G.disc); G.disc=[top];
  log('Ablage wurde neu gemischt.'); return true;
}
function drawDeck(){ if(!refill()){log('Keine Karten mehr – Zug ohne Ziehen.'); G.stage='play'; return null;}
  const c=G.deck.pop(); P().hand.push(c); G.stage='play'; log(`${P().name} zieht vom Stapel.`); return c; }
function drawDisc(){ const top=G.disc[G.disc.length-1]; if(!top||top.k==='s') return null;
  G.disc.pop(); P().hand.push(top); G.stage='play'; log(`${P().name} nimmt ${desc(top)} von der Ablage.`); return top; }
function desc(c){return c.k==='j'?'einen Joker':c.k==='s'?'Aussetzen':`${COLOR_NAMES[c.c]} ${c.n}`;}
/* Etappe mit selbst zusammengestellten Gruppen auslegen – Gruppen dürfen größer sein als nötig */
function layPhaseGroups(groups){
  const p=P(), specs=PHASES[p.phase].g;
  if(!Array.isArray(groups)||groups.length!==specs.length) return false;
  const used=new Set(), res=[];
  for(let gi=0;gi<specs.length;gi++){
    const [type,n]=specs[gi], ids=groups[gi];
    if(!Array.isArray(ids)||ids.length<n) return false;
    const cards=[];
    for(const id of ids){ if(used.has(id)) return false; const c=p.hand.find(x=>x.id===id); if(!c) return false; used.add(id); cards.push(c); }
    const g=makeGroup(type,cards); if(!g) return false;
    res.push(g);
  }
  p.hand=p.hand.filter(c=>!used.has(c.id)); p.laid=res;
  const extra=used.size-specs.reduce((s,[,n])=>s+n,0);
  log(`${p.name} legt Etappe ${p.phase+1} aus${extra>0?` (mit ${extra} Extra-Karte${extra>1?'n':''})`:''}!`); return true;
}
/* Für „Vorschlag“: Mindest-Gruppen finden und dann alle weiteren passenden Karten dazulegen */
function suggestGroups(hand,specs){
  const r=findPhase(hand,specs); if(!r) return null;
  const used=new Set(r.flatMap(g=>g.cards.map(c=>c.id)));
  let added=true;
  while(added){
    added=false;
    for(const c of hand){
      if(used.has(c.id)||c.k==='s') continue;
      const g=r.find(g=>canAdd(g,c));
      if(g){ addTo(g,c); used.add(c.id); added=true; }
    }
  }
  return r.map(g=>g.cards.map(c=>c.id));
}
function layPhase(cards){
  const p=P(); const res=findPhase(cards,PHASES[p.phase].g); if(!res) return false;
  const used=new Set(res.flatMap(g=>g.cards.map(c=>c.id)));
  p.hand=p.hand.filter(c=>!used.has(c.id)); p.laid=res;
  log(`${p.name} legt Etappe ${p.phase+1} aus!`); return true;
}
function layOff(card,pi,gi){
  const pl=G.players[pi]; if(!pl||!pl.laid||!pl.laid[gi]) return false;
  const g=pl.laid[gi]; if(!canAdd(g,card)) return false;
  P().hand=P().hand.filter(c=>c.id!==card.id); addTo(g,card);
  log(`${P().name} legt ${desc(card)} bei ${pl.name} an.`); return true;
}
function discard(card,target){
  const p=P(); p.hand=p.hand.filter(c=>c.id!==card.id); G.disc.push(card);
  if(card.k==='s' && target!=null){G.players[target].skip++; log(`${p.name} lässt ${G.players[target].name} aussetzen.`);}
  else log(`${p.name} wirft ${desc(card)} ab.`);
  if(!p.hand.length){endRound(G.cur);return;}
  nextPlayer();
}
function checkOut(){ if(!P().hand.length){endRound(G.cur);return true;} return false; }
function endRound(wi){
  G.stage='over'; const rows=[];
  G.players.forEach(p=>{
    const add=p.hand.reduce((s,c)=>s+pts(c),0); p.score+=add;
    const done=!!p.laid; rows.push({name:p.name,done,add,phase:p.phase,total:p.score});
    if(done) p.phase++;
  });
  log(`${G.players[wi].name} beendet die Runde.`);
  let winner=null;
  G.players.forEach((p,i)=>{ if(p.phase>=10 && (winner===null || p.score<G.players[winner].score)) winner=i; });
  G.over=winner!==null; G.summary={wi,rows,winner}; covered=false;
}
function skipTargets(){const me=G.cur; let t=G.players.map((p,i)=>i).filter(i=>i!==me); const free=t.filter(i=>G.players[i].skip===0); return free.length?free:t;}
function allGroups(){const r=[]; G.players.forEach((p,pi)=>{if(p.laid) p.laid.forEach((g,gi)=>r.push([pi,gi]));}); return r;}

/* Ein Spielzug als Aktion – geprüft, egal ob er von diesem Gerät oder übers Netz kommt */
function applyAction(seat,a){
  a=sanitizeAction(a); if(!a) return 'Unbekannter Zug.';
  if(!G||G.stage==='over') return 'Die Runde ist vorbei.';
  if(seat!==G.cur) return 'Du bist nicht dran.';
  const p=P(); if(p.ai) return 'Du bist nicht dran.';
  const card=id=>p.hand.find(c=>c.id===id);
  switch(a.type){
    case 'draw': if(G.stage!=='draw') return 'Du hast schon gezogen.'; drawDeck(); return null;
    case 'take': if(G.stage!=='draw') return 'Du hast schon gezogen.'; return drawDisc()?null:'Aussetzen-Karten darf man nicht aufnehmen.';
    case 'lay': {
      if(G.stage!=='play') return 'Zieh zuerst eine Karte.'; if(p.laid) return 'Deine Etappe liegt schon.';
      if(a.groups){ if(!layPhaseGroups(a.groups)) return 'Die Gruppen in der Vorablage passen noch nicht zu „'+PHASES[p.phase].t+'“.'; }
      else { const cards=[...new Set(a.ids)].map(card).filter(Boolean);
        if(!layPhase(cards)) return 'Die gewählten Karten ergeben noch nicht „'+PHASES[p.phase].t+'“.'; }
      checkOut(); return null; }
    case 'layoff': {
      if(G.stage!=='play') return 'Zieh zuerst eine Karte.'; if(!p.laid) return 'Lege zuerst deine Etappe aus.';
      const c=card(a.id); if(!c||!layOff(c,a.pi,a.gi)) return 'Diese Karte passt dort nicht.';
      checkOut(); return null; }
    case 'discard': {
      if(G.stage!=='play') return 'Zieh zuerst eine Karte.';
      const c=card(a.id); if(!c) return 'Diese Karte hast du nicht.';
      let t=null; if(c.k==='s'){ const ts=skipTargets(); t=ts.includes(a.target)?a.target:ts[0]; }
      discard(c,t); return null; }
  }
  return 'Unbekannter Zug.';
}

/* ---------- Änderungen weitergeben ---------- */
function changed(){ if(mode==='host'){ hostBroadcast(); hostSave(); } render(); maybeAI(); }
function maybeAI(){
  if(mode==='client'||!G||G.stage==='over'||aiBusy) return;
  if(!P().ai) return;
  runAI();
}
function mySeat(){
  if(!G) return null;
  if(mode==='local') return viewer;
  if(mode==='client'){ const y=CLIENT?CLIENT.you:null; return (y!=null&&y<G.players.length)?y:null; }
  const i=G.players.findIndex(p=>p.tok===myTok); return i<0?null:i;
}
function myTurn(){
  if(!G||G.stage==='over') return false; const p=P(); if(!p||p.ai) return false;
  if(mode==='local') return viewer===G.cur && !covered;
  return mySeat()===G.cur;
}
function act(a){
  if(mode==='client'){ if(!hostReachable()){ toast('Keine Verbindung zum Gastgeber – ich versuche es weiter …'); return; } clientAct(a); if(a.type!=='lay') sel.clear(); return; }
  const err=applyAction(G.cur,a);
  if(err){ toast(err); return; }
  sel.clear(); changed();
}

/* ---------- Computerzug ---------- */
async function runAI(){
  aiBusy=true; const myG=G, me=G.cur, p=P(), specs=PHASES[p.phase].g;
  const delay=(mode==='local'&&G.players.every(x=>x.ai))?250:700;
  const stale=()=>G!==myG||G.cur!==me||G.stage==='over';
  const wait=async ms=>{await sleep(ms); if(stale()) throw 'stale';};
  const step=()=>{ if(mode==='host'){hostBroadcast();} render(); };
  try{
    const dealWait=(G.log.length<=1&&!reduceMotion.matches&&!animOff)?10*G.players.length*55+500:0;   // erst austeilen lassen
    await wait(delay+dealWait);
    const top=G.disc[G.disc.length-1];
    let take=false;
    if(top && top.k!=='s'){
      if(p.laid) take=allGroups().some(([pi,gi])=>canAdd(G.players[pi].laid[gi],top));
      else if(top.k==='j') take=true;
      else take=bestDiscard([...p.hand,top],specs).score>progress(p.hand,specs)+0.4;
    }
    if(take) drawDisc(); else drawDeck();
    step(); await wait(delay);
    if(!p.laid && layPhase(p.hand)){ step(); await wait(delay); }
    if(p.laid){
      let again=true;
      while(again && p.hand.length){
        again=false;
        for(const c of [...p.hand]){
          const spot=allGroups().find(([pi,gi])=>canAdd(G.players[pi].laid[gi],c));
          if(spot){ layOff(c,spot[0],spot[1]); again=true; step(); await wait(delay/2); break; }
        }
      }
      if(checkOut()){ aiBusy=false; changed(); return; }
    }
    let d;
    if(p.laid) d=[...p.hand].sort((a,b)=>(b.k==='s')-(a.k==='s')||pts(b)-pts(a))[0];
    else d=bestDiscard(p.hand,specs).card;
    let target=null;
    if(d.k==='s'){ const ts=skipTargets(); target=ts.reduce((a,b)=>{const A=G.players[a],B=G.players[b]; return (B.phase>A.phase||(B.phase===A.phase&&(!!B.laid>!!A.laid)))?b:a;}); }
    aiBusy=false; discard(d,target); changed();
  }catch(err){ aiBusy=false; if(err!=='stale') throw err; maybeAI(); }
}

/* ---------- Bytes & Verschlüsselung ---------- */
const te=new TextEncoder(), td=new TextDecoder();
function cat(...parts){ let n=0; parts.forEach(p=>n+=p.length); const o=new Uint8Array(n); let i=0; parts.forEach(p=>{ o.set(p,i); i+=p.length; }); return o; }
function b64(u8){ let s=''; for(let i=0;i<u8.length;i+=0x8000) s+=String.fromCharCode.apply(null,u8.subarray(i,i+0x8000)); return btoa(s); }
function unb64(s){ try{ const bin=atob(String(s)); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u; }catch(e){ return new Uint8Array(0); } }
function hex(u8){ return Array.from(u8,x=>x.toString(16).padStart(2,'0')).join(''); }
async function aesEnc(key,obj){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,te.encode(JSON.stringify(obj))));
  return cat(iv,ct);
}
async function aesDec(key,u8){
  try{ if(!(u8 instanceof Uint8Array)||u8.length<29||u8.length>600000) return null;
    const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:u8.subarray(0,12)},key,u8.subarray(12));
    return JSON.parse(td.decode(pt));
  }catch(e){ return null; }
}
/* Aus dem Raum-Code werden Schlüssel und (geheimer) Kanalname abgeleitet. Ohne Code kann niemand mitlesen. */
async function roomKeys(code){
  const base=await crypto.subtle.importKey('raw',te.encode(code),'PBKDF2',false,['deriveBits']);
  const bits=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:te.encode('etappen-romme/v3/room'),iterations:200000},base,384));
  const key=await crypto.subtle.importKey('raw',bits.slice(0,32),'AES-GCM',false,['encrypt','decrypt']);
  return {key, topic:TOPIC_ROOT+hex(bits.slice(32,48))};
}
/* Zusätzlich hat jeder Mitspieler einen eigenen Schlüssel mit dem Gastgeber (ECDH).
   So können andere im Raum die Karten der anderen nicht entschlüsseln. */
async function newECDH(){
  const kp=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const pub=b64(new Uint8Array(await crypto.subtle.exportKey('raw',kp.publicKey)));
  return {kp,pub};
}
async function pairKey(kp,pubB64){
  const pk=await crypto.subtle.importKey('raw',unb64(pubB64),{name:'ECDH',namedCurve:'P-256'},false,[]);
  const bits=await crypto.subtle.deriveBits({name:'ECDH',public:pk},kp.privateKey,256);
  const hk=await crypto.subtle.importKey('raw',bits,'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:te.encode('etappen-romme/v3/pair'),info:new Uint8Array(0)},hk,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}

/* ---------- kleiner MQTT-Client über WebSocket ---------- */
function str16(s){ const b=te.encode(s); return cat([b.length>>8,b.length&255],b); }
function mqttPkt(h,body){ const len=[]; let x=body.length; do{ let d=x%128; x=Math.floor(x/128); if(x>0) d|=128; len.push(d); }while(x>0); return cat([h],len,body); }
class MqttLink{
  constructor(url,onMsg,onChange){ this.url=url; this.onMsg=onMsg; this.onChange=onChange; this.subs=new Set(); this.ok=false; this.closed=false; this.buf=new Uint8Array(0); this.pid=1; this.retry=0; this.open(); }
  open(){
    if(this.closed) return;
    let ws; try{ ws=new WebSocket(this.url,'mqtt'); }catch(e){ this.later(); return; }
    this.ws=ws; this.buf=new Uint8Array(0); ws.binaryType='arraybuffer';
    ws.onopen=()=>{ try{ ws.send(mqttPkt(0x10,cat([0,4,77,81,84,84,4,2,0,45],str16('etr'+randHex(10))))); }catch(e){} };
    ws.onmessage=e=>{ if(this.ws===ws) this.feed(new Uint8Array(e.data)); };
    ws.onclose=()=>{ if(this.ws!==ws) return; const was=this.ok; this.ok=false; clearInterval(this.ping); if(was) this.onChange(); this.later(); };
    ws.onerror=()=>{};
  }
  later(){ if(this.closed) return; clearTimeout(this.rt); const d=Math.min(10000,800*Math.pow(2,this.retry++)); this.rt=setTimeout(()=>this.open(),d); }
  kick(){ if(this.closed) return; if(!this.ws||this.ws.readyState>1){ this.retry=0; clearTimeout(this.rt); this.open(); } }
  feed(chunk){
    let b=cat(this.buf,chunk);
    for(;;){
      if(b.length<2) break;
      let mul=1,len=0,i=1,byte,bad=false;
      do{ if(i>=b.length){ i=-1; break; } byte=b[i++]; len+=(byte&127)*mul; mul*=128; if(mul>268435456){ bad=true; break; } }while(byte&128);
      if(bad||len>1048576){ try{this.ws.close();}catch(e){} return; }
      if(i<0||b.length<i+len) break;
      this.handle(b[0],b.subarray(i,i+len));
      b=b.subarray(i+len);
    }
    this.buf=b.slice();
  }
  handle(h,body){
    const type=h>>4;
    if(type===2){ // CONNACK
      if(body[1]!==0){ try{this.ws.close();}catch(e){} return; }
      this.ok=true; this.retry=0; this.subs.forEach(t=>this.sendSub(t));
      clearInterval(this.ping); const ws=this.ws; this.ping=setInterval(()=>{ try{ ws.send(new Uint8Array([0xC0,0])); }catch(e){} },20000);
      this.onChange();
    } else if(type===3){ // PUBLISH
      if(body.length<2) return;
      const tl=(body[0]<<8)|body[1]; let p=2+tl; if((h>>1)&3) p+=2;
      this.onMsg(td.decode(body.subarray(2,2+tl)), body.slice(p));
    }
  }
  sendSub(t){ this.pid=(this.pid%65535)+1; try{ this.ws.send(mqttPkt(0x82,cat([this.pid>>8,this.pid&255],str16(t),[0]))); }catch(e){} }
  sub(t){ this.subs.add(t); if(this.ok) this.sendSub(t); }
  pub(t,payload){ if(!this.ok) return false; try{ this.ws.send(mqttPkt(0x30,cat(str16(t),payload))); return true; }catch(e){ return false; } }
  close(){ this.closed=true; clearTimeout(this.rt); clearInterval(this.ping); try{ if(this.ok) this.ws.send(new Uint8Array([0xE0,0])); this.ws.close(); }catch(e){} this.ok=false; }
}

/* ---------- Netz: beide Server, Verschlüsselung, Doppelte aussortieren ---------- */
function netStart(keys,listenTopic,onEnv){
  const net={keys,links:[],seen:new Set(),seenQ:[]};
  const onMsg=async(topic,payload)=>{
    if(NET!==net||topic!==listenTopic) return;
    const env=await aesDec(keys.key,payload);
    if(!env||typeof env!=='object'||typeof env.m!=='string'||net.seen.has(env.m)) return;
    net.seen.add(env.m); net.seenQ.push(env.m); if(net.seenQ.length>500) net.seen.delete(net.seenQ.shift());
    onEnv(env);
  };
  const onChange=()=>{ if(NET!==net) return; render(); netChanged(); };
  NET=net;
  net.links=BROKERS.map(u=>new MqttLink(u,onMsg,onChange));
  net.links.forEach(l=>l.sub(listenTopic));
  return net;
}
async function netSend(topic,env){
  const net=NET; if(!net) return;
  env.m=randHex(8);
  const bytes=await aesEnc(net.keys.key,env);
  net.links.forEach(l=>l.pub(topic,bytes));
}
const netOnline=()=>!!NET&&NET.links.some(l=>l.ok);
function netKick(){ if(NET) NET.links.forEach(l=>l.kick()); }
function netChanged(){
  if(mode==='host') hostBroadcast();
  else if(mode==='client'&&CLIENT){ if(!CLIENT.key) clientHello(); else clientSendMsg({t:'ping'}); }
}
function stopNet(){
  clearInterval(hostTimer); clearInterval(clientTimer); hostTimer=clientTimer=null;
  const net=NET;
  if(net&&mode==='client'&&CLIENT&&CLIENT.key) clientSendMsg({t:'bye'});
  NET=null;
  if(net) setTimeout(()=>net.links.forEach(l=>l.close()),400);
  HOST=null; CLIENT=null;
}

/* ---------- Online: Gastgeber ---------- */
const CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE=new RegExp('^['+CODE_CHARS+']{'+CODE_LEN+'}$');
function newCode(){let s=''; for(let i=0;i<CODE_LEN;i++) s+=CODE_CHARS[randInt(CODE_CHARS.length)]; return s;}
const normCode=s=>String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,CODE_LEN);
const fmtCode=c=>c.slice(0,4)+'-'+c.slice(4);
const cryptoOK=()=>{ if(!(window.crypto&&crypto.subtle)){ toast('Dein Browser unterstützt die Verschlüsselung nicht. Bitte aktualisiere ihn.'); return false; } return true; };
function hostSave(){
  if(!HOST) return;
  lsSet('etappen-host',JSON.stringify({code:HOST.code,game:HOST.game,rules:HOST.rules,status:HOST.status,seats:HOST.seats,G,SV,MM,ts:Date.now()}));
}
function savedHost(){ try{ const s=JSON.parse(lsGet('etappen-host')); if(s&&CODE_RE.test(s.code)&&Date.now()-s.ts<48*3600e3) return s; }catch(e){} return null; }
function rateOK(c){ const now=Date.now(); if(!c._t||now-c._t>1000){c._t=now;c._n=0;} return ++c._n<=MAX_MSG_PER_SEC; }
const isOnline=c=>Date.now()-c.last<35000;

const GAME_NAME={etappen:'Etappen-Rommé',schiffe:'Schiffe versenken',maumau:'Mau-Mau'};
const normGame=g=>g==='schiffe'||g==='maumau'?g:'etappen';
const maxSeats=()=>HOST&&HOST.game==='schiffe'?2:6;
async function hostGame(resume,game){
  if(!cryptoOK()) return;
  const name=readName(); if(!resume&&!name){toast('Bitte gib zuerst deinen Namen ein.'); return;}
  stopNet(); G=null; SV=null; SVV=null; MM=null; MMV=null; mode='local'; render();
  overlay(`<h2>Raum wird geöffnet …</h2><p class="note">Verschlüsselung wird vorbereitet.</p>`,'wait');
  const code=resume?resume.code:newCode();
  const keys=await roomKeys(code), ecdh=await newECDH();
  mode='host';
  const g=normGame(resume?resume.game:game);
  HOST={code,keys,ecdh,game:g,rules:g==='maumau'?(resume&&resume.rules?mmCleanRules(resume.rules):mmRules()):null,status:resume?resume.status:'lobby',seats:resume?resume.seats:[{tok:myTok,name,ai:false,av:myAv}],clients:new Map()};
  const mine=HOST.seats.find(s=>s.tok===myTok); if(mine){ mine.av=myAv; if(HOST.status==='lobby'&&name) mine.name=name; }
  G=resume&&resume.status==='game'&&g==='etappen'?resume.G:null;
  SV=resume&&resume.status==='game'&&g==='schiffe'?resume.SV:null;
  MM=resume&&resume.status==='game'&&g==='maumau'?resume.MM:null;
  if(HOST.status==='game'&&!G&&!SV&&!MM) HOST.status='lobby';
  netStart(keys,keys.topic+'/h',hostOnEnv);
  hostSave(); keepAwake();
  hostTimer=setInterval(hostTick,10000);
  if(HOST.status==='lobby'){ render(); showLobby(); } else { overlay(''); if(SV) svChanged(); else if(MM) mmChanged(); else changed(); }
}
function hostTick(){
  if(mode!=='host'||!HOST) return;
  const now=Date.now(); HOST.clients.forEach((c,cid)=>{ if(now-c.last>180000) HOST.clients.delete(cid); });
  hostBroadcast(); render();
  if(HOST.status==='lobby'&&ovKey==='lobby') showLobby();
}
function hostSendRaw(cid,payload){ if(HOST) netSend(HOST.keys.topic+'/c/'+cid,{f:'host',p:payload}); }
async function hostSend(c,msg){ if(!HOST||!c.key) return; const x=b64(await aesEnc(c.key,msg)); hostSendRaw(c.cid,{x}); }
async function hostOnEnv(env){
  if(!HOST) return;
  const cid=str(env.f,32); if(!/^[0-9a-f]{16}$/.test(cid)) return;
  const p=env.p; if(!p||typeof p!=='object') return;
  let c=HOST.clients.get(cid);
  if(c&&!rateOK(c)) return;
  if(p.t==='hello'){
    if(p.v!==PROTO){ hostSendRaw(cid,{t:'deny',msg:'Deine App-Version passt nicht zu der des Gastgebers. Bitte beide die App aktualisieren.'}); return; }
    if(!c&&HOST.clients.size>=MAX_CONNS){
      for(const [k,o] of HOST.clients) if(!isOnline(o)) HOST.clients.delete(k);
      if(HOST.clients.size>=MAX_CONNS){ hostSendRaw(cid,{t:'deny',msg:'Der Raum ist voll.'}); return; }
    }
    let key; try{ key=await pairKey(HOST.ecdh.kp,str(p.pub,200)); }catch(e){ return; }
    if(!HOST) return;
    c=HOST.clients.get(cid)||{cid,tok:null,lastSeq:0,sn:0};
    c.key=key; c.last=Date.now(); HOST.clients.set(cid,c);
    hostSendRaw(cid,{t:'welcome',v:PROTO,pub:HOST.ecdh.pub});
    return;
  }
  if(typeof p.x!=='string') return;
  if(!c||!c.key){ hostSendRaw(cid,{t:'rehello'}); return; }
  const msg=await aesDec(c.key,unb64(p.x));
  if(!msg||typeof msg!=='object'){ hostSendRaw(cid,{t:'rehello'}); return; }
  if(!HOST) return;
  c.last=Date.now();
  hostOnMsg(c,msg);
}
function seatOf(c){ const S=HOST&&HOST.game==='schiffe'?SV:HOST&&HOST.game==='maumau'?MM:G; if(!S||!c.tok) return null; const i=S.players.findIndex(p=>p.tok===c.tok); return i<0?null:i; }
function onlineToks(){ const s=new Set([myTok]); HOST&&HOST.clients.forEach(c=>{ if(c.tok&&isOnline(c)) s.add(c.tok); }); return s; }
function onlineCount(){ let n=0; HOST&&HOST.clients.forEach(c=>{ if(c.tok&&isOnline(c)) n++; }); return n; }
function viewFor(seat){
  const v=JSON.parse(JSON.stringify(G));
  const on=onlineToks();
  v.players.forEach((p,i)=>{ if(i!==seat) p.hand=p.hand.map(()=>({k:'x'})); p.off=!p.ai&&!on.has(p.tok); delete p.tok; });
  v.deckN=G.deck.length; v.deck=[];
  return v;
}
function hostSendView(c){
  if(!HOST||!c.tok) return;
  if(HOST.status==='lobby') hostSend(c,{t:'lobby',v:PROTO,game:HOST.game,rules:HOST.rules,code:HOST.code,seats:HOST.seats.map(s=>({name:s.name,ai:s.ai,av:s.av,me:s.tok===c.tok,host:s.tok===myTok}))});
  else if(HOST.game==='maumau'){ if(!MM) return; const seat=seatOf(c); hostSend(c,{t:'mm',v:PROTO,sn:++c.sn,ack:c.lastSeq,you:seat,view:mmView(seat),hostName:HOST.seats[0].name}); }
  else if(HOST.game==='schiffe'){ if(!SV) return; const seat=seatOf(c); hostSend(c,{t:'sv',v:PROTO,sn:++c.sn,ack:c.lastSeq,you:seat,view:svView(seat),hostName:HOST.seats[0].name}); }
  else { const seat=seatOf(c); hostSend(c,{t:'state',v:PROTO,sn:++c.sn,ack:c.lastSeq,you:seat,view:viewFor(seat),hostName:HOST.seats[0].name}); }
}
function hostBroadcast(){ if(HOST) HOST.clients.forEach(c=>hostSendView(c)); }
function hostOnMsg(c,d){
  if(d.t==='join'){
    const tok=str(d.tok,64); if(!/^[0-9a-f]{32}$/.test(tok)||tok===myTok) return;
    const name=str(d.name,16)||'Gast', av=cleanAv(d.av);
    HOST.clients.forEach((o,k)=>{ if(o!==c&&o.tok===tok) HOST.clients.delete(k); });
    c.tok=tok;
    let seat=HOST.seats.find(s=>s.tok===tok);
    if(!seat){
      if(HOST.status!=='lobby') hostSend(c,{t:'info',msg:'Das Spiel läuft schon – du schaust zu.'});
      else if(HOST.seats.length>=maxSeats()){ hostSend(c,{t:'deny',msg:`Der Raum ist voll (${maxSeats()} Spieler).`}); HOST.clients.delete(c.cid); return; }
      else HOST.seats.push({tok,name,ai:false,av});
    } else if(HOST.status==='lobby'){ seat.name=name; seat.av=av; }
    hostSave();
    if(HOST.status==='lobby'&&ovKey==='lobby') showLobby();
    hostBroadcast(); render();
    return;
  }
  if(!c.tok) return;
  if(d.t==='ping'){ hostSendView(c); return; }
  if(d.t==='bye'){
    HOST.clients.delete(c.cid);
    if(HOST.status==='lobby'){ const i=HOST.seats.findIndex(s=>s.tok===c.tok&&s.tok!==myTok); if(i>=0) HOST.seats.splice(i,1); hostSave(); if(ovKey==='lobby') showLobby(); }
    hostBroadcast(); render(); return;
  }
  if(d.t==='act'&&HOST.status==='game'){
    const seq=int(d.seq,0,1e9,0);
    if(seq&&seq<=c.lastSeq){ hostSendView(c); return; }   // doppelt angekommen
    c.lastSeq=seq;
    const seat=seatOf(c); if(seat===null) return;
    const err=HOST.game==='schiffe'?svApply(seat,d.a):HOST.game==='maumau'?mmApply(seat,d.a):applyAction(seat,d.a);
    if(err){ hostSend(c,{t:'err',msg:err,ack:seq}); hostSendView(c); } else if(HOST.game==='schiffe') svChanged(); else if(HOST.game==='maumau') mmChanged(); else changed();
  }
}
function hostStart(){
  if(!HOST||HOST.seats.length<2) return;
  if(HOST.game==='schiffe'){
    if(HOST.seats.length!==2){ toast('Schiffe versenken spielt man zu zweit.'); return; }
    HOST.status='game'; G=null; svDraft=null;
    SV=svNew(HOST.seats.map(s=>({name:s.name,av:s.av,tok:s.tok})));
    overlay(''); svChanged(); return;
  }
  if(HOST.game==='maumau'){
    HOST.status='game'; G=null; SV=null; mmMauArmed=false;
    MM=mmNew(HOST.seats.map(s=>({name:s.name,av:s.av,ai:s.ai,tok:s.ai?null:s.tok})),HOST.rules||mmRules());
    overlay(''); mmChanged(); return;
  }
  HOST.status='game'; SV=null; MM=null;
  G=newGameState(HOST.seats.map(s=>({name:s.name,ai:s.ai,tok:s.ai?null:s.tok,av:s.av})));
  overlay(''); startRound(); changed();
}

/* ---------- Online: Mitspieler ---------- */
async function joinGame(codeRaw){
  if(!cryptoOK()) return;
  const name=readName(); if(!name){toast('Bitte gib zuerst deinen Namen ein.'); return;}
  const code=normCode(codeRaw); if(!CODE_RE.test(code)){toast(`Der Raum-Code hat ${CODE_LEN} Zeichen, zum Beispiel ABCD-2345.`); return;}
  stopNet(); G=null; SV=null; SVV=null; MM=null; MMV=null; mode='client'; render();
  overlay(`<h2>Verbinde mit Raum ${fmtCode(code)} …</h2><p class="note">Das dauert meist nur ein paar Sekunden.</p><div class="row"><button class="btn" id="toMenu">Abbrechen</button></div>`,'wait');
  const keys=await roomKeys(code), ecdh=await newECDH();
  if(mode!=='client') return;   // inzwischen abgebrochen
  CLIENT={code,keys,ecdh,cid:randHex(8),key:null,you:null,lobby:null,hostName:'',lastHost:0,lastPing:0,lastHello:0,sn:0,seq:0,pending:null,start:Date.now()};
  lsSet('etappen-last',code);
  netStart(keys,keys.topic+'/c/'+CLIENT.cid,clientOnEnv);
  clientHello();
  clientTimer=setInterval(clientTick,2500);
}
function clientHello(){ if(mode!=='client'||!CLIENT) return; CLIENT.lastHello=Date.now(); netSend(CLIENT.keys.topic+'/h',{f:CLIENT.cid,p:{t:'hello',v:PROTO,pub:CLIENT.ecdh.pub}}); }
async function clientSendMsg(msg){
  const C=CLIENT; if(!C||!C.key) return false;
  const x=b64(await aesEnc(C.key,msg));
  netSend(C.keys.topic+'/h',{f:C.cid,p:{x}}); return true;
}
function hostReachable(){ return !!CLIENT&&!!CLIENT.key&&Date.now()-CLIENT.lastHost<25000; }
function clientTick(){
  const C=CLIENT; if(mode!=='client'||!C) return;
  const now=Date.now();
  if(!C.key){
    if(now-C.lastHello>3000) clientHello();
    if(!C.lastHost&&now-C.start>20000&&ovKey==='wait') showNotFound();
  } else {
    if(now-C.lastPing>10000){ C.lastPing=now; clientSendMsg({t:'ping'}); }
    if(now-C.lastHost>25000&&now-C.lastHello>6000){ C.key=null; clientHello(); }   // Gastgeber neu gestartet? neu anmelden
  }
  if(C.pending&&C.key&&now-C.pending.at>2500){
    if(C.pending.tries<6){ C.pending.at=now; C.pending.tries++; clientSendMsg(C.pending.msg); } else C.pending=null;
  }
  render();
}
async function clientOnEnv(env){
  const C=CLIENT; if(!C||env.f!=='host') return;
  const p=env.p; if(!p||typeof p!=='object') return;
  if(p.t==='welcome'){
    if(p.v!==PROTO){ toast('Deine App-Version passt nicht zu der des Gastgebers. Bitte beide die App aktualisieren.'); return; }
    let key; try{ key=await pairKey(C.ecdh.kp,str(p.pub,200)); }catch(e){ return; }
    if(CLIENT!==C) return;
    C.key=key; C.sn=0; C.lastHost=Date.now(); C.lastPing=Date.now();
    clientSendMsg({t:'join',tok:myTok,name:myName,av:myAv});
    if(C.pending){ C.pending.at=0; }
    return;
  }
  if(p.t==='rehello'){ C.key=null; clientHello(); return; }
  if(p.t==='deny'){ toast(str(p.msg,160)||'Der Gastgeber hat abgelehnt.'); leaveToMenu(); return; }
  if(typeof p.x!=='string'||!C.key) return;
  const msg=await aesDec(C.key,unb64(p.x));
  if(CLIENT!==C) return;
  if(!msg||typeof msg!=='object'){ C.key=null; clientHello(); return; }
  C.lastHost=Date.now();
  clientOnData(msg);
}
function clientOnData(d){
  const C=CLIENT; if(!C) return;
  if(d.ack!=null&&C.pending&&int(d.ack,0,1e9,0)>=C.pending.seq) C.pending=null;
  if((d.t==='lobby'||d.t==='state'||d.t==='sv'||d.t==='mm')&&d.v!==PROTO){ toast('Deine App-Version passt nicht zu der des Gastgebers. Bitte beide die App aktualisieren.'); return; }
  if(d.t==='mm'){
    const sn=int(d.sn,0,1e12,0); if(sn&&sn<=C.sn) return; C.sn=sn;
    const v=sanitizeMmView(d.view); if(!v) return;
    G=null; SVV=null; MMV=v; C.you=v.you; C.hostName=str(d.hostName,16);
    if(['lobby','wait','notfound'].includes(ovKey)) overlay('');
    render(); return;
  }
  if(d.t==='sv'){
    const sn=int(d.sn,0,1e12,0); if(sn&&sn<=C.sn) return; C.sn=sn;
    const v=sanitizeSvView(d.view); if(!v) return;
    G=null; MMV=null; SVV=v; C.you=d.you==null?null:int(d.you,0,1,null); C.hostName=str(d.hostName,16);
    if(['lobby','wait','notfound'].includes(ovKey)) overlay('');
    render(); return;
  }
  if(d.t==='lobby'){
    C.lobby={code:C.code,game:normGame(d.game),rules:d.game==='maumau'?mmCleanRules(d.rules):null,seats:(Array.isArray(d.seats)?d.seats:[]).slice(0,6).map(s=>({name:str(s&&s.name,16)||'?',ai:!!(s&&s.ai),av:cleanAv(s&&s.av),me:!!(s&&s.me),host:!!(s&&s.host)}))};
    G=null; SV=null; SVV=null; MM=null; MMV=null; render(); if(['wait','lobby','notfound'].includes(ovKey)||!ovKey) showLobby(); return;
  }
  if(d.t==='state'){
    const sn=int(d.sn,0,1e12,0); if(sn&&sn<=C.sn) return; C.sn=sn;
    const v=sanitizeView(d.view); if(!v) return;
    G=v; SVV=null; MMV=null; C.you=d.you==null?null:int(d.you,0,v.players.length-1,null); C.hostName=str(d.hostName,16);
    if(['lobby','wait','notfound'].includes(ovKey)) overlay('');
    render(); return;
  }
  if(d.t==='err'||d.t==='info'){ toast(str(d.msg,160)); if(d.t==='err') render(); return; }
  if(d.t==='deny'||d.t==='kicked'){ toast(str(d.msg,160)||'Der Gastgeber hat dich aus dem Raum genommen.'); leaveToMenu(); }
}
function clientAct(a){
  const C=CLIENT; if(!C) return;
  if(C.pending){ toast('Moment, der letzte Zug wird noch übertragen …'); return; }
  const seq=++C.seq, msg={t:'act',a,seq};
  C.pending={seq,msg,at:Date.now(),tries:0};
  clientSendMsg(msg);
}
function showNotFound(){
  if(mode!=='client'||!CLIENT) return;
  overlay(`<h2>Raum nicht erreichbar</h2><p>Prüfe den Code. Der Gastgeber muss die App gerade geöffnet haben.</p><p class="note">Ich versuche es im Hintergrund weiter.</p><div class="row mt"><button class="btn primary" id="keepTrying">Weiter warten</button><button class="btn" id="toMenu">Zum Menü</button></div>`,'notfound');
}
function leaveToMenu(){ if(mode==='host') lsDel('etappen-host'); stopNet(); mode='local'; G=null; SV=null; SVV=null; MM=null; MMV=null; render(); showMenu(); }

/* Bildschirm wach halten, solange online gespielt wird */
let wakeLock=null;
async function keepAwake(){ try{ if('wakeLock' in navigator && document.visibilityState==='visible' && !wakeLock){ wakeLock=await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release',()=>{wakeLock=null;}); } }catch(e){} }
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState!=='visible') return;
  checkForUpdate();
  if(mode==='local') return;
  keepAwake(); netKick();
  if(mode==='host') hostBroadcast();
  else if(CLIENT){ if(CLIENT.key) clientSendMsg({t:'ping'}); else clientHello(); }
});
window.addEventListener('online',()=>{ netKick(); });

/* ---------- render ---------- */
const ord=c=>c.k==='n'?c.n:c.k==='j'?20:30;
function esc(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
function toast(t){const h=$('toastHost'); h.innerHTML=`<div class="toast" role="status">${esc(t)}</div>`; clearTimeout(toast.t); toast.t=setTimeout(()=>h.innerHTML='',3200);}

/* ---------- Vorablage (eigene Gruppen vorbereiten, bevor man auslegt) ---------- */
let stage={key:'',groups:[],active:null}, justStaged=null;
function stageFor(v,me){
  const specs=PHASES[Math.min(v.phase,9)].g;
  const key=G.round+'|'+me+'|'+v.phase;
  if(stage.key!==key) stage={key,groups:specs.map(()=>[]),active:null};
  const ids=new Set(v.hand.map(c=>c.id)), seen=new Set();
  stage.groups=stage.groups.map(g=>g.filter(id=>{ if(!ids.has(id)||seen.has(id)) return false; seen.add(id); return true; }));
  return stage;
}
function stageValid(v){
  const specs=PHASES[Math.min(v.phase,9)].g, byId=new Map(v.hand.map(c=>[c.id,c]));
  return specs.map(([type,n],gi)=>{ const cards=(stage.groups[gi]||[]).map(id=>byId.get(id)).filter(Boolean); return cards.length>=n&&!!makeGroup(type,cards); });
}
const stagedSet=()=>new Set(stage.groups.flat());

/* ---------- Animationen ---------- */
const reduceMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
let prevSnap=null, incoming=new Set(), discIncoming=false;
const backHTML=()=>'<div class="card back"></div>';
const handEl=id=>document.querySelector(`#hand .card[data-id="${id}"]`);
const rectOf=el=>el?el.getBoundingClientRect():null;
function snapState(){
  const me=mySeat(), v=me!=null&&!covered?G.players[me]:null;
  return {round:G.round, me:v?me:null, myIds:v?v.hand.map(c=>c.id):[], counts:G.players.map(p=>p.hand.length),
    discLen:G.disc.length, discTop:G.disc.length?G.disc[G.disc.length-1].id:null, cur:G.cur, stage:G.stage,
    laidIds:new Set(G.players.flatMap(p=>p.laid?p.laid.flatMap(g=>g.cards.map(c=>c.id)):[])), laidP:G.players.map(p=>!!p.laid)};
}
function captureRects(){
  const r={hand:{},pl:{},deck:null,disc:null};
  document.querySelectorAll('#hand .card[data-id]').forEach(el=>{ r.hand[el.dataset.id]=el.getBoundingClientRect(); });
  document.querySelectorAll('#req [data-sid]').forEach(el=>{ r.hand[el.dataset.sid]=el.getBoundingClientRect(); });
  document.querySelectorAll('#seatsR [data-pl]').forEach(el=>{ r.pl[el.dataset.pl]=rectOf(el.querySelector('svg.av')||el); });
  if(!$('center').hidden){ r.deck=rectOf($('deckSlot').firstElementChild); r.disc=rectOf($('discSlot').firstElementChild); }
  return r;
}
function fly(html,from,to,{delay=0,dur=420,fade=false,done=null}={}){
  let finished=false; const fin=()=>{ if(finished) return; finished=true; el.remove(); if(done) done(); };
  const el=document.createElement('div');
  if(!from||!to||!from.width||!to.width){ if(done) done(); return; }
  el.className='fly'; el.innerHTML=html;
  const w=to.width, h=w*1.42, card=el.firstElementChild; if(card) card.style.setProperty('--cw',w+'px');
  $('fx').appendChild(el);
  const sx=from.left+from.width/2-w/2, sy=from.top+from.height/2-h/2, tx=to.left+to.width/2-w/2, ty=to.top+to.height/2-h/2, s0=Math.max(.3,Math.min(3,from.width/w));
  try{
    const a=el.animate([{transform:`translate(${sx}px,${sy}px) scale(${s0}) rotate(-10deg)`,opacity:0,offset:0},{transform:`translate(${sx}px,${sy}px) scale(${s0}) rotate(-10deg)`,opacity:1,offset:.04},{transform:`translate(${tx}px,${ty}px) scale(1) rotate(0deg)`,opacity:fade?0:1,offset:1}],{duration:dur,delay,easing:'cubic-bezier(.2,.75,.25,1)',fill:'both'});
    a.onfinish=fin; a.oncancel=fin;
  }catch(e){ fin(); return; }
  setTimeout(fin,delay+dur+400);   // Sicherheitsnetz, falls die Animation hängt
}
function reveal(id){ incoming.delete(id); const el=handEl(id); if(el){ el.classList.remove('incoming'); el.classList.add('land'); } }
function revealDisc(){ discIncoming=false; const d=$('discSlot').firstElementChild; if(d){ d.classList.remove('incoming'); d.classList.add('land'); } }
function hideIncoming(el,id){ incoming.add(id); el.classList.add('incoming'); }
function runAnims(prev,now,before){
  if(!now||reduceMotion.matches||animOff||document.hidden) return;
  if(!prev){ if(G.log.length<=1&&G.stage!=='over') deal(now); return; }   // frisch ausgeteilt
  const deckEl=$('deckSlot').firstElementChild, discEl=$('discSlot').firstElementChild;
  const deckR=before.deck||rectOf(deckEl), discR=before.disc||rectOf(discEl);
  if(now.round!==prev.round){ deal(now); return; }
  const tookDisc=now.discLen<prev.discLen;
  if(now.me!=null&&now.me===prev.me){
    const old=new Set(prev.myIds), v=G.players[now.me];
    now.myIds.filter(id=>!old.has(id)).forEach((id,k)=>{
      const el=handEl(id); if(!el) return; const c=v.hand.find(x=>x.id===id);
      hideIncoming(el,id);
      fly(tookDisc&&c?cardHTML(c):backHTML(), tookDisc?discR:deckR, el.getBoundingClientRect(), {delay:k*90, dur:430, done:()=>reveal(id)});
    });
  }
  if(now.discTop!==prev.discTop&&now.discLen>prev.discLen&&discEl){
    const id=now.discTop, src=before.hand[id]||before.pl[prev.cur];
    if(src){ discIncoming=true; discEl.classList.add('incoming'); fly(cardHTML(G.disc[G.disc.length-1]), src, discEl.getBoundingClientRect(), {dur:420, done:revealDisc}); }
  }
  now.counts.forEach((n,i)=>{
    if(i===now.me||n<=prev.counts[i]) return;
    const t=rectOf(document.querySelector(`#seatsR [data-pl="${i}"] .bfan`)||document.querySelector(`#seatsR [data-pl="${i}"] svg.av`));
    if(t) fly(backOf(G.players[i].av), tookDisc&&prev.cur===i?discR:deckR, t, {dur:420, fade:true});
  });
  if(now.cur!==prev.cur&&myTurn()&&G.stage==='draw') showTurnBanner();
  now.laidP.forEach((l,i)=>{ if(l&&prev.laidP&&!prev.laidP[i]&&G.players[i]) fxBurst(i===now.me?'Etappe geschafft!':`${G.players[i].name}: Etappe geschafft!`,'ok'); });
}
function deal(now){
  const deckEl=$('deckSlot').firstElementChild; if(!deckEl) return;
  const src=deckEl.getBoundingClientRect(), n=G.players.length, step=55;
  const mineEls=[...document.querySelectorAll('#hand .card[data-id]')];
  mineEls.forEach(el=>hideIncoming(el,+el.dataset.id));
  for(let r=0;r<10;r++) for(let k=0;k<n;k++){
    const i=(G.dealer+1+k)%n, delay=(r*n+k)*step;
    if(i===now.me){ const el=mineEls[r]; if(!el) continue; const id=+el.dataset.id; fly(backHTML(), src, el.getBoundingClientRect(), {delay, dur:340, done:()=>reveal(id)}); }
    else { const t=rectOf(document.querySelector(`#seatsR [data-pl="${i}"] .bfan`)||document.querySelector(`#seatsR [data-pl="${i}"] svg.av`)); if(t) fly(backOf(G.players[i].av), src, t, {delay, dur:340, fade:true}); }
  }
  const d=$('discSlot').firstElementChild;
  if(d&&G.disc.length){ discIncoming=true; d.classList.add('incoming'); fly(cardHTML(G.disc[G.disc.length-1]), src, d.getBoundingClientRect(), {delay:10*n*step, dur:380, done:revealDisc}); }
  if(myTurn()) setTimeout(()=>{ if(myTurn()) showTurnBanner(); }, 10*n*step+400);
}
function showTurnBanner(av){
  if(!av){ const me=mySeat(); if(me==null||!G) return; av=G.players[me].av; }
  if(animOff) return;
  const b=$('turnBanner'); b.innerHTML=`${avatarSVG(av,44)}<span>Du bist dran!</span>`;
  b.hidden=false; b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  clearTimeout(showTurnBanner.t); showTurnBanner.t=setTimeout(()=>{ b.hidden=true; },1700);
}

/* ======================= SCHIFFE VERSENKEN ======================= */
const SV_N=10, SV_FLEET=[5,4,3,3,2], SV_ROWS='ABCDEFGHIJ';
const SV_NAME={5:'Schlachtschiff',4:'Kreuzer',3:'Zerstörer',2:'U-Boot'};
const SV_ACC={5:'das Schlachtschiff',4:'den Kreuzer',3:'einen Zerstörer',2:'das U-Boot'};
const SV_EMAX=10;
const SV_ABIL={
  radar:{cost:3,name:'Radar',icon:'◎',desc:'Scannt 3×3 Felder. Danach darfst du noch schießen.'},
  torpedo:{cost:4,name:'Torpedo',icon:'➤',desc:'Läuft durch eine Reihe oder Spalte bis zum ersten Schiff.'},
  salve:{cost:5,name:'Salve',icon:'⁂',desc:'3 Schüsse auf zufällige Felder.'},
  bombe:{cost:6,name:'Bombe',icon:'✹',desc:'Trifft 3×3 Felder auf einmal.'}
};
let SV=null;          // vollständiger Spielstand (lokal / Gastgeber)
let SVV=null;         // Sicht, die ein Mitspieler vom Gastgeber bekommt
let svDraft=null, svAiBusy=false, svSeenN=-1, svPrevCur=null, svMode={abil:null,dir:'h'};
const svKey=(r,c)=>r+','+c;
const svActive=()=>mode==='client'?!!SVV:!!SV;
function svSeat(){
  if(mode==='client') return CLIENT&&CLIENT.you!=null?CLIENT.you:null;
  if(!SV) return null;
  if(mode==='local') return svViewer;
  const i=SV.players.findIndex(p=>p.tok===myTok); return i<0?null:i;
}
/* An einem Gerät: wer schaut gerade aufs Meer? Bei zwei Menschen wird dazwischen verdeckt. */
let svViewer=0, svPendViewer=null, svCoverT=null;
function svWantViewer(){
  if(SV.phase==='place'){ const i=SV.players.findIndex(p=>!p.ai&&!p.ready); return i>=0?i:svViewer; }
  if(SV.phase==='play'&&!SV.players[SV.cur].ai) return SV.cur;
  return svViewer;
}
function svUpdateViewer(){
  if(mode!=='local'||!SV) return;
  const want=svWantViewer(); if(want===svViewer||want===svPendViewer) return;
  if(SV.players.filter(p=>!p.ai).length<=1){ svViewer=want; return; }
  svPendViewer=want; clearTimeout(svCoverT);
  svCoverT=setTimeout(()=>{ if(SV&&svPendViewer!=null&&(!ovKey||ovKey==='svcover')) showSvCover(); }, animOff?100:(SV.phase==='place'?300:1300));
}
function showSvCover(){
  const p=SV.players[svPendViewer]; if(!p) return;
  overlay(`<div class="center-av">${avatarSVG(p.av,84,'av av-xl')}</div><h2>Weitergeben an ${esc(p.name)}</h2><p>${SV.phase==='place'?'Jetzt stellt '+esc(p.name)+' die Flotte auf. Die anderen bitte wegschauen.':'Die anderen bitte wegschauen.'}</p><div class="row"><button class="btn primary" id="svUncover">Ich bin ${esc(p.name)} – los geht's</button></div>`,'svcover');
}
function svStartLocal(cfg){
  mode='local'; G=null; SVV=null; MM=null; MMV=null; covered=false; svMode={abil:null,dir:'h'}; svPendViewer=null; svDraft=null;
  SV=svNew(cfg.slice(0,2).map(p=>({name:p.name,av:p.av,ai:p.ai})));
  const h=SV.players.findIndex(p=>!p.ai); svViewer=h>=0?h:0;
  overlay(''); svChanged();
}
function svCellsOf(r,c,len,h){ const out=[]; for(let i=0;i<len;i++){ const rr=h?r:r+i, cc=h?c+i:c; if(rr<0||cc<0||rr>=SV_N||cc>=SV_N) return null; out.push([rr,cc]); } return out; }
function svArea(r,c){ const out=[]; for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++){ const rr=r+dr, cc=c+dc; if(rr>=0&&cc>=0&&rr<SV_N&&cc<SV_N) out.push([rr,cc]); } return out; }
function svTouches(cells,ships){
  const occ=new Set();
  ships.forEach(s=>s.cells.forEach(([r,c])=>{ for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++) occ.add(svKey(r+dr,c+dc)); }));
  return cells.some(([r,c])=>occ.has(svKey(r,c)));
}
function svRandomFleet(){
  for(let t=0;t<300;t++){
    const ships=[]; let ok=true;
    for(const len of SV_FLEET){
      let placed=false;
      for(let k=0;k<400&&!placed;k++){ const cells=svCellsOf(randInt(SV_N),randInt(SV_N),len,randInt(2)===0); if(cells&&!svTouches(cells,ships)){ ships.push({cells}); placed=true; } }
      if(!placed){ ok=false; break; }
    }
    if(ok) return ships;
  }
  return null;
}
function svValidFleet(ships){
  if(!Array.isArray(ships)||ships.length!==SV_FLEET.length) return null;
  const want=[...SV_FLEET].sort((a,b)=>b-a).join(), have=ships.map(s=>Array.isArray(s)?s.length:0).sort((a,b)=>b-a).join();
  if(want!==have) return null;
  const out=[];
  for(const s of ships){
    const cells=s.map(p=>[int(p&&p[0],0,SV_N-1,-1),int(p&&p[1],0,SV_N-1,-1)]);
    if(cells.some(([r,c])=>r<0||c<0)) return null;
    cells.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    const h=cells.every(p=>p[0]===cells[0][0]), v=cells.every(p=>p[1]===cells[0][1]);
    if(!h&&!v) return null;
    for(let i=1;i<cells.length;i++){ if((h?cells[i][1]-cells[i-1][1]:cells[i][0]-cells[i-1][0])!==1) return null; }
    if(svTouches(cells,out)) return null;
    out.push({cells});
  }
  return out;
}
function svNew(cfg,round){
  const s={phase:'place',round:round||1,cur:0,winner:null,last:null,log:['Stellt eure Flotten auf!'],
    players:cfg.map(p=>({name:p.name,av:cleanAv(p.av),tok:p.tok||null,ai:!!p.ai,ships:null,ready:false,hits:{},scans:{},shots:0,hitsMade:0,energy:0}))};
  s.players.forEach(p=>{ if(p.ai){ p.ships=svRandomFleet(); p.ready=true; } });
  return s;
}
function svLog(t){ SV.log.push(t); if(SV.log.length>30) SV.log.shift(); }
const svIsSunk=(ship,hits)=>ship.cells.every(([r,c])=>hits[svKey(r,c)]===1);
/* feuert auf mehrere Felder; gibt Ergebnis zurück */
function svFire(seat,cells){
  const me=SV.players[seat], opp=SV.players[1-seat], res=[], sunk=[];
  for(const [r,c] of cells){
    const k=svKey(r,c); if(opp.hits[k]!==undefined) continue;
    const ship=opp.ships.find(s=>s.cells.some(([rr,cc])=>rr===r&&cc===c));
    opp.hits[k]=ship?1:0; me.shots++; res.push([r,c,ship?1:0]);
    if(ship){ me.hitsMade++; if(svIsSunk(ship,opp.hits)&&!sunk.includes(ship)) sunk.push(ship); }
  }
  return {res, hits:res.filter(x=>x[2]).length, sunk};
}
function svAfterFire(seat,type,f,text){
  const me=SV.players[seat], opp=SV.players[1-seat];
  let t=text;
  const NOM={5:'Das Schlachtschiff',4:'Der Kreuzer',3:'Ein Zerstörer',2:'Das U-Boot'};
  if(f.sunk.length) t+=' '+f.sunk.map(s=>`${NOM[s.cells.length]} ist versenkt!`).join(' ');
  if(opp.ships.every(s=>svIsSunk(s,opp.hits))){ SV.phase='over'; SV.winner=seat; t+=` ${me.name} hat die ganze Flotte versenkt!`; }
  else if(!f.hits) SV.cur=1-seat;
  svLog(t);
  SV.last={by:seat,type,cells:f.res,sunk:f.sunk.map(s=>s.cells.length),n:(SV.last?SV.last.n:0)+1,text:t};
}
function svApply(seat,a){
  a=a&&typeof a==='object'?a:{};
  if(!SV) return 'Kein Spiel.';
  if(seat==null||!SV.players[seat]) return 'Du spielst nicht mit.';
  const me=SV.players[seat], opp=SV.players[1-seat];
  if(a.type==='place'){
    if(SV.phase!=='place') return 'Die Flotten stehen schon.';
    if(me.ready) return 'Du bist schon bereit.';
    const ships=svValidFleet(Array.isArray(a.ships)?a.ships.slice(0,6).map(s=>Array.isArray(s)?s.slice(0,6):[]):null);
    if(!ships) return 'Diese Aufstellung ist nicht erlaubt.';
    me.ships=ships; me.ready=true; svLog(`${me.name} ist bereit.`);
    if(SV.players.every(p=>p.ready)){ SV.phase='play'; SV.cur=randInt(2); svLog(`Alle Flotten stehen! ${SV.players[SV.cur].name} beginnt.`); SV.last={by:SV.cur,type:'start',cells:[],sunk:[],n:(SV.last?SV.last.n:0)+1,text:`${SV.players[SV.cur].name} beginnt.`}; }
    return null;
  }
  if(SV.phase!=='play') return 'Gerade kann niemand schießen.';
  if(SV.cur!==seat) return 'Du bist nicht dran.';
  const r=int(a.r,0,SV_N-1,-1), c=int(a.c,0,SV_N-1,-1);
  const name=(rr,cc)=>SV_ROWS[rr]+(cc+1);
  if(a.type==='shoot'){
    if(r<0||c<0) return 'Ungültiges Feld.';
    if(opp.hits[svKey(r,c)]!==undefined) return 'Da hast du schon hingeschossen.';
    const f=svFire(seat,[[r,c]]);
    me.energy=Math.min(SV_EMAX,me.energy+1);
    svAfterFire(seat,'shoot',f, f.hits?`${me.name} trifft auf ${name(r,c)}!`:`${me.name}: ${name(r,c)} – Wasser.`);
    return null;
  }
  const ab=SV_ABIL[a.type]; if(!ab) return 'Unbekannter Zug.';
  if(me.energy<ab.cost) return `Dafür brauchst du ${ab.cost} Energie.`;
  if(a.type==='radar'){
    if(r<0||c<0) return 'Ungültiges Feld.';
    const cells=svArea(r,c).filter(([rr,cc])=>opp.hits[svKey(rr,cc)]===undefined), res=[];
    cells.forEach(([rr,cc])=>{ const v=opp.ships.some(s=>s.cells.some(([sr,sc])=>sr===rr&&sc===cc))?1:0; me.scans[svKey(rr,cc)]=v; res.push([rr,cc,v]); });
    me.energy-=ab.cost;
    const n=res.filter(x=>x[2]).length, t=`${me.name} scannt um ${name(r,c)}: ${n?n+' Schiffsteil'+(n>1?'e':'')+' entdeckt':'nichts gefunden'}.`;
    svLog(t); SV.last={by:seat,type:'radar',cells:res,sunk:[],n:(SV.last?SV.last.n:0)+1,text:t};
    return null;
  }
  let cells=[];
  if(a.type==='bombe'){ if(r<0||c<0) return 'Ungültiges Feld.'; cells=svArea(r,c); }
  if(a.type==='salve'){ const free=[]; for(let rr=0;rr<SV_N;rr++) for(let cc=0;cc<SV_N;cc++) if(opp.hits[svKey(rr,cc)]===undefined) free.push([rr,cc]); for(let i=0;i<3&&free.length;i++) cells.push(free.splice(randInt(free.length),1)[0]); }
  if(a.type==='torpedo'){
    if(r<0||c<0) return 'Ungültiges Feld.';
    const h=a.dir!=='v';
    for(let i=0;i<SV_N;i++){ const rr=h?r:i, cc=h?i:c, k=svKey(rr,cc); if(opp.hits[k]!==undefined) continue; cells.push([rr,cc]); if(opp.ships.some(s=>s.cells.some(([sr,sc])=>sr===rr&&sc===cc))) break; }
  }
  if(!cells.some(([rr,cc])=>opp.hits[svKey(rr,cc)]===undefined)) return 'Dort gibt es nichts mehr zu treffen.';
  me.energy-=ab.cost;
  const f=svFire(seat,cells);
  const where=a.type==='torpedo'?(a.dir==='v'?`Spalte ${c+1}`:`Reihe ${SV_ROWS[r]}`):a.type==='bombe'?`um ${name(r,c)}`:'';
  svAfterFire(seat,a.type,f,`${me.name} setzt ${ab.name==='Bombe'?'eine Bombe':ab.name==='Salve'?'eine Salve':'einen Torpedo'} ein${where?' ('+where+')':''}: ${f.hits?f.hits+' Treffer':'kein Treffer'}.`);
  return null;
}
function svView(seat){
  const toArr=h=>Object.keys(h).map(k=>{ const [r,c]=k.split(',').map(Number); return [r,c,h[k]]; });
  const me=seat!=null?SV.players[seat]:null, opp=seat!=null?SV.players[1-seat]:null;
  return {phase:SV.phase, round:SV.round, cur:SV.cur, winner:SV.winner, last:SV.last,
    players:SV.players.map(p=>({name:p.name,av:p.av,ready:p.ready,left:p.ships?p.ships.filter(s=>!svIsSunk(s,p.hits)).length:SV_FLEET.length,shots:p.shots,hitsMade:p.hitsMade,energy:p.energy})),
    myShips:me&&me.ships?me.ships.map(s=>s.cells):null, myHits:me?toArr(me.hits):[], myScans:me?toArr(me.scans):[],
    oppHits:opp?toArr(opp.hits):[], oppSunk:opp&&opp.ships?opp.ships.filter(s=>svIsSunk(s,opp.hits)).map(s=>s.cells):[],
    oppShips:opp&&opp.ships&&SV.phase==='over'?opp.ships.map(s=>s.cells):null};
}
function sanitizeSvView(v){
  if(!v||typeof v!=='object'||!Array.isArray(v.players)||v.players.length!==2) return null;
  const cell=p=>[int(p&&p[0],0,9,0),int(p&&p[1],0,9,0)], hit=p=>[int(p&&p[0],0,9,0),int(p&&p[1],0,9,0),int(p&&p[2],0,1,0)];
  const ships=a=>Array.isArray(a)?a.slice(0,6).map(s=>(Array.isArray(s)?s.slice(0,6):[]).map(cell)):null;
  const L=v.last&&typeof v.last==='object'?v.last:null;
  return {phase:['place','play','over'].includes(v.phase)?v.phase:'place', round:int(v.round,1,1e4,1), cur:int(v.cur,0,1,0),
    winner:v.winner==null?null:int(v.winner,0,1,null),
    last:L?{by:int(L.by,0,1,0),type:['shoot','radar','torpedo','salve','bombe','start'].includes(L.type)?L.type:'shoot',cells:(Array.isArray(L.cells)?L.cells:[]).slice(0,12).map(hit),sunk:(Array.isArray(L.sunk)?L.sunk:[]).slice(0,5).map(x=>int(x,2,5,2)),n:int(L.n,0,1e6,0),text:str(L.text,200)}:null,
    players:v.players.map(p=>{ p=p&&typeof p==='object'?p:{}; return {name:str(p.name,16)||'?',av:cleanAv(p.av),ready:!!p.ready,left:int(p.left,0,6,0),shots:int(p.shots,0,200,0),hitsMade:int(p.hitsMade,0,200,0),energy:int(p.energy,0,SV_EMAX,0)}; }),
    myShips:ships(v.myShips), myHits:(Array.isArray(v.myHits)?v.myHits:[]).slice(0,100).map(hit), myScans:(Array.isArray(v.myScans)?v.myScans:[]).slice(0,100).map(hit),
    oppHits:(Array.isArray(v.oppHits)?v.oppHits:[]).slice(0,100).map(hit), oppSunk:ships(v.oppSunk)||[], oppShips:ships(v.oppShips)};
}
const curSvView=()=>mode==='client'?SVV:(SV?svView(svSeat()):null);

/* Computer: Schachbrett-Suche, verfolgt Treffer, lässt Felder neben versenkten Schiffen aus, nutzt die Bombe */
function svAiKnow(seat){
  const opp=SV.players[1-seat], H=opp.hits, tried=k=>H[k]!==undefined;
  const sunk=new Set(); opp.ships.filter(s=>svIsSunk(s,H)).forEach(s=>s.cells.forEach(([r,c])=>sunk.add(svKey(r,c))));
  const blocked=new Set(); sunk.forEach(k=>{ const [r,c]=k.split(',').map(Number); for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++) blocked.add(svKey(r+dr,c+dc)); });
  const open=(r,c)=>r>=0&&c>=0&&r<SV_N&&c<SV_N&&!tried(svKey(r,c))&&!blocked.has(svKey(r,c));
  const hits=Object.keys(H).filter(k=>H[k]===1&&!sunk.has(k)).map(k=>k.split(',').map(Number));
  return {H,tried,open,hits};
}
function svAiPick(seat){
  const {tried,open,hits}=svAiKnow(seat);
  if(hits.length){
    let cand=[];
    if(hits.length>=2){
      if(hits.every(h=>h[0]===hits[0][0])){ const cs=hits.map(h=>h[1]); cand=[[hits[0][0],Math.min(...cs)-1],[hits[0][0],Math.max(...cs)+1]]; }
      else if(hits.every(h=>h[1]===hits[0][1])){ const rs=hits.map(h=>h[0]); cand=[[Math.min(...rs)-1,hits[0][1]],[Math.max(...rs)+1,hits[0][1]]]; }
    }
    cand=cand.filter(([r,c])=>open(r,c));
    if(!cand.length) hits.forEach(([r,c])=>[[1,0],[-1,0],[0,1],[0,-1]].forEach(([dr,dc])=>{ if(open(r+dr,c+dc)) cand.push([r+dr,c+dc]); }));
    if(cand.length) return {type:'shoot',r:cand[0+randInt(cand.length)][0],c:cand[randInt(cand.length)][1],_cand:cand};
  }
  const me=SV.players[seat];
  if(me.energy>=SV_ABIL.bombe.cost){
    let best=null,bs=-1;
    for(let r=1;r<SV_N-1;r++) for(let c=1;c<SV_N-1;c++){ const s=svArea(r,c).filter(([rr,cc])=>open(rr,cc)).length; if(s>bs){bs=s;best=[r,c];} }
    if(best&&bs>=6) return {type:'bombe',r:best[0],c:best[1]};
  }
  let pool=[]; for(let r=0;r<SV_N;r++) for(let c=0;c<SV_N;c++) if(open(r,c)&&(r+c)%2===0) pool.push([r,c]);
  if(!pool.length) for(let r=0;r<SV_N;r++) for(let c=0;c<SV_N;c++) if(open(r,c)) pool.push([r,c]);
  if(!pool.length) for(let r=0;r<SV_N;r++) for(let c=0;c<SV_N;c++) if(!tried(svKey(r,c))) pool.push([r,c]);
  const p=pool[randInt(pool.length)]; return {type:'shoot',r:p[0],c:p[1]};
}
function maybeSvAI(){
  if(mode!=='local'||!SV||SV.phase!=='play'||svAiBusy) return;
  if(!SV.players[SV.cur].ai) return;
  svAiBusy=true; const mySV=SV;
  setTimeout(()=>{ svAiBusy=false; if(SV!==mySV||SV.phase!=='play'||!SV.players[SV.cur].ai) return;
    const seat=SV.cur; let a=svAiPick(seat);
    if(a._cand){ const p=a._cand[randInt(a._cand.length)]; a={type:'shoot',r:p[0],c:p[1]}; }
    svApply(seat,a); svChanged(); }, animOff?400:1000);
}
function svChanged(){ if(mode==='local') svUpdateViewer(); if(mode==='host'){ hostBroadcast(); hostSave(); } render(); maybeSvAI(); }
function svAct(a){
  if(mode==='client'){ if(!hostReachable()){ toast('Keine Verbindung zum Gastgeber – ich versuche es weiter …'); return; } clientAct(a); return; }
  const err=svApply(svSeat(),a); if(err){ toast(err); return; }
  svChanged();
}
function svStartVsCpu(){
  readName(); stopNet();
  svStartLocal([{name:myName||'Du',av:myAv},{name:'Computer',av:randomAv(),ai:true}]);
}
function svDraftFor(V){
  const key=V.round+'|'+mode+'|'+svSeat();
  if(!svDraft||svDraft.key!==key) svDraft={key,ships:SV_FLEET.map(len=>({len,cells:null})),sel:0,horiz:true};
  return svDraft;
}

/* Spielfeld zeichnen */
function svShipClasses(ships){
  const m=new Map();
  (ships||[]).forEach(cells=>{
    if(!cells||!cells.length) return;
    const s=[...cells].sort((a,b)=>a[0]-b[0]||a[1]-b[1]), h=s.length>1&&s[0][0]===s[1][0];
    s.forEach((p,i)=>m.set(svKey(p[0],p[1]),'ship '+(s.length===1?'':h?'sh-h':'sh-v')+(i===0?' sh-a':'')+(i===s.length-1?' sh-z':'')));
  });
  return m;
}
function svGridHTML(cellFn){
  let h='<div class="sv-lab"></div>'; for(let c=0;c<SV_N;c++) h+=`<div class="sv-lab">${c+1}</div>`; h+='<div class="sv-lab"></div>';
  for(let r=0;r<SV_N;r++){
    h+=`<div class="sv-lab">${SV_ROWS[r]}</div>`;
    for(let c=0;c<SV_N;c++){ const o=cellFn(r,c), lab=SV_ROWS[r]+(c+1);
      h+=o.attr?`<button class="sv-cell ${o.cls}" ${o.attr} aria-label="${lab}"></button>`:`<div class="sv-cell ${o.cls}"></div>`; }
    h+='<div class="sv-lab"></div>';
  }
  for(let c=0;c<SV_N+2;c++) h+='<div class="sv-lab sv-foot"></div>';
  return h;
}
/* Flotte: welche Schiffe schwimmen noch? */
function svFleetHTML(sunkLens){
  const left=[...sunkLens];
  return `<div class="sv-fleet">${SV_FLEET.map(len=>{ const i=left.indexOf(len), sunk=i>=0; if(sunk) left.splice(i,1);
    return `<span class="fl${sunk?' sunk':''}" title="${SV_NAME[len]}${sunk?' (versenkt)':''}">${'<i></i>'.repeat(len)}</span>`; }).join('')}</div>`;
}
function renderSV(){
  const V=curSvView(); if(!V) return;
  const me=svSeat(), oi=me!=null?1-me:1, meP=me!=null?V.players[me]:null, op=V.players[oi];
  const hold=mode==='local'&&svPendViewer!=null;
  const placing=V.phase==='place'&&meP&&!meP.ready&&!hold, myTurn=V.phase==='play'&&V.cur===me&&!hold;
  if(!myTurn) svMode.abil=null;
  $('roundInfo').textContent=`Schiffe versenken · Spiel ${V.round}`;
  $('svPlayers').innerHTML=[me!=null?me:0, oi].map(i=>{ const p=V.players[i]; return `<div class="sv-pl${V.phase==='play'&&V.cur===i?' cur':''}">${avatarSVG(p.av,40)}<div class="sv-pl-in"><b>${esc(p.name)}${i===me?' <span class="pl-meta">· du</span>':''}</b><div class="pl-meta">${V.phase==='place'?(p.ready?'bereit ✓':'stellt auf …'):`${p.left}/${SV_FLEET.length} Schiffe übrig`}</div>${V.phase!=='place'?`<div class="energy" aria-label="Energie ${p.energy} von ${SV_EMAX}">${Array.from({length:SV_EMAX},(_,k)=>`<i class="${k<p.energy?'on':''}"></i>`).join('')}</div>`:''}</div></div>`; }).join('');
  let msg='', sub='';
  if(placing){ msg='Stelle deine Flotte auf.'; sub='Schiff unten wählen, dann aufs Feld tippen. „Drehen“ wechselt die Richtung. Schiffe dürfen sich nicht berühren.'; }
  else if(V.phase==='place'){ msg=`Warte auf ${op.name} …`; sub=`${op.name} stellt noch auf.`; }
  else if(V.phase==='play'){
    if(myTurn){ msg=svMode.abil?`${SV_ABIL[svMode.abil].name}: Ziel wählen`:'Du bist dran!'; sub=svMode.abil?SV_ABIL[svMode.abil].desc:'Tippe ein Feld im gegnerischen Meer. Treffer = nochmal schießen.'; }
    else msg=`${V.players[V.cur].name} zielt …`;
  } else msg=V.winner===me?'Gewonnen!':`${V.players[V.winner].name} gewinnt.`;
  if(mode==='client'&&!hostReachable()) sub='Verbindung zum Gastgeber unterbrochen – ich versuche es automatisch weiter …';
  $('svMsg').textContent=msg; $('svSub').textContent=sub;
  $('svLog').innerHTML=V.last&&V.last.text?`<div class="sv-last">${esc(V.last.text)}</div>`:'';
  const fresh=V.last&&V.last.n!==svSeenN?V.last:null;
  const freshSet=new Set(fresh?fresh.cells.map(([r,c])=>svKey(r,c)):[]);
  // Gegnerisches Meer
  const oppWrap=$('svOppWrap');
  if(placing||V.phase==='place'){ oppWrap.hidden=true; }
  else {
    oppWrap.hidden=false;
    $('svOppTitle').innerHTML=`${avatarSVG(op.av,22)} Meer von ${esc(op.name)} ${svFleetHTML(V.oppSunk.map(s=>s.length))}`;
    const hits=new Map(V.oppHits.map(([r,c,h])=>[svKey(r,c),h])), sunk=new Set(V.oppSunk.flat().map(([r,c])=>svKey(r,c)));
    const scans=new Map((V.myScans||[]).map(([r,c,v])=>[svKey(r,c),v]));
    const reveal=svShipClasses(V.oppShips), canShoot=myTurn;
    $('svOpp').innerHTML=svGridHTML((r,c)=>{
      const k=svKey(r,c), h=hits.get(k); let cls=reveal.get(k)?reveal.get(k)+' ghost':'';
      if(h===1) cls+=' hit'+(sunk.has(k)?' sunk':''); else if(h===0) cls+=' miss';
      else if(scans.has(k)) cls+=scans.get(k)?' scan-ship':' scan-empty';
      if(fresh&&fresh.by===me&&freshSet.has(k)) cls+=fresh.type==='radar'?' scan-fresh':' fresh';
      const target=canShoot&&(h===undefined||svMode.abil==='radar'||svMode.abil==='bombe'||svMode.abil==='torpedo');
      return {cls, attr:target?`data-sv="${r},${c}"`:''};
    });
    $('svOpp').className='sv-grid opp'+(canShoot?' aim':'')+(svMode.abil?' mode-'+svMode.abil:'');
  }
  // Eigenes Meer
  const d=placing?svDraftFor(V):null;
  const myShips=placing?d.ships.filter(s=>s.cells).map(s=>s.cells):V.myShips;
  const shipCls=svShipClasses(myShips), myHits=new Map(V.myHits.map(([r,c,h])=>[svKey(r,c),h]));
  const mySunk=(V.myShips||[]).filter(cells=>cells.every(([r,c])=>myHits.get(svKey(r,c))===1)).map(s=>s.length);
  $('svMeTitle').innerHTML=`${meP?avatarSVG(meP.av,22):''} Deine Flotte ${placing?'':svFleetHTML(mySunk)}`;
  $('svMe').innerHTML=svGridHTML((r,c)=>{
    const k=svKey(r,c), h=myHits.get(k); let cls=shipCls.get(k)||'';
    if(h===1) cls+=' hit'; else if(h===0) cls+=' miss';
    if(fresh&&fresh.by!==me&&fresh.type!=='radar'&&freshSet.has(k)) cls+=' fresh';
    return {cls, attr:placing?`data-svp="${r},${c}"`:''};
  });
  $('svMeWrap').classList.toggle('big',placing);
  // Steuerung
  let ctrl='';
  if(placing){
    const all=d.ships.every(s=>s.cells);
    ctrl=`<div class="sv-ships">${d.ships.map((s,i)=>`<button class="sv-ship${d.sel===i?' on':''}${s.cells?' done':''}" data-svship="${i}" aria-label="${SV_NAME[s.len]}, ${s.len} Felder"><span class="blocks">${'<i></i>'.repeat(s.len)}</span><small>${SV_NAME[s.len]}${s.cells?' ✓':''}</small></button>`).join('')}</div>
      <div class="actions"><button class="btn" id="svRotate">Drehen: ${d.horiz?'waagerecht':'senkrecht'}</button><button class="btn" id="svRandom">Zufällig</button><button class="btn" id="svClear">Leeren</button><button class="btn primary" id="svReady" ${all?'':'disabled'}>Fertig – Flotte steht</button></div>`;
  }
  let abil='';
  if(V.phase==='play'&&meP){
    const en=meP.energy;
    abil=`<div class="abil-bar"><div class="abil-head"><b>Spezialangriffe</b><span class="pl-meta">Jeder normale Schuss lädt 1 Energie auf (max. ${SV_EMAX}).</span></div>
      <div class="abils">${Object.entries(SV_ABIL).map(([k,a])=>`<button class="abil${svMode.abil===k?' on':''}${en>=a.cost?' ready':''}" data-abil="${k}" ${myTurn&&en>=a.cost?'':'disabled'}><span class="ai">${a.icon}</span><b>${a.name}</b><small>${a.cost} ⚡</small></button>`).join('')}</div>
      ${svMode.abil==='torpedo'?`<div class="actions"><button class="btn" id="svTorpDir">Richtung: ${svMode.dir==='h'?'Reihe (→)':'Spalte (↓)'}</button></div>`:''}
      ${svMode.abil?`<div class="actions"><button class="btn" id="svAbilCancel">Abbrechen</button></div>`:''}</div>`;
  }
  $('svCtrl').innerHTML=ctrl; $('svAbil').innerHTML=abil;
  if(fresh) svSeenN=fresh.n;
  if(myTurn&&svPrevCur!==me&&meP) showTurnBanner(meP.av);
  svPrevCur=V.phase==='play'?V.cur:null;
  // Spielende
  if(V.phase==='over'){
    const k='svend'+V.round;
    if(ovKey!==k&&!['rules','menu','settings','privacy','online','avatar'].includes(ovKey)){
      const w=V.players[V.winner], canGo=mode!=='client';
      const rows=V.players.map(p=>`<tr><td><span class="who">${avatarSVG(p.av,26)}${esc(p.name)}</span></td><td>${p.shots}</td><td>${p.hitsMade}</td><td>${p.shots?Math.round(p.hitsMade/p.shots*100):0} %</td></tr>`).join('');
      confetti('sv'+V.round);
      setTimeout(()=>{ if(svActive()&&curSvView().phase==='over'&&ovKey!==k) overlay(`<div class="center-av winner">${avatarSVG(w.av,110,'av av-xl')}</div><h2>${esc(w.name)} gewinnt!</h2><p>Die ganze Flotte liegt auf dem Meeresgrund.</p><table><tr><th>Spieler</th><th>Schüsse</th><th>Treffer</th><th>Quote</th></tr>${rows}</table>${canGo?'':`<p class="note">Warte, ob ${esc((CLIENT&&CLIENT.hostName)||'der Gastgeber')} eine Revanche startet.</p>`}<div class="row mt">${canGo?'<button class="btn primary" id="svAgain">Revanche</button>':''}<button class="btn" id="toMenu">Zum Menü</button></div>`,k); }, animOff?0:900);
    }
  } else if(ovKey.startsWith('svend')) overlay('');
}
function svAgain(){
  if(!SV) return;
  SV=svNew(SV.players.map(p=>({name:p.name,av:p.av,tok:p.tok,ai:p.ai})),SV.round+1);
  svDraft=null; svMode={abil:null,dir:'h'}; svPendViewer=null; clearTimeout(svCoverT);
  if(mode==='local'){ const h=SV.players.findIndex(p=>!p.ai); svViewer=h>=0?h:0; }
  overlay(''); svChanged();
}
function showSvRules(ret){
  overlay(`<div class="rules"><h2>Schiffe versenken</h2>
    <ol>
      <li><b>Aufstellen:</b> Jeder stellt seine Flotte geheim auf: Schlachtschiff (5 Felder), Kreuzer (4), zwei Zerstörer (je 3) und ein U-Boot (2). Schiffe stehen waagerecht oder senkrecht und dürfen sich nicht berühren – auch nicht über Eck.</li>
      <li><b>Schießen:</b> Abwechselnd tippt ihr ein Feld im gegnerischen Meer an. ● heißt Wasser, ✕ heißt Treffer. Wer trifft, darf nochmal.</li>
      <li><b>Energie:</b> Jeder normale Schuss lädt 1 Energie auf (höchstens ${SV_EMAX}). Damit kannst du Spezialangriffe einsetzen:
        <ul>${Object.values(SV_ABIL).map(a=>`<li><b>${a.icon} ${a.name} (${a.cost} ⚡):</b> ${a.desc}</li>`).join('')}</ul>
        Trifft ein Angriff etwas, darfst du nochmal. Das Radar schießt nicht – danach bist du weiter dran.</li>
      <li><b>Sieg:</b> Wer zuerst alle gegnerischen Schiffe versenkt, gewinnt. Über jedem Meer siehst du, welche Schiffe noch schwimmen.</li>
    </ol>
    <div class="row mt"><button class="btn primary" id="svRulesBack">Verstanden</button></div></div>`,'rules',ret==='menu'?'full':'');
  showSvRules.ret=ret;
}

/* ======================= MAU-MAU ======================= */
const MM_SUITS=['♣','♠','♥','♦'], MM_SUITNAME=['Kreuz','Pik','Herz','Karo'];
const MM_R32=['7','8','9','10','B','D','K','A'], MM_R52=['2','3','4','5','6','7','8','9','10','B','D','K','A'];
const MM_EFF={none:'–',draw2:'Zwei ziehen',skip:'Aussetzen',reverse:'Richtungswechsel',wish:'Farbe wünschen',again:'Nochmal legen',all1:'Alle anderen ziehen 1'};
const MM_TOGGLES=[['stack','Ziehkarten stapeln','Auf eine „Zwei ziehen“-Karte darf man eine weitere legen – der Nächste zieht dann 4, 6 …'],
  ['wishAny','Wünscher passt auf jede Karte','Die Wunschkarte (z. B. Bube) darf man immer legen.'],
  ['jackOnJack','Wünscher auf Wünscher','Wunschkarte darf auf eine Wunschkarte gelegt werden.'],
  ['mau','„Mau“ sagen','Wer die vorletzte Karte legt, muss vorher „Mau“ tippen – sonst 2 Strafkarten.']];
const MM_PRESETS=[
  {id:'p-klassisch',name:'Klassisch',preset:true,hand:5,deck:32,eff:{'7':'draw2','8':'skip','B':'wish'},stack:true,jackOnJack:false,wishAny:true,mau:true},
  {id:'p-einfach',name:'Einfach',preset:true,hand:5,deck:32,eff:{'7':'draw2','8':'skip','B':'wish'},stack:false,jackOnJack:false,wishAny:true,mau:false},
  {id:'p-wild',name:'Wild',preset:true,hand:6,deck:32,eff:{'7':'draw2','8':'skip','9':'reverse','10':'all1','B':'wish','A':'again'},stack:true,jackOnJack:true,wishAny:true,mau:true}];
function mmCleanRules(r){
  r=r&&typeof r==='object'?r:{}; const eff={};
  MM_R52.forEach(k=>{ const v=r.eff&&r.eff[k]; if(MM_EFF[v]&&v!=='none') eff[k]=v; });
  const id=str(r.id,24);
  return {id:/^[a-z0-9-]{3,24}$/.test(id)?id:('c-'+randHex(4)), name:str(r.name,24)||'Eigene Regeln', preset:!!r.preset, hand:int(r.hand,3,8,5),
    deck:int(r.deck,32,52,32)===52?52:32, eff, stack:!!r.stack, jackOnJack:!!r.jackOnJack, wishAny:r.wishAny!==false, mau:!!r.mau};
}
let mmCustom=(()=>{ try{ const a=JSON.parse(lsGet('etappen-mmrules')); if(Array.isArray(a)) return a.slice(0,20).map(x=>mmCleanRules({...x,preset:false})); }catch(e){} return []; })();
let mmSelId=lsGet('etappen-mmsel')||'p-klassisch';
const mmAllRules=()=>[...MM_PRESETS,...mmCustom];
const mmRules=()=>mmAllRules().find(r=>r.id===mmSelId)||MM_PRESETS[0];
function mmSaveCustom(){ lsSet('etappen-mmrules',JSON.stringify(mmCustom)); lsSet('etappen-mmsel',mmSelId); }
function mmSummary(r){
  const ranks=r.deck===52?MM_R52:MM_R32, parts=ranks.filter(k=>r.eff[k]).map(k=>`${k}: ${MM_EFF[r.eff[k]]}`);
  if(r.stack) parts.push('stapeln'); if(r.mau) parts.push('„Mau“ sagen');
  parts.push(`${r.hand} Karten`); if(r.deck===52) parts.push('52er Blatt');
  return parts.join(' · ');
}

let MM=null, MMV=null, mmViewer=null, mmPendViewer=null, mmCoverT=null, mmMauArmed=false, mmAiBusy=false, mmPrevCur=null, mmPick=null;
const mmActive=()=>mode==='client'?!!MMV:!!MM;
const mmEff=(R,c)=>(c&&R.eff[c.r])||'none';
const mmIdx=(S,k)=>{ const n=S.players.length; return ((S.cur+S.dir*k)%n+n)%n; };
function mmDeck(R,n){
  const ranks=R.deck===52?MM_R52:MM_R32, copies=(n*R.hand+12>ranks.length*4)?2:1, d=[]; let id=0;
  for(let k=0;k<copies;k++) for(let s=0;s<4;s++) for(const r of ranks) d.push({id:++id,s,r});
  return shuffle(d);
}
function mmNew(cfg,R,prev){
  const players=cfg.map((p,i)=>({name:p.name,av:cleanAv(p.av),tok:p.tok||null,ai:!!p.ai,hand:[],wins:prev&&prev.players[i]?prev.players[i].wins:0}));
  const round=prev?prev.round+1:1;
  const S={rules:mmCleanRules(R),players,deck:[],disc:[],cur:(round-1)%players.length,dir:1,pend:0,wish:null,drawn:null,phase:'play',winner:null,round,log:[],last:null};
  S.deck=mmDeck(S.rules,players.length);
  for(let k=0;k<S.rules.hand;k++) players.forEach(p=>p.hand.push(S.deck.pop()));
  let top=S.deck.pop(), guard=0; while(mmEff(S.rules,top)!=='none'&&guard++<80){ S.deck.unshift(top); top=S.deck.pop(); }
  S.disc.push(top);
  S.last={by:null,type:'start',n:1,text:`Runde ${round}: ${players[S.cur].name} beginnt.`};
  return S;
}
function mmDraw(S,p,k){
  for(let i=0;i<k;i++){
    if(!S.deck.length){ if(S.disc.length<=1) break; const top=S.disc.pop(); S.deck=shuffle(S.disc); S.disc=[top]; }
    p.hand.push(S.deck.pop());
  }
}
function mmCanPlay(S,c){
  const R=S.rules, top=S.disc[S.disc.length-1], e=mmEff(R,c), te=mmEff(R,top);
  if(S.pend>0) return R.stack&&e==='draw2';
  if(e==='wish'){ if(te==='wish'&&!R.jackOnJack) return false; if(R.wishAny) return true; }
  if(S.wish!=null) return c.s===S.wish;
  return c.s===top.s||c.r===top.r;
}
function mmNext(S,steps){ S.cur=mmIdx(S,steps||1); S.drawn=null; }
function mmApply(seat,a){
  const S=MM; a=a&&typeof a==='object'?a:{};
  if(!S||S.phase!=='play') return 'Die Runde ist vorbei.';
  if(seat!==S.cur) return 'Du bist nicht dran.';
  const p=S.players[seat], R=S.rules;
  const say=t=>{ S.log.push(t); if(S.log.length>30) S.log.shift(); S.last={by:seat,type:a.type,n:(S.last?S.last.n:0)+1,text:t}; };
  if(a.type==='play'){
    const id=int(a.id,0,1e6,-1), c=p.hand.find(x=>x.id===id);
    if(!c) return 'Diese Karte hast du nicht.';
    if(S.drawn!=null&&c.id!==S.drawn) return 'Du darfst jetzt nur die gezogene Karte legen – oder „Weiter“ tippen.';
    if(!mmCanPlay(S,c)) return S.pend>0?`Du musst ${S.pend} Karten ziehen${R.stack?' – oder eine Ziehkarte drauflegen':''}.`:(S.wish!=null?`Gewünscht ist ${MM_SUITNAME[S.wish]} ${MM_SUITS[S.wish]}.`:'Diese Karte passt nicht.');
    p.hand=p.hand.filter(x=>x!==c); S.disc.push(c); S.wish=null; S.drawn=null;
    if(S.disc.length>60) S.disc.splice(0,S.disc.length-60);
    const e=mmEff(R,c); let t=`${p.name} legt ${MM_SUITS[c.s]}${c.r}`;
    if(R.mau&&p.hand.length===1){ if(a.mau) t+=' – „Mau!“'; else { mmDraw(S,p,2); t+=' – vergisst „Mau“ und zieht 2 Strafkarten'; } }
    if(!p.hand.length){ S.phase='over'; S.winner=seat; p.wins++; say(`${t}${R.mau?' – „Mau-Mau!“':''} ${p.name} gewinnt die Runde!`); return null; }
    switch(e){
      case 'draw2': S.pend+=2; mmNext(S); t+=` – ${S.players[S.cur].name} muss ${S.pend} ziehen!`; break;
      case 'skip': t+=` – ${S.players[mmIdx(S,1)].name} setzt aus.`; mmNext(S,2); break;
      case 'reverse': S.dir*=-1; t+=' – Richtungswechsel!'; mmNext(S); break;
      case 'wish': { const w=int(a.wish,0,3,c.s); S.wish=w; t+=` und wünscht sich ${MM_SUITNAME[w]} ${MM_SUITS[w]}.`; mmNext(S); break; }
      case 'again': t+=' und darf nochmal.'; break;
      case 'all1': S.players.forEach((q,i)=>{ if(i!==seat) mmDraw(S,q,1); }); t+=' – alle anderen ziehen 1!'; mmNext(S); break;
      default: if(!t.endsWith('“')) t+='.'; mmNext(S);
    }
    say(t); return null;
  }
  if(a.type==='draw'){
    if(S.drawn!=null) return 'Du hast schon gezogen – lege die Karte oder tippe „Weiter“.';
    if(S.pend>0){ const k=S.pend; mmDraw(S,p,k); S.pend=0; say(`${p.name} zieht ${k} Karten.`); mmNext(S); return null; }
    const before=p.hand.length; mmDraw(S,p,1);
    const c=p.hand[p.hand.length-1];
    if(p.hand.length>before&&mmCanPlay(S,c)){ S.drawn=c.id; say(`${p.name} zieht eine Karte.`); }
    else { say(`${p.name} zieht eine Karte – passt nicht.`); mmNext(S); }
    return null;
  }
  if(a.type==='pass'){ if(S.drawn==null) return 'Zieh zuerst eine Karte.'; say(`${p.name} legt nichts.`); mmNext(S); return null; }
  return 'Unbekannter Zug.';
}
function mmView(seat){
  const S=MM;
  return {rules:S.rules, phase:S.phase, round:S.round, cur:S.cur, dir:S.dir, pend:S.pend, wish:S.wish, winner:S.winner,
    drawn:seat===S.cur?S.drawn:null, deckN:S.deck.length, disc:S.disc.slice(-3), last:S.last,
    players:S.players.map(p=>({name:p.name,av:p.av,ai:p.ai,n:p.hand.length,wins:p.wins})),
    hand:seat!=null&&S.players[seat]?S.players[seat].hand:[], you:seat};
}
function mmCleanCard(c){ if(!c||typeof c!=='object') return null; return {id:int(c.id,0,1e6,0),s:int(c.s,0,3,0),r:MM_R52.includes(c.r)?c.r:'7'}; }
function sanitizeMmView(v){
  if(!v||typeof v!=='object'||!Array.isArray(v.players)||v.players.length<2) return null;
  const n=Math.min(6,v.players.length), L=v.last&&typeof v.last==='object'?v.last:null;
  return {rules:mmCleanRules(v.rules), phase:v.phase==='over'?'over':'play', round:int(v.round,1,1e4,1), cur:int(v.cur,0,n-1,0), dir:v.dir===-1?-1:1,
    pend:int(v.pend,0,60,0), wish:v.wish==null?null:int(v.wish,0,3,null), winner:v.winner==null?null:int(v.winner,0,n-1,null),
    drawn:v.drawn==null?null:int(v.drawn,0,1e6,null), deckN:int(v.deckN,0,200,0),
    disc:(Array.isArray(v.disc)?v.disc:[]).slice(-3).map(mmCleanCard).filter(Boolean),
    last:L?{by:L.by==null?null:int(L.by,0,n-1,null),n:int(L.n,0,1e6,0),text:str(L.text,200)}:null,
    players:v.players.slice(0,n).map(p=>{ p=p&&typeof p==='object'?p:{}; return {name:str(p.name,16)||'?',av:cleanAv(p.av),ai:!!p.ai,n:int(p.n,0,200,0),wins:int(p.wins,0,1e4,0)}; }),
    hand:(Array.isArray(v.hand)?v.hand:[]).slice(0,120).map(mmCleanCard).filter(Boolean), you:v.you==null?null:int(v.you,0,n-1,null)};
}
function mmSeat(){
  if(mode==='client') return MMV?MMV.you:null;
  if(!MM) return null;
  if(mode==='local') return mmViewer;
  const i=MM.players.findIndex(p=>p.tok===myTok); return i<0?null:i;
}
const curMmView=()=>mode==='client'?MMV:(MM?mmView(mmSeat()):null);

/* Computer */
function mmAiMove(S,seat){
  const p=S.players[seat], R=S.rules;
  const play=p.hand.filter(c=>mmCanPlay(S,c)&&(S.drawn==null||c.id===S.drawn));
  if(!play.length) return S.drawn!=null?{type:'pass'}:{type:'draw'};
  const nextN=S.players[mmIdx(S,1)].hand.length;
  const score=c=>{ const e=mmEff(R,c); let s=0; if(e==='wish') s-=5; if((e==='draw2'||e==='skip'||e==='all1')&&nextN<=2) s+=4; if(e==='again') s+=2; s+=p.hand.filter(x=>x.s===c.s).length*0.5; return s+Math.random(); };
  const c=play.sort((a,b)=>score(b)-score(a))[0];
  const counts=[0,0,0,0]; p.hand.forEach(x=>{ if(x!==c&&mmEff(R,x)!=='wish') counts[x.s]++; });
  return {type:'play',id:c.id,wish:counts.indexOf(Math.max(...counts)),mau:true};
}
function maybeMmAI(){
  if(mode==='client'||!MM||MM.phase!=='play'||mmAiBusy) return;
  if(!MM.players[MM.cur].ai) return;
  mmAiBusy=true; const my=MM;
  setTimeout(()=>{ mmAiBusy=false; if(MM!==my||MM.phase!=='play'||!MM.players[MM.cur].ai) return;
    const seat=MM.cur, err=mmApply(seat,mmAiMove(MM,seat));
    if(err) mmApply(seat,MM.drawn!=null?{type:'pass'}:{type:'draw'});
    mmChanged(); }, (animOff?350:900)+(MM.log.length===0&&animOK()?MM.rules.hand*MM.players.length*60+600:0));
}
/* Wer schaut aufs Gerät? (an einem Gerät mit mehreren Menschen) */
function mmUpdateViewer(){
  if(mode!=='local'||!MM||MM.phase!=='play') return;
  const p=MM.players[MM.cur]; if(p.ai||MM.cur===mmViewer) return;
  const humans=MM.players.filter(q=>!q.ai).length;
  if(humans<=1||mmViewer==null){ mmViewer=MM.cur; return; }
  if(mmPendViewer===MM.cur) return;
  mmPendViewer=MM.cur; clearTimeout(mmCoverT);
  mmCoverT=setTimeout(()=>{ if(MM&&mmPendViewer!=null&&!ovKey) showMmCover(); }, animOff?100:700);
}
function showMmCover(){
  const p=MM.players[mmPendViewer]; if(!p) return;
  overlay(`<div class="center-av">${avatarSVG(p.av,84,'av av-xl')}</div><h2>Weitergeben an ${esc(p.name)}</h2><p>Die anderen bitte wegschauen.</p><div class="row"><button class="btn primary" id="mmUncover">Ich bin ${esc(p.name)} – Karten zeigen</button></div>`,'mmcover');
}
function mmChanged(){ if(mode==='local') mmUpdateViewer(); if(mode==='host'){ hostBroadcast(); hostSave(); } render(); maybeMmAI(); }
function mmAct(a){
  if(mode==='client'){ if(!hostReachable()){ toast('Keine Verbindung zum Gastgeber – ich versuche es weiter …'); return; } clientAct(a); return; }
  const err=mmApply(mmSeat(),a); if(err){ toast(err); return; }
  mmChanged();
}
function mmStartLocal(cfg){
  mode='local'; G=null; SV=null; SVV=null; MM=null; MMV=null; MMV=null; mmPendViewer=null; mmMauArmed=false;
  MM=mmNew(cfg,mmRules());
  const h=MM.players.map((p,i)=>p.ai?-1:i).filter(i=>i>=0); mmViewer=h.length?h[0]:null;
  overlay(''); mmChanged();
}
function mmNextRound(){
  if(!MM) return;
  MM=mmNew(MM.players.map(p=>({name:p.name,av:p.av,tok:p.tok,ai:p.ai})),MM.rules,MM);
  mmPendViewer=null; mmMauArmed=false; overlay(''); mmChanged();
}

/* Anzeige */
function mmCardHTML(c,cls='',attrs=''){
  if(!c) return `<div class="card empty ${cls}" ${attrs}></div>`;
  const s=int(c.s,0,3,0), r=MM_R52.includes(c.r)?c.r:'?';
  return `<button class="card mm s${s} ${cls}" ${attrs} aria-label="${MM_SUITNAME[s]} ${r}"><span class="tl">${r}</span><span class="n">${r}</span><span class="s">${MM_SUITS[s]}</span></button>`;
}
const mmSortKey=c=>c.s*20+MM_R52.indexOf(c.r);
/* ---------- Mau-Mau-Animationen ---------- */
let prevMm=null, mmIncoming=new Set(), mmDiscIncoming=false;
const animOK=()=>!reduceMotion.matches&&!animOff&&!document.hidden;
function mmSeatRect(i){ return rectOf(document.querySelector(`#mmSeats [data-pl="${i}"] .bfan .fc:last-of-type`)||document.querySelector(`#mmSeats [data-pl="${i}"] svg.av`)); }
function mmCapture(){
  const r={hand:{},seat:{},deck:rectOf($('mmDeckBtn')),disc:rectOf($('mmTop'))};
  document.querySelectorAll('#hand [data-mmc]').forEach(el=>{ r.hand[el.dataset.mmc]=el.getBoundingClientRect(); });
  document.querySelectorAll('#mmSeats [data-pl]').forEach(el=>{ r.seat[el.dataset.pl]=rectOf(el.querySelector('.bfan .fc:last-of-type')||el.querySelector('svg.av')); });
  return r;
}
function mmReveal(id){ mmIncoming.delete(id); const el=document.querySelector(`#hand [data-mmc="${id}"]`); if(el){ el.classList.remove('incoming'); el.classList.add('land'); } }
function mmRevealDisc(V){ mmDiscIncoming=false; const d=$('mmTop'); if(d){ d.classList.remove('incoming'); d.classList.add('land'); } }
/* großer Schriftzug über dem Tisch */
function fxBurst(text,cls,rect){
  if(!animOK()) return;
  const r=rect||rectOf($('mm').hidden?$('tableR'):$('tableM'))||{left:innerWidth/2,top:innerHeight/2,width:0,height:0};
  const el=document.createElement('div'); el.className='fxburst '+(cls||''); el.textContent=text;
  el.style.left=(r.left+r.width/2)+'px'; el.style.top=(r.top+r.height/2)+'px';
  $('fx').appendChild(el);
  try{ el.animate([{transform:'translate(-50%,-50%) scale(.3) rotate(-8deg)',opacity:0},{transform:'translate(-50%,-50%) scale(1.15) rotate(2deg)',opacity:1,offset:.25},{transform:'translate(-50%,-50%) scale(1) rotate(0)',opacity:1,offset:.7},{transform:'translate(-50%,-75%) scale(.95)',opacity:0}],{duration:1300,easing:'ease-out',fill:'both'}).onfinish=()=>el.remove(); }catch(e){ el.remove(); }
  setTimeout(()=>el.remove(),1600);
}
/* Sprechblase am Platz eines Spielers */
function fxBubble(text,rect){
  if(!animOK()||!rect) return;
  const el=document.createElement('div'); el.className='fxbubble'; el.textContent=text;
  el.style.left=(rect.left+rect.width/2)+'px'; el.style.top=(rect.top)+'px';
  $('fx').appendChild(el);
  try{ el.animate([{transform:'translate(-50%,-80%) scale(.4)',opacity:0},{transform:'translate(-50%,-120%) scale(1.1)',opacity:1,offset:.2},{transform:'translate(-50%,-120%) scale(1)',opacity:1,offset:.8},{transform:'translate(-50%,-140%) scale(.9)',opacity:0}],{duration:1600,fill:'both'}).onfinish=()=>el.remove(); }catch(e){ el.remove(); }
  setTimeout(()=>el.remove(),1900);
}
/* Konfetti zum Sieg */
let confettiKey='';
function confetti(key){
  if(key&&key===confettiKey) return; confettiKey=key||'';
  if(!animOK()) return;
  const cols=['#ff6b6b','#ffd43b','#69db7c','#4dabf7','#da77f2','#ffa94d'];
  for(let i=0;i<70;i++){
    const el=document.createElement('div'); el.className='confetti';
    el.style.background=cols[i%cols.length]; el.style.left=(10+Math.random()*80)+'vw'; el.style.top='-20px';
    $('fx').appendChild(el);
    const dx=(Math.random()-.5)*240, dy=innerHeight+60, rot=(Math.random()-.5)*1080, dur=1600+Math.random()*1400;
    try{ el.animate([{transform:'translate(0,0) rotate(0)',opacity:1},{transform:`translate(${dx}px,${dy}px) rotate(${rot}deg)`,opacity:.9}],{duration:dur,delay:Math.random()*400,easing:'cubic-bezier(.25,.6,.4,1)',fill:'both'}).onfinish=()=>el.remove(); }catch(e){ el.remove(); }
    setTimeout(()=>el.remove(),dur+700);
  }
}
function mmEffectFx(V){
  const top=V.disc[V.disc.length-1]; if(!top) return;
  const e=mmEff(V.rules,top);
  if(e==='draw2') fxBurst(`+${V.pend||2}`,'warn');
  else if(e==='skip') fxBurst('⊘ Aussetzen!','red');
  else if(e==='reverse') fxBurst('⟲ Richtungswechsel','');
  else if(e==='wish'&&V.wish!=null) fxBurst(`${MM_SUITS[V.wish]} ${MM_SUITNAME[V.wish]}`,'suit'+V.wish);
  else if(e==='again') fxBurst('↻ Nochmal!','');
  else if(e==='all1') fxBurst('+1 für alle!','warn');
}
function mmDeal(V,me){
  const src=rectOf($('mmDeckBtn')); if(!src) return;
  const n=V.players.length, H=V.rules.hand, step=60;
  const mine=[...document.querySelectorAll('#hand [data-mmc]')];
  mine.forEach(el=>{ mmIncoming.add(+el.dataset.mmc); el.classList.add('incoming'); });
  for(let r=0;r<H;r++) for(let k=0;k<n;k++){
    const i=(V.cur+k)%n, delay=(r*n+k)*step;
    if(i===me){ const el=mine[r]; if(!el) continue; const id=+el.dataset.mmc; fly(backHTML(),src,el.getBoundingClientRect(),{delay,dur:340,done:()=>mmReveal(id)}); }
    else { const t=mmSeatRect(i); if(t) fly(backOf(V.players[i].av),src,t,{delay,dur:340,fade:true}); }
  }
  mine.slice(H).forEach(el=>mmReveal(+el.dataset.mmc));
  const d=$('mmTop'); if(d){ mmDiscIncoming=true; d.classList.add('incoming'); fly(mmCardHTML(V.disc[V.disc.length-1]),src,d.getBoundingClientRect(),{delay:H*n*step,dur:380,done:()=>mmRevealDisc(V)}); }
}
function mmAnims(prev,now,before,V){
  if(!now||!animOK()) return;
  if(!prev||prev.round!==now.round||prev.n!==now.n){ if(V.phase==='play'&&V.last&&V.last.type==='start') mmDeal(V,now.me); return; }
  const deckR=before.deck||rectOf($('mmDeckBtn')), discEl=$('mmTop');
  if(now.top!==prev.top&&now.lastN!==prev.lastN&&discEl){
    const by=V.last?V.last.by:null, src=before.hand[now.top]||(by!=null?before.seat[by]:null)||deckR;
    mmDiscIncoming=true; discEl.classList.add('incoming');
    fly(mmCardHTML(V.disc[V.disc.length-1]),src,discEl.getBoundingClientRect(),{dur:430,done:()=>{ mmRevealDisc(V); mmEffectFx(V); }});
  }
  if(now.me!=null&&prev.me===now.me){
    const old=new Set(prev.myIds);
    now.myIds.filter(id=>!old.has(id)).slice(0,8).forEach((id,k)=>{
      const el=document.querySelector(`#hand [data-mmc="${id}"]`); if(!el) return;
      mmIncoming.add(id); el.classList.add('incoming');
      fly(backHTML(),deckR,el.getBoundingClientRect(),{delay:k*120,dur:420,done:()=>mmReveal(id)});
    });
  }
  now.counts.forEach((c,i)=>{
    if(i===now.me) return;
    const diff=c-(prev.counts[i]||0);
    if(diff>0){ const t=mmSeatRect(i); if(t) for(let k=0;k<Math.min(diff,6);k++) fly(backOf(V.players[i].av),deckR,t,{delay:k*120,dur:420,fade:true}); }
    if(c===1&&prev.counts[i]!==1&&V.phase==='play') setTimeout(()=>fxBubble('Mau!',mmSeatRect(i)||before.seat[i]),450);
  });
  if(now.me!=null&&now.counts[now.me]===1&&prev.counts[now.me]!==1&&V.phase==='play') setTimeout(()=>fxBubble('Mau!',rectOf(document.querySelector('#mmSeats .seat.me .seat-who'))),450);
  if(now.phase==='over'&&prev.phase!=='over'){ setTimeout(()=>{ fxBurst('Mau-Mau!','warn'); confetti('mm'+V.round); },450); }
}

function renderMM(){
  const V=curMmView(); if(!V) return;
  const before=mmCapture();
  const me=mode==='client'?V.you:mmSeat(), covered=mode==='local'&&mmPendViewer!=null;
  const mine=V.phase==='play'&&V.cur===me&&me!=null&&!covered;
  const R=V.rules, top=V.disc[V.disc.length-1];
  $('roundInfo').textContent=`Mau-Mau · Runde ${V.round}`;
  const meVisible=me!=null&&!covered;
  const seatHTML=i=>{ const p=V.players[i], isMe=meVisible&&i===me;
    return `<div class="seat${isMe?' me':''}${V.phase==='play'&&V.cur===i?' cur':''}" data-pl="${i}">
      ${isMe?'':backFanHTML(p.n,p.av)}
      <div class="seat-who">${avatarSVG(p.av,isMe?36:40)}<div class="seat-txt"><b>${esc(p.name)}${isMe&&mode!=='local'?' · du':''}</b><small>${p.wins} Sieg${p.wins===1?'':'e'}${p.ai?' · Computer':''}</small></div></div>
      ${p.n===1&&V.phase==='play'?'<div class="mau-badge">Mau!</div>':''}
    </div>`; };
  $('mmSeats').innerHTML=opponents(V.players.length,meVisible?me:null).map(seatHTML).join('')+(meVisible?seatHTML(me):'');
  layoutTable($('tableM'));
  $('mmDeck').innerHTML=`<button class="card big back${mine&&V.drawn==null?' can':''}" id="mmDeckBtn" aria-label="Karte ziehen"></button>`;
  $('mmDeckN').textContent=`Stapel · ${V.deckN}`;
  $('mmDisc').innerHTML=mmCardHTML(top,'big'+(mmDiscIncoming?' incoming':''),'id="mmTop" tabindex="-1"');
  $('mmInfo').innerHTML=V.pend>0?`<span class="mm-tag warn">+${V.pend} ziehen!</span>`:V.wish!=null?`<span class="mm-tag s${V.wish}">Wunsch: ${MM_SUITS[V.wish]} ${MM_SUITNAME[V.wish]}</span>`:`<span class="mm-tag">${V.dir===1?'↻ im Uhrzeigersinn':'↺ gegen den Uhrzeigersinn'}</span>`;
  let msg='',sub='';
  if(V.phase==='over') msg=`${V.players[V.winner].name} gewinnt die Runde!`;
  else if(!mine){ msg=`${V.players[V.cur].name} ist dran …`; if(me==null&&mode!=='local') sub='Du schaust zu.'; }
  else if(V.pend>0){ msg=`Du musst ${V.pend} Karten ziehen.`; sub=R.stack?'Oder lege selbst eine Ziehkarte drauf.':'Tippe auf den Stapel.'; }
  else if(V.drawn!=null){ msg='Gezogene Karte legen oder „Weiter“.'; }
  else { msg='Du bist dran: Karte legen oder ziehen.'; sub=V.wish!=null?`Gewünscht ist ${MM_SUITNAME[V.wish]} ${MM_SUITS[V.wish]}.`:''; }
  if(mode==='client'&&!hostReachable()) sub='Verbindung zum Gastgeber unterbrochen – ich versuche es automatisch weiter …';
  $('mmMsg').textContent=msg; $('mmSub').textContent=sub;
  $('mmLog').innerHTML=V.last&&V.last.text?`<div class="sv-last">${esc(V.last.text)}</div>`:'';
  // Hand
  const meP=me!=null?V.players[me]:null;
  if(!meP||covered){ $('handTitle').textContent=covered?'Karten verdeckt':'Du spielst nicht mit.'; $('req').innerHTML=''; $('hand').innerHTML=''; $('actions').innerHTML=''; }
  else {
    $('handTitle').innerHTML=`${avatarSVG(meP.av,28)}<span class="ht-name">${esc(meP.name)}</span> <span>· Regeln: ${esc(R.name)}</span>`;
    const hand=[...V.hand].sort((a,b)=>mmSortKey(a)-mmSortKey(b));
    const showMau=R.mau&&mine&&V.hand.length===2;
    $('req').innerHTML=`<span class="chip">${esc(mmSummary(R))}</span>`;
    $('hand').innerHTML=hand.map(c=>{ const ok=mine&&mmCanPlay(V,c)&&(V.drawn==null||c.id===V.drawn); return mmCardHTML(c,(ok?'can':(mine?'dim':''))+(c.id===V.drawn?' sel':'')+(mmIncoming.has(c.id)?' incoming':''),`data-mmc="${c.id}"`); }).join('');
    const a=[];
    if(mine){
      if(showMau) a.push(`<button class="btn mau-btn${mmMauArmed?' on':''}" id="mmMau">${mmMauArmed?'„Mau!“ gesagt ✓':'„Mau“ sagen!'}</button>`);
      if(V.drawn==null) a.push(`<button class="btn primary" id="mmDraw">${V.pend>0?`${V.pend} Karten ziehen`:'Karte ziehen'}</button>`);
      else a.push(`<button class="btn primary" id="mmPass">Weiter</button>`);
    }
    $('actions').innerHTML=a.join('');
  }
  if(mine&&mmPrevCur!==me&&meP){
    const dealing=(!prevMm||prevMm.round!==V.round)&&V.last&&V.last.type==='start'&&animOK();
    if(dealing){ const av=meP.av; setTimeout(()=>{ const W=curMmView(); if(W&&W.cur===me&&W.phase==='play') showTurnBanner(av); }, R.hand*V.players.length*60+500); }
    else showTurnBanner(meP.av);
  }
  mmPrevCur=V.phase==='play'?(covered?null:V.cur):null;
  const nowMm={round:V.round,n:V.players.length,me:meP&&!covered?me:null,myIds:V.hand.map(c=>c.id),counts:V.players.map(p=>p.n),top:top?top.id:null,lastN:V.last?V.last.n:0,phase:V.phase};
  mmAnims(prevMm,nowMm,before,V); prevMm=nowMm;
  // Rundenende
  if(V.phase==='over'){
    const k='mmend'+V.round;
    if(ovKey!==k&&!['rules','menu','settings','privacy','online','avatar','mmrules','mmedit','mmhow'].includes(ovKey)){
      const w=V.players[V.winner], canGo=mode!=='client';
      const rows=[...V.players].map((p,i)=>({p,i})).sort((a,b)=>b.p.wins-a.p.wins).map(({p})=>`<tr><td><span class="who">${avatarSVG(p.av,26)}${esc(p.name)}</span></td><td>${p.wins}</td><td>${p.n}</td></tr>`).join('');
      setTimeout(()=>{ if(mmActive()&&curMmView().phase==='over'&&ovKey!==k) overlay(`<div class="center-av winner">${avatarSVG(w.av,110,'av av-xl')}</div><h2>Mau-Mau! ${esc(w.name)} gewinnt!</h2><table><tr><th>Spieler</th><th>Siege</th><th>Karten übrig</th></tr>${rows}</table>${canGo?'':`<p class="note">Warte, bis ${esc((CLIENT&&CLIENT.hostName)||'der Gastgeber')} die nächste Runde startet.</p>`}<div class="row mt">${canGo?'<button class="btn primary" id="mmNextRound">Nächste Runde</button>':''}<button class="btn" id="toMenu">Zum Menü</button></div>`,k); }, animOff?0:700);
    }
  } else if(ovKey.startsWith('mmend')) overlay('');
}
function showMmWish(card){
  mmPick=card;
  overlay(`<h2>Welche Farbe wünschst du dir?</h2><div class="mm-wish">${MM_SUITS.map((s,i)=>`<button class="mm-wishbtn s${i}" data-mmwish="${i}"><span>${s}</span><small>${MM_SUITNAME[i]}</small></button>`).join('')}</div><div class="row mt"><button class="btn" id="mmWishCancel">Abbrechen</button></div>`,'mmwish');
}

/* Regelwerke: Auswahl & Editor */
let mmRulesRet='menu', mmEdit=null;
function showMmRulesPage(ret){
  if(ret) mmRulesRet=ret;
  overlay(`<div class="page"><div class="page-top"><button class="btn" id="mmRulesBack">‹ Zurück</button><h2>Mau-Mau-Regeln</h2></div>
    <p class="note">Wähle ein Regelwerk oder erstelle dein eigenes. Das ausgewählte gilt für das nächste Spiel.</p>
    <div class="mm-sets">${mmAllRules().map(r=>`<div class="mm-set${r.id===mmSelId?' on':''}">
      <button class="mm-set-main" data-mmsel="${esc(r.id)}"><b>${r.id===mmSelId?'✓ ':''}${esc(r.name)}${r.preset?' <span class="pl-meta">· Vorlage</span>':''}</b><small>${esc(mmSummary(r))}</small></button>
      <div class="row">${r.preset?`<button class="btn sm" data-mmcopy="${esc(r.id)}">Als Vorlage für eigene Regeln</button>`:`<button class="btn sm" data-mmedit="${esc(r.id)}">Bearbeiten</button><button class="btn sm" data-mmdel="${esc(r.id)}">Löschen</button>`}</div></div>`).join('')}</div>
    <div class="row mt"><button class="btn primary" id="mmNewRules">Neues Regelwerk</button><button class="btn" id="mmHowTo">So wird gespielt</button></div></div>`,'mmrules','full');
}
function showMmEditor(){
  const r=mmEdit, ranks=r.deck===52?MM_R52:MM_R32;
  overlay(`<div class="page"><div class="page-top"><button class="btn" id="mmEditCancel">‹ Abbrechen</button><h2>Regelwerk</h2></div>
    <div class="row"><label class="note" for="mmName">Name</label><input type="text" id="mmName" maxlength="24" value="${esc(r.name)}"></div>
    <div class="row"><label class="note" for="mmHand">Startkarten</label><select id="mmHand">${[3,4,5,6,7,8].map(n=>`<option value="${n}" ${r.hand===n?'selected':''}>${n}</option>`).join('')}</select>
      <label class="note" for="mmDeckSel">Kartenspiel</label><select id="mmDeckSel"><option value="32" ${r.deck===32?'selected':''}>32 Karten (7 bis Ass)</option><option value="52" ${r.deck===52?'selected':''}>52 Karten (2 bis Ass)</option></select></div>
    <h3>Was bewirkt welche Karte?</h3>
    <div class="mm-effs">${ranks.map(k=>`<label class="mm-eff"><span class="mm-rank">${k}</span><select id="mmEff-${k}">${Object.entries(MM_EFF).map(([key,lab])=>`<option value="${key}" ${(r.eff[k]||'none')===key?'selected':''}>${lab}</option>`).join('')}</select></label>`).join('')}</div>
    <p class="note">B = Bube, D = Dame, K = König, A = Ass.</p>
    <h3>Weitere Regeln</h3>
    <div class="mm-togs">${MM_TOGGLES.map(([k,lab,desc])=>`<div class="mm-tog"><div><b>${lab}</b><small>${desc}</small></div><div class="seg"><button data-mmtog="${k},1" class="${r[k]?'on':''}">An</button><button data-mmtog="${k},0" class="${r[k]?'':'on'}">Aus</button></div></div>`).join('')}</div>
    <div class="row mt"><button class="btn primary" id="mmEditSave">Speichern & auswählen</button></div></div>`,'mmedit','full');
}
function mmReadForm(){
  if(!mmEdit) return;
  const nm=$('mmName'); if(nm) mmEdit.name=str(nm.value,24)||'Eigene Regeln';
  const h=$('mmHand'); if(h) mmEdit.hand=int(h.value,3,8,5);
  const d=$('mmDeckSel'); if(d) mmEdit.deck=d.value==='52'?52:32;
  MM_R52.forEach(k=>{ const s=$('mmEff-'+k); if(s){ if(s.value!=='none'&&MM_EFF[s.value]) mmEdit.eff[k]=s.value; else delete mmEdit.eff[k]; } });
}
function showMmHowTo(){
  const R=mmRules();
  overlay(`<div class="rules"><h2>Mau-Mau</h2>
    <ol>
      <li><b>Ziel:</b> Als Erster alle Karten loswerden.</li>
      <li><b>Legen:</b> Auf die oberste Karte darfst du eine Karte mit <b>gleicher Farbe</b> oder <b>gleichem Wert</b> legen.</li>
      <li><b>Ziehen:</b> Kannst oder willst du nicht legen, ziehst du eine Karte. Passt sie, darfst du sie sofort legen – sonst ist der Nächste dran.</li>
      <li><b>Sonderkarten</b> im Regelwerk „${esc(R.name)}“: ${esc(mmSummary(R))}.</li>
      ${R.mau?'<li><b>„Mau“:</b> Bevor du deine vorletzte Karte legst, tippe „Mau sagen“. Vergisst du es, ziehst du 2 Strafkarten.</li>':''}
    </ol>
    <p class="note">Unter „Regeln“ kannst du andere Regelwerke wählen oder eigene erstellen.</p>
    <div class="row mt"><button class="btn primary" id="mmHowBack">Verstanden</button></div></div>`,'mmhow',mmRulesRet==='menu'?'full':'');
}

function render(){
  const before=captureRects(), prev=prevSnap;
  const chip=$('netChip');
  if(mode==='host'&&HOST){ const ok=netOnline(); chip.hidden=false; chip.className='netchip'+(ok?'':' bad'); chip.textContent=ok?`Gastgeber · ${fmtCode(HOST.code)} · ${onlineCount()+1} online`:'Kein Internet – verbinde neu …'; }
  else if(mode==='client'&&CLIENT){ const ok=hostReachable(); chip.hidden=false; chip.className='netchip'+(ok?'':' bad'); chip.textContent=ok?'Online · '+fmtCode(CLIENT.code):(netOnline()?'Suche Gastgeber …':'Kein Internet – verbinde neu …'); }
  else chip.hidden=true;
  if(mmActive()){
    $('players').innerHTML=''; $('board').hidden=true; $('sv').hidden=true; $('mm').hidden=false; $('dock').hidden=false;
    prevSnap=null; renderMM(); measureDock(); return;
  }
  $('mm').hidden=true; mmPrevCur=null; prevMm=null; mmIncoming.clear(); mmDiscIncoming=false;
  if(svActive()){
    $('players').innerHTML=''; $('dock').hidden=true; $('board').hidden=true; $('sv').hidden=false; measureDock();
    prevSnap=null; renderSV(); return;
  }
  $('sv').hidden=true; $('board').hidden=false; svPrevCur=null;
  if(!G){
    $('roundInfo').textContent=''; $('players').innerHTML=''; $('seatsR').innerHTML=''; $('tableR').hidden=true; $('statusR').hidden=true; $('center').hidden=true; $('dock').hidden=true; measureDock();
    prevSnap=null; incoming.clear(); discIncoming=false;
    return;
  }
  $('center').hidden=false; $('dock').hidden=false; $('tableR').hidden=false; $('statusR').hidden=false;
  const me=mySeat();
  $('roundInfo').textContent=`Runde ${G.round}`;
  const p=P(); const mine=myTurn();
  const meP=me!=null?G.players[me]:null;
  const oneSel=sel.size===1?[...sel][0]:null;
  const selCard=oneSel&&meP?meP.hand.find(c=>c.id===oneSel):null;
  const canLayOff=mine && G.stage==='play' && p.laid && selCard;
  const sameRound=prev&&prev.round===G.round;
  // Plätze am Tisch: Gegner im Halbkreis (mit Karten-Fächer), ich unten
  const meVisible=me!=null&&!covered;
  const seatHTML=i=>{ const pl=G.players[i], isMe=meVisible&&i===me;
    return `<div class="seat${isMe?' me':''}${i===G.cur&&G.stage!=='over'?' cur':''}" data-pl="${i}">
      ${isMe?'':backFanHTML(int(pl.hand.length,0,999,0),pl.av)}
      <div class="seat-who">${avatarSVG(pl.av,isMe?36:40)}<div class="seat-txt"><b>${esc(pl.name)}${isMe&&mode!=='local'?' · du':''}</b><small>Etappe ${Math.min(int(pl.phase,0,10,0)+1,10)} · ${int(pl.score,0,1e6,0)} Pkt.</small></div></div>
      <div class="seat-badges">${pl.ai?'<span class="badge">Computer</span>':''}${pl.off?'<span class="badge off">offline</span>':''}${pl.skip?'<span class="badge">setzt aus</span>':''}${pl.laid?'<span class="badge ok">ausgelegt</span>':''}</div>
    </div>`; };
  $('seatsR').innerHTML=opponents(G.players.length,meVisible?me:null).map(seatHTML).join('')+(meVisible?seatHTML(me):'');
  layoutTable($('tableR'));
  // Ausgelegte Etappen unter dem Tisch
  const laidRows=G.players.map((pl,i)=>pl.laid?`<div class="laid-row"><span class="who">${avatarSVG(pl.av,26)}<b>${esc(pl.name)}</b><small class="pl-meta">Etappe ${Math.min(int(pl.phase,0,10,0)+1,10)}: ${PHASES[Math.min(int(pl.phase,0,10,0),9)].t}</small></span>
      <div class="groups">${pl.laid.map((g,gi)=>{const t=canLayOff&&canAdd(g,selCard); return `<div class="grp ${t?'target':''}" ${t?`data-lo="${i},${gi}" tabindex="0" role="button" aria-label="Hier anlegen"`:''}>${g.cards.map(c=>cardHTML(c,'mini'+(sameRound&&!prev.laidIds.has(c.id)?' pop':''),'tabindex="-1"')).join('')}</div>`;}).join('')}</div></div>`:'').join('');
  $('players').innerHTML=laidRows?`<h3 class="laid-h">Ausgelegt</h3>${laidRows}`:'';
  const top=G.disc[G.disc.length-1];
  const deckN=G.deckN!=null?G.deckN:G.deck.length;
  const drawOK=mine&&G.stage==='draw';
  $('deckSlot').innerHTML=(deckN||G.disc.length>1)?`<button class="card big back ${drawOK?'can':''}" id="deckBtn" aria-label="Vom Stapel ziehen"></button>`:cardHTML(null,'big');
  $('deckCount').textContent=`Stapel · ${deckN}`;
  $('discSlot').innerHTML=cardHTML(top,'big '+(drawOK&&top&&top.k!=='s'?'can':'disabled')+(discIncoming?' incoming':''),'id="discBtn"');
  let msg='',sub='';
  if(G.stage==='over') msg='Runde beendet.';
  else if(!mine){ msg=`${p.name} ist am Zug …`; if(mode!=='local'&&me==null) sub='Du schaust zu.'; else if(meP&&!meP.laid) sub='Du kannst schon Karten in deine Vorablage legen.'; }
  else if(G.stage==='draw'){msg='Du bist dran: Ziehe eine Karte.'; sub='Tippe auf den Stapel oder auf die Ablage.';}
  else if(!p.laid){msg='Etappe auslegen oder abwerfen.'; sub='Fülle die Felder der Vorablage und tippe „Etappe auslegen“. Zum Beenden eine Karte wählen und abwerfen.';}
  else {msg='Anlegen oder abwerfen.'; sub='Wähle eine Karte und tippe auf eine gelb markierte Gruppe, um sie anzulegen.';}
  if(mode==='client'&&!hostReachable()) sub='Verbindung zum Gastgeber unterbrochen – ich versuche es automatisch weiter …';
  if(mode==='host'&&!netOnline()) sub='Keine Internetverbindung – ich verbinde automatisch neu …';
  $('msg').textContent=msg; $('sub').textContent=sub;
  $('log').innerHTML=G.log.slice(-8).reverse().map(t=>`<div>${esc(t)}</div>`).join('');
  const v=me!=null&&!covered?G.players[me]:null;
  if(!v){
    $('handTitle').textContent=mode!=='local'?'Du spielst in diesem Spiel nicht mit.':(humans().length?'Karten verdeckt':'Nur Computer spielen');
    $('req').innerHTML=''; $('hand').innerHTML=''; $('actions').innerHTML='';
  } else {
    const ph=PHASES[Math.min(v.phase,9)];
    $('handTitle').innerHTML=`${avatarSVG(v.av,28)}<span class="ht-name">${esc(v.name)}</span> <span>· Etappe ${Math.min(v.phase+1,10)}: ${ph.t}${v.laid?' – erledigt':''}</span>`;
    const ids=new Set(v.hand.map(c=>c.id)); for(const id of [...sel]) if(!ids.has(id)) sel.delete(id);
    let staged=new Set(), valid=[];
    if(!v.laid&&G.stage!=='over'){
      const st=stageFor(v,me); valid=stageValid(v); staged=stagedSet();
      const byId=new Map(v.hand.map(c=>[c.id,c]));
      $('req').innerHTML=`<div class="stage">${ph.g.map(([type,n],gi)=>{
        const cards=st.groups[gi].map(id=>byId.get(id)).filter(Boolean);
        return `<div class="slot${st.active===gi?' on':''}${valid[gi]?' ok':''}" data-slot="${gi}" role="button" tabindex="0" aria-label="Vorablage ${GNAME[type](n)}">
          <div class="slot-h"><span>${GNAME[type](n)}</span><b>${valid[gi]?(cards.length>n?`✓ +${cards.length-n}`:'✓'):cards.length+'/'+n}</b></div>
          <div class="slot-cards">${cards.length?cards.map(c=>cardHTML(c,'st'+(c.id===justStaged?' new':''),`data-sid="${int(c.id,0,1e6,0)}"`)).join(''):`<span class="slot-empty">${st.active===gi?'Jetzt Karten antippen':'Antippen, dann Karten wählen'}</span>`}</div></div>`;}).join('')}</div>`;
    } else { $('req').innerHTML=''; stage.active=null; }
    for(const id of staged) sel.delete(id);
    const hand=v.hand.filter(c=>!staged.has(c.id)).sort(sortMode==='num'?((a,b)=>ord(a)-ord(b)||(a.c||0)-(b.c||0)):((a,b)=>(a.k==='n'?a.c:9)-(b.k==='n'?b.c:9)||ord(a)-ord(b)));
    $('hand').innerHTML=hand.map(c=>cardHTML(c,(sel.has(c.id)?'sel':'')+(incoming.has(c.id)?' incoming':''),`data-id="${int(c.id,0,1e6,0)}" aria-pressed="${sel.has(c.id)}"`)).join('');
    const a=[];
    if(mine&&G.stage==='play'){
      if(!v.laid) a.push(`<button class="btn primary" data-act="lay" ${valid.length&&valid.every(Boolean)?'':'disabled'}>Etappe auslegen</button>`);
      a.push(`<button class="btn ${v.laid?'primary':''}" data-act="disc" ${sel.size===1?'':'disabled'}>Abwerfen</button>`);
    }
    if(!v.laid&&G.stage!=='over'){ a.push(`<button class="btn" data-act="hint">Vorschlag</button>`); if(staged.size) a.push(`<button class="btn" data-act="unstage">Vorablage leeren</button>`); }
    if(sel.size) a.push(`<button class="btn" data-act="clear">Auswahl aufheben</button>`);
    a.push(`<button class="btn" data-act="sort">Sortieren: ${sortMode==='num'?'Zahl':'Farbe'}</button>`);
    $('actions').innerHTML=a.join('');
  }
  justStaged=null;
  measureDock();
  stateOverlay();
  const now=snapState();
  runAnims(prev,now,before);
  prevSnap=now;
}
function measureDock(){ const d=$('dock'); const h=d.hidden?0:d.offsetHeight; document.documentElement.style.setProperty('--dockH',h+'px'); }
if(window.ResizeObserver) new ResizeObserver(measureDock).observe($('dock'));
window.addEventListener('resize',measureDock);

/* ---------- overlays ---------- */
function overlay(html,key,cls){ ovKey=html?(key||'misc'):''; $('overlay').innerHTML=html?`<div class="ov${cls?' '+cls:''}"><div class="box">${html}</div></div>`:''; const b=$('overlay').querySelector('.box'); if(b) b.scrollTop=0; }
function stateOverlay(){
  if(!G) return;
  if(G.stage==='over'&&G.summary){
    const k='end'+G.round+(G.over?'x':'');
    if(ovKey!==k && !['rules','menu','setup','privacy','online','settings','avatar'].includes(ovKey)) showRoundEnd(k);
  } else {
    if(ovKey.startsWith('end')) overlay('');
    if(mode==='local'&&covered&&!ovKey) showCover();
  }
}
function showCover(){
  const p=P();
  overlay(`<div class="center-av">${avatarSVG(p.av,84,'av av-xl')}</div><h2>Weitergeben an ${esc(p.name)}</h2><p>Die anderen bitte wegschauen. ${esc(p.name)} ist mit Etappe ${p.phase+1} dran: ${PHASES[p.phase].t}.</p><div class="row"><button class="btn primary" id="uncover">Ich bin ${esc(p.name)} – Karten zeigen</button></div>`,'cover');
}
function showRoundEnd(k){
  const s=G.summary, wName=(G.players[s.wi]||{}).name||'?';
  confetti('r'+G.round+(s.winner!=null?'x':''));
  const tbl=`<table><tr><th>Spieler</th><th>Etappe</th><th>+Pkt.</th><th>Gesamt</th></tr>${s.rows.map((r,i)=>`<tr><td><span class="who">${avatarSVG((G.players[i]||{}).av,26)}${esc(r.name)}</span></td><td>${int(r.phase,0,10,0)+1} ${r.done?'✓ geschafft':'– nochmal'}</td><td>${int(r.add,0,1e4,0)}</td><td>${int(r.total,0,1e6,0)}</td></tr>`).join('')}</table>`;
  const canGo=mode!=='client';
  const wait=canGo?'':`<p class="note">Warte, bis ${esc((CLIENT&&CLIENT.hostName)||'der Gastgeber')} weitermacht.</p>`;
  if(s.winner!==null&&G.players[s.winner]){
    overlay(`<div class="center-av winner">${avatarSVG(G.players[s.winner].av,110,'av av-xl')}</div><h2>${esc(G.players[s.winner].name)} gewinnt!</h2><p>${esc(wName)} hat die letzte Runde beendet. Wer alle 10 Etappen geschafft hat, gewinnt – bei mehreren der mit den wenigsten Punkten.</p>${tbl}${wait}<div class="row mt">${canGo?'<button class="btn primary" id="again">Nochmal spielen</button>':''}<button class="btn" id="toMenu">Zum Menü</button></div>`,k);
  } else {
    overlay(`<div class="center-av">${avatarSVG((G.players[s.wi]||{}).av,84,'av av-xl')}</div><h2>${esc(wName)} ist fertig!</h2><p>Wer seine Etappe ausgelegt hat, steigt eine Etappe auf. Karten auf der Hand zählen als Minuspunkte.</p>${tbl}${wait}<div class="row mt">${canGo?'<button class="btn primary" id="nextRound">Nächste Runde</button>':''}</div>`,k);
  }
}
function askSkip(card){
  const ts=skipTargets();
  overlay(`<h2>Wer soll aussetzen?</h2><div class="row">${ts.map(i=>`<button class="btn who-btn" data-skip="${i}">${avatarSVG(G.players[i].av,28)}${esc(G.players[i].name)}</button>`).join('')}</div><div class="row"><button class="btn" id="cancelSkip">Abbrechen</button></div>`,'skip');
  askSkip.card=card;
}

/* Menü */
const inviteCode=(()=>{ const m=(location.hash||'').match(/^#raum-([A-Za-z0-9-]{8,9})$/); const c=m?normCode(m[1]):''; return CODE_RE.test(c)?c:''; })();
let installEvt=null;
window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); installEvt=e; if(ovKey==='menu') showMenu(); });
const standalone=()=>window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
const isIOS=/iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
/* ---------- Hintergründe & Einstellungen ---------- */
const THEMES={
  auto:{name:'Automatisch'},
  filz:{name:'Spieltisch',dark:1,table:'#0f2a20',table2:'#0b211a',panel:'#163629',fg:'#e7f2ec',muted:'#9db7aa',line:'#2b5444',accent:'#3fc28a',accentFg:'#05140e',hl:'#ffd24a'},
  ozean:{name:'Ozean',dark:1,table:'#0d3358',table2:'#071a30',panel:'#12365c',fg:'#e6f0fb',muted:'#9fb6cf',line:'#24507c',accent:'#4dabf7',accentFg:'#04121f',hl:'#ffd24a'},
  nacht:{name:'Galaxie',dark:1,table:'#2a1a4a',table2:'#100a1f',panel:'#2a1e47',fg:'#efe9fb',muted:'#b3a6cf',line:'#44356b',accent:'#b197fc',accentFg:'#140b26',hl:'#ffd24a'},
  kirsche:{name:'Kirsche',dark:1,table:'#4a121d',table2:'#22070c',panel:'#4d1620',fg:'#fbe9ec',muted:'#d6a3ab',line:'#6e2a35',accent:'#ff8787',accentFg:'#2a0509',hl:'#ffd43b'},
  sonne:{name:'Sonnenuntergang',dark:1,table:'#6b2a4f',table2:'#1f0d2e',panel:'#3d1a3a',fg:'#fdeef4',muted:'#e0aecb',line:'#6b2e5e',accent:'#ff922b',accentFg:'#2a0f00',hl:'#ffe066'},
  schwarz:{name:'Mitternacht',dark:1,table:'#1b1e23',table2:'#08090b',panel:'#1c1f24',fg:'#eceff3',muted:'#9aa3ad',line:'#2e333a',accent:'#63e6be',accentFg:'#04140f',hl:'#ffd43b'},
  sand:{name:'Sand',dark:0,table:'#f3e9d2',table2:'#e3d0a8',panel:'#fffaf0',fg:'#2b2216',muted:'#7a6a52',line:'#d8c49c',accent:'#b5651d',accentFg:'#ffffff',hl:'#e8590c'},
  minze:{name:'Minze',dark:0,table:'#dff5ec',table2:'#bfe8d6',panel:'#f6fffb',fg:'#12302a',muted:'#4f756b',line:'#a6d8c4',accent:'#0b8f68',accentFg:'#ffffff',hl:'#f59f00'},
  bonbon:{name:'Bonbon',dark:0,table:'#fde2f0',table2:'#f3c4dd',panel:'#fff6fb',fg:'#3a1630',muted:'#86587a',line:'#efbcd8',accent:'#c2255c',accentFg:'#ffffff',hl:'#f59f00'}
};
const THEME_VARS={table:'--table',table2:'--table-2',panel:'--panel',fg:'--fg',muted:'--muted',line:'--line',accent:'--accent',accentFg:'--accent-fg',hl:'--hl'};
let themeKey=THEMES[lsGet('etappen-theme')]?lsGet('etappen-theme'):'auto';
let animOff=lsGet('etappen-anim')==='off';
function applyTheme(){
  const r=document.documentElement.style, t=THEMES[themeKey];
  for(const k in THEME_VARS){ if(t&&t[k]) r.setProperty(THEME_VARS[k],t[k]); else r.removeProperty(THEME_VARS[k]); }
  if(t&&t.table){ r.setProperty('color-scheme',t.dark?'dark':'light'); } else r.removeProperty('color-scheme');
  const meta=document.querySelector('meta[name="theme-color"]'); if(meta) meta.setAttribute('content',(t&&t.table2)||'#0f2a20');
  document.documentElement.classList.toggle('no-anim',animOff);
}
applyTheme();

/* ---------- Hauptmenü ---------- */
const decoCard=(c,cls)=>cardHTML(c,cls).replace(/^<button/,'<div').replace(/<\/button>$/,'</div>');
function installBlock(){
  if(standalone()) return '';
  if(installEvt) return `<button class="hlink" id="install">App installieren</button>`;
  if(isIOS) return `<span class="hnote">Als App: Teilen → „Zum Home-Bildschirm“</span>`;
  return '';
}
function showMenu(){
  const nameEl=$('nameIn'); if(nameEl) myName=str(nameEl.value,16);
  const fan=[{k:'n',n:1,c:0},{k:'n',n:7,c:1},{k:'j'},{k:'n',n:12,c:3},{k:'n',n:5,c:2}];
  const mini=[{k:'n',n:3,c:0},{k:'j'},{k:'n',n:9,c:1}];
  const boat=`<svg class="boat" viewBox="0 0 120 70" aria-hidden="true"><path d="M8 44 L112 44 L98 62 L22 62 Z" fill="#8a96a3" stroke="#1d1b26" stroke-width="3" stroke-linejoin="round"/><rect x="38" y="30" width="34" height="14" rx="3" fill="#ced4da" stroke="#1d1b26" stroke-width="3"/><rect x="50" y="16" width="10" height="14" fill="#ff6b6b" stroke="#1d1b26" stroke-width="3"/><path d="M0 66 Q15 60 30 66 T60 66 T90 66 T120 66" fill="none" stroke="#e8f4ff" stroke-width="3" stroke-linecap="round"/></svg>`;
  const playing=G||svActive()||mmActive();
  const mmFan=[{s:2,r:'B'},{s:1,r:'7'},{s:3,r:'A'}];
  const tile=(game,cls,art,title,sub)=>`<div class="tile ${cls}">
        <div class="tile-art" aria-hidden="true">${art}</div>
        <div class="tile-body"><b>${title}</b><small>${sub}</small>
          <div class="tile-btns"><button class="btn primary" data-play="${game}">An einem Gerät</button><button class="btn" data-online="${game}">Online-Raum</button><button class="btn" data-rules="${game}">Regeln</button></div></div>
      </div>`;
  overlay(`<div class="home">
    <div class="home-hero">
      <div class="fan" aria-hidden="true">${fan.map((c,i)=>decoCard(c,'fan-'+i)).join('')}</div>
      <h1 class="logo">Spiel<span>hafen</span></h1>
      <p class="tag">Karten, Schiffe und ein Spieleabend – mit Freunden oder gegen den Computer.</p>
    </div>
    <div class="home-profile">
      <button class="av-btn" id="editAv" aria-label="Charakter bearbeiten">${avatarSVG(myAv,76)}<span>Bearbeiten</span></button>
      <div class="profile-in"><label class="note" for="nameIn">Dein Name</label><input type="text" id="nameIn" maxlength="16" placeholder="Wie heißt du?" value="${esc(myName)}" autocomplete="nickname"></div>
    </div>
    ${playing?`<button class="hbtn go" id="closeOv"><b>Weiterspielen</b><small>Zurück zum laufenden Spiel</small></button>`:''}
    <div class="tiles">
      ${tile('etappen','tile-cards',mini.map((c,i)=>decoCard(c,'tf-'+i)).join(''),'Etappen-Rommé','10 Etappen sammeln · 2–6 Spieler')}
      ${tile('maumau','tile-mm',mmFan.map((c,i)=>mmCardHTML(c,'tf-'+i).replace(/^<button/,'<div').replace(/<\/button>$/,'</div>')).join(''),'Mau-Mau',`Eigene Regeln · 2–6 Spieler`)}
      ${tile('schiffe','tile-sea',boat,'Schiffe versenken','Mit Spezialangriffen · 2 Spieler')}
    </div>
    <div class="home-btns">
      <button class="hbtn" id="goOnline"><b>Mit Code beitreten</b><small>Ein Freund hat einen Raum erstellt?</small></button>
      <button class="hbtn" id="goSettings"><b>Einstellungen</b><small>Hintergrund und Animationen</small></button>
    </div>
    <div class="home-foot">
      <button class="hlink" id="showPrivacy">Datenschutz</button>
      ${playing?'<button class="hlink" id="toMenu">Spiel beenden</button>':''}
      ${installBlock()}
      <span class="hnote">Version ${APP_VERSION}</span>
    </div>
  </div>`,'menu','full');
}
function showOnline(){
  readName();
  const sh=savedHost();
  const lastRaw=normCode(lsGet('etappen-last'));
  const typed=$('codeIn')?normCode($('codeIn').value):'';
  const last=typed||inviteCode||(CODE_RE.test(lastRaw)?lastRaw:'');
  overlay(`<div class="page">
    <div class="page-top"><button class="btn" id="homeBack">‹ Zurück</button><h2>Online spielen</h2></div>
    <div class="home-profile small">
      <button class="av-btn" id="editAvOnline" aria-label="Charakter bearbeiten">${avatarSVG(myAv,52)}</button>
      <div class="profile-in"><label class="note" for="nameIn">Dein Name</label><input type="text" id="nameIn" maxlength="16" placeholder="Wie heißt du?" value="${esc(myName)}" autocomplete="nickname"></div>
    </div>
    <div class="choice">
      <div><h3>Neues Spiel</h3><p class="note">Du wirst Gastgeber und bekommst einen Code für deine Freunde. Dein Gerät muss während des Spiels online bleiben.</p>
        <div class="row"><button class="btn primary" id="hostRoom">Etappen-Rommé-Raum</button><button class="btn primary" id="hostRoomMm">Mau-Mau-Raum</button><button class="btn primary" id="hostRoomSv">Schiffe-versenken-Raum</button></div>
        ${sh?`<div class="row"><button class="btn" id="resumeHost">Raum ${esc(fmtCode(sh.code))} fortsetzen (${GAME_NAME[sh.game==='schiffe'?'schiffe':'etappen']})</button></div>`:''}</div>
      <div><h3>Mitspielen</h3><p class="note">Gib den Code ein, den du bekommen hast.</p>
        <div class="row"><input type="text" id="codeIn" maxlength="${CODE_LEN+1}" placeholder="ABCD-2345" value="${esc(last?fmtCode(last):'')}" aria-label="Raum-Code" autocapitalize="characters" autocomplete="off" spellcheck="false" class="codein"><button class="btn primary" id="joinRoom">Beitreten</button></div></div>
    </div>
  </div>`,'online','full');
}
function showSettings(){
  overlay(`<div class="page">
    <div class="page-top"><button class="btn" id="homeBack">‹ Zurück</button><h2>Einstellungen</h2></div>
    <h3>Hintergrund</h3>
    <div class="themes">${Object.keys(THEMES).map(k=>`<button class="theme${k===themeKey?' on':''}" data-theme-pick="${k}" aria-pressed="${k===themeKey}"><span class="sw" data-sw="${k}"></span><span class="tn">${THEMES[k].name}</span></button>`).join('')}</div>
    <p class="note">„Automatisch“ folgt dem hellen oder dunklen Modus deines Geräts.</p>
    <h3>Animationen</h3>
    <div class="row"><div class="seg"><button id="animOn" class="${animOff?'':'on'}">An</button><button id="animOffBtn" class="${animOff?'on':''}">Aus</button></div><span class="note">Fliegende Karten und hüpfende Figuren</span></div>
  </div>`,'settings','full');
  document.querySelectorAll('[data-sw]').forEach(el=>{
    const t=THEMES[el.dataset.sw];
    if(t&&t.table) el.style.background=`radial-gradient(circle at 50% 35%, ${t.table}, ${t.table2})`;
    else el.style.background='linear-gradient(135deg, #dfe9e3 0 50%, #0f2a20 50% 100%)';
    if(t&&t.accent) el.style.boxShadow=`inset 0 -10px 0 ${t.accent}`;
  });
}
function readName(){ const el=$('nameIn'); if(el){ myName=str(el.value,16); lsSet('etappen-name',myName);} return myName; }

/* Lobby */
function showLobby(){
  let seats, isHost, code, game='etappen';
  if(mode==='host'&&HOST){ isHost=true; code=HOST.code; game=HOST.game; const on=onlineToks(); seats=HOST.seats.map(s=>({name:s.name,ai:s.ai,av:s.av,me:s.tok===myTok,host:s.tok===myTok,off:!s.ai&&!on.has(s.tok)})); }
  else if(mode==='client'&&CLIENT&&CLIENT.lobby){ isHost=false; code=CLIENT.lobby.code; seats=CLIENT.lobby.seats; game=CLIENT.lobby.game; }
  else return;
  const sv=game==='schiffe', max=sv?2:6;
  const list=seats.map((s,i)=>`<li class="pop-in"><span class="who">${avatarSVG(s.av,36)}<b>${esc(s.name)}</b></span><span>${s.ai?'Computer':s.host?'Gastgeber':''}${s.me?' · du':''}${s.off?' · offline':''}${isHost&&!s.me?` <button class="btn sm" data-kick="${i}">Entfernen</button>`:''}</span></li>`).join('');
  overlay(`<h2>Raum · ${GAME_NAME[game]}</h2><p>Gib nur deinen Mitspielern diesen Code. Sie öffnen die App, tippen auf „Beitreten“ und geben ihn ein.</p>
    <div class="row"><span class="code">${esc(fmtCode(code))}</span></div>
    <div class="row"><button class="btn primary" id="shareInvite">Einladung teilen</button><button class="btn" id="copyCode">Code kopieren</button></div>
    <h3>Spieler (${seats.length}/${max})</h3><ul class="seats">${list}</ul>
    ${sv&&seats.length<2?'<p class="note">Schiffe versenken spielt man zu zweit – warte auf deinen Gegner.</p>':''}
    ${game==='maumau'?(()=>{ const R=isHost?HOST.rules:CLIENT.lobby.rules; return R?`<div class="row"><span>Regeln: <b>${esc(R.name)}</b></span>${isHost?'<button class="btn sm" id="mmLobbyRules">Ändern</button>':''}</div><p class="note">${esc(mmSummary(R))}</p>`:''; })():''}
    ${isHost?'<p class="note">Unbekannte Namen kannst du mit „Entfernen“ wieder hinauswerfen.</p>':''}
    <div class="row mt">
      ${isHost?`<button class="btn primary" id="startOnline" ${(sv?seats.length===2:seats.length>=2)?'':'disabled'}>Spiel starten</button>${sv?'':`<button class="btn" id="addBot" ${seats.length<6?'':'disabled'}>Computer hinzufügen</button>`}`:'<span class="note">Warte, bis der Gastgeber das Spiel startet …</span>'}
      <button class="btn" id="editAvLobby">Charakter ändern</button>
      <button class="btn" id="leaveRoom">Raum verlassen</button>
    </div>`,'lobby');
}

/* Charakter-Editor */
let avDraft=null, avReturn='menu';
function showAvatarEditor(ret){
  if(ret) avReturn=ret;
  if(!avDraft) avDraft={...myAv};
  overlay(`<h2>Dein Charakter</h2>
    <div class="av-edit">
      <div class="av-big">${avatarSVG(avDraft,150,'av av-xl wiggle')}<div class="back-prev">${backOf(avDraft,'')}${backOf(avDraft,'')}<small>So sehen andere deine Karten</small></div></div>
      <div class="av-rows">${AV_ORDER.map(k=>`<div class="av-row"><span class="av-lbl">${AV_LABEL[k]}</span><button class="btn sq" data-av="${k},-1" aria-label="${AV_LABEL[k]}: vorherige">‹</button><span class="av-val">${AV_NAMES[k][avDraft[k]]}</span><button class="btn sq" data-av="${k},1" aria-label="${AV_LABEL[k]}: nächste">›</button></div>`).join('')}</div>
    </div>
    <div class="row mt"><button class="btn" id="avRandom">Zufall</button><button class="btn primary" id="avSave">Fertig</button><button class="btn" id="avCancel">Abbrechen</button></div>`,'avatar');
}
function closeAvatarEditor(){
  avDraft=null;
  if(avReturn==='lobby'&&mode!=='local') showLobby(); else if(avReturn==='online') showOnline(); else showMenu();
}
function avatarChanged(){
  if(mode==='host'&&HOST){ const s=HOST.seats.find(x=>x.tok===myTok); if(s&&HOST.status==='lobby'){ s.av=myAv; hostSave(); hostBroadcast(); } }
  if(mode==='client'&&CLIENT&&CLIENT.key) clientSendMsg({t:'join',tok:myTok,name:myName,av:myAv});
}

/* lokales Spiel */
let setupCfg=null;
try{setupCfg=JSON.parse(lsGet('etappen-setup'));}catch(e){}
if(!Array.isArray(setupCfg)||!setupCfg.length||setupCfg.length>6) setupCfg=[{name:'Spieler 1',ai:false},{name:'Spieler 2',ai:false},{name:'Spieler 3',ai:false},{name:'Spieler 4',ai:false}];
setupCfg=setupCfg.map((p,i)=>({name:str(p&&p.name,16)||('Spieler '+(i+1)),ai:!!(p&&p.ai),av:p&&p.av?cleanAv(p.av):(i===0?{...myAv}:randomAv())}));
/* Einrichtung für alle Spiele (an einem Gerät) */
const SETUP_KEY={etappen:'etappen-setup',schiffe:'etappen-setup-sv',maumau:'etappen-setup-mm'};
function loadSetup(g,def){
  let c=null; try{ c=JSON.parse(lsGet(SETUP_KEY[g])); }catch(e){}
  if(!Array.isArray(c)||!c.length||c.length>6) c=def;
  return c.map((p,i)=>({name:str(p&&p.name,16)||('Spieler '+(i+1)),ai:!!(p&&p.ai),av:p&&p.av?cleanAv(p.av):(i===0?{...myAv}:randomAv())}));
}
const setupCfgs={etappen:setupCfg,
  schiffe:loadSetup('schiffe',[{name:myName||'Spieler 1',ai:false},{name:'Computer',ai:true}]).slice(0,2),
  maumau:loadSetup('maumau',[{name:myName||'Spieler 1',ai:false},{name:'Computer 1',ai:true},{name:'Computer 2',ai:true}])};
if(setupCfgs.schiffe.length<2) setupCfgs.schiffe.push({name:'Computer',ai:true,av:randomAv()});
let setupGame='etappen';
const SC=()=>setupCfgs[setupGame];
function showSetup(game){
  if(game) setupGame=game;
  const cfg=SC(), fixed=setupGame==='schiffe';
  const title={etappen:'Etappen-Rommé',schiffe:'Schiffe versenken',maumau:'Mau-Mau'}[setupGame];
  const rows=cfg.map((p,i)=>`<div class="row"><button class="av-btn sm" data-avr="${i}" aria-label="Andere Figur für Spieler ${i+1}">${avatarSVG(p.av,40)}</button><input type="text" id="pname${i}" value="${esc(p.name)}" maxlength="16" aria-label="Name Spieler ${i+1}"><div class="seg"><button data-type="${i},0" class="${p.ai?'':'on'}">Mensch</button><button data-type="${i},1" class="${p.ai?'on':''}">Computer</button></div></div>`).join('');
  const extra=setupGame==='maumau'?`<div class="row mt"><span>Regeln: <b>${esc(mmRules().name)}</b></span><button class="btn sm" id="mmRulesFromSetup">Ändern</button></div><p class="note">${esc(mmSummary(mmRules()))}</p>`:'';
  overlay(`<div class="page"><div class="page-top"><button class="btn" id="backMenu">‹ Zurück</button><h2>${title}</h2></div>
    <p class="note">${fixed?'Zwei Spieler: gegen den Computer oder zu zweit an einem Gerät.':'2 bis 6 Spieler.'} Menschen spielen abwechselnd an diesem Gerät – vor jedem Zug wird verdeckt. Tippe auf eine Figur, um eine andere zu würfeln.</p>
    ${fixed?'':`<div class="row"><span>Spieler:</span><div class="seg">${[2,3,4,5,6].map(n=>`<button data-count="${n}" class="${cfg.length===n?'on':''}">${n}</button>`).join('')}</div></div>`}
    ${rows}${extra}<div class="row mt"><button class="btn primary" id="startLocal">Spiel starten</button></div></div>`,'setup','full');
}
function readSetupNames(){SC().forEach((p,i)=>{const el=$('pname'+i); if(el) p.name=str(el.value,16)||('Spieler '+(i+1));});}
let rulesReturn=null;
function showRules(){
  overlay(`<div class="rules"><h2>So wird gespielt</h2>
  <p>Jeder versucht, nacheinander 10 Etappen zu schaffen. Jeder Spieler hat seine eigene Etappe. Jede Runde gibt es 10 Karten.</p>
  <ol>
    <li><b>Ziehen:</b> eine Karte vom Stapel oder die oberste der Ablage (Aussetzen-Karten nicht).</li>
    <li><b>Auslegen:</b> Hast du alle Gruppen deiner Etappe, lege sie auf einmal aus. Tipp: In der <b>Vorablage</b> über deiner Hand kannst du die Gruppen schon vorher zusammenstellen – Feld antippen, dann Karten antippen. Ein grüner Haken zeigt, dass die Gruppe passt. <b>Gruppen dürfen größer sein als nötig</b> – statt zwei Drillingen kannst du z. B. zwei Vierlinge auslegen. Gehen dabei alle Karten weg, bist du sofort fertig.</li>
    <li><b>Anlegen:</b> Nur wer seine Etappe liegen hat, darf danach Karten an beliebige Gruppen anlegen.</li>
    <li><b>Abwerfen:</b> Jeder Zug endet mit einer Karte auf die Ablage.</li>
  </ol>
  <p><b>Gruppen:</b> Zwilling/Drilling/Vierling/Fünfling = gleiche Zahl. Folge = aufeinanderfolgende Zahlen (1–12, Farbe egal). „Einer Farbe“ = gleiche Farbe, Zahl egal. Jede Gruppe braucht mindestens eine echte Zahlenkarte.</p>
  <p><b>Joker ★</b> ersetzen jede Karte. <b>Aussetzen ⊘</b> abwerfen und einen Spieler wählen, der seinen nächsten Zug verliert.</p>
  <p><b>Rundenende:</b> Wer keine Karten mehr hat, beendet die Runde. Wer seine Etappe ausgelegt hat, steigt auf. Restkarten zählen: 1–9 = 5, 10–12 = 10, Aussetzen = 15, Joker = 25 Punkte.</p>
  <p><b>Sieg:</b> Wer zuerst Etappe 10 schafft, beendet das Spiel. Schaffen es mehrere in derselben Runde, gewinnt der mit den wenigsten Punkten.</p>
  <table><tr><th>#</th><th>Etappe</th></tr>${PHASES.map((p,i)=>`<tr><td>${i+1}</td><td>${p.t}</td></tr>`).join('')}</table>
  <div class="row mt"><button class="btn primary" id="rulesBack">Verstanden</button></div></div>`,'rules',rulesReturn==='menu'?'full':'');
}
function showPrivacy(){
  overlay(`<div class="rules"><h2>Datenschutz</h2>
  <p>Spielhafen hat keine Konten, keine Werbung, keine Tracker und keine eigene Datenbank.</p>
  <h3>Auf deinem Gerät</h3>
  <p>Gespeichert werden nur: dein Name, deine Figur, eine zufällige Geräte-Kennung (damit du nach einem Verbindungsabbruch deinen Platz wiederbekommst), der letzte Raum-Code, deine Spiel-Einstellungen und – wenn du Gastgeber bist – der laufende Spielstand. Diese Daten verlassen dein Gerät nicht von selbst.</p>
  <h3>Beim Online-Spiel</h3>
  <ul>
    <li>Die Nachrichten laufen über zwei öffentliche Nachrichten-Server (MQTT): broker.hivemq.com (HiveMQ) und broker.emqx.io (EMQX). Sie sehen deine IP-Adresse und wann du online bist.</li>
    <li>Alles, was übertragen wird, ist Ende-zu-Ende verschlüsselt (AES-256). Der Schlüssel entsteht aus dem Raum-Code, und jeder Mitspieler hat zusätzlich einen eigenen Schlüssel mit dem Gastgeber. Die Server und andere im Raum können deine Karten nicht lesen.</li>
    <li>Übertragen werden nur dein Name, deine Figur und deine Spielzüge. Deine IP-Adresse sehen die Mitspieler nicht.</li>
    <li>Nur der Gastgeber kennt alle Karten. Alle anderen bekommen nur ihre eigene Hand.</li>
  </ul>
  <h3>Webseite</h3>
  <p>Die App liegt auf GitHub Pages. GitHub speichert beim Abruf technische Daten wie die IP-Adresse. Schriften und Programmteile liegen direkt auf der Seite, es wird nichts von Google Fonts oder anderen Anbietern nachgeladen.</p>
  <div class="row mt"><button class="btn primary" id="privacyBack">Zurück</button><button class="btn" id="wipeData">Meine Daten auf diesem Gerät löschen</button></div></div>`,'privacy','full');
}

/* ---------- Updates ---------- */
let swReg=null, updateReady=false, reloading=false;
function showUpdateBar(){
  if(updateReady) return; updateReady=true;
  const bar=$('updateBar'); bar.hidden=false;
  bar.innerHTML=`<span>Neue Version verfügbar.</span><button class="btn primary" id="doUpdate">Jetzt aktualisieren</button><button class="btn" id="laterUpdate">Später</button>`;
}
function checkForUpdate(){ if(swReg) swReg.update().catch(()=>{}); }
function setupSW(){
  if(!('serviceWorker' in navigator) || location.protocol==='file:') return;
  navigator.serviceWorker.register('sw.js').then(reg=>{
    swReg=reg;
    if(reg.waiting&&navigator.serviceWorker.controller) showUpdateBar();
    reg.addEventListener('updatefound',()=>{
      const nw=reg.installing; if(!nw) return;
      nw.addEventListener('statechange',()=>{ if(nw.state==='installed'&&navigator.serviceWorker.controller) showUpdateBar(); });
    });
    setInterval(checkForUpdate,30*60*1000);
  }).catch(()=>{});
  navigator.serviceWorker.addEventListener('controllerchange',()=>{ if(reloading) location.reload(); });
}

/* ---------- Eingaben ---------- */
document.addEventListener('click',async e=>{
  const t=e.target.closest('[data-sid]')||e.target.closest('[data-lo]')||e.target.closest('button')||e.target.closest('[data-slot]'); if(!t) return;
  const id=t.id;
  /* Charakter */
  if(id==='editAv'){ readName(); showAvatarEditor('menu'); return; }
  if(id==='editAvLobby'){ showAvatarEditor('lobby'); return; }
  if(id==='editAvOnline'){ readName(); showAvatarEditor('online'); return; }
  /* Hauptmenü & Einstellungen */
  if(id==='goOnline'){ readName(); showOnline(); return; }
  if(id==='goSettings'){ readName(); showSettings(); return; }
  if(id==='homeBack'){ readName(); showMenu(); return; }
  if(t.dataset.themePick){ if(THEMES[t.dataset.themePick]){ themeKey=t.dataset.themePick; lsSet('etappen-theme',themeKey); applyTheme(); showSettings(); } return; }
  if(id==='animOn'||id==='animOffBtn'){ animOff=id==='animOffBtn'; lsSet('etappen-anim',animOff?'off':'on'); applyTheme(); showSettings(); return; }
  if(t.dataset.av){ const [k,d]=t.dataset.av.split(','); if(AV_PARTS[k]){ const n=AV_PARTS[k]; avDraft[k]=(avDraft[k]+Number(d)+n)%n; showAvatarEditor(); } return; }
  if(id==='avRandom'){ avDraft=randomAv(); showAvatarEditor(); return; }
  if(id==='avSave'){ myAv=cleanAv(avDraft); saveAv(); Object.values(setupCfgs).forEach(c=>{ if(c[0]&&!c[0].ai) c[0].av={...myAv}; }); avatarChanged(); toast('Charakter gespeichert.'); closeAvatarEditor(); return; }
  if(id==='avCancel'){ closeAvatarEditor(); return; }
  if(t.dataset.avr!=null){ readSetupNames(); const i=int(t.dataset.avr,0,5,0); if(SC()[i]) SC()[i].av=randomAv(); showSetup(); return; }
  /* Startbildschirm-Kacheln */
  if(t.dataset.play){ readName(); showSetup(t.dataset.play); return; }
  if(t.dataset.online){ hostGame(null,t.dataset.online); return; }
  if(t.dataset.rules){ readName(); const g=t.dataset.rules; if(g==='schiffe') showSvRules('menu'); else if(g==='maumau') showMmRulesPage('menu'); else { rulesReturn='menu'; showRules(); } return; }
  if(id==='hostRoomMm'){ hostGame(null,'maumau'); return; }
  /* Schiffe: verdeckt weitergeben */
  if(id==='svUncover'){ if(svPendViewer!=null){ svViewer=svPendViewer; svPendViewer=null; } overlay(''); render(); return; }
  /* Mau-Mau */
  if(id==='mmUncover'){ if(mmPendViewer!=null){ mmViewer=mmPendViewer; mmPendViewer=null; } overlay(''); render(); return; }
  if(id==='mmDeckBtn'||id==='mmDraw'){ const V=curMmView(); if(V&&V.phase==='play'&&V.cur===(mode==='client'?V.you:mmSeat())&&V.drawn==null&&!(mode==='local'&&mmPendViewer!=null)) mmAct({type:'draw'}); return; }
  if(id==='mmPass'){ mmAct({type:'pass'}); return; }
  if(id==='mmMau'){ mmMauArmed=!mmMauArmed; render(); return; }
  if(id==='mmNextRound'){ if(mode!=='client') mmNextRound(); return; }
  if(t.dataset.mmc&&mmActive()){
    const V=curMmView(), me=mode==='client'?V.you:mmSeat();
    if(!V||V.phase!=='play'||V.cur!==me||(mode==='local'&&mmPendViewer!=null)) return;
    const c=V.hand.find(x=>x.id===+t.dataset.mmc); if(!c) return;
    if(V.drawn!=null&&c.id!==V.drawn){ toast('Du darfst jetzt nur die gezogene Karte legen – oder „Weiter“.'); return; }
    if(!mmCanPlay(V,c)){ toast(V.pend>0?`Du musst ${V.pend} Karten ziehen${V.rules.stack?' – oder eine Ziehkarte legen':''}.`:V.wish!=null?`Gewünscht ist ${MM_SUITNAME[V.wish]} ${MM_SUITS[V.wish]}.`:'Diese Karte passt nicht.'); return; }
    if(mmEff(V.rules,c)==='wish'){ showMmWish(c); return; }
    const mau=mmMauArmed; mmMauArmed=false; mmAct({type:'play',id:c.id,mau}); return;
  }
  if(t.dataset.mmwish!=null&&mmPick){ const c=mmPick; mmPick=null; overlay(''); const mau=mmMauArmed; mmMauArmed=false; mmAct({type:'play',id:c.id,wish:int(t.dataset.mmwish,0,3,0),mau}); return; }
  if(id==='mmWishCancel'){ mmPick=null; overlay(''); render(); return; }
  /* Mau-Mau-Regeln */
  if(id==='mmRulesFromSetup'){ readSetupNames(); showMmRulesPage('setup'); return; }
  if(id==='mmLobbyRules'){ showMmRulesPage('lobby'); return; }
  if(id==='mmRulesBack'){ if(mmRulesRet==='setup') showSetup('maumau'); else if(mmRulesRet==='lobby') showLobby(); else showMenu(); return; }
  if(t.dataset.mmsel){ if(mmAllRules().some(r=>r.id===t.dataset.mmsel)){ mmSelId=t.dataset.mmsel; mmSaveCustom(); if(mode==='host'&&HOST&&HOST.game==='maumau'&&HOST.status==='lobby'){ HOST.rules=mmRules(); hostSave(); hostBroadcast(); } } showMmRulesPage(); return; }
  if(t.dataset.mmcopy||id==='mmNewRules'){ const base=mmAllRules().find(r=>r.id===(t.dataset.mmcopy||mmSelId))||MM_PRESETS[0]; mmEdit=JSON.parse(JSON.stringify({...base,id:'c-'+randHex(4),name:'Meine Regeln',preset:false})); mmEdit.isNew=true; showMmEditor(); return; }
  if(t.dataset.mmedit){ const r=mmCustom.find(x=>x.id===t.dataset.mmedit); if(r){ mmEdit=JSON.parse(JSON.stringify(r)); showMmEditor(); } return; }
  if(t.dataset.mmdel){ if(t.dataset.sure!=='1'){ t.dataset.sure='1'; t.textContent='Wirklich löschen?'; return; } mmCustom=mmCustom.filter(x=>x.id!==t.dataset.mmdel); if(!mmAllRules().some(r=>r.id===mmSelId)) mmSelId='p-klassisch'; mmSaveCustom(); showMmRulesPage(); return; }
  if(t.dataset.mmtog&&mmEdit){ mmReadForm(); const [k,v]=t.dataset.mmtog.split(','); if(MM_TOGGLES.some(x=>x[0]===k)) mmEdit[k]=v==='1'; showMmEditor(); return; }
  if(id==='mmEditCancel'){ mmEdit=null; showMmRulesPage(); return; }
  if(id==='mmEditSave'&&mmEdit){ mmReadForm(); const r=mmCleanRules({...mmEdit,preset:false}); const i=mmCustom.findIndex(x=>x.id===r.id); if(i>=0) mmCustom[i]=r; else mmCustom.push(r); mmSelId=r.id; mmSaveCustom(); mmEdit=null;
    if(mode==='host'&&HOST&&HOST.game==='maumau'&&HOST.status==='lobby'){ HOST.rules=mmRules(); hostSave(); hostBroadcast(); }
    toast('Regelwerk gespeichert und ausgewählt.'); showMmRulesPage(); return; }
  if(id==='mmHowTo'){ showMmHowTo(); return; }
  if(id==='mmHowBack'){ if(mmActive()&&!['mmrules'].includes(mmRulesRet)&&mmRulesRet==='game'){ overlay(''); render(); } else showMmRulesPage(); return; }
  if(id==='doUpdate'){
    if(mode==='host'&&HOST){ hostSave(); }
    reloading=true; const w=swReg&&swReg.waiting; if(w) w.postMessage('skipWaiting'); else location.reload(); return; }
  if(id==='laterUpdate'){ $('updateBar').hidden=true; return; }
  if(id==='btnRules'){ if(!ovKey||ovKey==='menu'||ovKey==='lobby'){ if(svActive()&&!ovKey) showSvRules(''); else if(mmActive()&&!ovKey){ mmRulesRet='game'; showMmHowTo(); } else { rulesReturn=ovKey; showRules(); } } return; }
  /* Schiffe versenken */
  if(id==='svVsCpu'){ svStartVsCpu(); return; }
  if(id==='svOnline'||id==='hostRoomSv'){ hostGame(null,'schiffe'); return; }
  if(id==='svRulesBtn'){ readName(); showSvRules('menu'); return; }
  if(id==='svRulesBack'){ if(showSvRules.ret==='menu') showMenu(); else { overlay(''); render(); } return; }
  if(id==='svAgain'){ if(mode!=='client') svAgain(); return; }
  if(t.dataset.abil&&svActive()){
    const k=t.dataset.abil; if(!SV_ABIL[k]) return;
    if(k==='salve'){ svMode.abil=null; svAct({type:'salve'}); return; }
    svMode.abil=svMode.abil===k?null:k; render(); return; }
  if(id==='svTorpDir'){ svMode.dir=svMode.dir==='h'?'v':'h'; render(); return; }
  if(id==='svAbilCancel'){ svMode.abil=null; render(); return; }
  if(t.dataset.sv&&svActive()){
    const [r,c]=t.dataset.sv.split(',').map(Number);
    if(svMode.abil){ const k=svMode.abil; svMode.abil=null; svAct({type:k,r,c,dir:svMode.dir}); }
    else svAct({type:'shoot',r,c});
    return; }
  if(svActive()&&(t.dataset.svp||t.dataset.svship!=null||['svRotate','svRandom','svClear','svReady'].includes(id))){
    const V=curSvView(); if(!V||V.phase!=='place') return; const d=svDraftFor(V);
    if(t.dataset.svship!=null){ const i=int(t.dataset.svship,0,SV_FLEET.length-1,0); if(d.ships[i].cells) d.ships[i].cells=null; d.sel=i; render(); return; }
    if(id==='svRotate'){ d.horiz=!d.horiz; render(); return; }
    if(id==='svClear'){ d.ships.forEach(s=>s.cells=null); d.sel=0; render(); return; }
    if(id==='svRandom'){ const f=svRandomFleet(); if(f) d.ships.forEach((s,i)=>s.cells=f[i].cells); d.sel=null; render(); return; }
    if(id==='svReady'){ if(d.ships.every(s=>s.cells)) svAct({type:'place',ships:d.ships.map(s=>s.cells)}); return; }
    if(t.dataset.svp){
      const [r,c]=t.dataset.svp.split(',').map(Number);
      const hitIdx=d.ships.findIndex(s=>s.cells&&s.cells.some(([rr,cc])=>rr===r&&cc===c));
      if(hitIdx>=0){ d.ships[hitIdx].cells=null; d.sel=hitIdx; render(); return; }   // Schiff wieder aufnehmen
      if(d.sel==null||d.ships[d.sel].cells){ const n=d.ships.findIndex(s=>!s.cells); if(n<0) return; d.sel=n; }
      const s=d.ships[d.sel];
      let cells=svCellsOf(r,c,s.len,d.horiz);
      if(!cells){ cells=d.horiz?svCellsOf(r,SV_N-s.len,s.len,true):svCellsOf(SV_N-s.len,c,s.len,false); }   // am Rand: zurückschieben
      if(!cells){ toast('Das Schiff passt hier nicht hin.'); return; }
      if(svTouches(cells,d.ships.filter(x=>x!==s&&x.cells))){ toast('Schiffe dürfen sich nicht berühren – auch nicht über Eck.'); return; }
      s.cells=cells; const n=d.ships.findIndex(x=>!x.cells); d.sel=n>=0?n:null; render(); return;
    }
  }
  if(id==='showRules2'){ readName(); rulesReturn='menu'; showRules(); return; }
  if(id==='rulesBack'){ const r=rulesReturn; rulesReturn=null; if(r==='menu') showMenu(); else if(r==='lobby') showLobby(); else { overlay(''); render(); } return; }
  if(id==='showPrivacy'){ readName(); showPrivacy(); return; }
  if(id==='privacyBack'){ showMenu(); return; }
  if(id==='wipeData'){
    if(t.dataset.sure!=='1'){ t.dataset.sure='1'; t.textContent='Wirklich löschen? Nochmal tippen'; return; }
    stopNet(); LS_KEYS.forEach(lsDel); myName=''; myTok=randHex(16); lsSet('etappen-token',myTok); themeKey='auto'; animOff=false; applyTheme();
    mode='local'; G=null; SV=null; SVV=null; MM=null; MMV=null; render(); toast('Deine Daten auf diesem Gerät wurden gelöscht.'); showMenu(); return; }
  if(id==='btnNew'){ if(ovKey!=='menu') showMenu(); return; }
  if(id==='closeOv'){ overlay(''); render(); return; }
  if(id==='install'){ if(installEvt){ installEvt.prompt(); try{ await installEvt.userChoice; }catch(_){} installEvt=null; showMenu(); } return; }
  if(id==='localSetup'){ readName(); showSetup(); return; }
  if(id==='backMenu'){ readSetupNames(); showMenu(); return; }
  if(t.dataset.count){readSetupNames(); const n=int(t.dataset.count,2,6,4), cfg=SC(); while(cfg.length<n) cfg.push({name:'Computer '+cfg.length,ai:true,av:randomAv()}); setupCfgs[setupGame]=cfg.slice(0,n); showSetup(); return;}
  if(t.dataset.type){readSetupNames(); const [i,v]=t.dataset.type.split(',').map(Number); if(SC()[i]) SC()[i].ai=!!v; showSetup(); return;}
  if(id==='startLocal'){ readSetupNames(); const cfg=SC();
    if(setupGame!=='etappen'&&!cfg.some(p=>!p.ai)){ toast('Mindestens ein Mensch muss mitspielen.'); return; }
    lsSet(SETUP_KEY[setupGame],JSON.stringify(cfg)); stopNet(); overlay('');
    if(setupGame==='schiffe'){ svStartLocal(cfg); return; }
    if(setupGame==='maumau'){ mmStartLocal(cfg); return; }
    mode='local'; SV=null; SVV=null; MM=null; MMV=null; G=newGameState(cfg); const h=humans(); viewer=h.length===1?h[0]:null; covered=false; startRound(); changed(); return; }
  if(id==='hostRoom'){ hostGame(null,'etappen'); return; }
  if(id==='resumeHost'){ const sh=savedHost(); if(sh) hostGame(sh); return; }
  if(id==='joinRoom'){ joinGame($('codeIn').value); return; }
  if(id==='copyCode'){ const code=fmtCode(mode==='host'?HOST.code:CLIENT.code); try{ await navigator.clipboard.writeText(code); toast('Code kopiert.'); }catch(err){ toast('Code: '+code); } return; }
  if(id==='shareInvite'){
    const code=mode==='host'?HOST.code:CLIENT.code;
    const url=location.origin+location.pathname+'#raum-'+code;
    const gname=GAME_NAME[(mode==='host'?HOST.game:(CLIENT.lobby&&CLIENT.lobby.game))||'etappen'];
    const text=`Spiel ${gname} mit mir im Spielhafen! Raum-Code: ${fmtCode(code)}`;
    if(navigator.share){ try{ await navigator.share({title:'Spielhafen',text,url}); }catch(err){} }
    else { try{ await navigator.clipboard.writeText(text+'\n'+url); toast('Einladung kopiert – füge sie z. B. in WhatsApp ein.'); }catch(err){ toast('Code: '+fmtCode(code)); } }
    return; }
  if(id==='keepTrying'){ if(CLIENT){ CLIENT.start=Date.now(); } overlay(`<h2>Suche den Raum …</h2><p class="note">Sobald der Gastgeber online ist, geht es los.</p><div class="row"><button class="btn" id="toMenu">Abbrechen</button></div>`,'wait'); return; }
  if(id==='addBot'&&HOST){ if(HOST.seats.length<6){ const n=HOST.seats.filter(s=>s.ai).length+1; HOST.seats.push({tok:'bot-'+randHex(6),name:'Computer '+n,ai:true,av:randomAv()}); hostSave(); showLobby(); hostBroadcast(); } return; }
  if(t.dataset.kick!=null&&HOST){ const k=int(t.dataset.kick,0,5,-1); const s=HOST.seats[k]; if(s&&s.tok!==myTok&&HOST.status==='lobby'){ HOST.seats.splice(k,1); HOST.clients.forEach((c,cid)=>{ if(c.tok===s.tok){ hostSend(c,{t:'kicked'}); HOST.clients.delete(cid);} }); hostSave(); showLobby(); hostBroadcast(); } return; }
  if(id==='startOnline'){ hostStart(); return; }
  if(id==='leaveRoom'||id==='toMenu'){ if(mode==='host') lsDel('etappen-host'); stopNet(); mode='local'; G=null; SV=null; SVV=null; MM=null; MMV=null; render(); showMenu(); return; }
  if(id==='uncover'){covered=false; viewer=G.cur; overlay(''); render(); return;}
  if(id==='nextRound'){ if(mode!=='client'){ overlay(''); startRound(); changed(); } return; }
  if(id==='again'){ if(mode!=='client'){ overlay(''); G=newGameState(G.players.map(p=>({name:p.name,ai:p.ai,tok:p.tok,av:p.av}))); if(mode==='local'){const h=humans(); viewer=h.length===1?h[0]:null;} startRound(); changed(); } return; }
  if(t.dataset.skip!=null){ const c=askSkip.card; overlay(''); if(myTurn()&&G.stage==='play') act({type:'discard',id:c.id,target:int(t.dataset.skip,0,5,-1)}); else render(); return; }
  if(id==='cancelSkip'){overlay(''); render(); return;}
  if(!G) return;
  const mine=myTurn(); const me=mySeat(); const meP=me!=null?G.players[me]:null;
  if(id==='deckBtn'){ if(mine&&G.stage==='draw') act({type:'draw'}); return; }
  if(id==='discBtn'){ if(mine&&G.stage==='draw'){ const top=G.disc[G.disc.length-1]; if(top&&top.k==='s') toast('Aussetzen-Karten darf man nicht aufnehmen.'); else act({type:'take'}); } return; }
  const staging=meP&&!meP.laid&&!covered&&G.stage!=='over';
  /* Vorablage */
  if(t.dataset.sid&&staging){ const sid=+t.dataset.sid; stage.groups.forEach((g,gi)=>{ const k=g.indexOf(sid); if(k>=0){ g.splice(k,1); stage.active=gi; } }); render(); return; }
  if(t.dataset.slot!=null&&staging){ const gi=int(t.dataset.slot,0,2,0); stage.active=stage.active===gi?null:gi; sel.clear(); render(); return; }
  if(t.dataset.id){
    const cid=+t.dataset.id;
    if(staging&&stage.active!=null){
      const specs=PHASES[Math.min(meP.phase,9)].g, gi=stage.active, n=specs[gi][1];
      if(stage.groups[gi].length>=12){ toast('Mehr Karten passen nicht in eine Gruppe.'); return; }
      stage.groups[gi].push(cid); sel.delete(cid); justStaged=cid;
      // Mindestzahl erreicht: im Feld bleiben, solange noch eine passende Karte auf der Hand ist – sonst zum nächsten Feld
      if(stage.groups[gi].length>=n){
        const byId=new Map(meP.hand.map(c=>[c.id,c])), staged=stagedSet();
        const g=makeGroup(specs[gi][0],stage.groups[gi].map(id=>byId.get(id)).filter(Boolean));
        const more=g&&meP.hand.some(c=>!staged.has(c.id)&&c.k==='n'&&canAdd(g,c));
        if(!more){ const next=specs.findIndex(([,m],j)=>stage.groups[j].length<m); stage.active=next>=0?next:null; }
      }
      render(); return;
    }
    sel.has(cid)?sel.delete(cid):sel.add(cid); render(); return;
  }
  const a=t.dataset.act;
  if(a==='sort'){sortMode=sortMode==='num'?'col':'num'; render(); return;}
  if(a==='clear'){sel.clear(); render(); return;}
  if(a==='unstage'&&staging){ stage.groups=stage.groups.map(()=>[]); stage.active=0; render(); return; }
  if(a==='hint'&&staging){
    const r=suggestGroups(meP.hand,PHASES[meP.phase].g);
    if(r){ stage.groups=r; stage.active=null; sel.clear(); const left=meP.hand.length-r.flat().length;
      toast(left===0?'Vorablage gefüllt – damit wirst du alle Karten los!':'Vorablage gefüllt – alle passenden Karten sind schon dabei.'); }
    else toast('Mit deiner Hand geht die Etappe noch nicht.');
    render(); return; }
  if(!mine||G.stage!=='play'||!meP) return;
  if(a==='lay'){
    if(!stageValid(meP).every(Boolean)){ toast('Fülle zuerst alle Felder der Vorablage passend.'); return; }
    act({type:'lay',groups:stage.groups.map(g=>[...g])}); return; }
  if(a==='disc'){ const c=meP.hand.find(x=>sel.has(x.id)); if(!c) return; if(c.k==='s'){askSkip(c);return;} act({type:'discard',id:c.id}); return; }
  if(t.dataset.lo){ const [pi,gi]=t.dataset.lo.split(',').map(Number); const c=meP.hand.find(x=>sel.has(x.id)); if(c) act({type:'layoff',id:c.id,pi,gi}); return; }
});
document.addEventListener('keydown',e=>{
  if((e.key==='Enter'||e.key===' ')&&e.target.dataset&&(e.target.dataset.lo||e.target.dataset.slot!=null)){e.preventDefault(); e.target.click();}
  if(e.key==='Enter'&&e.target.id==='codeIn'){ $('joinRoom').click(); }
});
document.addEventListener('input',e=>{ if(e.target.id==='nameIn'){ myName=str(e.target.value,16); lsSet('etappen-name',myName);} });
document.addEventListener('change',e=>{ if(e.target.id==='mmDeckSel'&&mmEdit){ mmReadForm(); showMmEditor(); } });
window.addEventListener('beforeunload',e=>{ if(mode==='host'&&HOST&&onlineCount()&&!reloading){ e.preventDefault(); e.returnValue=''; } });

/* ---------- Zurück-Geste (Android-Wischen, Zurück-Taste, Browser-Zurück) ----------
   Es liegt immer ein „Wächter“-Eintrag im Verlauf. Wird zurückgewischt, fangen wir das ab,
   legen den Wächter neu an und gehen in der App einen Schritt zurück. */
let backArmed=0, exiting=false;
function setupBack(){ try{ history.replaceState({er:'base'},''); history.pushState({er:'guard'},''); }catch(e){} }
window.addEventListener('popstate',()=>{
  if(exiting) return;
  try{ history.pushState({er:'guard'},''); }catch(e){}
  handleBack();
});
function armOrDo(msg,fn){
  const now=Date.now();
  if(now-backArmed<2500){ backArmed=0; fn(); }
  else { backArmed=now; toast(msg); }
}
function leaveGame(){ stopNet(); mode='local'; G=null; SV=null; SVV=null; MM=null; MMV=null; covered=false; render(); showMenu(); toast('Spiel verlassen.'); }
function handleBack(){
  switch(ovKey){
    case 'online': case 'settings': case 'privacy': case 'setup': readName(); showMenu(); return;
    case 'rules': { const b=$('rulesBack')||$('svRulesBack'); if(b) b.click(); return; }
    case 'mmrules': { const b=$('mmRulesBack'); if(b) b.click(); return; }
    case 'mmedit': mmEdit=null; showMmRulesPage(); return;
    case 'mmhow': { const b=$('mmHowBack'); if(b) b.click(); return; }
    case 'mmwish': mmPick=null; overlay(''); render(); return;
    case 'avatar': closeAvatarEditor(); return;
    case 'skip': overlay(''); render(); return;
    case 'wait': case 'notfound': leaveToMenu(); return;
    case 'menu':
      if(G||svActive()||mmActive()){ overlay(''); render(); return; }   // zurück ins laufende Spiel
      armOrDo('Nochmal zurück wischen, um die App zu schließen.',()=>{ exiting=true; history.go(-2); });
      return;
  }
  if(G||svActive()||mmActive()||ovKey==='lobby'||ovKey==='cover'||ovKey.startsWith('end')||ovKey.startsWith('svend')||ovKey.startsWith('mmend')){
    armOrDo(mode==='local'?'Nochmal zurück wischen, um das Spiel zu verlassen.':'Nochmal zurück wischen, um den Raum zu verlassen.', leaveGame);
    return;
  }
  showMenu();
}

/* ---------- Start ---------- */
setupBack();
render();
if(inviteCode){ showOnline(); toast('Einladung erkannt: Gib deinen Namen ein und tippe „Beitreten“.'); } else showMenu();
setupSW();
})();
