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
// RENDERING
// ---------------------------------------------------------------------
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

// Edge midpoint for one side of cell (x,y) — where a connection to that
// neighbor actually crosses the tile boundary.
const PORT_OFFSET = {N:[0.5,0], S:[0.5,1], E:[1,0.5], W:[0,0.5]};
function trackPort(x, y, dir){
  const [ox,oy] = PORT_OFFSET[dir];
  return [x*CELL + ox*CELL, y*CELL + oy*CELL];
}
// Exactly 2 connected sides is the only case with one obvious, unambiguous
// line to draw — straight through for an opposite pair (N-S/E-W), a clean
// 45° diagonal cutting the corner for an adjacent pair (e.g. N-W) — so
// that's the only case drawn as a direct port-to-port line. Everything
// else has no single pair to prefer: 0 connections (isolated tile) or 1
// (dead end) draws a core with at most one spoke, same as multiple
// directions (a T- or 4-way junction) draws a core with one spoke per
// side, all meeting at the tile's center — unchanged from before this
// scheme, since a junction genuinely has multiple lines converging here,
// not one to straighten out.
function drawTrackCell(x, y, dirs, color, margin){
  const width = CELL - margin*2;
  const cx = x*CELL+CELL/2, cy = y*CELL+CELL/2;
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
  const x0=x*CELL, y0=y*CELL;
  if(dir==='N') return [[x0,y0],[x0+CELL,y0]];
  if(dir==='S') return [[x0,y0+CELL],[x0+CELL,y0+CELL]];
  if(dir==='E') return [[x0+CELL,y0],[x0+CELL,y0+CELL]];
  return [[x0,y0],[x0,y0+CELL]]; // 'W'
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
    ctx.fillRect(x*CELL, y*CELL, CELL, CELL);
  }

  // grid lines
  ctx.strokeStyle = getCss('--grid-line');
  ctx.lineWidth = 1;
  for(let x=0;x<=GRID_W;x++){ ctx.beginPath(); ctx.moveTo(x*CELL+.5,0); ctx.lineTo(x*CELL+.5,GRID_H*CELL); ctx.stroke(); }
  for(let y=0;y<=GRID_H;y++){ ctx.beginPath(); ctx.moveTo(0,y*CELL+.5); ctx.lineTo(GRID_W*CELL,y*CELL+.5); ctx.stroke(); }

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
    const cx = x*CELL+CELL/2, cy = y*CELL+CELL/2;
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
    const cx = x*CELL+CELL/2, cy = y*CELL+CELL/2;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx-6,cy-6); ctx.lineTo(cx+6,cy+6);
    ctx.moveTo(cx+6,cy-6); ctx.lineTo(cx-6,cy+6);
    ctx.stroke();
  }

  function drawRoadLayer(layerName, color, margin, dashed, buries){
    if(dashed) ctx.setLineDash([5,4]); // underground/railUnderground only — see the call sites above
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
      drawTrackCell(x, y, connectedDirs, cellColor, margin);
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
    const cx = x*CELL+CELL/2, cy = y*CELL+CELL/2;
    const rot = {N:-Math.PI/2, S:Math.PI/2, E:0, W:Math.PI}[dir];
    ctx.save();
    ctx.translate(cx,cy); ctx.rotate(rot);
    ctx.fillStyle = getCss('--amber');
    const tip = CELL/2 - margin - 2, size = 5;
    ctx.beginPath();
    ctx.moveTo(tip, 0);
    ctx.lineTo(tip-size, -size);
    ctx.lineTo(tip-size, size);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // buildings
  for(const id of queryEntities('Footprint')){
    const e = world.entities.get(id);
    const def = BUILDING_DEFS[e.type];
    const px = e.x*CELL, py = e.y*CELL;
    const pw = e.footprint.w*CELL, ph = e.footprint.h*CELL;
    ctx.fillStyle = def.color;
    const halted = producerHalted(e);
    ctx.fillRect(px+2, py+2, pw-4, ph-4);
    if(halted){ ctx.strokeStyle = getCss('--danger'); ctx.lineWidth=2; ctx.strokeRect(px+3, py+3, pw-6, ph-6); }
    if(e===selected){ ctx.strokeStyle = getCss('--amber'); ctx.lineWidth=2; ctx.strokeRect(px+1, py+1, pw-2, ph-2); }
    ctx.fillStyle = '#fff';
    ctx.font = '10px monospace';
    ctx.fillText(`${def.label} #${e.id}`, px+5, py+13);
    // Fill bar(s) span the building's full footprint width (Stations have
    // no storage of their own — show a linked/unlinked indicator dot
    // instead). A building with only one slot (Mine: out; Town: in) gets
    // one bar; a dual-slot building (Mill: both) gets two stacked bars —
    // output on top in teal, input below in a distinct color — so you can
    // see both buffers at a glance instead of just one ambiguous number.
    if(e.type==='station'){
      const linked = !!findLinkedIndustry(e);
      ctx.fillStyle = linked ? getCss('--teal') : getCss('--danger');
      ctx.beginPath(); ctx.arc(px+pw-8, py+ph-8, 4, 0, Math.PI*2); ctx.fill();
      // notch on the facing side — the only side that can ever touch a road
      if(e.facing){
        const d = ROAD_DIRS.find(r=>r.dir===e.facing);
        const nx = px+pw/2 + d.dx*(pw/2-2), ny = py+ph/2 + d.dy*(ph/2-2);
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
      const barH = 4, gap = 1;
      bars.forEach((bar, i)=>{
        const y = py+ph-9-(bars.length-1-i)*(barH+gap);
        const pct = bar.cap>0 ? bar.stock/bar.cap : 0;
        ctx.fillStyle = 'rgba(0,0,0,.5)';
        ctx.fillRect(px+4, y, pw-8, barH);
        ctx.fillStyle = bar.color;
        ctx.fillRect(px+4, y, (pw-8)*pct, barH);
      });
    }
    // The platform edge — a real loading platform runs alongside the
    // track it serves for its whole length (§ Depot parallel-track
    // requirement), so highlight whichever long side actually qualifies,
    // right against the footprint's edge, reading as "this is the side
    // trains dock along" the same way a Station's facing notch reads as
    // "this is the side that touches a road."
    if(e.type==='depot'){
      const platform = depotPlatformCells(e.x, e.y, e.footprint.w, e.footprint.h);
      if(platform){
        ctx.strokeStyle = getCss('--amber');
        ctx.lineWidth = 3;
        ctx.beginPath();
        if(platform[0].x < e.x || platform[0].x >= e.x+e.footprint.w){
          const lx = platform[0].x < e.x ? px : px+pw;
          ctx.moveTo(lx, py); ctx.lineTo(lx, py+ph);
        } else {
          const ly = platform[0].y < e.y ? py : py+ph;
          ctx.moveTo(px, ly); ctx.lineTo(px+pw, ly);
        }
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
    ctx.fillStyle = v.state==='blocked' ? getCss('--danger') : getVehicleStats(v).color;
    const cx = drawX*CELL+CELL/2, cy = drawY*CELL+CELL/2;

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
    const horizontal = v.path && v.pathIndex < v.path.length-1
      ? v.path[v.pathIndex+1].x !== v.path[v.pathIndex].x
      : true;
    const longPx = CELL * v.length;
    const shortPx = CELL * 0.42;
    const w = horizontal ? longPx : shortPx;
    const h = horizontal ? shortPx : longPx;
    ctx.fillRect(cx-w/2, cy-h/2, w, h);
    if(v.layer==='elevated' || v.layer==='railElevated' || v.layer==='airspace' || v.layer==='railAirspace'){
      // Same "above ground" outline for elevated AND airspace — both mean
      // "currently above ground level," so one shared visual cue is enough
      // (solid, vs. underground/deepUnderground's dashed "below ground"
      // outline below).
      ctx.strokeStyle='#7fb8c9'; ctx.lineWidth=2;
      ctx.strokeRect(cx-w/2-2, cy-h/2-2, w+4, h+4);
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
      ctx.save();
      ctx.setLineDash([4,3]);
      ctx.strokeStyle='#8a7a6a'; ctx.lineWidth=2;
      ctx.strokeRect(cx-w/2-2, cy-h/2-2, w+4, h+4);
      ctx.restore();
    }
    if(v===selected){
      ctx.strokeStyle='#fff'; ctx.lineWidth=2;
      ctx.strokeRect(cx-w/2-3, cy-h/2-3, w+6, h+6);
    }
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
      ctx.strokeRect(hoverCell.x*CELL+1, hoverCell.y*CELL+1, fp.w*CELL-2, fp.h*CELL-2);
    } else if(currentTool==='road' || currentTool==='track' || VEHICLE_DEFS[currentTool] || currentTool==='assembletrain'){
      ctx.strokeRect(hoverCell.x*CELL+1, hoverCell.y*CELL+1, CELL-2, CELL-2);
    }
  }

  // Elevation numbers — only where non-zero (0 is the implicit default,
  // reads as "no need to check"); drawn last so they stay legible over
  // track/terrain/vehicles rather than getting buried under them.
  ctx.font = '9px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for(const [k,cell] of world.grid){
    if(!cell.elevation) continue;
    const [x,y] = k.split(',').map(Number);
    ctx.fillText((cell.elevation>0?'+':'')+cell.elevation, x*CELL+3, y*CELL+CELL-3);
  }

  // HUD
  const treasuryEl = document.getElementById('treasury');
  treasuryEl.textContent = '$' + world.treasury;
  treasuryEl.classList.toggle('negative', world.treasury < 0);
  document.getElementById('tickInfo').textContent = 'tick ' + world.tick;
}
function getCss(varName){ return getComputedStyle(document.documentElement).getPropertyValue(varName).trim(); }
