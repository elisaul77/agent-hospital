import { scenery } from './scenery.js';
// Draws the hospital. The static layout is cached once per map; each frame draws the discharge shutter,
// gurneys with their warning threads, agents with their equipment, and bubbles.
import { TILE, W, H, T, idx, ROOMS } from './map.js';
import { drawAgent, drawGurney, drawBubble } from './sprites.js';
import {
  equipmentOf, drawEquipment, drawGateLamp, drawBrakeChock, drawThreads, threadsOf, drawShutter,
} from './anim.js';

const WALL = '#0d1419';
const CORRIDOR = '#22313b';
const TUBE = '#2f5560';
const DOOR = '#c9a24a';
const LAMP = 'rgba(242,180,74,0.10)';

function buildBackground(map) {
  const c = document.createElement('canvas');
  c.width = W * TILE;
  c.height = H * TILE;
  const g = c.getContext('2d');
  g.fillStyle = WALL;
  g.fillRect(0, 0, c.width, c.height);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = map.tiles[idx(x, y)];
      const ri = map.roomAt[idx(x, y)];
      let color = null;
      if (t === T.CORRIDOR) color = CORRIDOR;
      else if (t === T.DOOR) color = DOOR;
      else if (t === T.FLOOR && ri >= 0) {
        const base = map.rooms[ri].floor;
        color = (x + y) % 2 ? lighten(base, 0.05) : base; // checker floor
      }
      if (color) { g.fillStyle = color; g.fillRect(x * TILE, y * TILE, TILE, TILE); }
    }
  }
  // Pneumatic tube backbone along each corridor centre line.
  for (const cr of map.corridors) {
    g.fillStyle = TUBE;
    g.fillRect(cr.x * TILE, (cr.y + Math.floor(cr.h / 2)) * TILE + 7, cr.w * TILE, 2);
  }
  // Room identity: accent stripe, light pool, label.
  for (const room of map.rooms) {
    const r = room.rect;
    g.fillStyle = room.accent;
    g.fillRect(r.x * TILE, r.y * TILE, r.w * TILE, 2);
    g.save();
    g.beginPath();
    g.rect(r.x * TILE, r.y * TILE, r.w * TILE, r.h * TILE);
    g.clip();
    const cx = (r.x + r.w / 2) * TILE, cy = (r.y + r.h / 2) * TILE;
    const grad = g.createRadialGradient(cx, cy, 4, cx, cy, Math.max(r.w, r.h) * TILE * 0.7);
    grad.addColorStop(0, LAMP);
    grad.addColorStop(1, 'rgba(242,180,74,0)');
    g.fillStyle = grad;
    g.fillRect(r.x * TILE, r.y * TILE, r.w * TILE, r.h * TILE);
    g.restore();
    g.font = '8px monospace';
    g.fillStyle = 'rgba(220,235,230,0.85)';
    // Labels are brass plaques in scenery().
  }
  scenery(g, map);
  return c;
}

