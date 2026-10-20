import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleRooms } from '../public/js/focus.js';
import { ROOMS } from '../public/js/map.js';

const agent = (sessionId, room, extras = {}) => ({ sessionId, room, status: 'working', sleeping: false, leaving: false, ...extras });
const workflows = {
  'codex-pool': { workflow: 'subagent-pool', runtime: 'codex' },
  'claude-other': { workflow: 'other', runtime: 'claude' },
  'codex-unknown': { workflow: 'unknown', runtime: 'codex' },
};

test('confirmed pool keeps the complete hospital, even if no room is occupied', () => {
  const view = { workflows, agents: {} };
  assert.deepEqual(visibleRooms(view, 'codex-pool'), new Set(ROOMS.map((r) => r.id)));
});

test('ordinary and unknown sessions show only active evidenced work and Specialist Pool', () => {
  const view = { workflows, agents: {
    a: agent('claude-other', 'diagnosis', { role: 'planning' }),
    b: agent('claude-other', 'radiology', { role: 'review', sleeping: true }),
    c: agent('claude-other', 'council', { role: 'council-risk' }),
    d: agent('codex-unknown', 'operating', { role: 'implement' }),
    e: agent('codex-unknown', 'discharge', { leaving: true }),
  } };
  assert.deepEqual(visibleRooms(view, 'claude-other'), new Set(['specialists', 'diagnosis']));
  assert.deepEqual(visibleRooms(view, 'codex-unknown'), new Set(['specialists', 'operating']));
  assert.deepEqual(visibleRooms({ agents: { x: agent('codex-none', 'triage') } }, 'codex-none'), new Set(['specialists']));
});

test('leaving agents keep their observed room until they disappear, with restricted rooms mapped to specialists', () => {
  const view = { workflows: { 'codex-unknown': workflows['codex-unknown'] }, agents: {
    review: agent('codex-unknown', 'radiology', { status: 'handback', leaving: true }),
    generic: agent('codex-unknown', 'discharge', { status: 'handback', leaving: true }),
    idle: agent('codex-unknown', 'diagnosis', { status: 'handback', leaving: false }),
  } };
  assert.deepEqual(visibleRooms(view, 'codex-unknown'), new Set(['specialists', 'radiology']));
  delete view.agents.review;
  assert.deepEqual(visibleRooms(view, 'codex-unknown'), new Set(['specialists']));
});

test('all sessions are a union of their own evidence; switching sessions does not retain old rooms', () => {
  const view = { workflows: { 'claude-other': workflows['claude-other'], 'codex-unknown': workflows['codex-unknown'] }, agents: {
    a: agent('claude-other', 'diagnosis'), b: agent('codex-unknown', 'operating'),
  } };
  assert.deepEqual(visibleRooms(view, null), new Set(['specialists', 'diagnosis', 'operating']));
  assert.deepEqual(visibleRooms(view, 'codex-unknown'), new Set(['specialists', 'operating']));
  assert.deepEqual(visibleRooms(view, 'claude-other'), new Set(['specialists', 'diagnosis']));
});

test('demo explicitly retains the full map without workflow metadata', () => {
  assert.deepEqual(visibleRooms({ agents: {} }, null, { demo: true }), new Set(ROOMS.map((r) => r.id)));
});
