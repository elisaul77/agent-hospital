// Isometric Hospital Vivo view over the existing case reducer and A* grid.
import { TILE, W, H, T, idx, SPECIALTY_DESKS } from './map.js';
import { project, WORLD } from './projection.js';
import { createArt } from './iso-art.js';
import { hash, drawBubble, drawCapsule, drawEnvelope, drawBell, drawSealCard, drawKeySwitch, drawUserChair, drawWristband, drawChip, drawMore } from './sprites.js';
import { equipmentOf, drawEquipment, drawGateLamp, drawBrakeChock, drawThreads, threadsOf, drawShutter } from './anim.js';
import { wristbandOf, chipRowsOf, caseColourOf } from './patients.js';
import { makeGurney, retarget, stepGurney } from './gurney.js';

const PALETTES = {
 direction:['#d6c8aa','#f4dfba','#8b795f'], waiting:['#c4d9b9','#e4edcd','#8bae91'],
 reception:['#e4d5b3','#f8e8c7','#b2a27c'], triage:['#c2d8b6','#e5efcf','#81a18b'],
 casefile:['#d6c5ae','#edddc4','#a99882'], architect:['#d1c7e0','#e8def4','#9b8dad'],
 diagnosis:['#bccddd','#dfebf2','#809bb2'], specialists:['#bad7cb','#dff0df','#80a89c'],
 council:['#d9c2d6','#f0ddeb','#b28da9'], operating:['#bad8d3','#d8f0e3','#78a69c'],
 radiology:['#c9c4de','#e7dff5','#988bae'], discharge:['#bdd6b8','#e1efd1','#89a481'],
 stopped:['#dbbaba','#f2d8cd','#b58b8a'],
};

function background(map) {
 const c=document.createElement('canvas'); c.width=WORLD.width;c.height=WORLD.height;
 const ctx=c.getContext('2d');ctx.imageSmoothingEnabled=false;
 const a=createArt(ctx);
 a.block(-1,-1,W+2,H+2,18,'#bdc9b7','#819d96','#587b7b',-18);
 // Sidewalk and street are scenery only; agents continue using the logical grid.
 a.tile(-6,-2,3.5,H+5,-10,'#587581');
 for(let y=0;y<H;y+=3)a.tile(-4.3,y,.1,1.3,-9,'#cfdbce');
 for(let y=14;y<17;y+=.5)a.tile(-5.8,y,3.1,.22,-8,'#f0e7ca');
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){
  const t=map.tiles[idx(x,y)],r=map.rooms[map.roomAt[idx(x,y)]];
  const p=r?PALETTES[r.id]:null;
  const color=p?((x+y)%2?p[0]:p[1]):t===T.CORRIDOR||t===T.DOOR?((x+y)%2?'#e5dbbd':'#eee4cb'):'#a7bcab';
  a.tile(x,y,1,1,0,color,'#718e7c22');
 }
 for(const cor of map.corridors){
  a.line(project(cor.x,cor.y+1,1),project(cor.x+cor.w,cor.y+1,1),'#a9b39b',2);
  for(let x=cor.x+2;x<cor.x+cor.w;x+=5){const [px,py]=project(x,cor.y+1,2);a.text('›',px,py,'#81998b',14);}
 }
 // Garden fills the former unused upper wing beside Direction and Waiting.
 a.block(31,1,14,3,5,'#80ae8b','#628c75','#527c6e');
 for(let x=32;x<45;x+=2)a.plant(x,2);
 return c;
}

