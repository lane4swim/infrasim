// ---------------------------------------------------------------------
// FIXED-TIMESTEP LOOP  (§8 — decoupled from render framerate)
// ---------------------------------------------------------------------
let acc = 0, lastT = performance.now();
function frame(now){
  const dt = now - lastT; lastT = now;
  acc += dt;
  while(acc >= TICK_MS){ simTick(); acc -= TICK_MS; }
  render();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------
// RENDERING
// ---------------------------------------------------------------------
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

function render(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  // grid lines
  ctx.strokeStyle = getCss('--grid-line');
  ctx.lineWidth = 1;
  for(let x=0;x<=GRID_W;x++){ ctx.beginPath(); ctx.moveTo(x*CELL+.5,0); ctx.lineTo(x*CELL+.5,GRID_H*CELL); ctx.stroke(); }
  for(let y=0;y<=GRID_H;y++){ ctx.beginPath(); ctx.moveTo(0,y*CELL+.5); ctx.lineTo(GRID_W*CELL,y*CELL+.5); ctx.stroke(); }

  // roads — a core square plus a stub toward each side with an established
  // edge connection, so an isolated tile visibly reads as disconnected and
  // a through-route reads as a continuous line, instead of every road tile
  // looking identical regardless of what it actually connects to. Ground is
  // drawn first, elevated on top in a distinct color so a crossing (both
  // layers occupying the same cell without connecting) is visible as two
  // independent lines rather than one merged road.
  drawRoadLayer('ground', getCss('--road'), 8);
  drawRoadLayer('elevated', '#7fb8c9', 12);
  // Rail reuses drawRoadLayer entirely unchanged — same {track,edges,
  // oneWayBlocked} shape, so a signal renders exactly like a one-way arrow
  // for free, and rail crossing a road at the same cell reads as two
  // independent lines (different layer key, never auto-connected).
  drawRoadLayer('rail', '#9b6bd6', 10);

  // ramps — a small diamond marking a cell where ground and elevated are
  // deliberately linked (the only place a vehicle can change layer)
  for(const [k,cell] of world.grid){
    if(!cell.ramp) continue;
    const [x,y] = k.split(',').map(Number);
    const cx = x*CELL+CELL/2, cy = y*CELL+CELL/2;
    ctx.save();
    ctx.translate(cx,cy); ctx.rotate(Math.PI/4);
    ctx.fillStyle = '#7fb8c9';
    ctx.fillRect(-5,-5,10,10);
    ctx.restore();
  }

  function drawRoadLayer(layerName, color, margin){
    ctx.fillStyle = color;
    for(const [k,cell] of world.grid){
      const track = cell.layers[layerName];
      if(!track.track) continue;
      const [x,y] = k.split(',').map(Number);
      ctx.fillStyle = color;
      ctx.fillRect(x*CELL+margin, y*CELL+margin, CELL-margin*2, CELL-margin*2); // core
      for(const {dir,dx,dy,opp} of ROAD_DIRS){
        if(!track.edges[dir]) continue;
        ctx.fillStyle = color;
        if(dir==='N') ctx.fillRect(x*CELL+margin, y*CELL, CELL-margin*2, margin);
        if(dir==='S') ctx.fillRect(x*CELL+margin, y*CELL+CELL-margin, CELL-margin*2, margin);
        if(dir==='E') ctx.fillRect(x*CELL+CELL-margin, y*CELL+margin, margin, CELL-margin*2);
        if(dir==='W') ctx.fillRect(x*CELL, y*CELL+margin, margin, CELL-margin*2);
        // One-way arrow: drawn only from the side that's still allowed to
        // depart, so each physical one-way edge gets exactly one arrow.
        const nTrack = getCell(x+dx, y+dy).layers[layerName];
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
        // one bar, not two identical stacked ones.
        bars.push({stock:e.outStock, cap:e.outCap, color:getCss('--teal')});
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
    if(isTrain(v.id)){
      // A train is a much bigger commitment than a truck — drawn as a
      // rectangle rather than a dot so it reads as visually distinct on
      // the rail layer, oriented along its direction of travel. Sized by
      // v.length (which already reflects the whole consist — engine plus
      // every wagon — since randomizedMovement derived it from
      // getTrainStats), so a longer train visibly reads as longer.
      const horizontal = v.path && v.pathIndex < v.path.length-1
        ? v.path[v.pathIndex+1].x !== v.path[v.pathIndex].x
        : true;
      ctx.save();
      ctx.translate(cx,cy);
      const longSide = CELL * Math.max(0.6, Math.min(v.length/5, 2.5)); // consist length varies a lot now (1 wagon vs. 6) — scale within reason, don't let it swallow the grid
      const w = horizontal ? longSide : CELL*0.5;
      const h = horizontal ? CELL*0.5 : longSide;
      ctx.fillRect(-w/2, -h/2, w, h);
      ctx.restore();
    } else {
      const r = v.layer==='elevated' ? 6 : 8;
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
      if(v.layer==='elevated'){ ctx.strokeStyle='#7fb8c9'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(cx,cy,r+2,0,Math.PI*2); ctx.stroke(); }
    }
    if(v===selected){ ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.strokeRect(cx-9, cy-9, 18, 18); }
  }

  // hover ghost for build tools — sized to the building's footprint where relevant
  if(hoverCell){
    ctx.strokeStyle = getCss('--teal');
    ctx.lineWidth = 2;
    if(currentTool==='mine' || currentTool==='mill' || currentTool==='town' || currentTool==='station' || currentTool==='depot' || currentTool==='trainyard'){
      const fp = BUILDING_DEFS[currentTool].footprint;
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
