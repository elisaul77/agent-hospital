// Phase 5a: fit-to-screen zoom. Pure (imported by node:test). Integer zoom from 1x to 4x: the largest one that keeps
// the whole hospital inside the viewport beside the HUD frame. Never below 1x (small screens pan the 1x map).
import { W, H, TILE } from './map.js';

export const FIT_SIDE = 32; // px kept free left and right of the map
export const FIT_TOP = 100; // px for the header and the controls
export const FIT_BOTTOM = 90; // px for the footer

/** @returns {number} integer zoom in [1, 4] */
export function fitZoomOf(viewW, viewH) {
  const byWidth = Math.floor((viewW - 2 * FIT_SIDE) / (W * TILE));
  const byHeight = Math.floor((viewH - FIT_TOP - FIT_BOTTOM) / (H * TILE));
  return Math.max(1, Math.min(4, byWidth, byHeight));
}
