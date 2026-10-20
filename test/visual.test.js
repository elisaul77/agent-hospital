// Visual regression for the Codex-astra look, ported from design/codex-astra/test/runtime.test.js and
// retargeted at public/. Canvas and DOM are adapters: they prove call order, state and contracts, not
// browser rasterization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoView } from './fixtures/demo-view.js';
import { createRenderer } from '../public/js/render.js';
import { buildMap, ROOMS } from '../public/js/map.js';
import { gateBlocked } from '../public/js/anim.js';

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
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return new Proxy(target, { get: (t, k) => (k in t ? t[k] : () => {}) });
}

function newLog() {
  return { smoothing: [], scales: [], translates: [], text: [], depth: 0 };
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
