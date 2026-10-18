// A* on a 4-connected tile grid. Pure: no DOM, so node:test can import it.
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * @param {number} W grid width
 * @param {number} H grid height
 * @param {(x:number, y:number) => boolean} walkable
 * @param {{x:number,y:number}} start
 * @param {{x:number,y:number}} goal
 * @returns {{x:number,y:number}[] | null} tiles from start to goal inclusive, or null
 */
export function findPath(W, H, walkable, start, goal) {
  if (!walkable(start.x, start.y) || !walkable(goal.x, goal.y)) return null;
  const key = (x, y) => y * W + x;
  const goalK = key(goal.x, goal.y);
  const startK = key(start.x, start.y);
  const g = new Float64Array(W * H).fill(Infinity);
  const came = new Int32Array(W * H).fill(-1);
  const closed = new Uint8Array(W * H);
  const h = (k) => Math.abs((k % W) - goal.x) + Math.abs(Math.floor(k / W) - goal.y); // Manhattan
  const open = [startK];
  g[startK] = 0;

  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) {
      const a = open[i], b = open[bi];
      if (g[a] + h(a) < g[b] + h(b)) bi = i;
    }
    const cur = open[bi];
    open.splice(bi, 1);
    if (cur === goalK) {
      const path = [];
      for (let k = cur; k !== -1; k = came[k]) path.push({ x: k % W, y: Math.floor(k / W) });
      return path.reverse();
    }
    closed[cur] = 1;
    const cx = cur % W, cy = Math.floor(cur / W);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || !walkable(nx, ny)) continue;
      const nk = key(nx, ny);
      if (closed[nk]) continue;
      const ng = g[cur] + 1;
      if (ng < g[nk]) {
        g[nk] = ng;
        came[nk] = cur;
        if (!open.includes(nk)) open.push(nk);
      }
    }
  }
  return null;
}
