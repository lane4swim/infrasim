// ---------------------------------------------------------------------
// COMMANDS  (§7 — the only way the world is mutated by the player)
// ---------------------------------------------------------------------
// Every kind sharing a grade (road and rail today — see newGradeLayer in
// world.js) shares the same physical space: a real level crossing is two
// networks crossing at a right angle, never running side by side through
// the same point. So a single direction (N/S/E/W) at a given cell can
// belong to a through-connected edge of ONE kind at that grade, never
// more than one; the different kinds are free to occupy perpendicular
// directions at the same cell (a clean crossing: road claims E/W, rail
// claims N/S), but never the same direction (which would mean two
// networks literally overlapping in the same lane). Iterates every OTHER
// kind at the layer's own grade rather than naming one fixed counterpart
// — a third kind (a pipeline, a power line) added to newGradeLayer
// automatically gets this same protection against every kind already
// there, and vice versa, with no new code here at all. A layer's
// counterpart at a DIFFERENT grade (ground road vs. elevated rail, or the
// reverse) is never checked — a bridge passes physically above whatever's
// below it, the same non-interaction ground/elevated road already has
// absent a Ramp.
function directionClaimedByOtherNetwork(x,y,layer,dir){
  const [grade, kind] = LAYER_GRADE_KIND[layer];
  const gradeLayer = getCell(x,y).layers[grade];
  for(const otherKind in gradeLayer){
    if(otherKind === kind) continue;
    if(gradeLayer[otherKind].edges[dir]) return true;
  }
  return false;
}
// Connect only the specific edges that actually border an existing tile on
// the SAME layer — a ground tile and an elevated tile at the same (x,y)
// never connect to each other just by overlapping; that's what lets an
// elevated road cross a ground road without joining it. Same-grade,
// different-kind neighbors additionally skip any direction another kind
// already holds (see directionClaimedByOtherNetwork above) — the
// mechanism that turns a same-cell overlap into a real perpendicular
// crossing instead of two networks silently fusing. Shared by every "lay
// a tile" command (road, rail track, and whatever's added later) since
// none of this is road- or rail-specific.
function connectNewTileEdges(x,y,layer,track){
  for(const {dir,dx,dy,opp} of ROAD_DIRS){
    if(directionClaimedByOtherNetwork(x,y,layer,dir)) continue;
    if(directionClaimedByOtherNetwork(x+dx,y+dy,layer,opp)) continue;
    const nTrack = trackAt(x+dx,y+dy,layer);
    if(nTrack.track){ track.edges[dir] = true; nTrack.edges[opp] = true; }
  }
}
// Shared by cmdBuildRoad and cmdBuildTrack — laying a tile of any kind, at
// any grade, is the same shape: charge for it (elevated at the same x2
// multiplier every grade uses), mark it built, auto-connect if asked.
// Ground-grade tiles additionally can't go under a building, regardless
// of kind — a building already occupies that physical ground space.
// Returns whether the tile was actually built, since the two rail-block
// recompute calls (cmdBuildTrack only, road has no blocks) need to know
// whether anything actually changed.
function buildTrackTile(x,y,layer,autoConnect,costPerTile,label){
  if(autoConnect === undefined) autoConnect = true;
  const cell = getCell(x,y);
  const [grade] = LAYER_GRADE_KIND[layer];
  const track = trackAt(x,y,layer);
  if(track.track) return false;
  if(grade==='ground' && cell.buildingId) return false; // can't lay ground-level track under a building
  const cost = costPerTile * (grade==='elevated' ? ELEVATED_COST_MULTIPLIER : 1);
  if(!canAfford(cost)){ logEvent(`Insufficient funds for ${label}.`, 'warn'); return false; }
  charge(cost, grade==='elevated' ? `elevated ${label}` : label);
  track.track = true;
  if(autoConnect) connectNewTileEdges(x,y,layer,track); // else placed isolated — wire it up later with Connect / Disconnect
  return true;
}
function cmdBuildRoad(x,y,layer,autoConnect){
  layer = layer || 'ground';
  buildTrackTile(x,y,layer,autoConnect,ROAD_COST_PER_TILE,'road tile');
}
// Rail track tile — same construction/connection shape as a road tile (see
// buildTrackTile/connectNewTileEdges), just at RAIL_DEFS' own per-tile
// cost. Block segmentation only ever needs recomputing when the track
// graph's topology actually changes, so it's done once here (and in
// cmdDemolish/cmdToggleConnection/cmdToggleOneWay/cmdBuildRailRamp)
// rather than every tick.
function cmdBuildTrack(x,y,layer,autoConnect){
  layer = layer || 'rail';
  if(buildTrackTile(x,y,layer,autoConnect,RAIL_DEFS.track.costPerTile,'rail track tile')) computeRailBlocks();
}
function cmdToggleConnection(x1,y1,x2,y2,layer){
  // Manually connect or sever the specific edge between two adjacent tiles
  // on the same layer — the counterpart to auto-connect, and what lets two
  // parallel one-way streets (or rail lines) sit side by side without
  // joining across the middle.
  const d = ROAD_DIRS.find(r => x1+r.dx===x2 && y1+r.dy===y2);
  if(!d){ logEvent('Connect only works between two orthogonally adjacent tiles.', 'warn'); return; }
  const aTrack = trackAt(x1,y1,layer);
  const bTrack = trackAt(x2,y2,layer);
  if(!aTrack.track || !bTrack.track){ logEvent(`Both tiles need ${layer} track to connect.`, 'warn'); return; }
  if(aTrack.edges[d.dir]){
    // currently connected — sever it, and clear any one-way state on what
    // is now not an edge at all (a stale block would otherwise linger and
    // silently reapply if the same two tiles are ever reconnected later)
    aTrack.edges[d.dir] = false; bTrack.edges[d.opp] = false;
    aTrack.oneWayBlocked[d.dir] = false; bTrack.oneWayBlocked[d.opp] = false;
    logEvent('Connection removed.');
  } else {
    if(directionClaimedByOtherNetwork(x1,y1,layer,d.dir) || directionClaimedByOtherNetwork(x2,y2,layer,d.opp)){
      const other = LAYER_GRADE_KIND[layer][1]==='rail' ? 'road' : 'rail';
      logEvent(`Can't connect — ${other} track already runs through here in that direction; only a perpendicular crossing is possible.`, 'warn');
      return;
    }
    aTrack.edges[d.dir] = true; bTrack.edges[d.opp] = true; // new connections start two-way
    logEvent('Connection made.');
  }
  if(LAYER_GRADE_KIND[layer][1]==='rail') computeRailBlocks();
}
// Shared by cmdBuildRamp and cmdBuildRailRamp — a Ramp of any kind links
// that SAME kind's ground and elevated tiles at one cell; different kinds'
// ramps are entirely independent of each other (a cell can have either,
// both, or neither). Rail's own ramp additionally recomputes blocks,
// since a Rail Ramp cell is a hub (see railCellIsHub) — plain road ramps
// have no block concept to update.
function buildRamp(x,y,kind,label){
  const cell = getCell(x,y);
  if(!cell.layers.ground[kind].track || !cell.layers.elevated[kind].track){
    logEvent(`A ${label} needs both a ground and an elevated ${kind} tile at the same cell.`, 'warn');
    return;
  }
  if(cell.ramps[kind]){ logEvent(`There is already a ${label} here.`, 'warn'); return; }
  if(!canAfford(RAMP_COST)){ logEvent(`Insufficient funds for ${label.toLowerCase()}.`, 'warn'); return; }
  charge(RAMP_COST, label.toLowerCase());
  cell.ramps[kind] = true;
  if(kind==='rail') computeRailBlocks(); // a Rail Ramp cell is a hub — topology-equivalent to adding a signal
}
function cmdBuildRamp(x,y){ buildRamp(x,y,'road','Ramp'); }
// Rail's own Ramp — links `rail` and `railElevated` at a cell exactly like
// a (road) Ramp links `ground` and `elevated`, entirely independent of it.
function cmdBuildRailRamp(x,y){ buildRamp(x,y,'rail','Rail Ramp'); }
function cmdToggleOneWay(x1,y1,x2,y2,layer){
  // Also doubles as rail's "Toggle Signal Direction" (layer='rail' or
  // 'railElevated') — same mechanism, since a signal is exactly a one-way
  // restriction on a track edge; a signal is additionally a rail block
  // boundary (see computeRailBlocks), which plain road one-ways don't
  // need to care about.
  const d = ROAD_DIRS.find(r => x1+r.dx===x2 && y1+r.dy===y2);
  if(!d){ logEvent('This only applies between two orthogonally adjacent tiles.', 'warn'); return; }
  const aTrack = trackAt(x1,y1,layer);
  const bTrack = trackAt(x2,y2,layer);
  if(!aTrack.edges[d.dir]){ logEvent(`Those tiles aren't connected on the ${layer} layer.`, 'warn'); return; }
  if(bTrack.oneWayBlocked[d.opp]){
    // currently one-way (first -> second) only; revert to two-way
    bTrack.oneWayBlocked[d.opp] = false;
    logEvent('Edge set back to two-way.');
  } else {
    aTrack.oneWayBlocked[d.dir] = false; // make sure the forward direction stays open
    bTrack.oneWayBlocked[d.opp] = true;  // block the reverse
    logEvent('Edge set to one-way.');
  }
  if(LAYER_GRADE_KIND[layer][1]==='rail') computeRailBlocks();
}
function cmdBuildBuilding(type, x, y, tier, facing, resource){
  const def = BUILDING_DEFS[type];
  const {w,h} = effectiveFootprint(type, def, facing);
  for(let dx=0; dx<w; dx++){
    for(let dy=0; dy<h; dy++){
      const cx = x+dx, cy = y+dy;
      if(!inBounds(cx,cy)){ logEvent(`${def.label} footprint (${w}x${h}) doesn't fit on the grid there.`, 'warn'); return; }
      const cell = getCell(cx,cy);
      // A building occupies real ground-level space, so it conflicts with
      // ANY kind of ground-grade infrastructure there (road, rail, or
      // whatever's added later) — iterating the grade's kinds instead of
      // naming road/rail specifically means a new kind never needs a new
      // clause here either.
      const groundOccupied = Object.values(cell.layers.ground).some(t => t.track);
      if(groundOccupied || cell.buildingId){ logEvent(`${def.label} footprint overlaps something at (${cx},${cy}).`, 'warn'); return; }
    }
  }
  if(type==='station'){
    // Stations don't touch roads directly here — they touch an industry, or
    // another station, forming the access chain vehicles actually use.
    if(!touchesIndustryOrStation(x, y, {w,h})){
      logEvent('A Station must touch a Mine, Town, or another Station.', 'warn');
      return;
    }
  }
  if(type==='depot'){
    // A real loading platform runs alongside the track it serves for its
    // whole length, not just touching it at one corner — see
    // depotPlatformCells. Only one of the footprint's two LONG sides (the
    // pair parallel to whichever of w/h is bigger) needs a full run; the
    // short end caps never count, same as a real platform's end doesn't
    // serve trains passing alongside it.
    if(!depotPlatformCells(x, y, w, h)){
      logEvent('A Rail Depot must run alongside a straight, unbroken length of track along one of its long sides.', 'warn');
      return;
    }
  }
  const cost = def.buildCost + def.tiers[tier].add;
  if(!canAfford(cost)){ logEvent('Insufficient funds for construction.', 'warn'); return; }
  charge(cost, `${def.label} (${tier})`);
  createBuilding(type, x, y, tier, facing, resource);
}
function cmdDemolish(x,y,layer){
  layer = layer || 'ground';
  const cell = getCell(x,y);
  if(cell.buildingId){
    const buildingId = cell.buildingId; // capture before the footprint loop clears this very cell's buildingId
    const building = world.entities.get(buildingId);
    const wasRailNode = hasComponent(buildingId, 'RailNode'); // a Depot touching rail can be a block boundary — see computeRailBlocks
    if(building){ for(const c of footprintCells(building)) getCell(c.x,c.y).buildingId = null; }
    destroyEntity(buildingId);
    if(wasRailNode) computeRailBlocks();
    return;
  }
  const track = trackAt(x,y,layer);
  if(track.track){
    const [, kind] = LAYER_GRADE_KIND[layer];
    // Sever this tile's edges from whichever neighbors it was connected to,
    // so they don't retain a connection to track that no longer exists.
    for(const {dir,dx,dy,opp} of ROAD_DIRS){
      if(track.edges[dir]) trackAt(x+dx, y+dy, layer).edges[opp] = false;
    }
    track.track = false;
    track.edges = {N:false, S:false, E:false, W:false};
    track.oneWayBlocked = {N:false, S:false, E:false, W:false};
    track.blockId = {N:null, S:null, E:null, W:null};
    // This kind's Ramp needs both of ITS OWN grades present — demolishing
    // ground-level road only ever invalidates the road Ramp, demolishing
    // ground-level rail only ever invalidates the Rail Ramp, never the
    // other kind's.
    if(cell.ramps[kind]) cell.ramps[kind] = false;
    if(kind==='rail') computeRailBlocks(); // topology changed — block boundaries may have moved
  }
}
function cmdPurchaseVehicle(x,y,vehicleType){
  vehicleType = vehicleType || 'bulk';
  if(!trackAt(x,y,'ground').track){ logEvent('Trucks must be placed on a ground road tile.', 'warn'); return; }
  const def = getVehicleDef(vehicleType);
  if(!canAfford(def.purchaseCost)){ logEvent(`Insufficient funds for ${def.label.toLowerCase()}.`, 'warn'); return; }
  charge(def.purchaseCost, `${def.label.toLowerCase()} purchase`);
  createTruck(x,y,vehicleType);
}
// Trains aren't purchased off a fixed def — they're assembled at a Train
// Yard from an engine and N wagons, and must depart from track that
// actually touches a Yard (railCellTouchesYard), not just any track tile.
function cmdAssembleTrain(x,y,engineType,wagonType,wagonCount){
  if(!trackAt(x,y,'rail').track){ logEvent('Trains must be assembled on a rail track tile.', 'warn'); return; }
  if(!railCellTouchesYard(x,y)){ logEvent('That track doesn\'t touch a Train Yard.', 'warn'); return; }
  const engine = ENGINE_DEFS[engineType], wagon = WAGON_DEFS[wagonType];
  if(!engine || !wagon || !Number.isInteger(wagonCount) || wagonCount < 1){
    logEvent('Invalid train configuration.', 'warn'); return;
  }
  const stats = getTrainStats({engineType, wagonType, wagonCount});
  if(!canAfford(stats.purchaseCost)){ logEvent(`Insufficient funds for ${stats.label}.`, 'warn'); return; }
  charge(stats.purchaseCost, `${stats.label} assembled`);
  createTrain(x,y,engineType,wagonType,wagonCount);
}
function cmdSellVehicle(vehicle){
  const stats = getVehicleStats(vehicle);
  const refund = Math.round(stats.purchaseCost * stats.sellFraction);
  credit(refund, `${stats.label.toLowerCase()} sold`);
  destroyEntity(vehicle.id);
}
function cmdSetOrders(vehicle, orders){
  vehicle.orders = orders;
  vehicle.ordersIndex = Math.min(vehicle.ordersIndex, Math.max(0, orders.length-1));
  vehicle.path = null; // force a fresh path toward the (possibly new) target
}
