// Tool equipment and warning threads. The equipment table and the warning rules are pure (imported by
// node:test); the drawing functions only draw pixels. Nothing here draws text or Bash commands: tool
// labels stay in render.js, and warning texts never reach the canvas.

export const FIXED_DROP_MS = 1500;
const BLOCKING = new Set(['open', 'unruled', 'acceptable', 'must_fix']);

const px = (ctx, x, y, w, h, color) => {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
};

/** Tool name -> equipment kind (plan table, Phase 3). Unknown tools get the generic working kind. */
export function equipmentOf(tool) {
  if (tool === 'Read' || tool === 'NotebookRead') return 'lightbox';
  if (tool === 'Grep' || tool === 'Glob') return 'microscope';
  if (tool === 'Bash') return 'sparks';
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') return 'scalpel';
  if (tool === 'WebSearch' || tool === 'WebFetch') return 'dish';
  if (tool === 'Task' || tool === 'Agent') return 'pager';
  if (tool === 'SendMessage') return 'capsule';
  if (typeof tool === 'string' && tool.startsWith('mcp__')) return 'console';
  return 'working';
}

/** Warnings that keep a case out of Discharge (same rule as the reducer). */
export function gateBlocked(c) {
  return (c?.warnings ?? []).some((w) => BLOCKING.has(w.state));
}

/** Threads to draw: every blocking warning, plus fixed ones still dropping (cut recently). */
export function threadsOf(c, now) {
  return (c?.warnings ?? []).filter((w) => {
    if (BLOCKING.has(w.state)) return true;
    return w.state === 'fixed' && w.ruledT != null && now - w.ruledT >= 0 && now - w.ruledT < FIXED_DROP_MS;
  });
}

/** One short line for the HUD (counts and gate state only, no warning text). Empty when there are none. */
export function warningSummary(c) {
  const ws = c?.warnings ?? [];
  const count = (state) => ws.filter((w) => w.state === state).length;
  const parts = [];
  if (count('open')) parts.push(`${count('open')} abierto(s)`);
  if (count('unruled')) parts.push(`${count('unruled')} sin dictamen`);
  if (count('must_fix')) parts.push(`${count('must_fix')} a corregir`);
  if (count('acceptable')) parts.push(`${count('acceptable')} a la espera del usuario`);
  if (count('fixed')) parts.push(`${count('fixed')} resuelto(s)`);
  if (c?.held) parts.push('retenido en Alta');
  return parts.join(' · ');
}

// Render-only fixtures for ?freezeWarn=<name> (screenshots). Never sent anywhere: a fixed view that
// shows one case in one warning state, so a frame is reproducible whatever the live stream holds.
const FROZEN_CASE = { caseId: 'frozen', room: 'radiology', tier: 'M', caseKind: 'feature', status: 'active', phasesDone: 1, pendingClose: null };
const FROZEN = new Map([
  ['fixed', { warnings: (now) => [{ id: 'f1', text: '', state: 'fixed', ruledT: now - 700 }], held: null }],
  ['must_fix', { warnings: () => [{ id: 'm1', text: '', state: 'must_fix', ruledT: null }], held: null }],
  ['acceptable', { warnings: () => [{ id: 'a1', text: '', state: 'acceptable', ruledT: null }], held: null }],
  ['held', { warnings: () => [
    { id: 'h1', text: '', state: 'open', ruledT: null },
    { id: 'h2', text: '', state: 'unruled', ruledT: null },
  ], held: 'discharge' }],
]);

/** @returns {object|null} a one-case view for ?freezeWarn=<name>, or null for an unknown name */
export function frozenWarnView(name, now) {
  const f = FROZEN.get(name);
  if (!f) return null;
  const c = { ...FROZEN_CASE, warnings: f.warnings(now), held: f.held };
  return { t: now, now, agents: {}, cases: { frozen: c }, messages: [] };
}

// ---- equipment: ~10x10 px, drawn with its top-left at (x, y) ----

