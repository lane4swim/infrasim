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

function render(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  // grid lines
  ctx.strokeStyle = getCss('--grid-line');
  ctx.lineWidth = 1;
  for(let x=0;x<=GRID_W;x++){ ctx.beginPath(); ctx.moveTo(x*CELL+.5,0); ctx.lineTo(x*CELL+.5,GRID_H*CELL); ctx.stroke(); }
  for(let y=0;y<=GRID_H;y++){ ctx.beginPath(); ctx.moveTo(0,y*CELL+.5); ctx.lineTo(GRID_W*CELL,y*CELL+.5); ctx.stroke(); }

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
  drawRoadLayer('ground', getCss('--road'), 8);
  drawRoadLayer('elevated', '#7fb8c9', 12);
  // Rail reuses drawRoadLayer entirely unchanged — same {track,edges,
  // oneWayBlocked} shape, so a signal renders exactly like a one-way arrow
  // for free, and rail crossing a road at the same cell reads as two
  // independent lines (different layer key, never auto-connected).
  // railElevated is rail's own bridge layer (rail ramps, not roads) — a
  // lighter tint of rail's purple, the same relationship elevated road's
  // light blue has to ground road's gray.
  drawRoadLayer('rail', '#9b6bd6', 10);
  drawRoadLayer('railElevated', '#c9a8e8', 13);

  // ramps — a small diamond marking a cell where a layer pair is
  // deliberately linked (the only place a vehicle can change layer): the
  // road Ramp (ground<->elevated) in elevated road's own light blue, the
  // independent Rail Ramp (rail<->railElevated) in elevated rail's own
  // light purple, so the two are visibly distinguishable when a cell
  // happens to have both.
  for(const [k,cell] of world.grid){
    if(!cell.ramps.road) continue;
    const [x,y] = k.split(',').map(Number);
    const cx = x*CELL+CELL/2, cy = y*CELL+CELL/2;
    ctx.save();
    ctx.translate(cx,cy); ctx.rotate(Math.PI/4);
    ctx.fillStyle = '#7fb8c9';
    ctx.fillRect(-5,-5,10,10);
    ctx.restore();
  }
  for(const [k,cell] of world.grid){
    if(!cell.ramps.rail) continue;
    const [x,y] = k.split(',').map(Number);
    const cx = x*CELL+CELL/2, cy = y*CELL+CELL/2;
    ctx.save();
    ctx.translate(cx,cy); ctx.rotate(Math.PI/4);
    ctx.fillStyle = '#c9a8e8';
    ctx.fillRect(-5,-5,10,10);
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
  for(const [k] of world.grid){
    const [x,y] = k.split(',').map(Number);
    if(!isRoadRailCrossing(x,y,'rail') && !isRoadRailCrossing(x,y,'railElevated')) continue;
    const cx = x*CELL+CELL/2, cy = y*CELL+CELL/2;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx-6,cy-6); ctx.lineTo(cx+6,cy+6);
    ctx.moveTo(cx+6,cy-6); ctx.lineTo(cx-6,cy+6);
    ctx.stroke();
  }

  function drawRoadLayer(layerName, color, margin){
    for(const [k] of world.grid){
      const [x,y] = k.split(',').map(Number);
      const track = trackAt(x,y,layerName);
      if(!track.track) continue;
      const connectedDirs = ROAD_DIRS.filter(d => track.edges[d.dir]).map(d => d.dir);
      drawTrackCell(x, y, connectedDirs, color, margin);
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
    if(v.layer==='elevated' || v.layer==='railElevated'){
      // Same "on a bridge" outline for a truck on elevated road and a train
      // on elevated rail — both mean the same thing (currently on this
      // vehicle's own elevated layer), so one shared visual cue is enough.
      ctx.strokeStyle='#7fb8c9'; ctx.lineWidth=2;
      ctx.strokeRect(cx-w/2-2, cy-h/2-2, w+4, h+4);
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
    if(currentTool==='mine' || currentTool==='mill' || currentTool==='town' || currentTool==='station' || currentTool==='depot' || currentTool==='trainyard'){
      const fp = currentTool==='depot' ? effectiveFootprint('depot', BUILDING_DEFS.depot, currentDepotOrientation()) : BUILDING_DEFS[currentTool].footprint;
      ctx.strokeRect(hoverCell.x*CELL+1, hoverCell.y*CELL+1, fp.w*CELL-2, fp.h*CELL-2);
    } else if(currentTool==='road' || currentTool==='track' || currentTool==='bulktruck' || currentTool==='flatbedtruck' || currentTool==='assembletrain'){
      ctx.strokeRect(hoverCell.x*CELL+1, hoverCell.y*CELL+1, CELL-2, CELL-2);
    }
  }

  // HUD
  const treasuryEl = document.getElementById('treasury');
  treasuryEl.textContent = '$' + world.treasury;
  treasuryEl.classList.toggle('negative', world.treasury < 0);
  document.getElementById('tickInfo').textContent = 'tick ' + world.tick;
}
function getCss(varName){ return getComputedStyle(document.documentElement).getPropertyValue(varName).trim(); }
