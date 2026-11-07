/* Etappen-Rommé – Spiellogik, Online-Modus (verschlüsselt über MQTT) und Oberfläche */
(function(){
'use strict';
const APP_VERSION='1.2.1';
const PROTO=3;                       // Netzwerk-Protokoll; Gastgeber und Mitspieler müssen gleich sein
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
const LS_KEYS=['etappen-name','etappen-token','etappen-setup','etappen-host','etappen-last'];
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
    name:str(p.name,16)||'?', ai:!!p.ai, off:!!p.off, phase:int(p.phase,0,10,0), score:int(p.score,0,1e6,0), skip:int(p.skip,0,10,0),
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
  return {type, ids:Array.isArray(a.ids)?a.ids.slice(0,12).map(x=>int(x,0,1e6,-1)):[], id:int(a.id,0,1e6,-1), pi:int(a.pi,0,5,-1), gi:int(a.gi,0,2,-1), target:int(a.target,0,5,-1)};
}

/* ---------- state ----------
   mode 'local'  : alles auf diesem Gerät
   mode 'host'   : dieses Gerät ist Gastgeber und hat den vollen Spielstand
   mode 'client' : G ist nur die Sicht, die der Gastgeber schickt (fremde Hände verdeckt) */
let G=null, mode='local';
let sel=new Set(), viewer=null, covered=false, sortMode='num', aiBusy=false, ovKey='';
let myName=str(lsGet('etappen-name'),16);
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
  return {players:cfg.map(p=>({name:p.name,ai:!!p.ai,tok:p.tok||null,phase:0,score:0,hand:[],laid:null,skip:0})),deck:[],disc:[],cur:0,dealer:-1,round:0,stage:'draw',log:[],over:false,summary:null};
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
      const cards=[...new Set(a.ids)].map(card).filter(Boolean);
      if(!layPhase(cards)) return 'Die gewählten Karten ergeben noch nicht „'+PHASES[p.phase].t+'“.';
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
    await wait(delay);
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
  lsSet('etappen-host',JSON.stringify({code:HOST.code,status:HOST.status,seats:HOST.seats,G,ts:Date.now()}));
}
function savedHost(){ try{ const s=JSON.parse(lsGet('etappen-host')); if(s&&CODE_RE.test(s.code)&&Date.now()-s.ts<48*3600e3) return s; }catch(e){} return null; }
function rateOK(c){ const now=Date.now(); if(!c._t||now-c._t>1000){c._t=now;c._n=0;} return ++c._n<=MAX_MSG_PER_SEC; }
const isOnline=c=>Date.now()-c.last<35000;

async function hostGame(resume){
  if(!cryptoOK()) return;
  const name=readName(); if(!resume&&!name){toast('Bitte gib zuerst deinen Namen ein.'); return;}
  stopNet(); G=null; mode='local'; render();
  overlay(`<h2>Raum wird geöffnet …</h2><p class="note">Verschlüsselung wird vorbereitet.</p>`,'wait');
  const code=resume?resume.code:newCode();
  const keys=await roomKeys(code), ecdh=await newECDH();
  mode='host';
  HOST={code,keys,ecdh,status:resume?resume.status:'lobby',seats:resume?resume.seats:[{tok:myTok,name,ai:false}],clients:new Map()};
  G=resume&&resume.status==='game'?resume.G:null;
  netStart(keys,keys.topic+'/h',hostOnEnv);
  hostSave(); keepAwake();
  hostTimer=setInterval(hostTick,10000);
  if(HOST.status==='lobby'){ render(); showLobby(); } else { overlay(''); changed(); }
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
function seatOf(c){ if(!G||!c.tok) return null; const i=G.players.findIndex(p=>p.tok===c.tok); return i<0?null:i; }
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
  if(HOST.status==='lobby') hostSend(c,{t:'lobby',v:PROTO,code:HOST.code,seats:HOST.seats.map(s=>({name:s.name,ai:s.ai,me:s.tok===c.tok,host:s.tok===myTok}))});
  else { const seat=seatOf(c); hostSend(c,{t:'state',v:PROTO,sn:++c.sn,ack:c.lastSeq,you:seat,view:viewFor(seat),hostName:HOST.seats[0].name}); }
}
function hostBroadcast(){ if(HOST) HOST.clients.forEach(c=>hostSendView(c)); }
function hostOnMsg(c,d){
  if(d.t==='join'){
    const tok=str(d.tok,64); if(!/^[0-9a-f]{32}$/.test(tok)||tok===myTok) return;
    const name=str(d.name,16)||'Gast';
    HOST.clients.forEach((o,k)=>{ if(o!==c&&o.tok===tok) HOST.clients.delete(k); });
    c.tok=tok;
    let seat=HOST.seats.find(s=>s.tok===tok);
    if(!seat){
      if(HOST.status!=='lobby') hostSend(c,{t:'info',msg:'Das Spiel läuft schon – du schaust zu.'});
      else if(HOST.seats.length>=6){ hostSend(c,{t:'deny',msg:'Der Raum ist voll (6 Spieler).'}); HOST.clients.delete(c.cid); return; }
      else HOST.seats.push({tok,name,ai:false});
    } else if(HOST.status==='lobby') seat.name=name;
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
    const err=applyAction(seat,d.a);
    if(err){ hostSend(c,{t:'err',msg:err,ack:seq}); hostSendView(c); } else changed();
  }
}
function hostStart(){
  if(!HOST||HOST.seats.length<2) return;
  HOST.status='game';
  G=newGameState(HOST.seats.map(s=>({name:s.name,ai:s.ai,tok:s.ai?null:s.tok})));
  overlay(''); startRound(); changed();
}