function furnishings(map) {
 const items=[];
 const add=(x,y,draw)=>items.push({depth:x+y,draw});
 for(const room of map.rooms){
  const {x,y,w,h}=room.rect,p=PALETTES[room.id];
  // Back and left walls are cut away at doors; depth ordering keeps people behind furniture correctly.
  for(let k=0;k<w;k++){
   const door=room.doors.some(([dx,dy])=>dx===x+k&&dy===y-1);
   if(!door)add(x+k,y,a=>{
    a.block(x+k,y,1,.16,38,p[1],p[0],p[2]);
    a.line(project(x+k,y+.18,14),project(x+k+1,y+.18,14),p[2],3);
    if(k%3===1){a.poly([project(x+k+.12,y+.2,21),project(x+k+.88,y+.2,21),project(x+k+.88,y+.2,33),project(x+k+.12,y+.2,33)],'#a4d7d7','#f9f2d8');}
   });
  }
  for(let k=0;k<h;k++)add(x,y+k,a=>a.block(x,y+k,.14,1,38,p[1],p[0],p[2]));
  add(x+w-1,y+1,a=>a.plant(x+w-1,y+1));
  add(x+1,y+1,a=>a.block(x+.6,y+.6,.8,.5,24,'#b6c5c3','#8da4a7','#657f8b'));
  if(['reception','direction','discharge','stopped'].includes(room.id)){
   add(x+3,y+2,a=>{a.desk(x+2,y+1.7,Math.min(4,w-4),.8);a.chair(x+3,y+1,'#8775a1');});
  }else if(room.id==='waiting'){
   for(let k=0;k<6;k++)add(x+2+k*2,y+2.4,a=>a.chair(x+2+k*2,y+2.4,'#78a59a'));
  }else if(room.id==='specialists'){
   for(const d of SPECIALTY_DESKS){const [sx,sy]=d.seat;add(sx,sy-.4,a=>{a.desk(sx-.5,sy-.8,1.8,.65);const [px,py]=project(sx+.3,sy-.5,34);a.text(d.label,px,py,'#354b54',8);});}
  }else if(room.id==='council'){
   add(x+6,y+3,a=>{a.block(x+3,y+2,7,2,17,'#b89b7f','#866c62','#655a62');for(let k=0;k<4;k++){a.tile(x+3.5+k*1.5,y+2.4,.7,.6,18,'#fff0d1');a.chair(x+3.5+k*1.7,y+1.3,'#a88cae');a.chair(x+3.5+k*1.7,y+4.3,'#a88cae');}});
  }else if(room.id==='casefile'){
   for(let k=1;k<w-1;k+=1.5)add(x+k,y+1.8,a=>{a.block(x+k,y+1,.8,.6,28,'#d2c1a2','#ac967f','#7e8582');const [px,py]=project(x+k+.5,y+1.7,18);a.text('▤',px,py,'#f6e8c8',14);});
   add(x+3,y+4.6,a=>a.desk(x+2,y+4.3,3));
  }else if(room.id==='architect'){
   add(x+5,y+3,a=>{a.desk(x+3,y+2,5,1.5);a.tile(x+3.5,y+2.2,3,1,24,'#83b4cc');for(let k=0;k<3;k++)a.line(project(x+4+k,y+2.3,25),project(x+4+k,y+3,25),'#dff2e9');});
   add(x+11,y+3,a=>{a.block(x+10,y+2,3,2,18,'#c3af8b','#9b8876','#6f7b7c');a.block(x+10.4,y+2.3,.7,.7,14,'#bfd3da','#729bb0','#507b8c',18);});
  }else if(room.id==='radiology'){
   add(x+3,y+2.8,a=>a.scanner(x+3,y+2.8,false));add(x+7,y+2,a=>a.monitor(x+7,y+2,30,true));
  }else{
   for(let k=0;k<2;k++)add(x+3+k*4,y+3,a=>{a.bed(x+3+k*4,y+3,false,room.id==='operating');a.monitor(x+4+k*4,y+2.6,28);});
  }
 }
 return items;
}

