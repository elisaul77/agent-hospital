// Wiring: SSE -> mirror state -> walking targets (A* on the static map) -> render loop + HUD.
import { buildMap, ROOMS, W, H, TILE, walkable } from './map.js';
import { findPath } from './path.js';
import { fitZoomOf } from './view.js';
import { exitTileOf } from './exit.js';
import { connect } from './net.js';
import { createRenderer } from './render.js';
import { hash } from './sprites.js';
import { warningSummary, frozenWarnView, frozenSceneView, SCENE_NAMES } from './anim.js';
import { freshEscalations } from './bell.js';
import { createBellSound } from './audio.js';
import { specialtyDeskOf, phaseStateLabel } from './patients.js';
import { createArchive } from './archive.js';

const WALK_SPEED = 4.5; // tiles per second
const LOG_MAX = 14;
// Council hats keep their seat in the council room (seat index in map.js): spec, architect, lateral, risk.
const COUNCIL_SEAT = { 'council-spec': 0, 'council-architect': 1, 'council-lateral': 2, 'council-risk': 3 };
const SOUND_KEY = 'hospital.bellSound';
const BELL_ICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' fill='%23142332'/><path d='M8 3a4 4 0 0 0-4 4v3l-1 2h10l-1-2V7a4 4 0 0 0-4-4z' fill='%23f2b44a'/><circle cx='8' cy='13' r='1.3' fill='%23f2b44a'/></svg>";
const IDLE_ICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' fill='%23142332'/><path d='M8 3a4 4 0 0 0-4 4v3l-1 2h10l-1-2V7a4 4 0 0 0-4-4z' fill='%23557'/></svg>";
// Screenshot aid: ?freeze=<ToolName> (e.g. Read, Bash, Grep) freezes the animation clock and shows that
// tool's equipment on every working agent. Without it the page runs live.
const FREEZE_TOOL = new URLSearchParams(location.search).get('freeze');
const FREEZE_NOW = 1000;
// Screenshot aid: ?freezeWarn=<fixed|must_fix|acceptable|held> draws one fixed case in that warning state.
// Render-only: the canvas shows the fixture instead of the live view; the HUD and the stream are unchanged.
const FREEZE_WARN = new URLSearchParams(location.search).get('freezeWarn');
const WARN_VIEW = FREEZE_WARN ? frozenWarnView(FREEZE_WARN, FREEZE_NOW) : null;
if (FREEZE_WARN && !WARN_VIEW) console.error(`[hospital] unknown freezeWarn ${FREEZE_WARN}`);
// Screenshot aid: ?freezeScene=<council|tube|accepted|direction|direction-answered> shows one fixed Phase 4 scene,
// zoomed on its focus tile. The scene replaces the live view for the canvas, the walking, and the HUD bell.
const SCENE_NAME = new URLSearchParams(location.search).get('freezeScene');
const SCENE = SCENE_NAME ? frozenSceneView(SCENE_NAME, FREEZE_NOW) : null;
if (SCENE_NAME && !SCENE) console.error(`[hospital] unknown freezeScene ${SCENE_NAME}; known: ${SCENE_NAMES.join(', ')}`);
const HOLD_ROOM = 'direction'; // a delegate that asked Direction walks to this room's door and holds there
const hudView = () => (SCENE ? SCENE.view : view);

const canvas = document.getElementById('world');
const map = buildMap();
const renderer = createRenderer(canvas, map);
// Camera in screen pixels: integer zoom 1x-4x keeps the pixel art crisp; small viewports pan the 1x map.
const camera = { x: 0, y: 0, scale: 1 };
let zoom = 1;

let view = { t: 0, now: 0, agents: {}, cases: {}, messages: [] };
const positions = {}; // agentId -> {x, y, path: [{x,y}], seat: 'room:idx'}
const seatOwner = {}; // 'room:idx' -> agentId

const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const casesEl = document.getElementById('cases');
const logEl = document.getElementById('log');
const modeEl = document.getElementById('mode');
const sessionEl = document.getElementById('session');
const zoomEl = document.getElementById('zoom');
const activityEl = document.getElementById('activity');
const inspectorEl = document.getElementById('inspector');
const detailsEl = document.getElementById('details');
// Phase 5: the Archive panel (case files, read-only). Opened from the HUD, the Archivo del caso room, or a case.
const archive = createArchive(document);
const ARCHIVE_ROOM = 'casefile';
const CLICK_SLOP_PX = 6; // a pointer that moves less than this is a click, not a drag

let es = null;
let currentMode = null;
let currentSession = null;

// Escalation bell: sound is opt-in and persisted; the AudioContext is only created after a click (see below).
const bellEl = document.getElementById('bell');
const soundEl = document.getElementById('sound');
const vignetteEl = document.getElementById('vignette');
const bellSound = createBellSound();
let soundOn = loadSoundPref();
let seenBell = null; // escalation ids already handled; null until the first snapshot of a stream

