// Phase 5a: a gurney rolls along the A* route of the corridors (no wall crossing). Pure: positions in canvas px,
// the route is found on tiles with the same A* as the agents. A goal with no route leaves the gurney where it is.
import { TILE, walkable } from './map.js';
import { findPath } from './path.js';

export const GURNEY_SPEED = 1.2; // px per frame (about the agents' 4.5 tiles per second at 60 fps)

export function makeGurney(p) {
  return { x: p.x, y: p.y, path: [], goal: null, blocked: false };
}

/** Waypoints in px from `from` to `to` (tile centres, then the exact goal). null when no route. */
export function gurneyRoute(map, from, to) {
  const a = { x: Math.floor(from.x / TILE), y: Math.floor(from.y / TILE) };
  const b = { x: Math.floor(to.x / TILE), y: Math.floor(to.y / TILE) };
  const tiles = findPath(map.W, map.H, (x, y) => walkable(map, x, y), a, b);
  if (!tiles) return null;
  const pts = tiles.slice(1).map((t) => ({ x: t.x * TILE + TILE / 2, y: t.y * TILE + TILE / 2 }));
  pts.push({ x: to.x, y: to.y });
  return pts;
}

/** Sets a new goal (re-routes only when the goal moved). Returns the gurney. */
export function retarget(map, g, goal) {
  if (g.goal && g.goal.x === goal.x && g.goal.y === goal.y) return g;
  const route = gurneyRoute(map, g, goal);
  g.goal = { x: goal.x, y: goal.y };
  g.path = route ?? [];
  g.blocked = route === null;
  return g;
}

/** Moves up to `speed` px along the route. @returns {boolean} true when it moved */
export function stepGurney(g, speed = GURNEY_SPEED) {
  if (!g.path.length) return false;
  let budget = speed;
  let moved = false;
  while (g.path.length && budget > 0) {
    const t = g.path[0];
    const dx = t.x - g.x;
    const dy = t.y - g.y;
    const d = Math.hypot(dx, dy);
    if (d <= budget) {
      g.x = t.x;
      g.y = t.y;
      g.path.shift();
      budget -= d;
    } else {
      g.x += (dx / d) * budget;
      g.y += (dy / d) * budget;
      budget = 0;
    }
    moved = true;
  }
  return moved;
}