export function drawEquipment(ctx, kind, x, y, now) {
  const f = Math.floor(now / 150);
  const blink = f % 2 === 0;
  switch (kind) {
    case 'lightbox': { // film panel that brightens and dims
      const b = 0.55 + 0.45 * Math.sin(now / 300);
      px(ctx, x, y, 8, 6, '#2b2f36');
      px(ctx, x + 1, y + 1, 6, 4, `rgba(245,240,170,${b.toFixed(2)})`);
      px(ctx, x + 3, y + 6, 2, 3, '#2b2f36');
      break;
    }
    case 'microscope': { // tube with a scanning light
      px(ctx, x + 1, y, 3, 3, '#c0c8d0');
      px(ctx, x + 2, y + 3, 1, 4, '#8c93a0');
      px(ctx, x, y + 7, 6, 1, '#8c93a0');
      px(ctx, x + 2 + (f % 3), y + 1, 1, 1, blink ? '#9bd7ff' : '#3b5f7a');
      break;
    }
    case 'sparks': { // defib paddles with sparks between them
      px(ctx, x, y + 2, 3, 4, '#d9d9d9');
      px(ctx, x + 7, y + 2, 3, 4, '#d9d9d9');
      for (let k = 0; k < 3; k++) {
        const sy = y + ((f + k * 2) % 6);
        px(ctx, x + 3 + ((f + k) % 3), sy, 1, 1, k === 1 ? '#fff3a0' : '#ffe066');
      }
      break;
    }
    case 'scalpel': { // blade and a stitch that moves along the cut
      px(ctx, x, y + 6, 3, 1, '#5a6470');
      px(ctx, x + 3, y + 4, 5, 1, '#e6eef5');
      px(ctx, x + 4, y + 3, 4, 1, '#e6eef5');
      for (let k = 0; k < 3; k++) px(ctx, x + ((f + k * 3) % 9), y + 8, 1, 1, '#ff8fb1');
      break;
    }
    case 'dish': { // satellite dish with a blinking signal
      px(ctx, x + 2, y + 2, 4, 1, '#c0c8d0');
      px(ctx, x + 1, y + 3, 6, 1, '#c0c8d0');
      px(ctx, x + 4, y + 4, 1, 5, '#8c93a0');
      px(ctx, x + 7, y, 1, 1, blink ? '#9bd7ff' : '#2a3a4a');
      break;
    }
    case 'pager': { // beeper with a blinking LED
      px(ctx, x, y + 2, 6, 4, '#3a4450');
      px(ctx, x + 1, y + 3, 4, 2, '#9bd770');
      px(ctx, x + 5, y + 1, 2, 1, blink ? '#ff5a4e' : '#4a1d1d');
      break;
    }
    case 'capsule': { // pneumatic capsule riding a short tube
      px(ctx, x, y + 4, 10, 2, '#2f5560');
      px(ctx, x + ((f * 2) % 7), y + 3, 3, 3, '#f2c94c');
      break;
    }
    case 'console': { // monitor with a blinking cursor
      px(ctx, x, y, 8, 6, '#1d2430');
      px(ctx, x + 1, y + 1, 6, 4, '#1a3a2a');
      px(ctx, x + 2, y + 3, 1, 1, blink ? '#7fd6a8' : '#1a3a2a');
      px(ctx, x + 3, y + 6, 2, 2, '#1d2430');
      break;
    }
    default: { // working: a tray with three cycling dots
      px(ctx, x, y + 7, 8, 1, '#8c93a0');
      for (let k = 0; k < 3; k++) px(ctx, x + 1 + k * 2, y + 3, 1, 2, (f + k) % 3 === 0 ? '#e0e0e0' : '#5d6670');
    }
  }
}

// ---- warnings on the gurney: threads from the folder top, tags at their ends ----

// Thread columns relative to the folder centre; -1 and 0 are kept free for the status lamp. Neighbouring
// threads are at least one free column apart, so two threads read as two.
const THREAD_DX = [-4, 2, -2, 4];

/**
 * Blinking lamp while the gate is closed; the lamp is then not green (discharged) nor red (stopped).
 * Amber for open/acceptable/must fix; violet when every blocking warning is unruled (no reviewer verdict yet).
 */
export function drawGateLamp(ctx, cx, top, c, now) {
  if (!gateBlocked(c) || c.status !== 'active') return;
  const on = Math.floor(now / 450) % 2 === 0;
  const blocking = c.warnings.filter((w) => BLOCKING.has(w.state));
  const unruledOnly = blocking.every((w) => w.state === 'unruled');
  const color = unruledOnly ? (on ? '#b9a7e0' : '#4d4262') : (on ? '#ffb020' : '#6b4a12');
  px(ctx, cx - 1, top - 3, 2, 2, color);
}

export function drawBrakeChock(ctx, cx, fy, c) {
  if (!gateBlocked(c)) return;
  px(ctx, cx - 9, fy + 2, 2, 2, '#8b5a2b');
}

export function drawThreads(ctx, cx, top, threads, now) {
  threads.forEach((w, i) => {
    const x = cx + THREAD_DX[i % THREAD_DX.length];
    const fixed = w.state === 'fixed';
    const unruled = w.state === 'unruled';
    const age = fixed ? now - w.ruledT : 0;
    const drop = fixed ? Math.min(14, Math.round((age / FIXED_DROP_MS) * 14)) : 0;
    const amp = w.state === 'must_fix' ? 2 : 1;
    const sway = Math.round(Math.sin(now / (w.state === 'must_fix' ? 120 : 400) + i) * amp);
    const len = 8 + (i % 2);
    const ink = w.state === 'must_fix' ? '#ff5a4e' : fixed ? '#8fd3a8' : unruled ? '#b9a7e0' : '#e8e8e8';
    ctx.save();
    if (fixed) ctx.globalAlpha = Math.max(0.2, 1 - drop / 14);
    for (let y = 0; y < len; y++) {
      if (unruled && y % 2) continue; // dashed: no reviewer ruling on this thread yet
      px(ctx, x + Math.round((sway * y) / len), top - 1 - y + drop, 1, 1, ink);
    }
    const tx = x + sway;
    const ty = top - 1 - len + drop;
    if (w.state === 'acceptable') {
      // Unsigned wax blob: dull amber, waits for the user.
      px(ctx, tx - 1, ty - 1, 3, 3, '#7a5a1f');
      px(ctx, tx, ty, 1, 1, '#b8903a');
    } else if (unruled) {
      // Hollow tag: an outline, not a knot.
      px(ctx, tx - 1, ty - 1, 3, 1, ink);
      px(ctx, tx - 1, ty + 1, 3, 1, ink);
      px(ctx, tx - 1, ty - 1, 1, 3, ink);
      px(ctx, tx + 1, ty - 1, 1, 3, ink);
    } else {
      px(ctx, tx, ty - 1, 2, 2, ink);
    }
    ctx.restore();
  });
}

/** Rolled-down shutter with a padlock over the Discharge door tile (tile x, y in tiles, TILE px). */
export function drawShutter(ctx, x, y, tile) {
  px(ctx, x, y, tile, tile, '#5a6470');
  for (let s = 0; s < tile; s += 3) px(ctx, x, y + s, tile, 1, '#3b434c');
  px(ctx, x + 6, y + 6, 4, 4, '#c9a24a');
  px(ctx, x + 7, y + 4, 2, 2, '#c9a24a');
}
