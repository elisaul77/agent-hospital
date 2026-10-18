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
