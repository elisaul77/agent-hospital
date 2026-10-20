// Drawing vocabulary adapted from the user-provided example/HOSPITAL_V2.html.
// Pure canvas painter: no separate simulation, network or fabricated activity.
import { project } from './projection.js';
export function createArt(ctx, now = 0) {
const elapsed = now / 1000;
const point = project;
function poly(pts,fill,stroke){ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();if(fill){ctx.fillStyle=fill;ctx.fill()}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=1;ctx.stroke()}}
function tile(x,y,w,h,z,color,stroke){poly([point(x,y,z),point(x+w,y,z),point(x+w,y+h,z),point(x,y+h,z)],color,stroke)}
function block(x,y,w,h,height,top,left,right,z=0){const outline='#263d4d88';poly([point(x,y+h,z),point(x+w,y+h,z),point(x+w,y+h,height+z),point(x,y+h,height+z)],left,outline);poly([point(x+w,y,z),point(x+w,y+h,z),point(x+w,y+h,height+z),point(x+w,y,height+z)],right,outline);tile(x,y,w,h,height+z,top,outline)}

function line(a,b,c,width=1){ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.strokeStyle=c;ctx.lineWidth=width;ctx.stroke()}
function text(t,x,y,color='#b8d3dc',size=10,align='center'){ctx.font=`bold ${size}px monospace`;ctx.textAlign=align;ctx.fillStyle=color;ctx.fillText(t,Math.round(x),Math.round(y))}