function loadSoundPref() {
  try {
    return localStorage.getItem(SOUND_KEY) === '1';
  } catch (e) {
    console.error(`[hospital] sound preference unreadable: ${e.message}`);
    return false;
  }
}

function saveSoundPref(on) {
  try {
    localStorage.setItem(SOUND_KEY, on ? '1' : '0');
  } catch (e) {
    console.error(`[hospital] sound preference not saved: ${e.message}`);
  }
}

function paintSound() {
  soundEl.setAttribute('aria-pressed', String(soundOn));
  soundEl.textContent = soundOn ? 'Campana: sonido' : 'Campana: silencio';
}

function setIcon(ringing) {
  const link = document.getElementById('favicon');
  if (link) link.href = ringing ? BELL_ICON : IDLE_ICON;
}

function ringBell() {
  vignetteEl.classList.remove('on');
  void vignetteEl.offsetWidth; // restart the pulse
  vignetteEl.classList.add('on');
  bellSound.ring();
}

// Ring once per new escalation. The first snapshot of a stream is silent: it only shows what is waiting.
function updateBell(silent) {
  const list = hudView().escalations ?? [];
  const fresh = seenBell === null ? [] : freshEscalations(seenBell, list);
  if (fresh.length && !silent) ringBell();
  seenBell = new Set(list.map((e) => e.id));
  bellEl.hidden = list.length === 0;
  bellEl.textContent = list.length ? `Campana: ${list.slice(0, 3).map((e) => e.label).join(' · ')}` : '';
  document.title = list.length ? '(!) Hospital de agentes' : 'Hospital de agentes';
  setIcon(list.length > 0);
}

// Bell click: centre the camera on the room that holds the first waiting escalation.
function centerOnRoom(roomId) {
  const room = ROOMS.find((r) => r.id === roomId);
  if (!room) return;
  camera.scale = zoom;
  camera.x = Math.round(innerWidth / 2 - (room.rect.x + room.rect.w / 2) * TILE * zoom);
  camera.y = Math.round(innerHeight / 2 - (room.rect.y + room.rect.h / 2) * TILE * zoom);
}

// Scene aid: centre a tile (tile units) at a given zoom.
function centerOnTile(tx, ty) {
  camera.scale = zoom;
  camera.x = Math.round(innerWidth / 2 - tx * TILE * zoom);
  camera.y = Math.round(innerHeight / 2 - ty * TILE * zoom);
}

function applyScene() {
  zoom = SCENE.zoom;
  centerOnTile(SCENE.focus[0], SCENE.focus[1]);
  zoomEl.textContent = `${zoom * 100}%`;
}

// Phase 5a: largest integer zoom (1x-4x) that fits the hospital beside the HUD frame. Used on load and by Centrar.
function fitZoom() {
  return fitZoomOf(innerWidth, innerHeight);
}

function center() {
  camera.scale = zoom;
  camera.x = Math.round((innerWidth - W * TILE * zoom) / 2);
  camera.y = Math.round(100 + (innerHeight - 190 - H * TILE * zoom) / 2);
  zoomEl.textContent = `${zoom * 100}%`;
}

function resize() {
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  zoom = fitZoom();
  center();
}

function changeZoom(value) {
  zoom = Math.max(1, Math.min(4, Math.round(value)));
  center();
}

function showEmptyLog() {
  if (logEl.children.length) return;
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = 'sin eventos';
  logEl.appendChild(li);
}

// Reset everything that belongs to the previous stream before opening a new one (mode/session switch).
function openStream() {
  if (es) es.close();
  seenBell = null;
  view = { t: 0, now: 0, agents: {}, cases: {}, messages: [] };
  logEl.replaceChildren();
  showEmptyLog();
  es = connect({
    mode: currentMode,
    session: currentSession,
    onStatus: (s) => { statusEl.textContent = s; },
    onSnapshot: (state) => { view = state; reconcile(); updateHud(); updateBell(true); },
    onDelta: ({ events, state }) => {
      view = state;
      reconcile();
      updateHud();
      updateBell(false);
      for (const ev of events) if (ev.kind !== 'idle_tick') logEvent(ev);
    },
  });
}

// Session picker (live mode only). Keeps the current choice when the list refreshes.
async function loadSessions() {
  const r = await fetch('/api/sessions');
  if (!r.ok) throw new Error(`/api/sessions ${r.status}`);
  const { sessions } = await r.json();
  const keep = sessionEl.value;
  sessionEl.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'todas las sesiones';
  sessionEl.appendChild(all);
  for (const s of sessions) {
    const opt = document.createElement('option');
    opt.value = s.sessionId;
    opt.textContent = `${s.sessionId.slice(0, 8)} · ${s.project}`;
    sessionEl.appendChild(opt);
  }
  sessionEl.value = [...sessionEl.options].some((o) => o.value === keep) ? keep : '';
  sessionEl.hidden = false;
}

