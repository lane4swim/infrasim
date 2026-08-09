// ---------------------------------------------------------------------
// RENDER LOOP  (§8) — simTick() no longer runs here at all. The
// simulation itself now lives in a Web Worker (see
// src/worker/worker-client.js), ticking on its own setInterval(TICK_MS)
// independent of this page's framerate; this loop's only job is to keep
// redrawing the shadow `world` that worker-client.js's onmessage handler
// overwrites each time a snapshot arrives.
// ---------------------------------------------------------------------
function frame(){
  render();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------
// RENDERING — isometric grid (§ Begin transferring to an isometric grid).
// The simulation's own grid (world.js) is still a plain orthogonal (x,y)
// integer grid — pathfinding, occupancy, footprints, everything in sim/*.js
// is completely unaware any of this exists. Only the SCREEN mapping
// changed: every grid coordinate now goes through gridToScreen (or its
// exact inverse, screenToGrid, for turning a mouse click back into a grid
// cell — see ui.js's cellFromEvent) instead of the old flat `x*CELL,y*CELL`
// multiply. This is deliberately the classic 2:1 "diamond" projection
// (ISO_W wide, ISO_H = ISO_W/2 tall per cell) rather than a true 3D camera
// — it's a linear map, so anything that was a straight line in grid space
// (a road edge, a grid line spanning the whole map) is STILL a straight
// line on screen, just angled; only shapes that relied on axes being
// perpendicular (a building footprint, terrain fill) need to become
// explicit filled polygons instead of fillRect.
//
// Deliberately flat (z=0) for now — elevation still only tints color, it
// doesn't yet lift a raised cell's diamond up-screen the way a "real"
// isometric terrain relief would. Doing that properly means solving mouse
// picking against a height field (a screen point no longer maps to a
// single unambiguous grid cell once tiles can overlap vertically), which
// is a separate, harder problem from the flat projection here — left for
// a later increment rather than attempted in this pass.
const ISO_W = CELL*2, ISO_H = CELL;         // one diamond's full width/height
const ISO_ORIGIN_X = GRID_H*ISO_W/2;        // shifts the diamond so the whole grid has no negative screen-x
const ISO_ORIGIN_Y = 0;
// Forward transform — grid coordinates (fractional; a cell's own corners
// are at integer (x,y), its center at (x+0.5,y+0.5), same convention the
// old `x*CELL` code used) to a screen pixel position.
function gridToScreen(gx, gy){
  return [ (gx-gy)*ISO_W/2 + ISO_ORIGIN_X, (gx+gy)*ISO_H/2 + ISO_ORIGIN_Y ];
}
// The exact algebraic inverse of gridToScreen (solve the 2x2 linear system
// above for gx,gy) — screen pixels back to fractional grid coordinates.
// Used by ui.js's cellFromEvent (floors the result to a concrete cell) so
// clicking still targets the right tile under the new projection.
function screenToGrid(sx, sy){
  const px = sx-ISO_ORIGIN_X, py = sy-ISO_ORIGIN_Y;
  return [ px/ISO_W + py/ISO_H, py/ISO_H - px/ISO_W ];
}

// ---------------------------------------------------------------------
// RENDERING
// ---------------------------------------------------------------------
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
// The diamond-projected grid's bounding box — see gridToScreen/ISO_ORIGIN_X
// above for the derivation (GRID_H shifts the left tip of the diamond to
// screen-x 0; the full grid spans (GRID_W+GRID_H) diamond-widths/heights).
// Set here (once, at load) rather than left as index.html's old fixed
// 880x560 attributes, so this always matches whatever GRID_W/GRID_H/CELL
// actually are instead of needing to be hand-kept in sync with them.
canvas.width = (GRID_W+GRID_H)*ISO_W/2;
canvas.height = (GRID_W+GRID_H)*ISO_H/2;

// Edge midpoint for one side of cell (x,y) — where a connection to that
// neighbor actually crosses the tile boundary.
const PORT_OFFSET = {N:[0.5,0], S:[0.5,1], E:[1,0.5], W:[0,0.5]};
function trackPort(x, y, dir){
  const [ox,oy] = PORT_OFFSET[dir];
  return gridToScreen(x+ox, y+oy);
}
// Exactly 2 connected sides is the only case with one obvious, unambiguous
// line to draw — straight through for an opposite pair (N-S/E-W), a clean
// 45° diagonal cutting the corner for an adjacent pair (e.g. N-W) — so
// that's the only case drawn as a direct port-to-port line. Everything
// else has no single pair to prefer: 0 connections (isolated tile) or 1
// (dead end) draws a core with at most one spoke — a ROAD T- or 4-way
// junction does too, one spoke per side meeting at the tile's center,
// since a real road junction genuinely lets traffic converge there. Rail
// is the exception below.
//
// The one exception: a rail cell with 3 or more directions connected (§
// Rail crossings — isRailSwitch, pathfinding.js: a T/3-way junction just
// as much as a genuine 4-way crossing) is never a real any-to-any junction
// — this game has no switch/points equipment, so its straight-through
// pair(s) (N-S and/or E-W, whichever the connected directions complete)
// are always independent through-lines, and travel is restricted to
// whichever one was entered on. Drawing it with the ordinary
// spoke-from-a-filled-center treatment would visually read as "any of
// these directions can reach any other," exactly the turning this shape
// forbids — so each straight-through pair is drawn as a clean line
// instead, with no center hub joining them. A T-junction's lone "branch"
// direction (the one with no opposite present) has no default line at
// all — it's real, built track, just not connected by default — so it
// gets its own short stub spoke to the center instead, reading as
// "present but not through-routed." Road's own T/4-way intersections
// (turning IS allowed there) are untouched — `kind` is only ever 'rail'
// for this case. `diagonalPairs` (only meaningful here, at a genuine rail
// switch — see cmdToggleDiagonalConnection, commands.js) draws one
// additional corner-cutting line per enabled pair whose both directions
// are actually connected here, in the SAME port-to-port style the plain
// 2-connected case already uses below — a real, player-thrown switch
// reads as a real extra line, not a hidden pathfinding-only rule.
function drawTrackCell(x, y, dirs, color, margin, kind, diagonalPairs){
  const width = CELL - margin*2;
  const [cx, cy] = gridToScreen(x+0.5, y+0.5);
  if(kind==='rail' && dirs.length>=3){
    const present = new Set(dirs);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'butt';
    const throughPairs = [['N','S'],['E','W']].filter(([a,b]) => present.has(a) && present.has(b));
    for(const [a,b] of throughPairs){
      const [pa,pb] = [a,b].map(d => trackPort(x,y,d));
      ctx.beginPath(); ctx.moveTo(pa[0],pa[1]); ctx.lineTo(pb[0],pb[1]); ctx.stroke();
    }
    const throughDirs = new Set(throughPairs.flat());
    for(const dir of dirs){
      if(throughDirs.has(dir)) continue; // a T-junction's lone branch direction
      const [px,py] = trackPort(x,y,dir);
      ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(px,py); ctx.stroke();
    }
    for(const pairKey in DIAGONAL_PAIR_PORTS){
      if(!diagonalPairs || !diagonalPairs[pairKey]) continue;
      const [d1,d2] = DIAGONAL_PAIR_PORTS[pairKey];
      if(!present.has(d1) || !present.has(d2)) continue; // corner not buildable here (e.g. a T missing that side)
      const [a,b] = [d1,d2].map(d => trackPort(x,y,d));
      ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]); ctx.stroke();
    }
    return;
  }
  if(dirs.length === 2){
    const [a,b] = dirs.map(d => trackPort(x,y,d));
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    return;
  }
  ctx.fillStyle = color;
  ctx.fillRect(cx-width/2, cy-width/2, width, width); // core — also what a lone spoke's flat end blends into
  if(dirs.length === 0) return; // isolated tile: core only, reads as disconnected
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  for(const dir of dirs){
    const [px,py] = trackPort(x,y,dir);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(px, py);
    ctx.stroke();
  }
}