function rounded(x,y,w,h,r,fill,stroke){ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fillStyle=fill;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.stroke()}}
function shadow(x,y,rx=12,ry=5){ctx.fillStyle='#07131c50';ctx.beginPath();ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2);ctx.fill()}
function plant(x,y){let [px,py]=point(x,y,4);shadow(px,py,9,4);block(x-.17,y-.17,.34,.34,10,'#64797d','#394d53','#263e45',3);line([px,py-12],[px,py-29],'#477d65',2);for(let i=0;i<6;i++){let a=i*2.4;ctx.fillStyle=i%2?'#4a8e72':'#326c58';ctx.beginPath();ctx.ellipse(px+Math.cos(a)*5,py-22+Math.sin(a)*5,3,8,a,0,7);ctx.fill()}}
function monitor(x,y,z=29,large=false){const [px,py]=point(x,y,z),w=large?32:19,h=large?23:15;rounded(px-w/2,py-h,w,h,2,'#1c303f','#5e7d8b');rounded(px-w/2+2,py-h+2,w-4,h-4,1,'#082734');ctx.beginPath();for(let i=0;i<7;i++){let xx=px-w/2+4+i*(w-8)/6,yy=py-h/2+(i===3?-4:i===4?4:Math.sin(i+elapsed*3)*1.5);i?ctx.lineTo(xx,yy):ctx.moveTo(xx,yy)}ctx.strokeStyle='#64e5cb';ctx.lineWidth=1;ctx.stroke();line([px,py],[px,py+4],'#8298a0',2)}
function bed(x,y,occupied=false,surgery=false){let w=surgery?.9:.8,h=1.7;block(x-.4,y-.8,w,h,9,'#718d9c','#3f5b71','#2c4558',5);tile(x-.34,y-.74,w-.12,h-.13,17,surgery?'#84c9c0':'#c4d6d6','#7eaaa9');tile(x-.29,y-.68,w-.22,.35,19,'#e6eeee');tile(x-.32,y-.12,w-.15,.85,19,surgery?'#439d91':'#6194af');for(const dx of [0,w-.1]){let [px,py]=point(x-.4+dx,y+.8,4);ctx.fillStyle='#102738';ctx.fillRect(px-2,py-2,4,4)}if(occupied){let [px,py]=point(x,y-.37,22);ctx.fillStyle='#dfb592';ctx.beginPath();ctx.ellipse(px,py,5,4,-.3,0,7);ctx.fill();tile(x-.26,y-.05,.52,.7,23,surgery?'#4aa597':'#76a9bc')}if(surgery){let [px,py]=point(x-.6,y-.4,68);line(point(x-.7,y-1,4),[px,py],'#719da3',2);ctx.fillStyle='#aec9c4';ctx.beginPath();ctx.ellipse(px+10,py+3,15,7,-.4,0,7);ctx.fill();ctx.fillStyle='#e3f6dc';ctx.beginPath();ctx.ellipse(px+10,py+6,12,4,-.4,0,7);ctx.fill()}}
function desk(x,y,w=1.5,h=.7){block(x,y,w,h,22,'#b2aa8f','#787e7f','#4a606c',3);monitor(x+w*.6,y+.25,28)}
function chair(x,y,color='#457f87'){block(x,y,.4,.42,10,color,'#345467','#263e52',2);block(x,y,.4,.09,19,color,'#4d7785','#2e5365',2)}
function person(p){let [px,py]=point(p.x,p.y,7);px=Math.round(px);py=Math.round(py);const moving=p.path.length>0,step=moving?Math.round(Math.sin(p.phase)*2):0,flip=p.path.length&&p.path[0][0]<p.x?-1:1;shadow(px,py+1,10,4);ctx.save();ctx.translate(px,py);ctx.scale(flip,1);const r=(x,y,w,h,c)=>{ctx.fillStyle=c;ctx.fillRect(x,y,w,h)},id=p.id||1,skin=['#edba93','#c88f6a','#9e6852','#f5cca8'][id%4],hair=['#53443e','#322d35','#b07843','#764a39','#e2ba6d'][id%5],suit=p.color??(p.role==='doctor'?'#fff9e9':p.role==='nurse'?'#ad90d7':'#73a8b7');
// Dark one-pixel silhouettes, oversized heads and three-frame walking cycles.
r(-9,-10,8,9+step,'#253447');r(2,-10,8,9-step,'#253447');r(-10,-3+step,9,4,'#17283a');r(2,-3-step,11,4,'#17283a');r(-10,-28,21,20,'#293b4e');r(-8,-27,17,18,suit);r(-8,-12,17,3,p.role==='doctor'?'#a5c2c9':'#6f758c');r(-13,-25,5,16,'#2f3c4a');r(-12,-24,4,11,suit);r(-12,-13,4,5,skin);r(9,-25,5,16,'#2f3c4a');r(10,-24,3,10,suit);r(10,-14,4,5,skin);if(p.role==='doctor'){r(-2,-27,5,17,'#64b8b0');r(3,-20,4,5,'#b7d3da');r(-5,-23,2,6,'#3d5564');r(-5,-18,5,2,'#3d5564')}else if(p.role==='nurse'){r(-2,-22,5,2,'#f7e9ec');r(-1,-24,2,6,'#f7e9ec')}else if(p.role==='porter'){r(-4,-20,9,5,'#c2dee2')}else{r(-6,-25,11,3,'#ffffff42');r(1,-22,3,12,'#ffffff22')}
r(-10,-47,19,20,'#2e3544');r(-9,-46,18,17,skin);r(9,-39,3,5,skin);r(-10,-47,19,6,hair);r(-10,-41,4,8,hair);r(-7,-45,11,3,hair);r(4,-39,2,3,'#2d303b');r(6,-33,3,1,'#9d6759');r(-2,-29,7,3,skin);if(id%5===1){r(-10,-41,3,17,hair);r(-12,-35,3,10,hair)}if(p.role==='doctor'&&p.room==='surgery'){r(-10,-48,20,6,'#60afa5');r(0,-35,11,6,'#9cddd3')}if(p.role==='nurse'){r(-8,-48,15,5,'#f4eeed');r(-1,-49,3,7,'#db7783');r(-3,-47,7,3,'#db7783')}if(p.recovered)text('♥',0,-55,'#f8b4c1',14);else if(p.severity===3)text('!',0,-55,'#d76065',16);ctx.restore()}

function scanner(x,y,occupied){block(x-.8,y-.7,1.6,1.7,14,'#8aabbb','#57788e','#3b5a72',4);let [px,py]=point(x,y-.25,41);ctx.lineWidth=11;ctx.strokeStyle='#adc6d2';ctx.beginPath();ctx.ellipse(px,py,21,26,-.45,0,Math.PI*2);ctx.stroke();ctx.lineWidth=4;ctx.strokeStyle='#76b8ca';ctx.stroke();bed(x+.2,y+.55,occupied);let [mx,my]=point(x-1,y+.2,15);ctx.fillStyle='#60ddca';ctx.fillRect(mx,my-16,3,3)}

return { point, poly, tile, block, line, text, rounded, shadow, plant, monitor, bed, desk, chair, person, scanner };
}