async function init() {
  let defaultMode = 'demo';
  try {
    const h = await fetch('/api/health').then((r) => r.json());
    defaultMode = h.mode;
  } catch (e) {
    modeEl.textContent = 'sin health';
    console.error(`[hospital] health: ${e.message}`);
  }
  currentMode = new URLSearchParams(location.search).get('mode') || defaultMode;
  modeEl.textContent = currentMode;
  if (currentMode === 'live') {
    sessionEl.addEventListener('change', () => {
      currentSession = sessionEl.value || null;
      openStream();
    });
    try {
      await loadSessions();
    } catch (e) {
      console.error(`[hospital] sessions: ${e.message}`);
    }
    setInterval(() => loadSessions().catch((e) => console.error(`[hospital] sessions: ${e.message}`)), 30000);
  }
  openStream();
}

function pickSeat(agentId, roomId, role) {
  const room = ROOMS.find((r) => r.id === roomId);
  const n = room.seats.length;
  const preferred = roomId === 'council' ? COUNCIL_SEAT[role] : undefined;
  const start = preferred ?? hash(agentId) % n;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const key = `${roomId}:${i}`;
    if (!seatOwner[key] || seatOwner[key] === agentId) return { i, key, tile: room.seats[i] };
  }
  const i = start; // room full: share the hashed seat
  return { i, key: `${roomId}:${i}`, tile: room.seats[i] };
}

function releaseSeat(agentId) {
  const p = positions[agentId];
  if (p && p.seat && seatOwner[p.seat] === agentId) delete seatOwner[p.seat];
}

// Reconcile walking targets with the latest agent rooms. The room decides the target, except for a delegate
// holding at the Direction door (holdingAt): it stands in the door tile until the user answers.
function reconcile() {
  const v = hudView();
  for (const id of Object.keys(positions)) {
    if (!v.agents[id]) { releaseSeat(id); delete positions[id]; }
  }
  for (const a of Object.values(v.agents)) {
    const holding = a.holdingAt === HOLD_ROOM;
    // Phase 5a: a walking-out agent (finished, or an idle Conductor) heads for the exit of its room.
    const leaving = a.leaving === true && !holding;
    const roomId = holding ? HOLD_ROOM : a.room;
    const room = ROOMS.find((r) => r.id === roomId);
    if (!room) { console.error(`[hospital] unknown room ${roomId} for ${a.agentId}`); continue; }
    let p = positions[a.agentId];
    if (!p) {
      const door = room.doors[0];
      p = { x: door[0], y: door[1], path: [], seat: null, room: null };
      positions[a.agentId] = p;
    }
    // Phase 4b: a consult sits at the desk of its specialty (generic desk for an unknown token).
    const desk = !holding && !leaving && a.consult ? specialtyDeskOf(a.specialty) : null;
    const key = leaving ? `leave:${a.room}` : holding ? `${roomId}:door` : desk ? `desk:${desk.id}` : roomId;
    if (p.room === key) continue;
    releaseSeat(a.agentId);
    const from = { x: Math.round(p.x), y: Math.round(p.y) };
    let seat = null;
    let tile;
    if (leaving) {
      tile = exitTileOf(map, a.room, from) ?? room.doors[0];
    } else {
      seat = holding ? null : desk ? { key: `desk:${desk.id}`, tile: desk.seat } : pickSeat(a.agentId, a.room, a.role);
      if (seat) seatOwner[seat.key] = a.agentId;
      tile = holding ? room.doors[0] : seat.tile;
    }
    const path = findPath(W, H, (x, y) => walkable(map, x, y), from, { x: tile[0], y: tile[1] });
    if (!path) {
      console.error(`[hospital] no path for ${a.agentId} to ${key}`);
      p.path = [];
    } else {
      p.path = path.slice(1);
    }
    p.seat = seat ? seat.key : null;
    p.room = key;
  }
}

let last = performance.now();
function step(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (SCENE) { // scene: every walker is already where its path ends
    for (const p of Object.values(positions)) {
      const end = p.path[p.path.length - 1];
      if (end) { p.x = end.x; p.y = end.y; p.path = []; }
    }
  }
  for (const p of Object.values(positions)) {
    let budget = WALK_SPEED * dt;
    while (p.path.length && budget > 0) {
      const t = p.path[0];
      const dx = t.x - p.x, dy = t.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d <= budget) { p.x = t.x; p.y = t.y; p.path.shift(); budget -= d; }
      else { p.x += (dx / d) * budget; p.y += (dy / d) * budget; budget = 0; }
    }
  }
  const frozen = FREEZE_TOOL || FREEZE_WARN || SCENE;
  renderer.draw(WARN_VIEW ?? hudView(), positions, frozen ? FREEZE_NOW : Date.now(), { camera, freezeTool: FREEZE_TOOL });
  requestAnimationFrame(step);
}

