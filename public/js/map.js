// Static hospital layout: 48x30 tiles of 16 px. Pure data + one builder, no DOM (imported by node:test too).
// Bands: M mezzanine y1-4 | wall 5 | A rooms y6-13 | wall 14 | corridor 15-16 | wall 17 | B rooms y18-24 | wall 25 | corridor 26-27 | wall 28 | C rooms y29-33 | outer wall 34.

export const TILE = 16;
export const W = 48;
export const H = 35;
export const T = { WALL: 0, FLOOR: 1, CORRIDOR: 2, DOOR: 3 };

// Rows 1-4: DIRECTION mezzanine (glass wall over Reception, one door at [5,5]). Phase 4 moved the rest of the
// hospital down 5 rows to make room; the grid is 48x35 instead of 48x30.
export const ROOMS = [
  { id: 'direction', name: 'Dirección', rect: { x: 1, y: 1, w: 10, h: 4 }, floor: '#2d2a24', accent: '#c9a24a', doors: [[5, 5]],
    seats: [[2, 1], [4, 1], [7, 1], [2, 4], [8, 4], [5, 3]] },
  { id: 'reception', name: 'Recepción', rect: { x: 1, y: 6, w: 10, h: 8 }, floor: '#1d3b3a', accent: '#5fd1c2', doors: [[5, 14]],
    seats: [[3, 8], [5, 8], [7, 8], [3, 11], [7, 11], [5, 11]] },
  { id: 'triage', name: 'Triaje', rect: { x: 12, y: 6, w: 8, h: 8 }, floor: '#2a3a2e', accent: '#9bd770', doors: [[15, 14]],
    seats: [[13, 8], [15, 8], [18, 8], [13, 11], [15, 11], [18, 11]] },
  { id: 'casefile', name: 'Archivo del caso', rect: { x: 21, y: 6, w: 8, h: 8 }, floor: '#3a2f22', accent: '#e0b070', doors: [[24, 14]],
    seats: [[22, 8], [24, 8], [27, 8], [22, 11], [24, 11], [27, 11]] },
  { id: 'architect', name: 'Oficina del arquitecto', rect: { x: 30, y: 6, w: 17, h: 8 }, floor: '#2b2a3f', accent: '#9d8cff', doors: [[38, 14]],
    seats: [[31, 8], [34, 8], [37, 8], [41, 8], [44, 8], [34, 11], [41, 11]] },
  { id: 'diagnosis', name: 'Diagnóstico', rect: { x: 1, y: 18, w: 10, h: 7 }, floor: '#1f3344', accent: '#6cb6ff', doors: [[5, 17], [5, 25]],
    seats: [[2, 20], [5, 20], [8, 20], [2, 23], [5, 23], [8, 23]] },
  { id: 'specialists', name: 'Pool de especialistas', rect: { x: 12, y: 18, w: 20, h: 7 }, floor: '#2c3640', accent: '#b7c4d0', doors: [[20, 17], [20, 25]],
    seats: [[13, 20], [16, 20], [19, 20], [22, 20], [25, 20], [28, 20], [13, 23], [16, 23], [19, 23], [22, 23], [25, 23], [28, 23]] },
  { id: 'council', name: 'Consejo', rect: { x: 33, y: 18, w: 14, h: 7 }, floor: '#3a2a33', accent: '#ff8fb1', doors: [[40, 17], [40, 25]],
    // Seats 0-3 are the four council hats: spec, architect, lateral, risk (see main.js COUNCIL_SEAT).
    seats: [[36, 20], [40, 19], [44, 20], [36, 23], [40, 23], [44, 23]] },
  { id: 'operating', name: 'Quirófano', rect: { x: 1, y: 29, w: 14, h: 5 }, floor: '#16343a', accent: '#5fe3e0', doors: [[7, 28]],
    seats: [[2, 31], [5, 31], [8, 31], [11, 31], [3, 33], [10, 33]] },
  { id: 'radiology', name: 'Radiología / Revisión', rect: { x: 16, y: 29, w: 10, h: 5 }, floor: '#2e2e1f', accent: '#f2e27a', doors: [[20, 28]],
    seats: [[17, 31], [20, 31], [23, 31], [18, 33], [22, 33]] },
  { id: 'discharge', name: 'Alta', rect: { x: 27, y: 29, w: 9, h: 5 }, floor: '#1f3a26', accent: '#5fdc8a', doors: [[31, 28]],
    seats: [[28, 31], [31, 31], [34, 31], [29, 33], [33, 33]] },
  { id: 'stopped', name: 'Caso detenido', rect: { x: 37, y: 29, w: 10, h: 5 }, floor: '#3a2020', accent: '#ff5a4e', doors: [[41, 28]],
    seats: [[38, 31], [41, 31], [44, 31], [39, 33], [43, 33]] },
];

// Phase 4b: seven specialty desks in the Specialist pool. `desk` is the desk's top-left in px relative to the
// room origin (the furnishing of scenery.js); `seat` is the tile the consult stands at. The last desk is the
// generic one: unknown or missing specialty tokens go there, never to Radiology.
export const SPECIALTY_DESKS = [
  { id: 'architecture', label: 'ARQUI', desk: [9, 33], seat: [13, 20] },
  { id: 'security', label: 'SEGUR', desk: [67, 33], seat: [17, 20] },
  { id: 'data', label: 'DATOS', desk: [125, 33], seat: [21, 20] },
  { id: 'ui', label: 'UI', desk: [183, 33], seat: [24, 20] },
  { id: 'performance', label: 'RENDIM', desk: [241, 33], seat: [28, 20] },
  { id: 'infra', label: 'INFRA', desk: [16, 79], seat: [14, 23] },
  { id: 'general', label: 'GENERAL', desk: [81, 79], seat: [18, 23] },
];

export const CORRIDORS = [
  { x: 1, y: 15, w: 46, h: 2 },
  { x: 1, y: 26, w: 46, h: 2 },
];

export const idx = (x, y) => y * W + x;

export function buildMap() {
  const tiles = new Uint8Array(W * H); // WALL everywhere by default
  const roomAt = new Int8Array(W * H).fill(-1);
  const fill = (r, type) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) tiles[idx(x, y)] = type;
  };
  for (const c of CORRIDORS) fill(c, T.CORRIDOR);
  ROOMS.forEach((room, i) => {
    fill(room.rect, T.FLOOR);
    for (let y = room.rect.y; y < room.rect.y + room.rect.h; y++) {
      for (let x = room.rect.x; x < room.rect.x + room.rect.w; x++) roomAt[idx(x, y)] = i;
    }
    for (const [x, y] of room.doors) tiles[idx(x, y)] = T.DOOR;
  });
  return { W, H, tiles, roomAt, rooms: ROOMS, corridors: CORRIDORS };
}

export function walkable(map, x, y) {
  if (x < 0 || y < 0 || x >= map.W || y >= map.H) return false;
  return map.tiles[idx(x, y)] !== T.WALL;
}
