// Draws the hospital. The static layout is cached once per map; each frame draws the discharge shutter,
// gurneys with their warning threads, agents with their equipment, and bubbles.
import { TILE, W, H, T, idx, ROOMS, SPECIALTY_DESKS } from './map.js';
import {
  drawAgent, drawGurney, drawBubble, drawCapsule, drawEnvelope, drawKeySwitch, drawBell, drawSealCard, drawUserChair,
  drawWristband, drawChip, drawMore,
} from './sprites.js';
import {
  equipmentOf, drawEquipment, drawGateLamp, drawBrakeChock, drawThreads, threadsOf, drawShutter,
} from './anim.js';
import { scenery } from './scenery.js';
import { wristbandOf, chipRowsOf, caseColourOf } from './patients.js';
import { makeGurney, retarget, stepGurney } from './gurney.js';

const WALL = '#0d1419';
const CORRIDOR = '#22313b';
const TUBE = '#2f5560';
const DOOR = '#c9a24a';
const LAMP = 'rgba(242,180,74,0.10)';
const GLASS = 'rgba(111,184,201,0.55)';
const CAPSULE_MS = 1600; // flight time of a SendMessage capsule along the tube
const STAMP_MS = 4000; // the user's answer: chair fills and the stamp shows for this long
const CHIP_ROW_H = 9; // Phase 5a: one row per case, rows stacked 9 px apart
const CHIP_STEP = 15; // chip width 14 px + 1 px gap

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
  // Phase 4b: a brass plaque on each specialty desk. The labels are fixed constants from map.js.
  const pool = map.rooms.find((r) => r.id === 'specialists').rect;
  for (const d of SPECIALTY_DESKS) {
    const dx = pool.x * TILE + d.desk[0];
    const dy = pool.y * TILE + d.desk[1];
    g.fillStyle = '#c9a24a';
    g.fillRect(dx + 7, dy + 13, 29, 6);
    g.font = '6px monospace';
    g.fillStyle = '#2a1f08';
    g.fillText(d.label, dx + 8, dy + 18);
  }
  // Glass wall between the Direction mezzanine and Reception (row above Reception, door left open).
  const dm = map.rooms.find((r) => r.id === 'direction');
  const [dx, dy] = dm.doors[0];
  for (let x = dm.rect.x; x < dm.rect.x + dm.rect.w; x++) {
    if (x === dx) continue;
    g.fillStyle = GLASS;
    g.fillRect(x * TILE, dy * TILE, TILE, TILE);
    g.fillStyle = '#c9e4ea';
    g.fillRect(x * TILE + 7, dy * TILE, 2, TILE);
  }
  // Ceiling tubes: Direction <-> Reception through the door, and Direction -> Case File along the top wall.
  g.fillStyle = TUBE;
  g.fillRect(dx * TILE, dy * TILE + 3, (24 - dx) * TILE, 2);
  g.fillStyle = '#4f7f8a';
  g.fillRect(dx * TILE, dy * TILE + 2, (24 - dx) * TILE, 1);
  return c;
}

