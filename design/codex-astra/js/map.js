// Static hospital layout: 48x30 tiles of 16 px. Pure data + one builder, no DOM (imported by node:test too).
// Bands: A rooms y1-8 | wall 9 | corridor 10-11 | wall 12 | B rooms y13-19 | wall 20 | corridor 21-22 | wall 23 | C rooms y24-28 | outer wall 29.

export const TILE = 16;
export const W = 48;
export const H = 30;
export const T = { WALL: 0, FLOOR: 1, CORRIDOR: 2, DOOR: 3 };

export const ROOMS = [
  { id: 'reception', name: 'Recepción', rect: { x: 1, y: 1, w: 10, h: 8 }, floor: '#1d3b3a', accent: '#5fd1c2', doors: [[5, 9]],
    seats: [[3, 3], [5, 3], [7, 3], [3, 6], [7, 6], [5, 6]] },
  { id: 'triage', name: 'Triaje', rect: { x: 12, y: 1, w: 8, h: 8 }, floor: '#2a3a2e', accent: '#9bd770', doors: [[15, 9]],
    seats: [[13, 3], [15, 3], [18, 3], [13, 6], [15, 6], [18, 6]] },
  { id: 'casefile', name: 'Archivo del caso', rect: { x: 21, y: 1, w: 8, h: 8 }, floor: '#3a2f22', accent: '#e0b070', doors: [[24, 9]],
    seats: [[22, 3], [24, 3], [27, 3], [22, 6], [24, 6], [27, 6]] },
  { id: 'architect', name: 'Oficina del arquitecto', rect: { x: 30, y: 1, w: 17, h: 8 }, floor: '#2b2a3f', accent: '#9d8cff', doors: [[38, 9]],
    seats: [[31, 3], [34, 3], [37, 3], [41, 3], [44, 3], [34, 6], [41, 6]] },
  { id: 'diagnosis', name: 'Diagnóstico', rect: { x: 1, y: 13, w: 10, h: 7 }, floor: '#1f3344', accent: '#6cb6ff', doors: [[5, 12], [5, 20]],
    seats: [[2, 15], [5, 15], [8, 15], [2, 18], [5, 18], [8, 18]] },
  { id: 'specialists', name: 'Pool de especialistas', rect: { x: 12, y: 13, w: 20, h: 7 }, floor: '#2c3640', accent: '#b7c4d0', doors: [[20, 12], [20, 20]],
    seats: [[13, 15], [16, 15], [19, 15], [22, 15], [25, 15], [28, 15], [13, 18], [16, 18], [19, 18], [22, 18], [25, 18], [28, 18]] },
  { id: 'council', name: 'Consejo', rect: { x: 33, y: 13, w: 14, h: 7 }, floor: '#3a2a33', accent: '#ff8fb1', doors: [[40, 12], [40, 20]],
    seats: [[36, 15], [40, 14], [44, 15], [36, 18], [40, 18], [44, 18]] },
  { id: 'operating', name: 'Quirófano', rect: { x: 1, y: 24, w: 14, h: 5 }, floor: '#16343a', accent: '#5fe3e0', doors: [[7, 23]],
    seats: [[2, 26], [5, 26], [8, 26], [11, 26], [3, 28], [10, 28]] },
  { id: 'radiology', name: 'Radiología / Revisión', rect: { x: 16, y: 24, w: 10, h: 5 }, floor: '#2e2e1f', accent: '#f2e27a', doors: [[20, 23]],
    seats: [[17, 26], [20, 26], [23, 26], [18, 28], [22, 28]] },
  { id: 'discharge', name: 'Alta', rect: { x: 27, y: 24, w: 9, h: 5 }, floor: '#1f3a26', accent: '#5fdc8a', doors: [[31, 23]],
    seats: [[28, 26], [31, 26], [34, 26], [29, 28], [33, 28]] },
  { id: 'stopped', name: 'Caso detenido', rect: { x: 37, y: 24, w: 10, h: 5 }, floor: '#3a2020', accent: '#ff5a4e', doors: [[41, 23]],
    seats: [[38, 26], [41, 26], [44, 26], [39, 28], [43, 28]] },
];

export const CORRIDORS = [
  { x: 1, y: 10, w: 46, h: 2 },
  { x: 1, y: 21, w: 46, h: 2 },
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
