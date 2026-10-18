// Phase 5a: gurneys follow A* corridors (no wall crossing), pure so node:test can check the route tile by tile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMap, walkable, W, TILE, ROOMS } from '../public/js/map.js';
import { gurneyRoute, retarget, stepGurney, makeGurney, GURNEY_SPEED } from '../public/js/gurney.js';

const map = buildMap();
const px = (tx, ty) => ({ x: tx * TILE + 8, y: ty * TILE + 4 });
const tileOf = (p) => ({ x: Math.floor(p.x / TILE), y: Math.floor(p.y / TILE) });

test('a route from Reception to Alta runs through the corridors and never onto a wall', () => {
  const route = gurneyRoute(map, px(9, 13), px(30, 31));
  assert.ok(route && route.length > 10);
  const tiles = route.map(tileOf);
  for (const t of tiles) assert.ok(walkable(map, t.x, t.y), `(${t.x},${t.y}) is walkable`);
  assert.ok(tiles.some((t) => t.y === 15 || t.y === 16), 'crosses the upper corridor');
  assert.ok(tiles.some((t) => t.y === 26 || t.y === 27), 'crosses the lower corridor');
});

test('consecutive waypoints are one tile apart (4-connected, no diagonal cut through a wall corner)', () => {
  const tiles = gurneyRoute(map, px(9, 13), px(30, 31)).map(tileOf);
  for (let i = 1; i < tiles.length; i++) {
    const d = Math.abs(tiles[i].x - tiles[i - 1].x) + Math.abs(tiles[i].y - tiles[i - 1].y);
    assert.ok(d <= 1, `step ${i} is ${d} tiles`);
  }
});

test('an unreachable goal gives no route, and the gurney stays where it is', () => {
  assert.equal(gurneyRoute(map, px(9, 13), px(0, 0)), null);
  const g = retarget(map, makeGurney(px(9, 13)), px(0, 0));
  const before = { x: g.x, y: g.y };
  assert.equal(stepGurney(g), false);
  assert.deepEqual({ x: g.x, y: g.y }, before);
});

test('stepGurney moves at most GURNEY_SPEED per frame and arrives at the goal exactly', () => {
  const goal = px(30, 31);
  const g = retarget(map, makeGurney(px(9, 13)), goal);
  let frames = 0;
  for (;;) {
    const before = { x: g.x, y: g.y };
    if (!stepGurney(g) || frames > 2000) break;
    assert.ok(Math.hypot(g.x - before.x, g.y - before.y) <= GURNEY_SPEED + 1e-9, 'bounded step');
    frames++;
  }
  assert.ok(frames > 20 && frames < 2000, `frames ${frames}`);
  assert.deepEqual({ x: g.x, y: g.y }, goal);
  assert.equal(g.path.length, 0);
});

test('retarget to the same goal keeps the current route', () => {
  const goal = px(30, 31);
  const g = retarget(map, makeGurney(px(9, 13)), goal);
  const first = g.path;
  retarget(map, g, { ...goal });
  assert.equal(g.path, first);
});

test('every room door is open (not a wall), so the gurney can roll through it', () => {
  for (const r of ROOMS.filter((x) => x.id !== 'direction')) {
    const door = r.doors[0];
    assert.ok(map.tiles[door[1] * W + door[0]] !== 0, `${r.id} door is open`);
  }
});
