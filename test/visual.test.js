// Visual regression for the Codex-astra look, ported from design/codex-astra/test/runtime.test.js and
// retargeted at public/. Canvas and DOM are adapters: they prove call order, state and contracts, not
// browser rasterization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoView } from './fixtures/demo-view.js';
import { createRenderer } from '../public/js/render.js';
import { buildMap, ROOMS } from '../public/js/map.js';
import { gateBlocked } from '../public/js/anim.js';
import { project } from '../public/js/projection.js';
import { caseColourOf } from '../public/js/patients.js';

// Recording 2D context. Unknown methods are no-ops; the calls the renderer depends on are recorded.
// drawImage is explicit (not a no-op) so the smoothing check really runs at draw time.
function makeContext(log) {
  const target = {
    imageSmoothingEnabled: true,
    fillStyle: '',
    font: '',
    drawImage() { log.smoothing.push(this.imageSmoothingEnabled); },
    save() { log.depth += 1; },
    restore() { log.depth -= 1; },
    translate(x, y) { log.translates.push([x, y]); },
    scale(x, y) { log.scales.push(x, y); },
    measureText: (s) => ({ width: s.length * 5 }),
    fillText(s) { log.text.push(s); },
    fillRect(x, y, w, h) { log.rects.push({ x, y, w, h, colour: this.fillStyle }); },
    fill() { log.fills.push(this.fillStyle); },
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return new Proxy(target, { get: (t, k) => (k in t ? t[k] : () => {}) });
}

function newLog() {
  return { smoothing: [], scales: [], translates: [], text: [], rects: [], fills: [], depth: 0 };
}

// A canvas whose dimension assignment resets the context state, as browsers do (smoothing is cleared).
function makeCanvas(ctx) {
  let width = 0;
  return {
    get width() { return width; },
    set width(v) { width = v; ctx.imageSmoothingEnabled = true; },
    height: 1100,
    getContext: () => ctx,
  };
}

test('local fixture keeps held case in its logical room and maintains complete records', () => {
  const view = demoView(1000);
  assert.equal(Object.keys(view.agents).length, 12);
  for (const a of Object.values(view.agents)) {
    assert.ok(ROOMS.some((r) => r.id === a.room));
    for (const k of ['agentId', 'sessionId', 'caseId', 'subagentType', 'role', 'room', 'status', 'tool', 'reviewer',
      'parentAgentId', 'description', 'toolUseId', 'lastT', 'sleeping', 'stalled']) assert.ok(k in a, k);
  }
  const held = Object.values(view.cases).find((c) => c.held);
  assert.equal(held.room, 'radiology');
  assert.equal(gateBlocked(held), true);
  assert.equal(gateBlocked({ warnings: [{ state: 'accepted' }] }), false);
});

test('renderer draws all rooms and roles with live bubbles, without mutating view or positions', () => {
  const log = newLog();
  const ctx = makeContext(log);
  globalThis.document = { createElement: () => makeCanvas(ctx) };
  const canvas = makeCanvas(ctx);
  canvas.width = 1600;
  const view = demoView(1000);
  const positions = {};
  for (const a of Object.values(view.agents)) {
    const r = ROOMS.find((x) => x.id === a.room);
    positions[a.agentId] = { x: r.seats[0][0], y: r.seats[0][1], path: [], room: a.room };
  }
  const before = JSON.stringify({ view, positions });
  const renderer = createRenderer(canvas, buildMap());

  log.scales.length = 0;
  log.translates.length = 0;
  log.text.length = 0;
  log.smoothing.length = 0;
  canvas.width = 1600; // dimension reset between frames
  renderer.draw(view, positions, 1000, { camera: { x: 20, y: 40, scale: 2 } });

  assert.ok(ROOMS.every((r) => log.text.includes(r.name)), 'all room names are drawn as plaques');
  assert.ok(log.smoothing.length > 0 && log.smoothing.every((v) => v === false), 'smoothing off at every drawImage');
  assert.ok(log.scales.length > 1);
  assert.ok(log.scales.every(Number.isInteger), 'camera and character scales are integers');
  assert.deepEqual(log.translates[0], [20, 40], 'camera translate comes first');
  assert.equal(log.depth, 0, 'save/restore balanced');
  assert.ok(log.text.includes('Bash') && log.text.includes('Grep'), 'tool bubbles drawn by default');
  assert.ok(!log.text.some((s) => s.includes('Simulation warning')), 'warning prose never drawn on canvas');
  assert.equal(JSON.stringify({ view, positions }), before);
});

test('focused ordinary view draws occupied rooms and session badges without clinical markers', () => {
  const log = newLog();
  const ctx = makeContext(log);
  globalThis.document = { createElement: () => makeCanvas(ctx) };
  const canvas = makeCanvas(ctx);
  canvas.width = 1600;
  const renderer = createRenderer(canvas, buildMap());
  const room = ROOMS.find((r) => r.id === 'diagnosis');
  const view = { agents: { a: { agentId: 'a', sessionId: 'codex-12345678', runtime: 'codex',
    room: 'diagnosis', role: 'planning', status: 'working', tool: null } }, cases: {}, messages: [] };
  const positions = { a: { x: room.seats[0][0], y: room.seats[0][1], path: [] } };
  renderer.draw(view, positions, 1000, { visibleRooms: new Set(['specialists', 'diagnosis']), badges: true });
  assert.ok(log.text.includes('Diagnóstico'));
  assert.ok(log.text.includes('Pool de especialistas'));
  assert.ok(log.text.includes('Codex · 12345678'));
  for (const id of ['triage', 'council', 'direction', 'discharge', 'waiting']) {
    assert.ok(!log.text.includes(ROOMS.find((r) => r.id === id).name), `${id} plaque hidden`);
  }
  assert.ok(!log.text.includes('RESPONDIDO'));
});

test('focused background paints only observed room floors and no muted unused tiles', () => {
  const mainLog = newLog();
  const backgroundLog = newLog();
  const ctx = makeContext(mainLog);
  globalThis.document = { createElement: () => makeCanvas(makeContext(backgroundLog)) };
  const canvas = makeCanvas(ctx);
  canvas.width = 1600;
  const renderer = createRenderer(canvas, buildMap());
  backgroundLog.fills.length = 0;
  renderer.draw({ agents: {}, cases: {}, messages: [] }, {}, 1000,
    { visibleRooms: new Set(['specialists', 'diagnosis']) });
  assert.ok(backgroundLog.fills.includes('#bccddd'), 'selected Diagnosis floor is painted');
  assert.ok(backgroundLog.fills.includes('#bad7cb'), 'selected Specialist floor is painted');
  assert.ok(!backgroundLog.fills.includes('#c2d8b6'), 'unused Triage floor is absent');
  assert.ok(!mainLog.fills.includes('#344b50db'), 'unused rooms are not covered by translucent tiles');
});

test('waiting-only case draws a Waiting row marker but no Discharge marker', () => {
  const log = newLog();
  const ctx = makeContext(log);
  globalThis.document = { createElement: () => makeCanvas(ctx) };
  const canvas = makeCanvas(ctx);
  canvas.width = 1600;
  const map = buildMap();
  const view = demoView(1000);
  const caseId = 'CASE-028';
  view.cases = { [caseId]: { ...view.cases[caseId], phases: [{ id: 'P-1', title: 'Waiting', state: 'waiting' }] } };
  view.agents = {};
  const renderer = createRenderer(canvas, map);
  log.rects.length = 0;
  renderer.draw(view, {}, 1000);

  const waiting = map.rooms.find((room) => room.id === 'waiting').rect;
  const [x, y] = project(waiting.x + 2, waiting.y + 1.4, 8);
  const colour = caseColourOf(caseId, Object.keys(view.cases));
  const markers = log.rects.filter((rect) => rect.colour === colour && rect.w === 3 && rect.h === 8);
  assert.deepEqual(markers, [{ x: x - 5, y, w: 3, h: 8, colour }]);
});

test('HUD: snapshot and delta reach the DOM; zoom, reset, drag, details; isometric zoom on desktop and mobile', async () => {
  const log = newLog();
  const ctx = makeContext(log);
  const listeners = {};
  const elements = {};
  const makeElement = (id) => {
    const el = {
      id, value: '', hidden: false, textContent: '', className: '', children: [], attrs: {}, open: false, style: {},
      parent: null,
      classList: { toggle: () => { el.open = !el.open; return el.open; } },
      addEventListener(type, fn) { listeners[`${id}:${type}`] = fn; },
      setAttribute(k, v) { el.attrs[k] = v; },
      appendChild(c) { c.parent = el; el.children.push(c); return c; },
      prepend(c) { c.parent = el; el.children.unshift(c); },
      replaceChildren(...nodes) { el.children = nodes; nodes.forEach((n) => { n.parent = el; }); },
      querySelector: (sel) => el.children.find((c) => sel === `li.${c.className}`) ?? null,
      get lastChild() { return el.children.at(-1) ?? null; },
      remove() { if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); },
      setPointerCapture() {},
      getContext: () => ctx,
    };
    if (id === 'world') {
      let width = 0;
      Object.defineProperty(el, 'width', {
        get: () => width,
        set: (v) => { width = v; ctx.imageSmoothingEnabled = true; },
      });
    }
    return el;
  };
  const byId = (id) => (elements[id] ??= makeElement(id));
  globalThis.document = { getElementById: byId, createElement: (tag) => makeElement(tag) };
  globalThis.location = { search: '?mode=demo' };
  globalThis.innerWidth = 1600;
  globalThis.innerHeight = 1100;
  const windowListeners = {};
  globalThis.window = { addEventListener: (type, fn) => { windowListeners[type] = fn; } };
  let pendingFrame = null;
  globalThis.requestAnimationFrame = (f) => { pendingFrame = f; };
  const runFrame = (t) => { const f = pendingFrame; pendingFrame = null; f(t); };
  const streams = [];
  globalThis.EventSource = class {
    constructor(url) { this.url = url; this.handlers = {}; streams.push(this); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    close() { this.closed = true; }
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, mode: 'demo' }) });
  const click = (id) => listeners[`${id}:click`]();

  await import('../public/js/main.js');
  await new Promise((r) => setImmediate(r)); // let init() finish its health fetch and open the stream
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, '/events?mode=demo');
  assert.equal(byId('log').children[0].textContent, 'sin eventos');

  const es = streams[0];
  es.handlers.snapshot({ data: JSON.stringify(demoView(1000)) });
  assert.equal(byId('count').textContent, '12 agentes');
  assert.equal(byId('cases').children.length, 3);
  assert.equal(byId('activity').textContent, '3 expedientes en planta');

  es.handlers.delta({ data: JSON.stringify({
    events: [{ kind: 'tool_start', t: 1000, agentId: 'night-0', tool: 'Read' }, { kind: 'idle_tick', t: 1000 }],
    state: demoView(1500),
  }) });
  assert.equal(byId('log').children.length, 1, 'placeholder removed, idle_tick skipped');
  assert.match(byId('log').children[0].textContent, /tool_start night-0 Read/);

  runFrame(1000);
  runFrame(1016);
  assert.match(byId('zoom').textContent, /%$/);
  const beforeZoom=Number.parseInt(byId('zoom').textContent);
  click('plus');
  assert.ok(Number.parseInt(byId('zoom').textContent)>beforeZoom);
  click('reset');
  assert.equal(Number.parseInt(byId('zoom').textContent), beforeZoom);

  listeners['world:pointerdown']({ pointerId: 1, clientX: 10, clientY: 10 });
  listeners['world:pointermove']({ clientX: 30, clientY: 50 });
  listeners['world:pointerup']();
  log.translates.length = 0;
  runFrame(1032);
  const fitted = Math.min((1600 - 32) / 1694, (1100 - 228) / 947, 2);
  assert.deepEqual(log.translates[0], [Math.round((1600 - 1694 * fitted) / 2) + 20, Math.round(92 + (1100 - 228 - 947 * fitted) / 2) + 40],
    'drag moves the camera by the pointer delta');

  click('details');
  assert.equal(byId('details').attrs['aria-expanded'], 'true');
  assert.equal(byId('inspector').open, true);

  globalThis.innerWidth = 390;
  globalThis.innerHeight = 844;
  windowListeners.resize();
  runFrame(1048);
  assert.match(byId('zoom').textContent, /%$/);
  assert.ok(log.scales.every(Number.isFinite), 'finite zoom at desktop and mobile dimensions');
  assert.ok(log.translates.flat().every(Number.isInteger), 'integer camera offsets');
  assert.ok(log.smoothing.length > 0 && log.smoothing.every((v) => v === false), 'smoothing restored after resize');
});

