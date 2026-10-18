// Procedural sprites: no bitmaps, every pixel is a fillRect in canvas units (1 unit = 1 screen px before CSS scale).
// Silhouette/headgear encodes the role; hue/skin/hair come from a hash of agentId so looks persist.

const SKIN = ['#e0b58a', '#c68f63', '#f1cfa8', '#9a6a45'];
const HAIR = ['#2b2118', '#5a3b22', '#d9c7a0', '#1a1a1a', '#8a3b2a'];
const TIER_COLOR = { S: '#ff6b5b', M: '#f2c94c', L: '#56a8ff' };

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function px(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

/**
 * Draws one agent with its feet at (cx, fy). Role decorations per the plan's silhouette table.
 */
export function drawAgent(ctx, cx, fy, agent, now) {
  const h = hash(agent.agentId);
  const shirt = `hsl(${h % 360} 38% ${agent.role === 'review' ? 30 : 46}%)`;
  const skin = SKIN[h % SKIN.length];
  const hair = HAIR[(h >>> 8) % HAIR.length];
  ctx.save();
  if (agent.status === 'handback') ctx.globalAlpha = 0.55;
  ctx.translate(cx, fy); ctx.scale(2, 2); cx=0; fy=0;
  if (agent.walking) fy -= Math.floor(now / 140) % 2;
  else fy -= Math.sin(now / 650 + h % 9) > .8 ? 1 : 0;
  // shadow
  px(ctx, cx - 3, fy, 6, 1, 'rgba(0,0,0,0.35)');
  // legs + body + arms + head
  px(ctx, cx - 2, fy - 3, 1, 3, '#1d2430');
  px(ctx, cx + 1, fy - 3, 1, 3, '#1d2430');
  px(ctx, cx - 3, fy - 8, 6, 5, shirt);
  px(ctx, cx - 4, fy - 7, 1, 4, shirt);
  px(ctx, cx + 3, fy - 7, 1, 4, shirt);
  px(ctx, cx - 2, fy - 12, 4, 4, skin);
  px(ctx, cx - 2, fy - 12, 4, 1, hair);

  switch (agent.role) {
    case 'conductor': // charge nurse: white cap + headset
      px(ctx, cx - 2, fy - 13, 4, 1, '#f4f4f4');
      px(ctx, cx + 2, fy - 11, 1, 2, '#222');
      px(ctx, cx + 2, fy - 9, 1, 1, '#222');
      break;
    case 'planning': // clipboard + round glasses
      px(ctx, cx - 6, fy - 7, 2, 3, '#d9c48a');
      px(ctx, cx - 2, fy - 10, 1, 1, '#111');
      px(ctx, cx + 1, fy - 10, 1, 1, '#111');
      break;
    case 'implement': // surgical cap + mask + tool arm
      px(ctx, cx - 2, fy - 13, 4, 1, '#7fd6d0');
      px(ctx, cx - 1, fy - 9, 2, 1, '#eeeeee');
      px(ctx, cx + 4, fy - 7, 2, 1, '#c0c8d0');
      break;
    case 'review': // lead apron + light-box film
      px(ctx, cx - 3, fy - 6, 6, 1, '#8c93a0');
      px(ctx, cx + 3, fy - 9, 3, 4, '#f5f0a0');
      break;
    case 'codex': // teal halo = provider marker
      px(ctx, cx - 3, fy - 16, 6, 1, '#2ec4b6');
      px(ctx, cx - 4, fy - 15, 1, 2, '#2ec4b6');
      px(ctx, cx + 3, fy - 15, 1, 2, '#2ec4b6');
      break;
    case 'council-spec': // scroll + red hat
      px(ctx, cx - 4, fy - 8, 2, 4, '#f0e0b0');
      px(ctx, cx - 2, fy - 14, 4, 2, '#7a3b3b');
      break;
    case 'council-architect': // compass hat
      px(ctx, cx - 2, fy - 14, 4, 2, '#2f6f8f');
      px(ctx, cx, fy - 15, 1, 1, '#ffd166');
      break;
    case 'council-lateral': // tilted hat
      px(ctx, cx - 2, fy - 14, 5, 2, '#8e5ad0');
      px(ctx, cx + 3, fy - 15, 1, 1, '#8e5ad0');
      break;
    case 'council-risk': // hazard lamp + hard hat
      px(ctx, cx - 2, fy - 14, 4, 2, '#f2c230');
      px(ctx, cx + 3, fy - 17, 2, 2, Math.floor(now / 400) % 2 ? '#ff8a1f' : '#7a4a1f');
      break;
    case 'architect': // blueprint roll
      px(ctx, cx - 6, fy - 12, 2, 9, '#7fb2ff');
      break;
    default: // consultant: visitor lanyard + badge
      px(ctx, cx - 1, fy - 7, 1, 3, '#ff6f91');
      px(ctx, cx - 1, fy - 5, 2, 2, '#ffffff');
  }
  ctx.restore();
}

export function drawGurney(ctx, cx, fy, c) {
  const thick = Math.min(6, c.phasesDone + 1);
  px(ctx, cx - 7, fy, 14, 1, '#6f7a86'); // cart frame
  px(ctx, cx - 6, fy + 1, 1, 2, '#6f7a86');
  px(ctx, cx + 5, fy + 1, 1, 2, '#6f7a86');
  px(ctx, cx - 5, fy - thick, 10, thick, '#e8dcc0'); // folder, thickness = phases done
  px(ctx, cx + 3, fy - thick, 2, 2, TIER_COLOR[c.tier] ?? '#888'); // tier tag
  const lamp = c.status === 'discharged' ? '#5fdc8a' : c.status === 'stopped' ? '#ff5a4e' : '#f2b44a';
  px(ctx, cx - 1, fy - thick - 3, 2, 2, lamp); // lamp = state
}

export function drawBubble(ctx, cx, fy, text, stalled) {
  ctx.font = '8px monospace';
  const w = Math.ceil(ctx.measureText(text).width) + 4;
  const x = Math.round(cx - w / 2);
  const y = fy - 38;
  px(ctx, x, y, w, 10, stalled ? '#4a1d1d' : '#f4f1e6');
  ctx.fillStyle = stalled ? '#ffb4a8' : '#1a1a1a';
  ctx.fillText(text, x + 2, y + 8);
}

// ---- Phase 4 props: pneumatic capsule, sealed envelope, brass key switch, desk bell, signed card, user chair.
// Same rule as the rest: every pixel is a fillRect; no text is drawn on the canvas.

/** Capsule riding a tube between two rooms; (x, y) is its centre in canvas units. */
export function drawCapsule(ctx, x, y) {
  px(ctx, x - 6, y - 2, 12, 4, '#2f5560');
  px(ctx, x - 4, y - 3, 8, 6, '#f2c94c');
  px(ctx, x - 2, y - 2, 3, 3, '#fff3a0');
}

/** Sealed envelope waiting at the Direction door. Blinks while the approval is pending. */
export function drawEnvelope(ctx, x, y, pending, now) {
  px(ctx, x, y, 8, 5, '#eee3c3');
  px(ctx, x, y, 8, 1, '#c9b68a');
  px(ctx, x + 3, y + 2, 2, 2, pending && Math.floor(now / 500) % 2 ? '#ff5a4e' : '#7a2a24');
}

/** Two-position brass key switch; amber glow while the approval is pending. */
export function drawKeySwitch(ctx, x, y, on) {
  px(ctx, x - 1, y - 1, 10, 8, '#5a4a2a');
  px(ctx, x, y, 8, 6, on ? '#c9a24a' : '#7a6236');
  px(ctx, on ? x + 5 : x + 1, y + 1, 2, 4, '#f7e6b0');
  if (on) px(ctx, x - 2, y - 2, 12, 10, 'rgba(255,176,32,0.22)');
}

/** Brass desk bell on the Reception counter; swings while an escalation is waiting for the user. */
export function drawBell(ctx, cx, fy, ringing, now) {
  const swing = ringing ? Math.round(Math.sin(now / 60)) : 0;
  px(ctx, cx - 3, fy - 4, 6, 1, '#8a6a2a');
  px(ctx, cx - 3 + swing, fy - 3, 6, 3, '#dcb768');
  px(ctx, cx - 2 + swing, fy, 4, 1, '#c9a24a');
  px(ctx, cx + swing, fy + 1, 2, 1, '#5a4a2a');
  if (ringing && Math.floor(now / 250) % 2) px(ctx, cx - 5, fy - 6, 1, 1, '#ffd58a');
}

/** Index card pinned to the archive drawer. Accepted: filled amber seal. Waiting: an empty seal ring. */
export function drawSealCard(ctx, x, y, accepted) {
  px(ctx, x, y, 11, 7, '#efe6cc');
  px(ctx, x, y, 11, 1, '#b9a57a');
  if (accepted) {
    px(ctx, x + 7, y + 3, 3, 3, '#f2b44a');
    px(ctx, x + 8, y + 2, 1, 1, '#ffe0a0');
  } else {
    px(ctx, x + 7, y + 2, 4, 1, '#7a6a4a');
    px(ctx, x + 7, y + 5, 4, 1, '#7a6a4a');
    px(ctx, x + 7, y + 3, 1, 2, '#7a6a4a');
    px(ctx, x + 10, y + 3, 1, 2, '#7a6a4a');
  }
}

/** High-backed chair for the user at the Direction table; filled while the user has just answered. */
export function drawUserChair(ctx, x, y, filled) {
  px(ctx, x, y, 8, 3, filled ? '#8e5ad0' : '#6f67a0');
  px(ctx, x + 1, y + 3, 6, 3, filled ? '#6a3ab0' : '#4a4480');
  px(ctx, x + 2, y + 6, 4, 1, filled ? '#8e5ad0' : '#8a84b8');
}

// ---- Phase 4b: wristbands on the gurney, patient chips in Reception and Alta. Labels are plan phase ids and
// counts (canvas text via fillText; phase titles are never drawn on the canvas).

/** Wristband under a gurney at (cx, fy): the case's current patient as `id/N`. */
export function drawWristband(ctx, cx, fy, label, colour) {
  px(ctx, cx - 11, fy + 5, 22, 7, '#f4f1e6');
  px(ctx, cx - 11, fy + 5, 22, 1, '#7a6a4a');
  if (colour) px(ctx, cx - 11, fy + 5, 3, 7, colour); // Phase 5a: the case colour (same as its chip row)
  ctx.font = '6px monospace';
  ctx.fillStyle = '#1a1a1a';
  ctx.fillText(label, cx - 10, fy + 10);
}

/** One waiting or finished patient as a small wristband chip at (x, y) (top-left). */
export function drawChip(ctx, x, y, label, kind) {
  px(ctx, x, y, 14, 7, kind === 'done' ? '#8fd3a8' : '#e8e8e8');
  ctx.font = '6px monospace';
  ctx.fillStyle = '#1a1a1a';
  ctx.fillText(label, x + 1, y + 6);
}

/** "+N" after the last chip when a row is capped. */
export function drawMore(ctx, x, y, n) {
  ctx.font = '6px monospace';
  ctx.fillStyle = '#f4f1e6';
  ctx.fillText(`+${n}`, x, y + 6);
}
