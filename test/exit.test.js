// Phase 5a: a walking-out agent heads for the corridor beyond the nearest door of its room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMap, walkable } from '../public/js/map.js';
import { exitTileOf } from '../public/js/exit.js';
import { findPath } from '../public/js/path.js';
import { W, H } from '../public/js/map.js';

const map = buildMap();

test('the exit of the council is the corridor beyond the door nearest to the agent', () => {
  assert.deepEqual(exitTileOf(map, 'council', { x: 40, y: 20 }), { x: 40, y: 16 });
  assert.deepEqual(exitTileOf(map, 'council', { x: 40, y: 24 }), { x: 40, y: 26 });
});

test('reception exits to the upper corridor, alta to the lower one', () => {
  assert.deepEqual(exitTileOf(map, 'reception', { x: 5, y: 8 }), { x: 5, y: 15 });
  assert.deepEqual(exitTileOf(map, 'discharge', { x: 30, y: 31 }), { x: 31, y: 27 });
});

test('a room whose door opens into another room (Direction) exits through its own door tile', () => {
  assert.deepEqual(exitTileOf(map, 'direction', { x: 3, y: 2 }), { x: 5, y: 5 });
});

test('the exit is walkable and reachable by A* from every seat of the council', () => {
  const room = map.rooms.find((r) => r.id === 'council');
  for (const seat of room.seats) {
    const exit = exitTileOf(map, 'council', { x: seat[0], y: seat[1] });
    assert.ok(walkable(map, exit.x, exit.y));
    const path = findPath(W, H, (x, y) => walkable(map, x, y), { x: seat[0], y: seat[1] }, exit);
    assert.ok(path, `seat ${seat} reaches its exit`);
  }
});

test('an unknown room has no exit', () => {
  assert.equal(exitTileOf(map, 'nowhere', { x: 1, y: 1 }), null);
});