// Terrain elevation (§ Terrain elevation) — a subtle tint per cell, cool
// blue for below-0 ("valley"), warm tan for above-0 ("hill"), nothing at
// all for elevation 0 (the implicit default, which reads as "no need to
// check"). Deliberately faint (low lightness/alpha) since it sits UNDER
// every other layer and shouldn't compete with track/building colors.
function elevationColor(elevation){
  if(!elevation) return null;
  const t = Math.max(-1, Math.min(1, elevation / ELEVATION_MAX));
  return t > 0 ? `hsla(35, 45%, ${10+t*12}%, 0.9)` : `hsla(212, 50%, ${8+(-t)*10}%, 0.9)`;
}
// deepUnderground/railDeepUnderground are the only "level" infrastructure
// — flat global planes at a constant elevationAt() z (world.js), unlike
// ground/elevated/underground which all move with local terrain and so
// always sit at the same RELATIVE depth from their own column's surface.
// A level tunnel's relative depth below the surface, in contrast, grows
// with local terrain: elevationAt(x,y,'ground') - DEEP_UNDERGROUND_Z is
// dominated by the constant, but the part that actually varies as terrain
// rises is exactly cell.elevation — so that's the z-index signal used
// here to darken the tunnel toward the rock/dirt color it's now buried
// under, reading as the tunnel visually "burrowing into a hillside" the
// higher the local terrain gets above it. Only positive elevation buries
// more (a valley doesn't un-bury a flat tunnel any further than baseline).
function mixTowardBlack(hex, t){
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  const mix = c => Math.round(c * (1-t));
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}
function burialColor(hex, elevation){
  return mixTowardBlack(hex, Math.max(0, Math.min(1, elevation / ELEVATION_MAX)) * 0.65);
}
// Underground level 1 keeps its exact original color/margin (unchanged
// since before multi-level tunnels existed); each deeper level darkens a
// bit further and thickens a bit more, the same "further down reads as
// more hidden" trend deepUnderground's own more extreme treatment already
// established — capped well short of deepUnderground's own darkness so
// the deepest REGULAR level and the separate, reserved deepUnderground
// grade stay visually distinct. The depth-based darkening exists purely to
// tell multiple SIMULTANEOUSLY-VISIBLE levels apart when they're all
// stacked at once (§ Underground visibility toggle) — once the player
// focuses on exactly one level, that reason is moot, so `focused` skips
// the darkening and renders at full clarity instead.
function undergroundLevelColor(level, kind, focused){
  const base = kind==='rail' ? '#4a3a5a' : '#5a4a3a';
  return focused ? base : mixTowardBlack(base, Math.min(0.5, (level-1)*0.18));
}
function undergroundLevelMargin(level){
  return Math.max(4, 6-(level-1));
}
// The two endpoints of one cell-boundary edge segment, for drawing a
// "cliff" marker (see the elevation-delta loop in render() below) — a
// straight line along the actual tile border the ramp-less connectivity
// cap (MAX_ELEVATION_DELTA, commands.js) refuses to join.
function cellEdgeSegment(x,y,dir){
  if(dir==='N') return [gridToScreen(x,y), gridToScreen(x+1,y)];
  if(dir==='S') return [gridToScreen(x,y+1), gridToScreen(x+1,y+1)];
  if(dir==='E') return [gridToScreen(x+1,y), gridToScreen(x+1,y+1)];
  return [gridToScreen(x,y), gridToScreen(x,y+1)]; // 'W'
}
// A cell's 4 corners as one filled/stroked diamond polygon, screen-space —
// the isometric replacement for a plain fillRect(x*CELL,y*CELL,CELL,CELL);
// linear projection turns a grid-aligned square into a parallelogram
// (specifically a rhombus for a single 1x1 cell), never anything curved, so
// this is still just 4 points and a closed path. `w,h` (grid units, default
// 1x1) let the same helper draw a building's whole WxH footprint as one
// diamond instead of a cell at a time.
function diamondPath(x, y, w, h){
  w = w||1; h = h||1;
  const corners = [gridToScreen(x,y), gridToScreen(x+w,y), gridToScreen(x+w,y+h), gridToScreen(x,y+h)];
  ctx.beginPath();
  ctx.moveTo(corners[0][0], corners[0][1]);
  for(let i=1;i<corners.length;i++) ctx.lineTo(corners[i][0], corners[i][1]);
  ctx.closePath();
  return corners;
}

