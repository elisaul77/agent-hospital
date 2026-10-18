# Guardia nocturna — isolated Astra proposal

Standalone procedural clinic, copied from `public/` and modified only here. The default scene is explicitly labeled **SIMULACIÓN LOCAL**; it is fabricated demonstration state, not connected activity. No images or runtime libraries are downloaded. Optional VT323 comes from Google Fonts; monospace remains usable offline.

## Run

From the repository root:

```bash
python3 -m http.server 8714 --bind 127.0.0.1 --directory design/codex-astra
```

Open http://127.0.0.1:8714/. Drag the courtyard, scroll or use +/− to zoom, use Centrar to reset, and Casos to inspect cases. The local specialist makes a round every eight seconds. For live/demo SSE, serve this directory from the existing hospital server or a same-origin proxy supplying `/events`; the plain Python server cannot supply SSE. Choose En vivo or Demo SSE, optionally enter a session. Switching sources closes the old stream, clears the timer, positions, occupied seats, and state.

Capture in an environment permitting Flatpak and local sockets:

```bash
flatpak run --share=network --filesystem="$PWD/design/codex-astra" com.google.Chrome \
  --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
  --force-color-profile=srgb --window-size=1600,1100 --timeout=5000 \
  --screenshot="$PWD/design/codex-astra/shot.png" http://127.0.0.1:8714/
```

`?freeze=Read|Bash|Grep` freezes equipment and enables tool bubbles. `?freezeWarn=held|fixed|must_fix|acceptable` preserves the original render-only warning fixtures. HTTP is preferred; local file modules require browser file-access support.

## Merge map and contracts

- `index.html` → `public/index.html`: full-viewport canvas, pixel HUD, source/session controls, accessible buttons, case inspector, relative script entry.
- `js/main.js` → integration reference for `public/js/main.js`: camera controls, source lifecycle, seat reconciliation and A* stepping; includes local simulation choice. Integrate deliberately with any concurrent production changes.
- `js/scenery.js` → new procedural furnishing painter: raised rear walls, desks, cool monitors, beds, archive cabinets, cherrywood council table, chairs, plants, clocks, notices and conduits. Furniture is visual; walkability is unchanged.
- `js/render.js` → `createRenderer(canvas,map).draw(view,positions,now,opts={})` retained. Adds `opts.camera={x,y,scale}` and opt-in `opts.bubbles`, night courtyard, furniture; agents sort by world y. Gurneys retain warning threads, lamp, chock, held-door anchor and shutter.
- `js/sprites.js` → retained `drawAgent`, `drawGurney`, `drawBubble`, `hash`; role sprites enlarged 2× with walking/breathing movement and original role silhouettes.
- `js/demo.js` → optional isolated local fixture; complete view/agent/case shapes. Does not send anything to a server or alter reducer state.
- `js/map.js`, `js/path.js`, `js/net.js`, `js/anim.js` are reused copies. All eleven room names, tile-space positions and `findPath`/`connect` contracts remain. SSE named snapshot is a full view and delta `{events,state}` replaces the full view.
- Warning helper exports `equipmentOf`, `gateBlocked`, `threadsOf`, `warningSummary`, `frozenWarnView` retained. Open/unruled/acceptable/must_fix block; accepted does not; fixed drops for 1500 ms. Held cases retain their logical room, and no warning prose is drawn on canvas.

## Verification and limitations

First move: inspected and reused the map, A*, SSE and warning helpers before building visual changes; reviewed the original demo and warning screenshot. Existing source tests were left untouched. Local copies of animation/path tests run against this proposal; additional runtime tests check fixture shape, held-room invariant, all roles drawing without state mutation or leaked warning text, and HUD initialization/zoom/reset/drag/source-switch.

```bash
node --test design/codex-astra/test/*.test.js
```

Result: **3/3 test files pass**, no skipped/failed files. Syntax checked for main/render and subsequently all local JavaScript files. Canvas/DOM tests use an adapter; they do not prove browser rasterization or actual pointer delivery.

**Browser visual verification BLOCKED:** HTTP bind fails `PermissionError: [Errno 1] Operation not permitted`. Flatpak Chrome fails `error: Could not connect: Operation not permitted`. No screenshot was produced or fabricated. `shot.png` is intentionally absent pending a permitted capture. Font loading, final visual layout, real SSE connection, responsive browser rendering and actual browser interaction remain unverified. Furnishings are currently cached background drawings; agents are depth-sorted with each other, but do not dynamically occlude behind furniture. Camera zoom is restricted to integer 1×–4× levels and role enlargement is integer 2×. Reset/resize chooses the largest integer scale that fits, with a minimum of 1×; smaller screens must pan to see the whole map. Every frame restores disabled image smoothing after canvas resizing. These are integration/polish limitations, not changes to logical navigation.

Review regression: the runtime test failed before correction (exit 1), then passed with simulated canvas-width resets asserting smoothing is disabled before drawImage, integer character/camera scales, and desktop/mobile HUD zoom checks. Furniture remains background art and can visibly overlap walking agents; full furniture occlusion/navigation is deferred rather than represented as verified.