export function createRenderer(canvas,map){
 const ctx=canvas.getContext('2d');const bg=background(map);const furniture=furnishings(map);const gurneys={};let last=null;
 function draw(view,positions,now,opts={}){
  const dt=last===null?0:Math.max(0,Math.min(.1,(now-last)/1000));last=now;
  ctx.setTransform(1,0,0,1,0,0);ctx.imageSmoothingEnabled=false;ctx.fillStyle='#83aaa6';ctx.fillRect(0,0,canvas.width,canvas.height);
  const cam=opts.camera??{x:0,y:0,scale:1};ctx.save();ctx.translate(Math.round(cam.x),Math.round(cam.y));ctx.scale(cam.scale,cam.scale);ctx.drawImage(bg,0,0);
  const art=createArt(ctx,now),cases=Object.values(view.cases),draws=furniture.map(f=>({depth:f.depth,fn:()=>f.draw(art)}));
  const at=(id,dx,dy,z=0)=>{const r=map.rooms.find(r=>r.id===id).rect;return project(r.x+dx,r.y+dy,z);};
  const door=id=>map.rooms.find(r=>r.id===id).doors[0];
  const order=Object.keys(view.cases),slots={};
  for(const c of cases){
   const id=c.approval?'direction':c.held==='discharge'?'discharge':c.room,r=map.rooms.find(r=>r.id===id);if(!r)continue;
   const slot=slots[id]??0;slots[id]=slot+1;
   const [dx,dy]=r.doors[0];
   const target=c.held==='discharge'?{x:(dx+.5-slot)*TILE,y:(dy-.5)*TILE}:{x:(r.rect.x+r.rect.w-2-slot)*TILE+8,y:(r.rect.y+r.rect.h-1)*TILE+8};
   const g=gurneys[c.caseId]??(gurneys[c.caseId]=makeGurney(target));retarget(map,g,target);stepGurney(g,72*dt);
   const x=g.x/TILE,y=g.y/TILE;draws.push({depth:x+y,fn:()=>{
    art.bed(x,y,true);const [px,py]=project(x,y,25);const band=wristbandOf(c);
    if(band)drawWristband(ctx,px,py,band.label,caseColourOf(c.caseId,order));
    drawBrakeChock(ctx,px,py,c);drawThreads(ctx,px,py,threadsOf(c,now),now);drawGateLamp(ctx,px,py,c,now);
   }});
  }
  for(const id of Object.keys(gurneys))if(!view.cases[id])delete gurneys[id];
  const agents=Object.values(view.agents);
  for(const a of agents){const p=positions[a.agentId];if(!p)continue;draws.push({depth:p.x+p.y+.6,fn:()=>{
   const role=a.role??'';const suit=role.includes('council')?'#b499d7':role.includes('implement')?'#72bcb0':role.includes('review')?'#8eabd2':'#fff5df';
   art.person({x:p.x+.5,y:p.y+.5,path:p.path??[],phase:now/100,id:hash(a.agentId),role:'doctor',room:a.room==='operating'?'surgery':a.room,color:suit});
   const [px,py]=project(p.x+.5,p.y+.5,0);
   // Role-colour cap retains the reference's large silhouettes.
   ctx.fillStyle=suit;ctx.fillRect(px-9,py-56,18,5);
   if(a.sleeping)art.text('zz',px+15,py-48,'#4a657c',10);
   if(a.tool)drawEquipment(ctx,equipmentOf(opts.freezeTool??a.tool.name),px+15,py-25,now);
   if(a.holdingAt==='direction')drawEnvelope(ctx,px+12,py-16,true,now);
  }});}
  draws.sort((a,b)=>a.depth-b.depth).forEach(d=>d.fn());
  // Room plates and room occupancy are derived from the same live snapshot as the characters.
  for(const room of map.rooms){const {x,y,w,h}=room.rect;const [px,py]=project(x+w/2,y,48);const label=room.name;const width=label.length*6+20;
   art.rounded(px-width/2,py-13,width,21,3,'#34465a','#243449');art.text(label,px,py+1,'#fff1d0',10);
   const count=agents.filter(a=>a.room===room.id&&!a.leaving).length;const [bx,by]=project(x+w-1,y+h-.5,6);
   art.rounded(bx-12,by-10,24,16,2,'#fff0d0','#789a98');art.text(String(count),bx,by+1,'#46665f',10);
  }
  let row=0;
  for(const r of chipRowsOf(view.cases)){
   for(const [id,items,more]of[['waiting',r.waiting,r.waitingMore],['discharge',r.finished,r.finishedMore]]){
    const [x,y]=at(id,2,1.4+row*.65,8);ctx.fillStyle=r.colour;ctx.fillRect(x-5,y,3,8);
    items.forEach((p,i)=>drawChip(ctx,x+i*17,y,p.id,id==='waiting'?'waiting':'done'));if(more)drawMore(ctx,x+items.length*17,y,more);
   }row++;
  }
  const pending=cases.some(c=>c.approval),answered=view.userT&&now-view.userT>=0&&now-view.userT<4000;
  drawKeySwitch(ctx,...at('direction',5,2,25),pending);drawUserChair(ctx,...at('direction',3,1,10),Boolean(answered));
  if(answered)art.text('RESPONDIDO',...at('direction',5,3,30),'#34865f',10);
  if(pending&&!agents.some(a=>a.holdingAt==='direction'))drawEnvelope(ctx,...project(...door('direction'),10),true,now);
  drawBell(ctx,...at('reception',4,2,28),(view.escalations??[]).length>0,now);
  let card=0;for(const c of cases){for(const accepted of [...(c.accepted??[]).map(()=>true),...(c.warnings??[]).filter(w=>w.state==='acceptable').map(()=>false)]){if(card<6)drawSealCard(ctx,...at('casefile',2+card++*.7,5,26),accepted);}}
  if(cases.some(c=>c.held==='discharge'))drawShutter(ctx,...project(...door('discharge'),5),25);
  for(const m of view.messages??[]){const age=now-m.t,a=positions[m.from],b=positions[m.to];if(age<0||age>=1600||!a||!b)continue;const from=project(a.x+.5,a.y+.5,35),to=project(b.x+.5,b.y+.5,35),k=age/1600;art.line(from,to,'#5f8e9270',2);drawCapsule(ctx,from[0]+(to[0]-from[0])*k,from[1]+(to[1]-from[1])*k);}
  for(const a of agents){const p=positions[a.agentId];if(!p||!a.tool||opts.bubbles===false)continue;const label=a.tool.label?`${a.tool.name}: ${a.tool.label}`:a.tool.name;drawBubble(ctx,...project(p.x+.5,p.y+.5,48),label.length>32?label.slice(0,31)+'…':label,a.stalled);}
  ctx.restore();
 }
 return {draw};
}