// ---------------------------------------------------------------------
// ISOMETRIC SPRITES (§ Isometric sprites) — an optional per-def `sprites`
// object (loader.js's validateSprites) lets a content pack replace a
// building/vehicle's procedural diamond/rotated-rect fill with real art,
// picked per the direction the entity is actually facing/traveling right
// now. Absent entirely by default — every def without `sprites` keeps
// today's flat-color rendering untouched, same graceful-degrade contract
// every other optional content-pack field already follows.
// ---------------------------------------------------------------------

// Only n/s/e/w are ever produced by resolveDirectionKey below — the sim
// grid is strictly 4-connected (pathfinding.js's ROAD_DIRS has no diagonal
// edge), so ne/nw/se/sw are validated/stored but never selected here. The
// screen vector each real direction produces is NOT the screen-cardinal
// direction the name suggests: running gridToScreen's deltas through each
// grid direction lands e/w on the down-right/up-left diagonal and n/s on
// the up-right/down-left diagonal (diamond projection), so this table is
// derived from gridToScreen itself, not hand-picked angles.
const DIR_SCREEN_VECTOR = {
  e: [ ISO_W/2,  ISO_H/2],
  w: [-ISO_W/2, -ISO_H/2],
  s: [-ISO_W/2,  ISO_H/2],
  n: [ ISO_W/2, -ISO_H/2],
};
// A moving vehicle's real direction key, from the actual next-node delta on
// its path (not just "which axis", the old movingAlongX boolean this
// replaces) — idle/no path defaults to 'e', the same direction the old
// movingAlongX-true default drew.
function vehicleDirectionKey(v){
  if(v.path && v.pathIndex < v.path.length-1){
    const cur = v.path[v.pathIndex], next = v.path[v.pathIndex+1];
    if(next.x > cur.x) return 'e';
    if(next.x < cur.x) return 'w';
    if(next.y > cur.y) return 's';
    if(next.y < cur.y) return 'n';
  }
  return 'e';
}
// A train (one Movement entity spanning engine+wagons — see § Vehicle
// length's "one big literal rectangle" choice, unchanged here) has no
// single content-pack def of its own; it's an assembled Consist. Its
// sprite, if any, is the ENGINE's — the same "one rect, optionally filled
// with an image instead of a flat color" idea trucks use, just sourced from
// a different def, with no new segmented per-wagon drawing logic.
function spriteDefForVehicle(v){
  return isTrain(v.id) ? ENGINE_DEFS[v.consist.engineType] : VEHICLE_DEFS[v.type];
}
// A building has no travel direction, but Stations have a real player-
// chosen `facing` (n/s/e/w) and a Depot's `orientation` ('ns'/'ew') is
// exactly the same 2-state real property depotPlatformCells (pathfinding.js)
// already infers from footprint w-vs-h — reused here rather than adding new
// storage, mapped to 'n' (tall/ns) or 'e' (wide/ew) as representative
// direction keys. Every other building type (Mine/Mill/Town/Train Yard, any
// content-pack production building) has no facing at all and always uses 'n'.
function buildingDirectionKey(e){
  if(e.type==='depot') return e.footprint.h >= e.footprint.w ? 'n' : 'e';
  if(e.facing) return e.facing;
  return 'n';
}

// Sprite defs are decoded into a real Image exactly once per (def,
// direction) and cached forever after — content packs don't change at
// runtime, so there's nothing to invalidate. Keyed by the def object itself
// (BUILDING_DEFS/VEHICLE_DEFS/ENGINE_DEFS entries are already unique per
// type) rather than a string id, so no naming collision is possible across
// sections. Returns null (draw the procedural fallback instead) whenever
// there's no sprite for this exact direction, or the Image hasn't finished
// decoding yet — a data: URI decodes same-tick in every browser this game
// targets, but checking `complete` costs nothing and keeps this correct
// even if that ever isn't true.
const spriteImageCache = new Map(); // def -> {dirKey: Image}
function spriteImageFor(def, dirKey){
  if(!def || !def.sprites) return null;
  const sprite = def.sprites[dirKey];
  if(!sprite) return null;
  let byDir = spriteImageCache.get(def);
  if(!byDir){ byDir = {}; spriteImageCache.set(def, byDir); }
  let img = byDir[dirKey];
  if(!img){
    img = new Image();
    img.src = spriteDataUri(sprite);
    byDir[dirKey] = img;
  }
  return (img.complete && img.naturalWidth>0) ? img : null;
}

