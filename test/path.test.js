import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMap, walkable } from '../public/js/map.js';
import { findPath } from '../public/js/path.js';

const map = buildMap();
const isWalk = (x, y) => walkable(map, x, y);
const reception = map.rooms.find((r) => r.id === 'reception');
const [sx, sy] = reception.seats[0];
const start = { x: sx, y: sy };

test('every room has a door that touches its floor and a corridor', () => {
  for (const room of map.rooms) {
    assert.ok(room.doors.length > 0, `${room.id} has no door`);
    for (const [dx, dy] of room.doors) {
      const inside = [[dx, dy - 1], [dx, dy + 1]].some(([x, y]) =>
        x >= room.rect.x && x < room.rect.x + room.rect.w &&
        y >= room.rect.y && y < room.rect.y + room.rect.h);
      assert.ok(inside, `${room.id} door ${dx},${dy} does not touch its floor`);
    }
  }
});

test('A* reaches every seat of every room from reception', () => {
  for (const room of map.rooms) {
    for (const seat of room.seats) {
      const path = findPath(map.W, map.H, isWalk, start, { x: seat[0], y: seat[1] });
      assert.ok(path, `no path from reception to ${room.id} seat ${seat}`);
      assert.deepEqual(path[0], start);
      assert.deepEqual(path.at(-1), { x: seat[0], y: seat[1] });
    }
  }
});

test('path steps are 4-adjacent and stay on walkable tiles', () => {
  const room = map.rooms.find((r) => r.id === 'stopped');
  const seat = room.seats[0];
  const path = findPath(map.W, map.H, isWalk, start, { x: seat[0], y: seat[1] });
  for (let i = 1; i < path.length; i++) {
    const d = Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y);
    assert.equal(d, 1, `step ${i} is not 4-adjacent`);
    assert.ok(isWalk(path[i].x, path[i].y), `step ${i} is on a wall`);
  }
});

test('unreachable goal (outer wall) returns null', () => {
  assert.equal(findPath(map.W, map.H, isWalk, start, { x: 0, y: 0 }), null);
});

test('start equal to goal returns a single tile', () => {
  const p = findPath(map.W, map.H, isWalk, start, { x: start.x, y: start.y });
  assert.deepEqual(p, [{ x: start.x, y: start.y }]);
});
