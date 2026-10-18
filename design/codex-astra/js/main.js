import {buildMap,ROOMS,W,H,TILE,walkable} from './map.js';
import {findPath} from './path.js';
import {connect} from './net.js';
import {createRenderer} from './render.js';
import {demoView} from './demo.js';
import {warningSummary,frozenWarnView} from './anim.js';
const $=id=>document.getElementById(id), canvas=$('world'),map=buildMap(),renderer=createRenderer(canvas,map);
const query=new URLSearchParams(location.search),freeze=query.get('freeze'),freezeWarn=query.get('freezeWarn');
let view={t:0,now:0,agents:{},cases:{},messages:[]},positions={},seats={},stream=null,timer=null,tick=0,zoom=1;
const camera={x:0,y:0,scale:1};
// Integer world pixels: small viewports pan the 1× map instead of shrinking it.
function fitZoom(){return Math.max(1,Math.min(4,Math.floor(Math.min((innerWidth-64)/(W*TILE),(innerHeight-200)/(H*TILE)))))}
function resize(){canvas.width=innerWidth;canvas.height=innerHeight;zoom=fitZoom();center()}
function center(){camera.scale=zoom;camera.x=Math.round((innerWidth-W*TILE*zoom)/2);camera.y=Math.round(100+(innerHeight-190-H*TILE*zoom)/2);$('zoom').textContent=(zoom*100)+'%'}
function changeZoom(value){zoom=Math.max(1,Math.min(4,Math.round(value)));center()}
$('plus').onclick=()=>changeZoom(zoom+1);$('minus').onclick=()=>changeZoom(zoom-1);$('reset').onclick=()=>{zoom=fitZoom();center()};
$('details').onclick=()=>{const opened=$('inspector').classList.toggle('open');$('details').setAttribute('aria-expanded',String(opened))};
canvas.addEventListener('wheel',e=>{e.preventDefault();changeZoom(zoom+(e.deltaY<0?1:-1))},{passive:false});
let drag=null;canvas.onpointerdown=e=>{canvas.setPointerCapture(e.pointerId);drag={x:e.clientX,y:e.clientY,cx:camera.x,cy:camera.y}};canvas.onpointermove=e=>{if(drag){camera.x=drag.cx+e.clientX-drag.x;camera.y=drag.cy+e.clientY-drag.y}};canvas.onpointerup=canvas.onpointercancel=()=>drag=null;
function apply(state,initial=false){view=state;
 for(const id of Object.keys(positions))if(!view.agents[id]){delete seats[positions[id].seat];delete positions[id]}
 for(const a of Object.values(view.agents)){const room=ROOMS.find(r=>r.id===a.room);if(!room)continue;let p=positions[a.agentId];if(p?.room===a.room)continue;
 if(p)delete seats[p.seat];let i=room.seats.findIndex((_,i)=>!seats[room.id+':'+i]);if(i<0)i=0;const seat=room.id+':'+i,[x,y]=room.seats[i];seats[seat]=a.agentId;
 if(!p){const d=initial?[x,y]:room.doors[0];p=positions[a.agentId]={x:d[0],y:d[1],path:[]}}
 const path=findPath(W,H,(x,y)=>walkable(map,x,y),{x:Math.round(p.x),y:Math.round(p.y)},{x,y});p.path=path?path.slice(1):[];p.seat=seat;p.room=a.room;
 }
 $('count').textContent=Object.keys(view.agents).length+' agentes';$('cases').replaceChildren();for(const c of Object.values(view.cases)){const li=document.createElement('li');li.textContent=`${c.caseId} · ${c.tier??'—'} / ${ROOMS.find(r=>r.id===c.room)?.name??c.room} · ${warningSummary(c)||c.status}`;$('cases').append(li)}
 $('activity').textContent=`· ${Object.keys(view.cases).length} expedientes en planta`;
}
function source(){stream?.close();clearInterval(timer);positions={};seats={};view={t:0,now:0,agents:{},cases:{},messages:[]};apply(view);const mode=$('mode').value;$('session').hidden=mode==='local';
 if(mode==='local'){$('status').textContent='SIMULACIÓN LOCAL';apply(demoView(Date.now()),true);timer=setInterval(()=>{apply(demoView(Date.now(),++tick));$('log').textContent='Simulación: ronda de especialistas'},8000)}
 else{$('status').textContent='CONECTANDO SSE';stream=connect({mode,session:$('session').value||null,onStatus:s=>$('status').textContent=s,onSnapshot:s=>apply(s),onDelta:({state,events})=>{apply(state);$('log').textContent=events.at(-1)?.kind??'sin eventos'}})}
}
$('mode').value=['live','demo'].includes(query.get('mode'))?query.get('mode'):'local';$('session').value=query.get('session')??'';$('mode').onchange=source;$('session').onchange=source;
let last=performance.now();function frame(t){const dt=Math.min(.1,(t-last)/1000);last=t;for(const p of Object.values(positions)){let budget=dt*3;while(p.path.length&&budget>0){const n=p.path[0],dx=n.x-p.x,dy=n.y-p.y,d=Math.hypot(dx,dy);if(d<=budget){p.x=n.x;p.y=n.y;p.path.shift();budget-=d}else{p.x+=dx/d*budget;p.y+=dy/d*budget;budget=0}}}
 const now=freeze||freezeWarn?1000:Date.now();renderer.draw(freezeWarn?frozenWarnView(freezeWarn,now)??view:view,positions,now,{camera,freezeTool:freeze,bubbles:!!freeze});requestAnimationFrame(frame)}
window.addEventListener('resize',resize);resize();source();requestAnimationFrame(frame);