function lighten(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.min(255, Math.round(v + (255 - v) * amount));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** Slot for a case gurney inside its room: bottom-right corner, shifted per case already in the room. */
function gurneyAnchor(map, roomId, slot) {
  const room = map.rooms.find((r) => r.id === roomId);
  if (!room) return null;
  const r = room.rect;
  return {
    x: (r.x + r.w - 2) * TILE + 8 - slot * 18,
    y: (r.y + r.h - 1) * TILE + 4,
  };
}

/** Held at the Discharge door: the corridor tile in front of the door, one slot per held case. */
function heldAnchor(map, slot) {
  const room = map.rooms.find((r) => r.id === 'discharge');
  const [dx, dy] = room.doors[0];
  return { x: dx * TILE + 8 - slot * 18, y: (dy - 1) * TILE + 12 };
}

export function createRenderer(canvas, map) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const bg = buildBackground(map);
  const gurneys = {}; // caseId -> {x,y} displayed position, tweened toward the anchor
  const TWEEN = 0.08;
  const dischargeDoor = ROOMS.find((r) => r.id === 'discharge').doors[0];

  function draw(view, positions, now, opts = {}) {
    // Assigning canvas dimensions resets context state, including smoothing.
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#101e34'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Night courtyard: restrained paving, rain glints and foundation shadow.
    for (let x=0;x<canvas.width;x+=48) for(let y=0;y<canvas.height;y+=48) {
      ctx.fillStyle=(x+y)%96?'#142238':'#132136';ctx.fillRect(x,y,47,47);
    }
    const camera = opts.camera ?? {x:0,y:0,scale:1};
    ctx.save(); ctx.translate(Math.round(camera.x), Math.round(camera.y)); ctx.scale(camera.scale,camera.scale);
    ctx.fillStyle='#091221';ctx.fillRect(-9,8,W*TILE+24,H*TILE+18);
    ctx.fillStyle='#3e5966';ctx.fillRect(-6,-8,W*TILE+12,H*TILE+13);
    ctx.drawImage(bg, 0, 0);

    // Shutter over the Discharge door while any case is held there.
    const cases = Object.values(view.cases);
    if (cases.some((c) => c.held === 'discharge')) {
      drawShutter(ctx, dischargeDoor[0] * TILE, dischargeDoor[1] * TILE, TILE);
    }

    // Gurneys: slot = index among cases in the same place (room, or the door when held).
    const byRoom = {};
    let heldCount = 0;
    for (const c of cases) {
      let target;
      if (c.held === 'discharge') target = heldAnchor(map, heldCount++);
      else {
        const slot = byRoom[c.room] ?? 0;
        byRoom[c.room] = slot + 1;
        target = gurneyAnchor(map, c.room, slot);
      }
      if (!target) continue;
      const cur = gurneys[c.caseId] ?? { ...target };
      cur.x += (target.x - cur.x) * TWEEN;
      cur.y += (target.y - cur.y) * TWEEN;
      gurneys[c.caseId] = cur;
      const cx = Math.round(cur.x);
      const fy = Math.round(cur.y);
      drawGurney(ctx, cx, fy, c);
      const top = fy - Math.min(6, c.phasesDone + 1);
      drawBrakeChock(ctx, cx, fy, c);
      drawThreads(ctx, cx, top, threadsOf(c, now), now);
      drawGateLamp(ctx, cx, top, c, now);
    }
    for (const id of Object.keys(gurneys)) if (!view.cases[id]) delete gurneys[id];

    // Agents, then equipment, then bubbles on top.
    const list = Object.values(view.agents).sort((a,b) => (positions[a.agentId]?.y ?? 0)-(positions[b.agentId]?.y ?? 0));
    for (const a of list) {
      const p = positions[a.agentId];
      if (!p) continue;
      const cx = Math.round(p.x * TILE + TILE / 2);
      const fy = Math.round(p.y * TILE + TILE / 2 + 4);
      drawAgent(ctx, cx, fy, {...a, walking: p.path?.length > 0}, now);
      if (a.sleeping) {
        ctx.font = '8px monospace';
        ctx.fillStyle = '#cfe3ff';
        ctx.fillText('zz', cx + 4, fy - 14);
      }
      if (a.tool) {
        const kind = equipmentOf(opts.freezeTool ?? a.tool.name);
        drawEquipment(ctx, kind, cx + 5, fy - 13, now);
      }
    }
    for (const a of list) {
      const p = positions[a.agentId];
      if (!p || !a.tool || !opts.bubbles) continue;
      const cx = Math.round(p.x * TILE + TILE / 2);
      const fy = Math.round(p.y * TILE + TILE / 2 + 4);
      const label = a.tool.label ? `${a.tool.name}: ${a.tool.label}` : a.tool.name;
      drawBubble(ctx, cx, fy, truncate(label, 26), a.stalled);
    }
    ctx.restore();
  }

  return { draw };
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
