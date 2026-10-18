// Phase 5a: where a walking-out agent goes. The corridor tile beyond the door of its room nearest to the agent;
// a room whose door opens into another room (Direction) exits through its own door tile. Pure.
import { T } from './map.js';

const STEPS = [[0, -1], [0, 1], [-1, 0], [1, 0]];

/** @returns {{x:number,y:number}|null} the exit tile of a room, or null for an unknown room */
export function exitTileOf(map, roomId, from) {
  const room = map.rooms.find((r) => r.id === roomId);
  if (!room || !room.doors.length) return null;
  const dist = (d) => Math.abs(d[0] - from.x) + Math.abs(d[1] - from.y);
  const door = [...room.doors].sort((a, b) => dist(a) - dist(b))[0];
  for (const [dx, dy] of STEPS) {
    const x = door[0] + dx;
    const y = door[1] + dy;
    if (x < 0 || y < 0 || x >= map.W || y >= map.H) continue;
    if (map.tiles[y * map.W + x] === T.CORRIDOR) return { x, y };
  }
  return { x: door[0], y: door[1] };
}