function updateHud() {
  const v = hudView();
  const agents = Object.values(v.agents);
  countEl.textContent = `${agents.length} agentes`;
  activityEl.textContent = `${Object.keys(v.cases).length} expedientes en planta`;
  casesEl.replaceChildren();
  for (const c of Object.values(v.cases)) {
    const li = document.createElement('li');
    const warn = warningSummary(c);
    li.textContent = `${c.caseId} · ${c.room} · ${c.status}${c.tier ? ` · Tier ${c.tier}` : ''}${warn ? ` · ${warn}` : ''}`;
    // Phase 5: an archived case (a live state file) opens in the Archive room; demo cases have none.
    if (c.archiveId) {
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Abrir expediente';
      open.addEventListener('click', () => archive.openCase(c.archiveId, open));
      li.appendChild(open);
    }
    casesEl.appendChild(li);
    // Phase 4b: the plan phases of the case, as patients (titles via textContent only).
    for (const p of c.phases ?? []) {
      const ph = document.createElement('li');
      ph.textContent = `  ${p.id} · ${p.title} · ${phaseStateLabel(p.state)}`;
      casesEl.appendChild(ph);
    }
    // Signed risks from the case file (ACCEPTED_RISK lines). Text is shown as textContent, cut to 80 chars.
    for (const a of c.accepted ?? []) {
      const sig = document.createElement('li');
      sig.textContent = `firmado ${a.date}: ${a.item} · «${a.userWords}»`;
      casesEl.appendChild(sig);
    }
  }
  for (const e of v.escalations ?? []) {
    const li = document.createElement('li');
    li.textContent = `campana · ${e.label} · ${e.caseId}`;
    casesEl.appendChild(li);
  }
}

function logEvent(ev) {
  logEl.querySelector('li.empty')?.remove();
  const li = document.createElement('li');
  const who = ev.agentId ?? ev.sessionId ?? '';
  li.textContent = `${new Date(ev.t).toLocaleTimeString('es-CO')} ${ev.kind} ${who}${ev.tool ? ` ${ev.tool}` : ''}${ev.verdict ? ` ${ev.verdict}` : ''}`;
  logEl.prepend(li);
  while (logEl.children.length > LOG_MAX) logEl.lastChild.remove();
}

document.getElementById('plus').addEventListener('click', () => changeZoom(zoom + 1));
document.getElementById('minus').addEventListener('click', () => changeZoom(zoom - 1));
document.getElementById('reset').addEventListener('click', () => { zoom = fitZoom(); center(); });
bellEl.addEventListener('click', () => {
  const v = hudView();
  const e = (v.escalations ?? [])[0];
  if (!e) return;
  centerOnRoom(e.reason === 'approve' ? 'direction' : v.cases[e.caseId]?.room);
});
soundEl.addEventListener('click', () => {
  soundOn = !soundOn;
  saveSoundPref(soundOn);
  bellSound.setEnabled(soundOn);
  paintSound();
});
// A saved preference arms the bell on the first gesture only (browsers forbid audio before one).
if (soundOn) document.addEventListener('pointerdown', () => bellSound.setEnabled(true), { once: true });
paintSound();
document.getElementById('archive-open').addEventListener('click', (e) => archive.openList(e.currentTarget));
detailsEl.addEventListener('click', () => {
  const opened = inspectorEl.classList.toggle('open');
  detailsEl.setAttribute('aria-expanded', String(opened));
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  changeZoom(zoom + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y, moved: false };
});
canvas.addEventListener('pointermove', (e) => {
  if (drag) {
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > CLICK_SLOP_PX) drag.moved = true;
    camera.x = drag.cx + e.clientX - drag.x; camera.y = drag.cy + e.clientY - drag.y;
  }
});
// Phase 5: a click (not a drag) on the Archivo del caso room opens the Archive room list.
canvas.addEventListener('pointerup', (e) => {
  if (!drag || drag.moved) return;
  const room = ROOMS.find((r) => r.id === ARCHIVE_ROOM);
  const tx = (e.clientX - camera.x) / (TILE * camera.scale);
  const ty = (e.clientY - camera.y) / (TILE * camera.scale);
  if (room && tx >= room.rect.x && tx < room.rect.x + room.rect.w && ty >= room.rect.y && ty < room.rect.y + room.rect.h) {
    archive.openList(null);
  }
});
const endDrag = () => { drag = null; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
window.addEventListener('resize', resize);
resize();
if (SCENE) { applyScene(); reconcile(); updateHud(); updateBell(true); }

init();

requestAnimationFrame((t) => { last = t; requestAnimationFrame(step); });
