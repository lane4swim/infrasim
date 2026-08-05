// ---------------------------------------------------------------------
// COMMANDS  (§7 — the only way the world is mutated by the player)
// ---------------------------------------------------------------------
// Ground road and rail share the same physical grade — a real level
// crossing is two networks crossing at a right angle, never running side
// by side through the same point. So a single direction (N/S/E/W) at a
// given cell can belong to a through-connected ground-road edge OR a
// through-connected rail edge, never both; the two networks are free to
// occupy perpendicular directions at the same cell (a clean crossing:
// road claims E/W, rail claims N/S), but never the same direction (which
// would mean the two literally overlapping in the same lane). Elevated
// has no counterpart here — a bridge passes physically above rail, the
// same non-interaction it already has with ground road absent a Ramp — so
// this only ever applies between 'ground' and 'rail'.
const GROUND_RAIL_COUNTERPART = {ground:'rail', rail:'ground'};
function directionClaimedByOtherNetwork(x,y,layer,dir){
  const counterpart = GROUND_RAIL_COUNTERPART[layer];
  if(!counterpart) return false; // elevated: no counterpart, no constraint
  return getCell(x,y).layers[counterpart].edges[dir];
}
// Connect only the specific edges that actually border an existing tile on
// the SAME layer — a ground tile and an elevated tile at the same (x,y)
// never connect to each other just by overlapping; that's what lets an
// elevated road cross a ground road without joining it. Ground and rail
// additionally skip any direction the other one already holds (see
// directionClaimedByOtherNetwork above) — the mechanism that turns a
// same-cell overlap into a real perpendicular crossing instead of two
// networks silently fusing. Shared by every "lay a tile" command (road,
// rail track) since none of this is road-specific.
function connectNewTileEdges(x,y,layer,track){
  for(const {dir,dx,dy,opp} of ROAD_DIRS){
    if(directionClaimedByOtherNetwork(x,y,layer,dir)) continue;
    if(directionClaimedByOtherNetwork(x+dx,y+dy,layer,opp)) continue;
    const nTrack = getCell(x+dx,y+dy).layers[layer];
    if(nTrack.track){ track.edges[dir] = true; nTrack.edges[opp] = true; }
  }
}
function cmdBuildRoad(x,y,layer,autoConnect){
  layer = layer || 'ground';
  if(autoConnect === undefined) autoConnect = true;
  const cell = getCell(x,y);
  const track = cell.layers[layer];
  if(track.track) return;
  if(layer==='ground' && cell.buildingId) return; // can't lay ground road under a building
  const cost = ROAD_COST_PER_TILE * (layer==='elevated' ? ELEVATED_COST_MULTIPLIER : 1);
  if(!canAfford(cost)){ logEvent('Insufficient funds for road.', 'warn'); return; }
  charge(cost, layer==='elevated' ? 'elevated road tile' : 'road tile');
  track.track = true;
  if(autoConnect) connectNewTileEdges(x,y,layer,track); // else placed isolated — wire it up later with Connect / Disconnect
}
// Rail track tile — same construction/connection shape as a road tile (see
// connectNewTileEdges), just on the `rail` layer and at RAIL_DEFS' own
// per-tile cost. Block segmentation only ever needs recomputing when the
// track graph's topology actually changes, so it's done once here (and in
// cmdDemolish/cmdToggleOneWay-on-rail) rather than every tick.
function cmdBuildTrack(x,y,autoConnect){
  if(autoConnect === undefined) autoConnect = true;
  const cell = getCell(x,y);
  const track = cell.layers.rail;
  if(track.track) return;
  if(cell.buildingId) return; // can't lay track under a building
  const cost = RAIL_DEFS.track.costPerTile;
  if(!canAfford(cost)){ logEvent('Insufficient funds for track.', 'warn'); return; }
  charge(cost, 'rail track tile');
  track.track = true;
  if(autoConnect) connectNewTileEdges(x,y,'rail',track);
  computeRailBlocks();
}
function cmdToggleConnection(x1,y1,x2,y2,layer){
  // Manually connect or sever the specific edge between two adjacent tiles
  // on the same layer — the counterpart to auto-connect, and what lets two
  // parallel one-way streets (or rail lines) sit side by side without
  // joining across the middle.
  const d = ROAD_DIRS.find(r => x1+r.dx===x2 && y1+r.dy===y2);
  if(!d){ logEvent('Connect only works between two orthogonally adjacent tiles.', 'warn'); return; }
  const aTrack = getCell(x1,y1).layers[layer];
  const bTrack = getCell(x2,y2).layers[layer];
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
      const other = layer==='rail' ? 'road' : 'rail';
      logEvent(`Can't connect — ${other} track already runs through here in that direction; only a perpendicular crossing is possible.`, 'warn');
      return;
    }
    aTrack.edges[d.dir] = true; bTrack.edges[d.opp] = true; // new connections start two-way
    logEvent('Connection made.');
  }
  if(layer==='rail') computeRailBlocks();
}
function cmdBuildRamp(x,y){
  const cell = getCell(x,y);
  if(!cell.layers.ground.track || !cell.layers.elevated.track){
    logEvent('A Ramp needs both a ground and an elevated road tile at the same cell.', 'warn');
    return;
  }
  if(cell.ramp){ logEvent('There is already a Ramp here.', 'warn'); return; }
  if(!canAfford(RAMP_COST)){ logEvent('Insufficient funds for ramp.', 'warn'); return; }
  charge(RAMP_COST, 'ramp');
  cell.ramp = true;
}
function cmdToggleOneWay(x1,y1,x2,y2,layer){
  // Also doubles as rail's "Toggle Signal Direction" (layer='rail') — same
  // mechanism, since a signal is exactly a one-way restriction on a track
  // edge; a signal is additionally a rail block boundary (see
  // computeRailBlocks), which plain road one-ways don't need to care about.
  const d = ROAD_DIRS.find(r => x1+r.dx===x2 && y1+r.dy===y2);
  if(!d){ logEvent('This only applies between two orthogonally adjacent tiles.', 'warn'); return; }
  const aTrack = getCell(x1,y1).layers[layer];
  const bTrack = getCell(x2,y2).layers[layer];
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
  if(layer==='rail') computeRailBlocks();
}
function cmdBuildBuilding(type, x, y, tier, facing, resource){
  const def = BUILDING_DEFS[type];
  const {w,h} = def.footprint;
  for(let dx=0; dx<w; dx++){
    for(let dy=0; dy<h; dy++){
      const cx = x+dx, cy = y+dy;
      if(!inBounds(cx,cy)){ logEvent(`${def.label} footprint (${w}x${h}) doesn't fit on the grid there.`, 'warn'); return; }
      const cell = getCell(cx,cy);
      if(cell.layers.ground.track || cell.layers.rail.track || cell.buildingId){ logEvent(`${def.label} footprint overlaps something at (${cx},${cy}).`, 'warn'); return; }
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
  const track = cell.layers[layer];
  if(track.track){
    // Sever this tile's edges from whichever neighbors it was connected to,
    // so they don't retain a connection to track that no longer exists.
    for(const {dir,dx,dy,opp} of ROAD_DIRS){
      if(track.edges[dir]) getCell(x+dx, y+dy).layers[layer].edges[opp] = false;
    }
    track.track = false;
    track.edges = {N:false, S:false, E:false, W:false};
    track.oneWayBlocked = {N:false, S:false, E:false, W:false};
    track.blockId = {N:null, S:null, E:null, W:null};
    if(cell.ramp) cell.ramp = false; // a Ramp needs both layers present
    if(layer==='rail') computeRailBlocks(); // topology changed — block boundaries may have moved
  }
}
function cmdPurchaseVehicle(x,y,vehicleType){
  vehicleType = vehicleType || 'bulk';
  const cell = getCell(x,y);
  if(!cell.layers.ground.track){ logEvent('Trucks must be placed on a ground road tile.', 'warn'); return; }
  const def = getVehicleDef(vehicleType);
  if(!canAfford(def.purchaseCost)){ logEvent(`Insufficient funds for ${def.label.toLowerCase()}.`, 'warn'); return; }
  charge(def.purchaseCost, `${def.label.toLowerCase()} purchase`);
  createTruck(x,y,vehicleType);
}
// Trains aren't purchased off a fixed def — they're assembled at a Train
// Yard from an engine and N wagons, and must depart from track that
// actually touches a Yard (railCellTouchesYard), not just any track tile.
function cmdAssembleTrain(x,y,engineType,wagonType,wagonCount){
  const cell = getCell(x,y);
  if(!cell.layers.rail.track){ logEvent('Trains must be assembled on a rail track tile.', 'warn'); return; }
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

