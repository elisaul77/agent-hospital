// Original procedural furnishings. Coordinates remain in the existing tile space.
export function scenery(g,map){
 const box=(x,y,w,h,c)=>{g.fillStyle=c;g.fillRect(x,y,w,h)};
 const desk=(x,y,w=34)=>{box(x+2,y+5,w,17,'#12212a');box(x,y,w,13,'#98674b');box(x,y,w,2,'#d3a479');box(x+3,y+13,3,5,'#523d35');box(x+w-6,y+13,3,5,'#523d35');box(x+5,y-7,14,10,'#172b38');box(x+6,y-6,12,7,'#7dc7cf');box(x+8,y-4,7,1,'#d4f1df');box(x+22,y+3,8,5,'#eee1bc');box(x+24,y+4,4,1,'#8e927e')};
 const plant=(x,y)=>{box(x-4,y-4,9,8,'#af7960');box(x-5,y-5,11,2,'#dfab77');box(x,y-17,2,13,'#5e9678');box(x-7,y-15,7,6,'#447e69');box(x+2,y-20,6,9,'#71a579');box(x-3,y-23,5,9,'#97b77d')};
 const bed=(x,y)=>{box(x+3,y+3,22,36,'#142831');box(x,y,22,31,'#739b9d');box(x+2,y+2,18,27,'#b8d2c5');box(x+3,y+3,16,7,'#ecedce');box(x+3,y+13,16,14,'#639f9e');box(x-2,y-2,26,3,'#d0d8ba');box(x,y+31,3,4,'#a8b5b0');box(x+19,y+31,3,4,'#a8b5b0')};
 const shelf=(x,y,w)=>{box(x,y,w,22,'#364149');box(x,y,w,2,'#83928c');for(let k=3;k<w-5;k+=9){box(x+k,y+4,7,15,'#6d7b77');box(x+k+2,y+8,3,2,'#d4c9a5');box(x+k+5,y+13,1,3,'#283943')}};
 for(const room of map.rooms){const{x,y,w,h}=room.rect;const X=x*16,Y=y*16,W=w*16,H=h*16;
  // Raised back wall with crown, plaster face and low side returns.
  box(X-4,Y-8,W+8,22,'#334a55');box(X-4,Y-8,W+8,3,'#80958c');box(X,Y+9,W,4,'#182e39');box(X-4,Y+10,4,H-10,'#536b6b');box(X+W,Y+10,4,H-10,'#213943');
  box(X+5,Y-2,W-10,1,'#4d6670');
  // Clock, framed notice, wall lights.
  box(X+W-18,Y-4,11,11,'#122633');box(X+W-16,Y-2,7,7,'#e6dfba');box(X+W-13,Y-1,1,4,'#344950');box(X+W-13,Y+2,3,1,'#344950');
  box(X+7,Y-4,18,11,'#b9b8a1');box(X+9,Y-2,14,7,'#d6ddc4');box(X+11,Y,7,1,'#6d928d');
  plant(X+W-12,Y+H-16);
  if(room.id==='reception'){desk(X+24,Y+39,84);box(X+25,Y+51,82,17,'#654b40');box(X+27,Y+53,78,2,'#bc8658');for(let k=0;k<3;k++){box(X+8+k*25,Y+91,19,13,'#507b74');box(X+8+k*25,Y+88,19,5,'#78a49a')}box(X+94,Y+34,7,5,'#dcb768');box(X+96,Y+31,3,4,'#f7d27f')}
  else if(room.id==='triage'){bed(X+12,Y+28);shelf(X+66,Y+19,40);box(X+54,Y+29,2,42,'#91afab');box(X+49,Y+29,14,4,'#c9d7bd');desk(X+63,Y+82,43)}
  else if(room.id==='casefile'){shelf(X+8,Y+22,W-20);shelf(X+8,Y+50,W-20);desk(X+18,Y+88,55)}
  else if(room.id==='architect'){desk(X+45,Y+48,74);box(X+50,Y+49,50,10,'#6796aa');for(let k=0;k<5;k++)box(X+54+k*9,Y+50,1,8,'#b3d4d2');shelf(X+W-71,Y+22,54);box(X+164,Y+67,50,29,'#73594b');box(X+166,Y+69,46,23,'#c5c9ac');box(X+173,Y+73,26,1,'#638b89');box(X+173,Y+74,1,12,'#638b89')}
  else if(room.id==='diagnosis'){desk(X+10,Y+34,48);desk(X+92,Y+34,48);bed(X+62,Y+64)}
  else if(room.id==='specialists'){for(let k=0;k<5;k++)desk(X+9+k*58,Y+33,43);for(let k=0;k<4;k++)desk(X+16+k*65,Y+79,43)}
  else if(room.id==='council'){box(X+43,Y+36,137,48,'#201d29');box(X+39,Y+30,137,44,'#754238');box(X+42,Y+31,131,3,'#c18568');box(X+44,Y+35,127,35,'#945b46');for(let k=0;k<4;k++){box(X+53+k*29,Y+45,14,10,'#e1cfaa');box(X+56+k*29,Y+48,8,1,'#9a9e90');box(X+59+k*29,Y+60,4,4,'#f0c690')}for(let k=0;k<4;k++){box(X+49+k*32,Y+20,20,8,'#46556a');box(X+49+k*32,Y+77,20,8,'#46556a')}}
  else if(room.id==='operating'){bed(X+65,Y+26);bed(X+129,Y+26);desk(X+5,Y+25,39);box(X+180,Y+21,23,33,'#3b6971');box(X+183,Y+25,17,13,'#8ed0c6');box(X+186,Y+30,11,2,'#d9e5b5')}
  else if(room.id==='radiology'){for(let k=0;k<3;k++){box(X+12+k*43,Y+17,32,24,'#172d3a');box(X+15+k*43,Y+19,26,19,'#94c5c4');box(X+26+k*43,Y+22,3,13,'#d7e6d5');for(let j=0;j<4;j++)box(X+20+k*43,Y+24+j*3,15,1,'#638b9d')}desk(X+45,Y+55,46)}
  else if(room.id==='discharge'){desk(X+12,Y+34,65);box(X+88,Y+18,29,32,'#3e6b67');box(X+92,Y+23,21,6,'#b8d8af');box(X+98,Y+26,9,1,'#527263')}
  else if(room.id==='direction'){box(X+22,Y+22,116,15,'#2b2a3f');box(X+24,Y+24,112,11,'#5b3d30');box(X+24,Y+24,112,2,'#c99a6a');box(X+30,Y+37,3,6,'#3b2a22');box(X+131,Y+37,3,6,'#3b2a22');box(X+40,Y+30,6,6,'#8a8f98');box(X+41,Y+31,4,4,'#4c4a52');box(X+116,Y+28,12,8,'#c9a24a');box(X+118,Y+30,8,4,'#7a5a1f');box(X+6,Y+8,10,4,'#3b2a22');box(X+144,Y+8,10,4,'#3b2a22')}
  else {shelf(X+12,Y+20,62);box(X+95,Y+25,31,21,'#564853');box(X+98,Y+28,25,14,'#a08375');box(X+105,Y+32,10,2,'#d9b587')}
  // Brass floor plaque, below all work surfaces.
  g.font='8px monospace';box(X+5,Y+H-9,Math.min(W-10,g.measureText(room.name).width+8),11,'#152b36');g.fillStyle='#d0d8c6';g.fillText(room.name,X+9,Y+H-1);
 }
 // Corridor safety stripes and pneumatic conduit.
 for(const c of map.corridors){box(16,c.y*16+12,736,2,'#738e8c');box(16,c.y*16+15,736,2,'#1a303d');for(let x=32;x<750;x+=64){box(x,c.y*16+11,4,6,'#a8b7a6');box(x+22,c.y*16+26,15,1,'#647b78')}}
}