test('live HUD focuses observed rooms and clears focus on session switch', async () => {
  const log = newLog();
  const ctx = makeContext(log);
  const listeners = {}, elements = {}, streams = [];
  const makeElement = (id) => {
    const el = {
      id, value: '', hidden: false, textContent: '', className: '', children: [], attrs: {}, style: {},
      classList: { toggle: () => true },
      addEventListener(type, fn) { listeners[`${id}:${type}`] = fn; },
      setAttribute(k, v) { el.attrs[k] = v; },
      appendChild(c) { el.children.push(c); return c; },
      replaceChildren(...nodes) { el.children = nodes; },
      querySelector: () => null,
      get options() { return el.children; },
      getContext: () => ctx,
      setPointerCapture() {},
    };
    return el;
  };
  const byId = (id) => (elements[id] ??= makeElement(id));
  globalThis.document = { getElementById: byId, createElement: (tag) => makeElement(tag),
    body: { classList: { toggle: () => {} } } };
  globalThis.location = { search: '?mode=live' };
  globalThis.innerWidth = 1200;
  globalThis.innerHeight = 900;
  globalThis.window = { addEventListener: () => {} };
  let frame;
  globalThis.requestAnimationFrame = (fn) => { frame = fn; };
  globalThis.EventSource = class {
    constructor(url) { this.url = url; this.handlers = {}; streams.push(this); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    close() { this.closed = true; }
  };
  globalThis.fetch = async (url) => ({ ok: true, json: async () => url === '/api/health'
    ? { mode: 'live' } : { sessions: [
      { sessionId: 'codex-12345678', runtime: 'codex' },
      { sessionId: 'claude-87654321', runtime: 'claude' },
    ] } });
  const oldInterval = globalThis.setInterval;
  globalThis.setInterval = () => 1;
  try {
    await import('../public/js/main.js?focused-live-test');
    await new Promise((r) => setImmediate(r));
    assert.equal(streams[0].url, '/events?mode=live');
    const snapshot = (id, room, runtime) => ({ t: 1000, now: 1000,
      workflows: { [id]: { workflow: 'unknown', runtime } },
      agents: { one: { agentId: 'one', sessionId: id, room, runtime, role: 'planning',
        status: 'working', sleeping: false, leaving: false, tool: null } },
      cases: {}, messages: [], escalations: [] });
    streams[0].handlers.snapshot({ data: JSON.stringify(snapshot('codex-12345678', 'diagnosis', 'codex')) });
    const roomButton = (name) => byId('departments').children.find((b) => b.children[1].textContent === name);
    assert.equal(roomButton('Diagnóstico').hidden, false);
    assert.equal(roomButton('Consejo').hidden, true);
    assert.equal(roomButton('Alta').hidden, true);
    assert.equal(byId('overview').hidden, true);
    assert.equal(byId('case-stats').hidden, true);
    assert.match(byId('activity').textContent, /1 agente en actividad/);
    assert.equal(byId('session-badges').children[0].textContent, 'Codex · 12345678');
    const fittedZoom = Number.parseInt(byId('zoom').textContent);
    listeners['plus:click']();
    assert.ok(Number.parseInt(byId('zoom').textContent) > fittedZoom, 'focused room still zooms on click');
    listeners['reset:click']();
    assert.ok(Number.parseInt(byId('zoom').textContent) < fittedZoom, 'Vista general fits the whole hospital');
    assert.equal(roomButton('Consejo').hidden, false, 'Vista general exposes the Council room');
    assert.equal(roomButton('Alta').hidden, false, 'Vista general exposes Discharge');
    log.text.length = 0;
    frame(1040); // initial animation callback installs the drawing loop
    frame(1056);
    assert.ok(log.text.includes('Consejo'), `Vista general draws the Council room on Canvas: ${log.text.slice(0,25).join(', ')}`);
    const leaving = snapshot('codex-12345678', 'diagnosis', 'codex');
    leaving.agents.one.status = 'handback';
    leaving.agents.one.leaving = true;
    streams[0].handlers.snapshot({ data: JSON.stringify(leaving) });
    assert.equal(roomButton('Diagnóstico').hidden, false, 'walk-out room remains visible until TTL removal');

    const pending = snapshot('codex-12345678', 'diagnosis', 'codex');
    pending.workflows['codex-12345678'].workflow = 'subagent-pool';
    pending.cases = { 'codex-12345678': { caseId: 'codex-12345678', sessionId: 'codex-12345678', room: 'waiting', status: 'working' } };
    pending.escalations = [{ id: 'bell-1', caseId: 'codex-12345678', label: 'Revisar' }];
    streams[0].handlers.snapshot({ data: JSON.stringify(pending) });
    assert.equal(byId('bell').hidden, false);
    assert.equal(byId('cases').children.length, 2);

    byId('session').value = 'claude-87654321';
    listeners['session:change']();
    assert.equal(streams[0].closed, true);
    assert.equal(streams[1].url, '/events?mode=live&session=claude-87654321');
    assert.equal(byId('count').textContent, '0 agentes');
    assert.equal(byId('cases').children.length, 0);
    assert.equal(byId('activity').textContent, '0 agentes en actividad');
    assert.equal(byId('session-badges').children.length, 0);
    assert.equal(byId('bell').hidden, true);
    assert.equal(byId('bell').textContent, '');
    assert.equal(roomButton('Diagnóstico').hidden, true);
    assert.equal(roomButton('Consejo').hidden, true);
    streams[1].handlers.snapshot({ data: JSON.stringify(snapshot('claude-87654321', 'radiology', 'claude')) });
    assert.equal(roomButton('Diagnóstico').hidden, true);
    assert.equal(roomButton('Radiología / Revisión').hidden, false);
  } finally {
    globalThis.setInterval = oldInterval;
  }
});