/* ---------- Online: Mitspieler ---------- */
async function joinGame(codeRaw){
  if(!cryptoOK()) return;
  const name=readName(); if(!name){toast('Bitte gib zuerst deinen Namen ein.'); return;}
  const code=normCode(codeRaw); if(!CODE_RE.test(code)){toast(`Der Raum-Code hat ${CODE_LEN} Zeichen, zum Beispiel ABCD-2345.`); return;}
  stopNet(); G=null; mode='client'; render();
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
    clientSendMsg({t:'join',tok:myTok,name:myName});
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
  if((d.t==='lobby'||d.t==='state')&&d.v!==PROTO){ toast('Deine App-Version passt nicht zu der des Gastgebers. Bitte beide die App aktualisieren.'); return; }
  if(d.t==='lobby'){
    C.lobby={code:C.code,seats:(Array.isArray(d.seats)?d.seats:[]).slice(0,6).map(s=>({name:str(s&&s.name,16)||'?',ai:!!(s&&s.ai),me:!!(s&&s.me),host:!!(s&&s.host)}))};
    G=null; render(); if(['wait','lobby','notfound'].includes(ovKey)||!ovKey) showLobby(); return;
  }
  if(d.t==='state'){
    const sn=int(d.sn,0,1e12,0); if(sn&&sn<=C.sn) return; C.sn=sn;
    const v=sanitizeView(d.view); if(!v) return;
    G=v; C.you=d.you==null?null:int(d.you,0,v.players.length-1,null); C.hostName=str(d.hostName,16);
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
function leaveToMenu(){ if(mode==='host') lsDel('etappen-host'); stopNet(); mode='local'; G=null; render(); showMenu(); }

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

function render(){
  const chip=$('netChip');
  if(mode==='host'&&HOST){ const ok=netOnline(); chip.hidden=false; chip.className='netchip'+(ok?'':' bad'); chip.textContent=ok?`Gastgeber · ${fmtCode(HOST.code)} · ${onlineCount()+1} online`:'Kein Internet – verbinde neu …'; }
  else if(mode==='client'&&CLIENT){ const ok=hostReachable(); chip.hidden=false; chip.className='netchip'+(ok?'':' bad'); chip.textContent=ok?'Online · '+fmtCode(CLIENT.code):(netOnline()?'Suche Gastgeber …':'Kein Internet – verbinde neu …'); }
  else chip.hidden=true;
  if(!G){
    $('roundInfo').textContent=''; $('players').innerHTML=''; $('center').hidden=true; $('dock').hidden=true; measureDock();
    return;
  }
  $('center').hidden=false; $('dock').hidden=false;
  const me=mySeat();
  $('roundInfo').textContent=`Runde ${G.round}`;
  const p=P(); const mine=myTurn();
  const meP=me!=null?G.players[me]:null;
  const oneSel=sel.size===1?[...sel][0]:null;
  const selCard=oneSel&&meP?meP.hand.find(c=>c.id===oneSel):null;
  const canLayOff=mine && G.stage==='play' && p.laid && selCard;
  $('players').innerHTML=G.players.map((pl,i)=>`
    <div class="pl ${i===G.cur&&G.stage!=='over'?'cur':''}">
      <div class="pl-top"><div class="pl-name">${esc(pl.name)}${pl.ai?' <span class="pl-meta">· Computer</span>':''}${mode!=='local'&&i===me?' <span class="pl-meta">· du</span>':''}${pl.off?'<span class="badge off">offline</span>':''}${pl.skip?`<span class="badge">setzt aus</span>`:''}${pl.laid?`<span class="badge ok">ausgelegt</span>`:''}</div>
      <div class="pl-meta">${int(pl.hand.length,0,999,0)} Karten · ${int(pl.score,0,1e6,0)} Pkt.</div></div>
      <div class="pl-phase">Etappe <b>${Math.min(int(pl.phase,0,10,0)+1,10)}</b> · ${PHASES[Math.min(int(pl.phase,0,10,0),9)].t}</div>
      ${pl.laid?`<div class="groups">${pl.laid.map((g,gi)=>{const t=canLayOff&&canAdd(g,selCard); return `<div class="grp ${t?'target':''}" ${t?`data-lo="${i},${gi}" tabindex="0" role="button" aria-label="Hier anlegen"`:''}>${g.cards.map(c=>cardHTML(c,'mini','tabindex="-1"')).join('')}</div>`;}).join('')}</div>`:''}
    </div>`).join('');
  const top=G.disc[G.disc.length-1];
  const deckN=G.deckN!=null?G.deckN:G.deck.length;
  const drawOK=mine&&G.stage==='draw';
  $('deckSlot').innerHTML=(deckN||G.disc.length>1)?`<button class="card big back ${drawOK?'can':''}" id="deckBtn" aria-label="Vom Stapel ziehen"></button>`:cardHTML(null,'big');
  $('deckCount').textContent=`Stapel · ${deckN}`;
  $('discSlot').innerHTML=cardHTML(top,'big '+(drawOK&&top&&top.k!=='s'?'can':'disabled'),'id="discBtn"');
  let msg='',sub='';
  if(G.stage==='over') msg='Runde beendet.';
  else if(!mine){ msg=`${p.name} ist am Zug …`; if(mode!=='local'&&me==null) sub='Du schaust zu.'; }
  else if(G.stage==='draw'){msg='Du bist dran: Ziehe eine Karte.'; sub='Tippe auf den Stapel oder auf die Ablage.';}
  else if(!p.laid){msg='Etappe auslegen oder abwerfen.'; sub='Wähle die Karten für deine Etappe und tippe „Etappe auslegen“. Zum Beenden eine Karte wählen und abwerfen.';}
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
    $('handTitle').innerHTML=`${esc(v.name)} <span>· Etappe ${Math.min(v.phase+1,10)}: ${ph.t}${v.laid?' – erledigt':''}</span>`;
    $('req').innerHTML=v.laid?'':ph.g.map(([t,n])=>`<span class="chip">${GNAME[t](n)}</span>`).join('');
    const ids=new Set(v.hand.map(c=>c.id)); for(const id of [...sel]) if(!ids.has(id)) sel.delete(id);
    const hand=[...v.hand].sort(sortMode==='num'?((a,b)=>ord(a)-ord(b)||(a.c||0)-(b.c||0)):((a,b)=>(a.k==='n'?a.c:9)-(b.k==='n'?b.c:9)||ord(a)-ord(b)));
    $('hand').innerHTML=hand.map(c=>cardHTML(c,sel.has(c.id)?'sel':'',`data-id="${int(c.id,0,1e6,0)}" aria-pressed="${sel.has(c.id)}"`)).join('');
    const a=[];
    if(mine&&G.stage==='play'){
      if(!v.laid) a.push(`<button class="btn primary" data-act="lay" ${sel.size?'':'disabled'}>Etappe auslegen</button>`,`<button class="btn" data-act="hint">Vorschlag</button>`);
      a.push(`<button class="btn ${v.laid?'primary':''}" data-act="disc" ${sel.size===1?'':'disabled'}>Abwerfen</button>`);
    }
    if(sel.size) a.push(`<button class="btn" data-act="clear">Auswahl aufheben</button>`);
    a.push(`<button class="btn" data-act="sort">Sortieren: ${sortMode==='num'?'Zahl':'Farbe'}</button>`);
    $('actions').innerHTML=a.join('');
  }
  measureDock();
  stateOverlay();
}
function measureDock(){ const d=$('dock'); const h=d.hidden?0:d.offsetHeight; document.documentElement.style.setProperty('--dockH',h+'px'); }
if(window.ResizeObserver) new ResizeObserver(measureDock).observe($('dock'));
window.addEventListener('resize',measureDock);

/* ---------- overlays ---------- */
function overlay(html,key){ ovKey=html?(key||'misc'):''; $('overlay').innerHTML=html?`<div class="ov"><div class="box">${html}</div></div>`:''; }
function stateOverlay(){
  if(!G) return;
  if(G.stage==='over'&&G.summary){
    const k='end'+G.round+(G.over?'x':'');
    if(ovKey!==k && !['rules','menu','setup','privacy'].includes(ovKey)) showRoundEnd(k);
  } else {
    if(ovKey.startsWith('end')) overlay('');
    if(mode==='local'&&covered&&!ovKey) showCover();
  }
}
function showCover(){
  const p=P();
  overlay(`<h2>Weitergeben an ${esc(p.name)}</h2><p>Die anderen bitte wegschauen. ${esc(p.name)} ist mit Etappe ${p.phase+1} dran: ${PHASES[p.phase].t}.</p><div class="row"><button class="btn primary" id="uncover">Ich bin ${esc(p.name)} – Karten zeigen</button></div>`,'cover');
}
function showRoundEnd(k){
  const s=G.summary, wName=(G.players[s.wi]||{}).name||'?';
  const tbl=`<table><tr><th>Spieler</th><th>Etappe</th><th>+Pkt.</th><th>Gesamt</th></tr>${s.rows.map(r=>`<tr><td>${esc(r.name)}</td><td>${int(r.phase,0,10,0)+1} ${r.done?'✓ geschafft':'– nochmal'}</td><td>${int(r.add,0,1e4,0)}</td><td>${int(r.total,0,1e6,0)}</td></tr>`).join('')}</table>`;
  const canGo=mode!=='client';
  const wait=canGo?'':`<p class="note">Warte, bis ${esc((CLIENT&&CLIENT.hostName)||'der Gastgeber')} weitermacht.</p>`;
  if(s.winner!==null&&G.players[s.winner]){
    overlay(`<h2>${esc(G.players[s.winner].name)} gewinnt!</h2><p>${esc(wName)} hat die letzte Runde beendet. Wer alle 10 Etappen geschafft hat, gewinnt – bei mehreren der mit den wenigsten Punkten.</p>${tbl}${wait}<div class="row mt">${canGo?'<button class="btn primary" id="again">Nochmal spielen</button>':''}<button class="btn" id="toMenu">Zum Menü</button></div>`,k);
  } else {
    overlay(`<h2>${esc(wName)} ist fertig!</h2><p>Wer seine Etappe ausgelegt hat, steigt eine Etappe auf. Karten auf der Hand zählen als Minuspunkte.</p>${tbl}${wait}<div class="row mt">${canGo?'<button class="btn primary" id="nextRound">Nächste Runde</button>':''}</div>`,k);
  }
}
function askSkip(card){
  const ts=skipTargets();
  overlay(`<h2>Wer soll aussetzen?</h2><div class="row">${ts.map(i=>`<button class="btn" data-skip="${i}">${esc(G.players[i].name)}</button>`).join('')}</div><div class="row"><button class="btn" id="cancelSkip">Abbrechen</button></div>`,'skip');
  askSkip.card=card;
}

/* Menü */
const inviteCode=(()=>{ const m=(location.hash||'').match(/^#raum-([A-Za-z0-9-]{8,9})$/); const c=m?normCode(m[1]):''; return CODE_RE.test(c)?c:''; })();
let installEvt=null;
window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); installEvt=e; if(ovKey==='menu') showMenu(); });
const standalone=()=>window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
const isIOS=/iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
function showMenu(){
  const sh=savedHost();
  const lastRaw=normCode(lsGet('etappen-last'));
  const typed=$('codeIn')?normCode($('codeIn').value):'';
  const last=typed||inviteCode||(CODE_RE.test(lastRaw)?lastRaw:'');
  const nameEl=$('nameIn'); if(nameEl) myName=str(nameEl.value,16);
  let inst='';
  if(!standalone()){
    if(installEvt) inst=`<div><h3>Als App installieren</h3><p class="note">Legt Etappen-Rommé als App auf deinen Startbildschirm.</p><div class="row"><button class="btn primary" id="install">App installieren</button></div></div>`;
    else if(isIOS) inst=`<div><h3>Als App installieren</h3><p class="note">Tippe in Safari unten auf <b>Teilen</b> und dann auf <b>„Zum Home-Bildschirm“</b>.</p></div>`;
  }
  overlay(`<h2>Etappen-Rommé</h2><p>Sammle Drillinge, Folgen und Farben und schaffe als Erster alle 10 Etappen.</p>
  <div class="choice">
    <div><h3>Online – jeder an seinem Gerät</h3>
      <div class="row"><input type="text" id="nameIn" maxlength="16" placeholder="Dein Name" value="${esc(myName)}" aria-label="Dein Name" autocomplete="nickname"></div>
      <div class="row"><button class="btn primary" id="hostRoom">Neuen Raum erstellen</button>${sh?`<button class="btn" id="resumeHost">Raum ${esc(sh.code)} fortsetzen</button>`:''}</div>
      <div class="row"><input type="text" id="codeIn" maxlength="${CODE_LEN+1}" placeholder="ABCD-2345" value="${esc(last?fmtCode(last):'')}" aria-label="Raum-Code" autocapitalize="characters" autocomplete="off" spellcheck="false" class="codein"><button class="btn" id="joinRoom">Beitreten</button></div>
      <p class="note">Wer den Raum erstellt, ist Gastgeber. Sein Gerät muss während des Spiels online und an bleiben.</p>
    </div>
    <div><h3>An einem Gerät</h3><p class="note">Abwechselnd am selben Handy oder Tablet, auch mit Computergegnern.</p>
      <div class="row"><button class="btn" id="localSetup">Spiel einrichten</button></div></div>
    ${inst}
  </div>
  <div class="row mt">${G?'<button class="btn" id="closeOv">Zurück zum Spiel</button>':''}<button class="btn" id="showRules2">Regeln</button><button class="btn" id="showPrivacy">Datenschutz</button></div>
  <p class="note">Version ${APP_VERSION}</p>`,'menu');
}
function readName(){ const el=$('nameIn'); if(el){ myName=str(el.value,16); lsSet('etappen-name',myName);} return myName; }

/* Lobby */
function showLobby(){
  let seats, isHost, code;
  if(mode==='host'&&HOST){ isHost=true; code=HOST.code; const on=onlineToks(); seats=HOST.seats.map(s=>({name:s.name,ai:s.ai,me:s.tok===myTok,host:s.tok===myTok,off:!s.ai&&!on.has(s.tok)})); }
  else if(mode==='client'&&CLIENT&&CLIENT.lobby){ isHost=false; code=CLIENT.lobby.code; seats=CLIENT.lobby.seats; }
  else return;
  const list=seats.map((s,i)=>`<li><b>${esc(s.name)}</b><span>${s.ai?'Computer':s.host?'Gastgeber':''}${s.me?' · du':''}${s.off?' · offline':''}${isHost&&!s.me?` <button class="btn sm" data-kick="${i}">Entfernen</button>`:''}</span></li>`).join('');
  overlay(`<h2>Raum</h2><p>Gib nur deinen Mitspielern diesen Code. Sie öffnen die App, tippen auf „Beitreten“ und geben ihn ein.</p>
    <div class="row"><span class="code">${esc(fmtCode(code))}</span></div>
    <div class="row"><button class="btn primary" id="shareInvite">Einladung teilen</button><button class="btn" id="copyCode">Code kopieren</button></div>
    <h3>Spieler (${seats.length}/6)</h3><ul class="seats">${list}</ul>
    ${isHost?'<p class="note">Unbekannte Namen kannst du mit „Entfernen“ wieder hinauswerfen.</p>':''}
    <div class="row mt">
      ${isHost?`<button class="btn primary" id="startOnline" ${seats.length>=2?'':'disabled'}>Spiel starten</button><button class="btn" id="addBot" ${seats.length<6?'':'disabled'}>Computer hinzufügen</button>`:'<span class="note">Warte, bis der Gastgeber das Spiel startet …</span>'}
      <button class="btn" id="leaveRoom">Raum verlassen</button>
    </div>`,'lobby');
}

/* lokales Spiel */
let setupCfg=null;
try{setupCfg=JSON.parse(lsGet('etappen-setup'));}catch(e){}
if(!Array.isArray(setupCfg)||!setupCfg.length||setupCfg.length>6) setupCfg=[{name:'Spieler 1',ai:false},{name:'Spieler 2',ai:false},{name:'Spieler 3',ai:false},{name:'Spieler 4',ai:false}];
setupCfg=setupCfg.map((p,i)=>({name:str(p&&p.name,16)||('Spieler '+(i+1)),ai:!!(p&&p.ai)}));
function showSetup(){
  const rows=setupCfg.map((p,i)=>`<div class="row"><input type="text" id="pname${i}" value="${esc(p.name)}" maxlength="16" aria-label="Name Spieler ${i+1}"><div class="seg"><button data-type="${i},0" class="${p.ai?'':'on'}">Mensch</button><button data-type="${i},1" class="${p.ai?'on':''}">Computer</button></div></div>`).join('');
  overlay(`<h2>Spiel an einem Gerät</h2><p>2 bis 6 Spieler. Menschen spielen abwechselnd an diesem Gerät – vor jedem Zug wird die Hand verdeckt.</p>
    <div class="row"><span>Spieler:</span><div class="seg">${[2,3,4,5,6].map(n=>`<button data-count="${n}" class="${setupCfg.length===n?'on':''}">${n}</button>`).join('')}</div></div>
    ${rows}<div class="row mt"><button class="btn primary" id="startLocal">Spiel starten</button><button class="btn" id="backMenu">Zurück</button></div>`,'setup');
}
function readSetupNames(){setupCfg.forEach((p,i)=>{const el=$('pname'+i); if(el) p.name=str(el.value,16)||('Spieler '+(i+1));});}
let rulesReturn=null;
function showRules(){
  overlay(`<div class="rules"><h2>So wird gespielt</h2>
  <p>Jeder versucht, nacheinander 10 Etappen zu schaffen. Jeder Spieler hat seine eigene Etappe. Jede Runde gibt es 10 Karten.</p>
  <ol>
    <li><b>Ziehen:</b> eine Karte vom Stapel oder die oberste der Ablage (Aussetzen-Karten nicht).</li>
    <li><b>Auslegen:</b> Hast du alle Gruppen deiner Etappe, lege sie auf einmal aus.</li>
    <li><b>Anlegen:</b> Nur wer seine Etappe liegen hat, darf danach Karten an beliebige Gruppen anlegen.</li>
    <li><b>Abwerfen:</b> Jeder Zug endet mit einer Karte auf die Ablage.</li>
  </ol>
  <p><b>Gruppen:</b> Zwilling/Drilling/Vierling/Fünfling = gleiche Zahl. Folge = aufeinanderfolgende Zahlen (1–12, Farbe egal). „Einer Farbe“ = gleiche Farbe, Zahl egal. Jede Gruppe braucht mindestens eine echte Zahlenkarte.</p>
  <p><b>Joker ★</b> ersetzen jede Karte. <b>Aussetzen ⊘</b> abwerfen und einen Spieler wählen, der seinen nächsten Zug verliert.</p>
  <p><b>Rundenende:</b> Wer keine Karten mehr hat, beendet die Runde. Wer seine Etappe ausgelegt hat, steigt auf. Restkarten zählen: 1–9 = 5, 10–12 = 10, Aussetzen = 15, Joker = 25 Punkte.</p>
  <p><b>Sieg:</b> Wer zuerst Etappe 10 schafft, beendet das Spiel. Schaffen es mehrere in derselben Runde, gewinnt der mit den wenigsten Punkten.</p>
  <table><tr><th>#</th><th>Etappe</th></tr>${PHASES.map((p,i)=>`<tr><td>${i+1}</td><td>${p.t}</td></tr>`).join('')}</table>
  <div class="row mt"><button class="btn primary" id="rulesBack">Verstanden</button></div></div>`,'rules');
}
function showPrivacy(){
  overlay(`<div class="rules"><h2>Datenschutz</h2>
  <p>Etappen-Rommé hat keine Konten, keine Werbung, keine Tracker und keine eigene Datenbank.</p>
  <h3>Auf deinem Gerät</h3>
  <p>Gespeichert werden nur: dein Name, eine zufällige Geräte-Kennung (damit du nach einem Verbindungsabbruch deinen Platz wiederbekommst), der letzte Raum-Code, deine Spiel-Einstellungen und – wenn du Gastgeber bist – der laufende Spielstand. Diese Daten verlassen dein Gerät nicht von selbst.</p>
  <h3>Beim Online-Spiel</h3>
  <ul>
    <li>Die Nachrichten laufen über zwei öffentliche Nachrichten-Server (MQTT): broker.hivemq.com (HiveMQ) und broker.emqx.io (EMQX). Sie sehen deine IP-Adresse und wann du online bist.</li>
    <li>Alles, was übertragen wird, ist Ende-zu-Ende verschlüsselt (AES-256). Der Schlüssel entsteht aus dem Raum-Code, und jeder Mitspieler hat zusätzlich einen eigenen Schlüssel mit dem Gastgeber. Die Server und andere im Raum können deine Karten nicht lesen.</li>
    <li>Übertragen werden nur dein Name und deine Spielzüge. Deine IP-Adresse sehen die Mitspieler nicht.</li>
    <li>Nur der Gastgeber kennt alle Karten. Alle anderen bekommen nur ihre eigene Hand.</li>
  </ul>
  <h3>Webseite</h3>
  <p>Die App liegt auf GitHub Pages. GitHub speichert beim Abruf technische Daten wie die IP-Adresse. Schriften und Programmteile liegen direkt auf der Seite, es wird nichts von Google Fonts oder anderen Anbietern nachgeladen.</p>
  <div class="row mt"><button class="btn primary" id="privacyBack">Zurück</button><button class="btn" id="wipeData">Meine Daten auf diesem Gerät löschen</button></div></div>`,'privacy');
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
  const t=e.target.closest('[data-lo]')||e.target.closest('button'); if(!t) return;
  const id=t.id;
  if(id==='doUpdate'){
    if(mode==='host'&&HOST){ hostSave(); }
    reloading=true; const w=swReg&&swReg.waiting; if(w) w.postMessage('skipWaiting'); else location.reload(); return; }
  if(id==='laterUpdate'){ $('updateBar').hidden=true; return; }
  if(id==='btnRules'){ if(!ovKey||ovKey==='menu'||ovKey==='lobby'){ rulesReturn=ovKey; showRules(); } return; }
  if(id==='showRules2'){ readName(); rulesReturn='menu'; showRules(); return; }
  if(id==='rulesBack'){ const r=rulesReturn; rulesReturn=null; if(r==='menu') showMenu(); else if(r==='lobby') showLobby(); else { overlay(''); render(); } return; }
  if(id==='showPrivacy'){ readName(); showPrivacy(); return; }
  if(id==='privacyBack'){ showMenu(); return; }
  if(id==='wipeData'){
    if(t.dataset.sure!=='1'){ t.dataset.sure='1'; t.textContent='Wirklich löschen? Nochmal tippen'; return; }
    stopNet(); LS_KEYS.forEach(lsDel); myName=''; myTok=randHex(16); lsSet('etappen-token',myTok);
    mode='local'; G=null; render(); toast('Deine Daten auf diesem Gerät wurden gelöscht.'); showMenu(); return; }
  if(id==='btnNew'){ if(ovKey!=='menu') showMenu(); return; }
  if(id==='closeOv'){ overlay(''); render(); return; }
  if(id==='install'){ if(installEvt){ installEvt.prompt(); try{ await installEvt.userChoice; }catch(_){} installEvt=null; showMenu(); } return; }
  if(id==='localSetup'){ readName(); showSetup(); return; }
  if(id==='backMenu'){ readSetupNames(); showMenu(); return; }
  if(t.dataset.count){readSetupNames(); const n=int(t.dataset.count,2,6,4); while(setupCfg.length<n) setupCfg.push({name:'Spieler '+(setupCfg.length+1),ai:true}); setupCfg=setupCfg.slice(0,n); showSetup(); return;}
  if(t.dataset.type){readSetupNames(); const [i,v]=t.dataset.type.split(',').map(Number); if(setupCfg[i]) setupCfg[i].ai=!!v; showSetup(); return;}
  if(id==='startLocal'){ readSetupNames(); lsSet('etappen-setup',JSON.stringify(setupCfg)); stopNet(); overlay('');
    mode='local'; G=newGameState(setupCfg); const h=humans(); viewer=h.length===1?h[0]:null; covered=false; startRound(); changed(); return; }
  if(id==='hostRoom'){ hostGame(null); return; }
  if(id==='resumeHost'){ const sh=savedHost(); if(sh) hostGame(sh); return; }
  if(id==='joinRoom'){ joinGame($('codeIn').value); return; }
  if(id==='copyCode'){ const code=fmtCode(mode==='host'?HOST.code:CLIENT.code); try{ await navigator.clipboard.writeText(code); toast('Code kopiert.'); }catch(err){ toast('Code: '+code); } return; }
  if(id==='shareInvite'){
    const code=mode==='host'?HOST.code:CLIENT.code;
    const url=location.origin+location.pathname+'#raum-'+code;
    const text=`Spiel Etappen-Rommé mit mir! Raum-Code: ${fmtCode(code)}`;
    if(navigator.share){ try{ await navigator.share({title:'Etappen-Rommé',text,url}); }catch(err){} }
    else { try{ await navigator.clipboard.writeText(text+'\n'+url); toast('Einladung kopiert – füge sie z. B. in WhatsApp ein.'); }catch(err){ toast('Code: '+fmtCode(code)); } }
    return; }
  if(id==='keepTrying'){ if(CLIENT){ CLIENT.start=Date.now(); } overlay(`<h2>Suche den Raum …</h2><p class="note">Sobald der Gastgeber online ist, geht es los.</p><div class="row"><button class="btn" id="toMenu">Abbrechen</button></div>`,'wait'); return; }
  if(id==='addBot'&&HOST){ if(HOST.seats.length<6){ const n=HOST.seats.filter(s=>s.ai).length+1; HOST.seats.push({tok:'bot-'+randHex(6),name:'Computer '+n,ai:true}); hostSave(); showLobby(); hostBroadcast(); } return; }
  if(t.dataset.kick!=null&&HOST){ const k=int(t.dataset.kick,0,5,-1); const s=HOST.seats[k]; if(s&&s.tok!==myTok&&HOST.status==='lobby'){ HOST.seats.splice(k,1); HOST.clients.forEach((c,cid)=>{ if(c.tok===s.tok){ hostSend(c,{t:'kicked'}); HOST.clients.delete(cid);} }); hostSave(); showLobby(); hostBroadcast(); } return; }
  if(id==='startOnline'){ hostStart(); return; }
  if(id==='leaveRoom'||id==='toMenu'){ if(mode==='host') lsDel('etappen-host'); stopNet(); mode='local'; G=null; render(); showMenu(); return; }
  if(id==='uncover'){covered=false; viewer=G.cur; overlay(''); render(); return;}
  if(id==='nextRound'){ if(mode!=='client'){ overlay(''); startRound(); changed(); } return; }
  if(id==='again'){ if(mode!=='client'){ overlay(''); G=newGameState(G.players.map(p=>({name:p.name,ai:p.ai,tok:p.tok}))); if(mode==='local'){const h=humans(); viewer=h.length===1?h[0]:null;} startRound(); changed(); } return; }
  if(t.dataset.skip!=null){ const c=askSkip.card; overlay(''); if(myTurn()&&G.stage==='play') act({type:'discard',id:c.id,target:int(t.dataset.skip,0,5,-1)}); else render(); return; }
  if(id==='cancelSkip'){overlay(''); render(); return;}
  if(!G) return;
  const mine=myTurn(); const me=mySeat(); const meP=me!=null?G.players[me]:null;
  if(id==='deckBtn'){ if(mine&&G.stage==='draw') act({type:'draw'}); return; }
  if(id==='discBtn'){ if(mine&&G.stage==='draw'){ const top=G.disc[G.disc.length-1]; if(top&&top.k==='s') toast('Aussetzen-Karten darf man nicht aufnehmen.'); else act({type:'take'}); } return; }
  if(t.dataset.id){ const cid=+t.dataset.id; sel.has(cid)?sel.delete(cid):sel.add(cid); render(); return; }
  const a=t.dataset.act;
  if(a==='sort'){sortMode=sortMode==='num'?'col':'num'; render(); return;}
  if(a==='clear'){sel.clear(); render(); return;}
  if(!mine||G.stage!=='play'||!meP) return;
  if(a==='hint'){ const r=findPhase(meP.hand,PHASES[meP.phase].g); if(r){sel=new Set(r.flatMap(g=>g.cards.map(c=>c.id))); toast('Diese Karten ergeben deine Etappe.');} else toast('Mit deiner Hand geht die Etappe noch nicht.'); render(); return; }
  if(a==='lay'){ const ids=meP.hand.filter(c=>sel.has(c.id)).map(c=>c.id); if(mode!=='client'||findPhase(meP.hand.filter(c=>sel.has(c.id)),PHASES[meP.phase].g)) act({type:'lay',ids}); else toast('Die gewählten Karten ergeben noch nicht „'+PHASES[meP.phase].t+'“.'); return; }
  if(a==='disc'){ const c=meP.hand.find(x=>sel.has(x.id)); if(!c) return; if(c.k==='s'){askSkip(c);return;} act({type:'discard',id:c.id}); return; }
  if(t.dataset.lo){ const [pi,gi]=t.dataset.lo.split(',').map(Number); const c=meP.hand.find(x=>sel.has(x.id)); if(c) act({type:'layoff',id:c.id,pi,gi}); return; }
});
document.addEventListener('keydown',e=>{
  if((e.key==='Enter'||e.key===' ')&&e.target.dataset&&e.target.dataset.lo){e.preventDefault(); e.target.click();}
  if(e.key==='Enter'&&e.target.id==='codeIn'){ $('joinRoom').click(); }
});
document.addEventListener('input',e=>{ if(e.target.id==='nameIn'){ myName=str(e.target.value,16); lsSet('etappen-name',myName);} });
window.addEventListener('beforeunload',e=>{ if(mode==='host'&&HOST&&onlineCount()&&!reloading){ e.preventDefault(); e.returnValue=''; } });

/* ---------- Start ---------- */
render(); showMenu();
if(inviteCode){ const c=$('codeIn'); if(c) c.value=fmtCode(inviteCode); toast('Einladung erkannt: Gib deinen Namen ein und tippe „Beitreten“.'); }
setupSW();
})();
