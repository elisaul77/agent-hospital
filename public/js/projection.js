// One shared coordinate transform for drawing, picking, camera focus and navigation.
import { W, H } from './map.js';
export const SX = 18;
export const SY = 9;
export const ORIGIN = { x: H * SX + 100, y: 110 };
export const WORLD = { width: (W + H) * SX + 200, height: (W + H) * SY + 200 };
export function project(x, y, z = 0) {
  return [ORIGIN.x + (x - y) * SX, ORIGIN.y + (x + y) * SY - z];
}
export function unproject(px, py) {
  const a = (px - ORIGIN.x) / SX, b = (py - ORIGIN.y) / SY;
  return { x: (a + b) / 2, y: (b - a) / 2 };
}
export function screenToTile(x, y, camera) {
  return unproject((x - camera.x) / camera.scale, (y - camera.y) / camera.scale);
}
export function fitIsometric(width, height) {
  return Math.max(0.15, Math.min(2, (width - 32) / WORLD.width, (height - 228) / WORLD.height));
}