function render(){
  ctx.clearRect(0,0,canvas.width,canvas.height);

  // Terrain fill — drawn first, under everything, including the grid
  // lines, so it reads as ground itself rather than a UI overlay.
  for(const [k,cell] of world.grid){
    const color = elevationColor(cell.elevation);
    if(!color) continue;
    const [x,y] = k.split(',').map(Number);
    ctx.fillStyle = color;
    diamondPath(x, y);
    ctx.fill();
  }

  // grid lines — a line of constant grid-x (or grid-y) is still a straight
  // line after a LINEAR projection like gridToScreen, just angled instead
  // of vertical/horizontal, so this is still exactly one line per grid
  // index, only the two endpoints' pixel positions changed.
  ctx.strokeStyle = getCss('--grid-line');
  ctx.lineWidth = 1;
  for(let x=0;x<=GRID_W;x++){
    const [ax,ay] = gridToScreen(x,0), [bx,by] = gridToScreen(x,GRID_H);
    ctx.beginPath(); ctx.moveTo(ax,ay); ctx.lineTo(bx,by); ctx.stroke();
  }
  for(let y=0;y<=GRID_H;y++){
    const [ax,ay] = gridToScreen(0,y), [bx,by] = gridToScreen(GRID_W,y);
    ctx.beginPath(); ctx.moveTo(ax,ay); ctx.lineTo(bx,by); ctx.stroke();
  }

  // Cliff markers — a thick dark line along the shared border of two
  // adjacent cells whose terrain (ground.elevation) differs by more than
  // MAX_ELEVATION_DELTA, i.e. exactly the pairs elevationBlocksConnection
  // (commands.js) refuses to auto- or manually connect. Checked from every
  // cell in all four directions (not just E/S) so a cliff is always drawn
  // from whichever side of the pair happens to be the one that's actually
  // been terraformed (an untouched cell is never in world.grid, and always
  // reads as elevation 0 — see terraform in commands.js).
  for(const [k] of world.grid){
    const [x,y] = k.split(',').map(Number);
    for(const {dir,dx,dy} of ROAD_DIRS){
      const nx=x+dx, ny=y+dy;
      if(!inBounds(nx,ny)) continue;
      if(Math.abs(elevationAt(x,y,'ground') - elevationAt(nx,ny,'ground')) <= MAX_ELEVATION_DELTA) continue;
      const [[ax,ay],[bx,by]] = cellEdgeSegment(x,y,dir);
      ctx.strokeStyle = '#1a1410';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(ax,ay); ctx.lineTo(bx,by); ctx.stroke();
    }
  }

  // roads — connected edges render as a single straight line between their
  // two port midpoints, so an isolated tile visibly reads as disconnected,
  // a through-route reads as one continuous line, and — the point of this
  // scheme — a turn reads as a genuine diagonal cutting the corner, not a
  // blocky right-angle elbow bent through the tile's center; see
  // drawTrackCell below for exactly which cases get a direct line vs. a
  // center-based spoke. Ground is drawn first, elevated on top in a
  // distinct color so a crossing (both layers occupying the same cell
  // without connecting) is visible as two independent lines rather than
  // one merged road.
  // Underground levels (§ Multi-level tunnels) are drawn FIRST and dashed,
  // deepest level first, stacked as a muted "X-ray" hint by default — but
  // `undergroundView` (§ Underground visibility toggle) can narrow that
  // down to exactly one level: `'all'` (the default) keeps every level
  // stacked and depth-darkened as before; any other value shows ONLY that
  // one grade, at full undarkened clarity (see undergroundLevelColor's
  // `focused` param), and skips every other underground level entirely —
  // a real "which level am I looking at" view, not just a dimmer hint.
  // Ground/elevated content painted after it naturally covers it wherever
  // both exist at the same cell either way.
  // deepUnderground is a flat global plane one grade below the deepest
  // (terrain-following) underground level — an even thicker, dimmer dashed
  // line than any regular level's, since it's the deepest, most hidden
  // thing on the map, and it further darkens per-cell under raised terrain
  // (see burialColor above) — a "level" tunnel visually burrows deeper
  // into a hillside exactly where the hillside actually rises above it.
  // That terrain-burial darkening is real information (not a
  // stacked-levels artifact), so it stays even when deepUnderground is
  // the sole focused view. airspace is the mirror image at the opposite
  // end: a flat global plane above elevated, drawn as a thin, bright
  // dashed line since it's the highest, most "in the open" thing on the
  // map — it doesn't get the burial treatment (going up into open sky
  // isn't "burrowing") or the view toggle (it's not part of the
  // underground stack the toggle narrows). Both drawn FIRST/LAST
  // respectively in this group so ground/elevated still paint over them
  // wherever both exist at the same cell.
  const undergroundView = currentUndergroundView();
  if(undergroundView==='all' || undergroundView==='deepUnderground') drawRoadLayer('deepUnderground', '#3a2a1a', 4, true, true);
  for(let level=UNDERGROUND_LEVELS; level>=1; level--){
    const grade = undergroundGradeName(level);
    if(undergroundView!=='all' && undergroundView!==grade) continue;
    drawRoadLayer(grade, undergroundLevelColor(level,'road',undergroundView===grade), undergroundLevelMargin(level), true);
  }
  drawRoadLayer('ground', getCss('--road'), 8);
  drawRoadLayer('elevated', '#7fb8c9', 12);
  drawRoadLayer('airspace', '#8ac9e8', 14, true);
  // Rail reuses drawRoadLayer entirely unchanged — same {track,edges,
  // oneWayBlocked} shape, so a signal renders exactly like a one-way arrow
  // for free, and rail crossing a road at the same cell reads as two
  // independent lines (different layer key, never auto-connected).
  // railElevated is rail's own bridge layer (rail ramps, not roads) — a
  // lighter tint of rail's purple, the same relationship elevated road's
  // light blue has to ground road's gray. Each railUnderground level/
  // railDeepUnderground/railAirspace are the same dashed/muted treatment
  // as their road counterparts, just rail's own hue — railDeepUnderground
  // gets the same per-cell burial darkening as deepUnderground, for the
  // same reason, and the same `undergroundView` filtering applies here too.
  if(undergroundView==='all' || undergroundView==='deepUnderground') drawRoadLayer('railDeepUnderground', '#2a1a3a', 6, true, true);
  for(let level=UNDERGROUND_LEVELS; level>=1; level--){
    const grade = undergroundGradeName(level);
    if(undergroundView!=='all' && undergroundView!==grade) continue;
    drawRoadLayer(undergroundRailLayerName(level), undergroundLevelColor(level,'rail',undergroundView===grade), undergroundLevelMargin(level), true);
  }
  drawRoadLayer('rail', '#9b6bd6', 10);
  drawRoadLayer('railElevated', '#c9a8e8', 13);
  drawRoadLayer('railAirspace', '#d8b8f0', 15, true);

  // ramps — a small diamond marking a cell where a layer pair is
  // deliberately linked (one of the only two places a vehicle can change
  // layer, alongside the lateral Tunnel Ramp below): the road Ramp
  // (ground<->elevated) in elevated road's own light blue, the independent
  // Rail Ramp (rail<->railElevated) in elevated rail's own light purple.
  // Looped over RAMP_PAIRS (currently just this one entry — see world.js
  // for why deepUnderground/airspace have no ramp pair) rather than
  // hardcoded, so a future same-cell-shaped ramp pair only needs a new
  // RAMP_PAIRS entry and a color here, not new drawing logic.
  const RAMP_MARKER_COLOR = {
    road: { groundElevated: '#7fb8c9' },
    rail: { groundElevated: '#c9a8e8' },
  };
  for(const [k,cell] of world.grid){
    const [x,y] = k.split(',').map(Number);
    const [cx, cy] = gridToScreen(x+0.5, y+0.5);
    for(const kind of ['road','rail']){
      for(const pair of RAMP_PAIRS){
        if(!cell.ramps[kind][pair.key]) continue;
        ctx.save();
        ctx.translate(cx,cy); ctx.rotate(Math.PI/4);
        ctx.fillStyle = RAMP_MARKER_COLOR[kind][pair.key];
        ctx.fillRect(-5,-5,10,10);
        ctx.restore();
      }
    }
  }

  // Tunnel ramp markers (§ Underground layer; § Multi-level tunnels) — a
  // ramp edge is a property of one specific direction on one specific
  // cell (not the whole cell, like the same-cell Ramp diamonds above), so
  // its marker sits at the edge port the ramp actually descends through,
  // not the cell center — visually distinct in both position and shape (a
  // smaller diamond right at the boundary the vehicle actually crosses).
  // Checked from every grade that can be a ramp's UPPER side — ground, and
  // every underground level except the deepest (which is only ever a
  // LOWER side within the stack) — so each physical ramp gets exactly one
  // marker, not one from each side. rampEdge[dir] stores the target grade
  // directly, which doubles as the color key: a ramp descending further
  // (a deeper level's own color) reads as visually "deeper" than one just
  // off the surface, the same trend the track lines themselves follow.
  // Filtered by `undergroundView` (§ Underground visibility toggle) the
  // same way the track lines are — a ramp only shows if the focused level
  // is one of the two grades it actually connects, so the marker never
  // dangles at a level the player isn't currently looking at.
  const tunnelRampUpperGrades = ['ground'];
  for(let level=1; level<UNDERGROUND_LEVELS; level++) tunnelRampUpperGrades.push(undergroundGradeName(level));
  for(const [k,cell] of world.grid){
    const [x,y] = k.split(',').map(Number);
    for(const grade of tunnelRampUpperGrades){
      for(const {dir} of ROAD_DIRS){
        const roadTarget = cell.layers[grade].road.rampEdge[dir];
        if(roadTarget && (undergroundView==='all' || undergroundView===grade || undergroundView===roadTarget)) drawTunnelRampMarker(x,y,dir, undergroundLevelColor(undergroundLevelOfGrade(roadTarget)||1,'road',undergroundView===roadTarget));
        const railTarget = cell.layers[grade].rail.rampEdge[dir];
        if(railTarget && (undergroundView==='all' || undergroundView===grade || undergroundView===railTarget)) drawTunnelRampMarker(x,y,dir, undergroundLevelColor(undergroundLevelOfGrade(railTarget)||1,'rail',undergroundView===railTarget));
      }
    }
  }
  function drawTunnelRampMarker(x,y,dir,color){
    const [px,py] = trackPort(x,y,dir);
    ctx.save();
    ctx.translate(px,py); ctx.rotate(Math.PI/4);
    ctx.fillStyle = color;
    ctx.fillRect(-4,-4,8,8);
    ctx.restore();
  }

  // level crossings — a small white X marking a cell where a road layer and
  // its same-grade rail layer physically share the same grid cell
  // (necessarily crossing at a right angle; see
  // connectNewTileEdges/directionClaimedByOtherNetwork in commands.js for
  // why the two networks can never overlap in the same direction here).
  // Checked at both grades — ground road vs. ground rail, and elevated
  // road vs. elevated rail — either can independently be a crossing at the
  // same cell. Also exactly where a train passing through blocks road
  // traffic (at the SAME grade) until it clears — see
  // markTrainCrossingsOccupied in systems.js — so this marker doubles as
  // "vehicles may have to wait here."
  // Also filtered by `undergroundView`: a crossing marker for a hidden
  // underground level would otherwise float with no visible track lines
  // around it, since the level itself isn't being drawn.
  const crossingCheckLayers = ['rail', 'railElevated', 'railAirspace'];
  if(undergroundView==='all' || undergroundView==='deepUnderground') crossingCheckLayers.push('railDeepUnderground');
  for(let level=1; level<=UNDERGROUND_LEVELS; level++){
    const grade = undergroundGradeName(level);
    if(undergroundView==='all' || undergroundView===grade) crossingCheckLayers.push(undergroundRailLayerName(level));
  }
  for(const [k] of world.grid){
    const [x,y] = k.split(',').map(Number);
    if(!crossingCheckLayers.some(layer => isRoadRailCrossing(x,y,layer))) continue;
    const [cx, cy] = gridToScreen(x+0.5, y+0.5);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx-6,cy-6); ctx.lineTo(cx+6,cy+6);
    ctx.moveTo(cx+6,cy-6); ctx.lineTo(cx-6,cy+6);
    ctx.stroke();
  }

  function drawRoadLayer(layerName, color, margin, dashed, buries){
    if(dashed) ctx.setLineDash([5,4]); // underground/railUnderground only — see the call sites above
    const [, kind] = LAYER_GRADE_KIND[layerName];
    for(const [k] of world.grid){
      const [x,y] = k.split(',').map(Number);
      const track = trackAt(x,y,layerName);
      if(!track.track) continue;
      // `buries` (deepUnderground/railDeepUnderground only — see
      // burialColor above) darkens this ONE cell's line per its own local
      // terrain height, rather than using the flat `color` for the whole
      // layer the way every other grade does.
      const cellColor = buries ? burialColor(color, getCell(x,y).elevation) : color;
      const connectedDirs = ROAD_DIRS.filter(d => track.edges[d.dir]).map(d => d.dir);
      drawTrackCell(x, y, connectedDirs, cellColor, margin, kind, track.diagonalPairs);
      for(const {dir,dx,dy,opp} of ROAD_DIRS){
        if(!track.edges[dir]) continue;
        // One-way arrow: drawn only from the side that's still allowed to
        // depart, so each physical one-way edge gets exactly one arrow.
        const nTrack = trackAt(x+dx, y+dy, layerName);
        const thisBlocked = track.oneWayBlocked[dir];
        const otherBlocked = nTrack.oneWayBlocked[opp];
        if(!thisBlocked && otherBlocked) drawOneWayArrow(x, y, dir, margin);
      }
    }
    if(dashed) ctx.setLineDash([]);
  }
  function drawOneWayArrow(x, y, dir, margin){
    // N/S/E/W no longer map to fixed screen-up/down/right/left angles once
    // the grid is projected isometrically, so the rotation is computed from
    // the actual on-screen direction toward this side's port (trackPort)
    // rather than a hardcoded per-direction table — this generalizes
    // correctly under any linear projection, iso or the old orthogonal one.
    const [cx, cy] = gridToScreen(x+0.5, y+0.5);
    const [px, py] = trackPort(x, y, dir);
    const rot = Math.atan2(py-cy, px-cx);
    const dist = Math.hypot(px-cx, py-cy);
    ctx.save();
    ctx.translate(cx,cy); ctx.rotate(rot);
    ctx.fillStyle = getCss('--amber');
    const tip = dist - margin - 2, size = 5;
    ctx.beginPath();
    ctx.moveTo(tip, 0);
    ctx.lineTo(tip-size, -size);
    ctx.lineTo(tip-size, size);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // buildings — the footprint itself is one filled diamond (diamondPath),
  // covering exactly the WxH grid cells it actually occupies, same as the
  // old fillRect did before the grid became isometric. Everything ELSE
  // (label, storage bars, linked-dot) is drawn as a flat, unwarped overlay
  // "billboarded" at the footprint's projected center instead of fitted to
  // the diamond's slanted edges — the same convention most isometric games
  // use for their in-scene UI text, and far simpler than trying to wrap
  // text/bars onto a parallelogram. The platform-side highlight below is
  // the one exception: it's showing WHICH physical edge of the real
  // footprint the platform runs along, so it draws the actual diamond edge
  // rather than a billboard.
  for(const id of queryEntities('Footprint')){
    const e = world.entities.get(id);
    const def = BUILDING_DEFS[e.type];
    const fp = e.footprint;
    const corners = diamondPath(e.x, e.y, fp.w, fp.h);
    const spriteImg = spriteImageFor(def, buildingDirectionKey(e));
    if(spriteImg){
      // A sprite is pre-rendered art, not a shape to fill — drawn as a
      // plain rect fit to the diamond's screen-space bounding box (the
      // artist bakes the isometric look into the image itself, transparent
      // corners and all), the same way real isometric games composite
      // pre-rendered building art rather than warping a texture onto a
      // parallelogram.
      const xs = corners.map(c=>c[0]), ys = corners.map(c=>c[1]);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      ctx.drawImage(spriteImg, minX, minY, Math.max(...xs)-minX, Math.max(...ys)-minY);
    } else {
      ctx.fillStyle = def.color;
      ctx.fill();
    }
    const halted = producerHalted(e);
    if(halted){ ctx.strokeStyle = getCss('--danger'); ctx.lineWidth=2; diamondPath(e.x, e.y, fp.w, fp.h); ctx.stroke(); }
    if(e===selected){ ctx.strokeStyle = getCss('--amber'); ctx.lineWidth=2; diamondPath(e.x, e.y, fp.w, fp.h); ctx.stroke(); }

    const [ccx, ccy] = gridToScreen(e.x+fp.w/2, e.y+fp.h/2);
    ctx.fillStyle = '#fff';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${def.label} #${e.id}`, ccx, ccy-6);
    ctx.textAlign = 'left';
    // Fill bar(s) (Stations have no storage of their own — show a linked/
    // unlinked indicator dot instead). A building with only one slot (Mine:
    // out; Town: in) gets one bar; a dual-slot building (Mill: both) gets
    // two stacked bars — output on top in teal, input below in a distinct
    // color — so you can see both buffers at a glance instead of just one
    // ambiguous number.
    if(e.type==='station'){
      const linked = !!findLinkedIndustry(e);
      ctx.fillStyle = linked ? getCss('--teal') : getCss('--danger');
      ctx.beginPath(); ctx.arc(ccx+14, ccy+8, 4, 0, Math.PI*2); ctx.fill();
      // notch on the facing side — the only side that can ever touch a road
      if(e.facing){
        const d = ROAD_DIRS.find(r=>r.dir===e.facing);
        const [nx, ny] = gridToScreen(e.x+fp.w/2 + d.dx*fp.w*0.4, e.y+fp.h/2 + d.dy*fp.h*0.4);
        ctx.fillStyle = getCss('--amber');
        ctx.beginPath(); ctx.arc(nx, ny, 4, 0, Math.PI*2); ctx.fill();
      }
    } else {
      const bars = [];
      if(e.type==='depot'){
        // out and in are the same physical pile here (see createBuilding) —
        // one bar, not two identical stacked ones. When linked to an
        // industry (directly, or through a chain of Stations — same
        // forwarding a truck's Station does), trains bypass the Depot's
        // own pile entirely, so the bar shows the linked industry's real
        // stock instead — whichever slot it actually has (a Mine only
        // has `out`, a Town only `in`), since that's the number actually
        // moving now.
        const linked = findLinkedIndustry(e);
        const source = linked || e;
        const stock = source.outStock!==undefined ? source.outStock : source.inStock;
        const cap = source.outStock!==undefined ? source.outCap : source.inCap;
        bars.push({stock, cap, color:getCss('--teal')});
      } else {
        if(e.outStock!==undefined) bars.push({stock:e.outStock, cap:e.outCap, color:getCss('--teal')});
        if(e.inStock!==undefined) bars.push({stock:e.inStock, cap:e.inCap, color:'#7fb8c9'});
      }
      const barW = 34, barH = 4, gap = 1;
      bars.forEach((bar, i)=>{
        const y = ccy+2+i*(barH+gap);
        const pct = bar.cap>0 ? bar.stock/bar.cap : 0;
        ctx.fillStyle = 'rgba(0,0,0,.5)';
        ctx.fillRect(ccx-barW/2, y, barW, barH);
        ctx.fillStyle = bar.color;
        ctx.fillRect(ccx-barW/2, y, barW*pct, barH);
      });
    }
    // The platform edge — a real loading platform runs alongside the
    // track it serves for its whole length (§ Depot parallel-track
    // requirement), so highlight whichever long side actually qualifies,
    // right against the footprint's actual edge, reading as "this is the
    // side trains dock along" the same way a Station's facing notch reads
    // as "this is the side that touches a road."
    if(e.type==='depot'){
      const platform = depotPlatformCells(e.x, e.y, fp.w, fp.h);
      if(platform){
        ctx.strokeStyle = getCss('--amber');
        ctx.lineWidth = 3;
        ctx.beginPath();
        let a, b;
        if(platform[0].x < e.x || platform[0].x >= e.x+fp.w){
          const lx = platform[0].x < e.x ? e.x : e.x+fp.w;
          a = gridToScreen(lx, e.y); b = gridToScreen(lx, e.y+fp.h);
        } else {
          const ly = platform[0].y < e.y ? e.y : e.y+fp.h;
          a = gridToScreen(e.x, ly); b = gridToScreen(e.x+fp.w, ly);
        }
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
    }
  }

  // vehicles — drawn at their interpolated sub-tile position so fractional
  // speeds actually read as smooth motion instead of a jump once per cell
  for(const id of queryEntities('Movement')){
    const v = world.entities.get(id);
    let drawX = v.x, drawY = v.y;
    if(v.path && v.pathIndex < v.path.length-1 && v.frac > 0){
      const a = v.path[v.pathIndex], b = v.path[v.pathIndex+1];
      drawX = a.x + (b.x-a.x)*v.frac;
      drawY = a.y + (b.y-a.y)*v.frac;
    }
    const [cx, cy] = gridToScreen(drawX+0.5, drawY+0.5);

    // Every vehicle is drawn as a rectangle oriented along its direction of
    // travel, its long side scaled 1:1 with its own `length` (tile-units) —
    // the SAME unit `footprintKeysFor` already reserves cells with
    // (§ shared movement engine), so a vehicle's rendered footprint and its
    // actual physical reservation footprint agree. This is deliberately
    // literal rather than compressed: a heavily-loaded train (engine + up
    // to 6 wagons, ~10-20 tiles) is SUPPOSED to visibly span a big stretch
    // of track — that's the same "one expensive asset, one big commitment"
    // identity the Train Yard's cost/capacity numbers already carry,
    // arriving for free with an honest length scale instead of a special
    // train-only case. A truck's much smaller (~1.2-1.7 tile) length still
    // reads as a subtle size difference between e.g. a Bulk Truck and the
    // slightly longer Flatbed, rather than needing its own compressed scale.
    //
    // Under the isometric projection grid-x and grid-y travel are no longer
    // screen-horizontal/vertical, so the rectangle is drawn in a local frame
    // rotated to match the real on-screen travel direction: `stepLen` is the
    // screen-pixel distance covered by one grid-unit of travel along EITHER
    // axis (equal for both, by diamond symmetry), and `angle` is that
    // direction's screen angle (DIR_SCREEN_VECTOR, § Isometric sprites — the
    // same table a sprite lookup uses to pick which of the 4 real directions
    // this vehicle is facing).
    const dirKey = vehicleDirectionKey(v);
    const angle = Math.atan2(DIR_SCREEN_VECTOR[dirKey][1], DIR_SCREEN_VECTOR[dirKey][0]);
    const stepLen = Math.hypot(ISO_W/2, ISO_H/2);
    const longPx = stepLen * v.length;
    const shortPx = CELL * 0.42;
    const spriteImg = spriteImageFor(spriteDefForVehicle(v), dirKey);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    if(spriteImg){
      ctx.drawImage(spriteImg, -longPx/2, -shortPx/2, longPx, shortPx);
      if(v.state==='blocked'){
        ctx.strokeStyle = getCss('--danger'); ctx.lineWidth=2;
        ctx.strokeRect(-longPx/2-2, -shortPx/2-2, longPx+4, shortPx+4);
      }
    } else {
      ctx.fillStyle = v.state==='blocked' ? getCss('--danger') : getVehicleStats(v).color;
      ctx.fillRect(-longPx/2, -shortPx/2, longPx, shortPx);
    }
    if(v.layer==='elevated' || v.layer==='railElevated' || v.layer==='airspace' || v.layer==='railAirspace'){
      // Same "above ground" outline for elevated AND airspace — both mean
      // "currently above ground level," so one shared visual cue is enough
      // (solid, vs. underground/deepUnderground's dashed "below ground"
      // outline below).
      ctx.strokeStyle='#7fb8c9'; ctx.lineWidth=2;
      ctx.strokeRect(-longPx/2-2, -shortPx/2-2, longPx+4, shortPx+4);
    }
    if(/^(rail)?[Uu]nderground\d*$/.test(v.layer) || v.layer==='deepUnderground' || v.layer==='railDeepUnderground'){
      // Same idea, dashed instead of solid — "below ground" (any
      // underground level, or deepUnderground) reads as the opposite of
      // "above ground," and the dash matches the dashed underground/
      // deepUnderground track itself. The regex covers every underground
      // level's road/rail layer name (underground, underground2, ...,
      // railUnderground, railUnderground2, ...) without needing to list
      // them, the same way the draw calls above are generated from
      // UNDERGROUND_LEVELS rather than hardcoded.
      ctx.setLineDash([4,3]);
      ctx.strokeStyle='#8a7a6a'; ctx.lineWidth=2;
      ctx.strokeRect(-longPx/2-2, -shortPx/2-2, longPx+4, shortPx+4);
      ctx.setLineDash([]);
    }
    if(v===selected){
      ctx.strokeStyle='#fff'; ctx.lineWidth=2;
      ctx.strokeRect(-longPx/2-3, -shortPx/2-3, longPx+6, shortPx+6);
    }
    ctx.restore();
  }

  // hover ghost for build tools — sized to the building's footprint where relevant
  if(hoverCell){
    ctx.strokeStyle = getCss('--teal');
    ctx.lineWidth = 2;
    if(BUILDING_DEFS[currentTool]){
      // Any building tool (§ Dynamic toolbar — generated production
      // buildings included, not just the hand-written Town/Station/Depot/
      // Train Yard) gets a footprint-sized ghost; Depot's is length/
      // orientation-dependent, everyone else's is just their def.footprint.
      const fp = currentTool==='depot' ? effectiveFootprint('depot', BUILDING_DEFS.depot, currentDepotOrientation(), currentDepotLength()) : BUILDING_DEFS[currentTool].footprint;
      diamondPath(hoverCell.x, hoverCell.y, fp.w, fp.h);
      ctx.stroke();
    } else if(currentTool==='road' || currentTool==='track' || VEHICLE_DEFS[currentTool] || currentTool==='assembletrain'){
      diamondPath(hoverCell.x, hoverCell.y, 1, 1);
      ctx.stroke();
    }
  }

  // Elevation numbers — only where non-zero (0 is the implicit default,
  // reads as "no need to check"); drawn last so they stay legible over
  // track/terrain/vehicles rather than getting buried under them.
  ctx.font = '9px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.textAlign = 'center';
  for(const [k,cell] of world.grid){
    if(!cell.elevation) continue;
    const [x,y] = k.split(',').map(Number);
    const [lx, ly] = gridToScreen(x+0.5, y+0.7);
    ctx.fillText((cell.elevation>0?'+':'')+cell.elevation, lx, ly);
  }
  ctx.textAlign = 'left';

  // HUD
  const treasuryEl = document.getElementById('treasury');
  treasuryEl.textContent = '$' + world.treasury;
  treasuryEl.classList.toggle('negative', world.treasury < 0);
  document.getElementById('tickInfo').textContent = 'tick ' + world.tick;
}
function getCss(varName){ return getComputedStyle(document.documentElement).getPropertyValue(varName).trim(); }
