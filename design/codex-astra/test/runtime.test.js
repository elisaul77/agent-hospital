import {test} from 'node:test';
import assert from 'node:assert/strict';
import {demoView} from '../js/demo.js';
import {createRenderer} from '../js/render.js';
import {buildMap,ROOMS} from '../js/map.js';
import {gateBlocked} from '../js/anim.js';

test('local fixture keeps held case in its logical room and maintains complete records',()=>{
 const view=demoView(1000);assert.equal(Object.keys(view.agents).length,12);
 for(const a of Object.values(view.agents)){assert.ok(ROOMS.some(r=>r.id===a.room));for(const k of ['agentId','sessionId','caseId','subagentType','role','room','status','tool','reviewer','parentAgentId','description','toolUseId','lastT','sleeping','stalled'])assert.ok(k in a,k)}
 const held=Object.values(view.cases).find(c=>c.held);assert.equal(held.room,'radiology');assert.equal(gateBlocked(held),true);
 assert.equal(gateBlocked({warnings:[{state:'accepted'}]}),false);
});

test('renderer draws all roles and warning gate without mutating view or positions',()=>{
 const text=[],scales=[];let saves=0;const ctx=new Proxy({scale(x,y){scales.push([x,y])},drawImage(){assert.equal(this.imageSmoothingEnabled,false,'smoothing restored after dimension reset')},save(){saves++},restore(){saves--},measureText:s=>({width:s.length*5}),fillText:s=>text.push(s),createRadialGradient:()=>({addColorStop(){}})},{get:(t,k)=>k in t?t[k]:()=>{}});
 const canvas={set width(v){this._width=v;ctx.imageSmoothingEnabled=true},get width(){return this._width},height:1100,getContext:()=>ctx};canvas.width=1600;globalThis.document={createElement:()=>canvas};
 const map=buildMap(),view=demoView(1000),positions={};for(const a of Object.values(view.agents)){const r=ROOMS.find(r=>r.id===a.room);positions[a.agentId]={x:r.seats[0][0],y:r.seats[0][1],path:[],room:a.room}}
 const before=JSON.stringify({view,positions});const renderer=createRenderer(canvas,map);canvas.width=1600;renderer.draw(view,positions,1000,{camera:{x:20,y:40,scale:2}});
 assert.ok(scales.length>1);assert.ok(scales.flat().every(Number.isInteger),"all camera and character scales are integers");assert.equal(saves,0);assert.equal(JSON.stringify({view,positions}),before);assert.ok(!text.some(s=>s.includes('Simulation warning')));
});

test('HUD controls, source reset and animation frame run with a DOM adapter',async()=>{
 const listeners={},elements={},scales=[];const context=new Proxy({scale(x,y){scales.push(x,y)},measureText:s=>({width:s.length*5}),createRadialGradient:()=>({addColorStop(){}})},{get:(t,k)=>k in t?t[k]:()=>{}});
 const element=id=>elements[id]??=( {value:id==='mode'?'local':'',hidden:false,textContent:'',children:[],classList:{toggle:()=>true},setAttribute(){},append(v){this.children.push(v)},replaceChildren(){this.children=[]},getContext:()=>context,addEventListener(k,f){listeners[k]=f},setPointerCapture(){}} );
 globalThis.document={getElementById:element,createElement:()=>element('created'+Math.random())};globalThis.location={search:''};globalThis.innerWidth=1600;globalThis.innerHeight=1100;globalThis.window={addEventListener(k,f){listeners[k]=f}};
 let frame;globalThis.requestAnimationFrame=f=>{frame=f};const interval=globalThis.setInterval;globalThis.setInterval=()=>1;
 try{await import('../js/main.js');assert.match(element('count').textContent,/12 agentes/);frame(performance.now()+16);element('plus').onclick();assert.equal(element('zoom').textContent,'200%');element('reset').onclick();assert.equal(element('zoom').textContent,'100%');element('world').onpointerdown({pointerId:1,clientX:10,clientY:10});element('world').onpointermove({clientX:30,clientY:50});element('world').onpointerup();element('mode').onchange();assert.equal(element('cases').children.length,3);element('details').onclick();globalThis.innerWidth=390;globalThis.innerHeight=844;listeners.resize();frame(performance.now()+32);assert.ok(scales.every(Number.isInteger),'integer zoom at desktop and mobile dimensions');assert.equal(element('zoom').textContent,'100%');}finally{globalThis.setInterval=interval}
});