function lighten(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.min(255, Math.round(v + (255 - v) * amount));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** Anchor of a tile (tx, ty) in canvas units (tile centre). */
const centreOf = (tx, ty) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });

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
  const gurneys = {}; // caseId -> gurney (px position, A* route along the corridors)
  const dischargeDoor = ROOMS.find((r) => r.id === 'discharge').doors[0];
  const dirRoom = map.rooms.find((r) => r.id === 'direction');
  const dirDoor = dirRoom.doors[0];
  const recRoom = map.rooms.find((r) => r.id === 'reception');
  const casRoom = map.rooms.find((r) => r.id === 'casefile');
  // Fixed furnishing anchors (same coordinates as scenery.js, room-relative).
  const at = (room, dx, dy) => ({ x: room.rect.x * TILE + dx, y: room.rect.y * TILE + dy });
  const KEY = at(dirRoom, 116, 28);
  const CHAIR = at(dirRoom, 72, 6);
  const STAMP = at(dirRoom, 54, 26);
  const BELL = at(recRoom, 97, 38);
  const CARDS = at(casRoom, 10, 76);
  // Phase 5a patient rows: waiting rows at the top of Reception (under the glass), finished rows at the top of Alta.
  const WAIT = at(recRoom, 24, 4);
  const DONE = at(map.rooms.find((r) => r.id === 'discharge'), 6, 4);

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
    // A case waiting for Direction rolls into the mezzanine.
    // Phase 5a: a gurney rolls along the A* route of the corridors; it never crosses a wall.
    const order = Object.keys(view.cases);
    const byRoom = {};
    let heldCount = 0;
    for (const c of cases) {
      let target;
      if (c.held === 'discharge') target = heldAnchor(map, heldCount++);
      else {
        const where = c.approval ? 'direction' : c.room;
        const slot = byRoom[where] ?? 0;
        byRoom[where] = slot + 1;
        target = gurneyAnchor(map, where, slot);
      }
      if (!target) continue;
      const g = gurneys[c.caseId] ?? (gurneys[c.caseId] = makeGurney(target));
      const before = g.goal;
      retarget(map, g, target);
      if (g.blocked && g.goal !== before) console.error(`[hospital] no corridor route for the gurney of ${c.caseId}`);
      stepGurney(g);
      const cx = Math.round(g.x);
      const fy = Math.round(g.y);
      drawGurney(ctx, cx, fy, c);
      const band = wristbandOf(c); // only when the case has plan phases (no phases = a plain gurney)
      if (band) drawWristband(ctx, cx, fy, band.label, caseColourOf(c.caseId, order));
      const top = fy - Math.min(6, c.phasesDone + 1);
      drawBrakeChock(ctx, cx, fy, c);
      drawThreads(ctx, cx, top, threadsOf(c, now), now);
      drawGateLamp(ctx, cx, top, c, now);
    }
    for (const id of Object.keys(gurneys)) if (!view.cases[id]) delete gurneys[id];

    // Phase 5a patients: one row per case in Reception (waiting) and in Alta (finished), tagged with the case colour.
    // Caps per row: 6 waiting, 4 finished; the rest is "+N".
    let waitRows = 0;
    let doneRows = 0;
    for (const r of chipRowsOf(view.cases)) {
      if (r.waiting.length) drawChipRow(ctx, WAIT.x, WAIT.y + waitRows++ * CHIP_ROW_H, r.colour, r.waiting, r.waitingMore, 'waiting');
      if (r.finished.length) drawChipRow(ctx, DONE.x, DONE.y + doneRows++ * CHIP_ROW_H, r.colour, r.finished, r.finishedMore, 'done');
    }

    // Direction: key switch glows while a case waits; the envelope sits at the door; the user's chair and
    // stamp appear for a few seconds after the user answers.
    const pending = cases.some((c) => c.approval);
    const answered = view.userT && now - view.userT >= 0 && now - view.userT < STAMP_MS;
    // The delegate(s) that asked hold the envelope in hand (drawn after the agents). With no delegate
    // (a case-file gate has no agent) the envelope waits on the door shelf.
    const holders = pending ? Object.values(view.agents).filter((a) => a.holdingAt === 'direction' && positions[a.agentId]) : [];
    drawKeySwitch(ctx, KEY.x, KEY.y, pending);
    if (pending && !holders.length) drawEnvelope(ctx, dirDoor[0] * TILE - 2, (dirDoor[1] - 1) * TILE + 4, true, now);
    drawUserChair(ctx, CHAIR.x, CHAIR.y, Boolean(answered));
    if (answered) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      px(ctx, STAMP.x, STAMP.y, 10, 6, '#2e8b57');
      px(ctx, STAMP.x + 2, STAMP.y + 2, 6, 2, '#1d5c39');
      ctx.restore();
    }

    // Reception desk bell swings while any escalation waits for the user.
    drawBell(ctx, BELL.x, BELL.y, (view.escalations ?? []).length > 0, now);

    // Case file: one card per accepted risk (filled seal) and one empty seal ring per waiting acceptable item.
    let slot = 0;
    for (const c of cases) {
      for (const _a of c.accepted ?? []) {
        if (slot < 6) drawSealCard(ctx, CARDS.x + slot * 14, CARDS.y, true);
        slot++;
      }
      for (const w of c.warnings) {
        if (w.state !== 'acceptable') continue;
        if (slot < 6) drawSealCard(ctx, CARDS.x + slot * 14, CARDS.y, false);
        slot++;
      }
    }

    // Capsules: one flight per SendMessage, along the straight tube between the two agents.
    for (const m of view.messages ?? []) {
      const age = now - m.t;
      const a = positions[m.from];
      const b = positions[m.to];
      if (age < 0 || age >= CAPSULE_MS || !a || !b) continue;
      const k = age / CAPSULE_MS;
      const from = centreOf(a.x, a.y);
      const to = centreOf(b.x, b.y);
      drawCapsule(ctx, from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k - 6);
    }

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
    for (const h of holders) {
      const p = positions[h.agentId];
      drawEnvelope(ctx, p.x * TILE + 12, p.y * TILE, true, now); // in hand, at the holder's shoulder
    }
    for (const a of list) {
      const p = positions[a.agentId];
      if (!p || !a.tool || opts.bubbles === false) continue; // live bubbles by default (Phase 2 behavior)
      const cx = Math.round(p.x * TILE + TILE / 2);
      const fy = Math.round(p.y * TILE + TILE / 2 + 4);
      const label = a.tool.label ? `${a.tool.name}: ${a.tool.label}` : a.tool.name;
      drawBubble(ctx, cx, fy, truncate(label, 26), a.stalled);
    }
    ctx.restore();
  }

  return { draw };
}

function px(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

// One case's chips in a row: a colour tag, the chips (plan phase ids), then "+N" when capped.
function drawChipRow(ctx, x, y, colour, items, more, kind) {
  px(ctx, x, y, 3, 7, colour);
  items.forEach((p, i) => drawChip(ctx, x + 5 + i * CHIP_STEP, y, p.id, kind));
  if (more) drawMore(ctx, x + 5 + items.length * CHIP_STEP, y, more);
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
