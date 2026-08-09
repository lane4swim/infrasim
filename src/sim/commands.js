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
// Ground, elevated, and underground all follow local terrain (elevationAt
// in world.js) — ELEVATION_OFFSET moves elevated/underground with whatever
// ground.elevation is at that (x,y), so the delta between two ADJACENT
// cells at one of these grades is exactly the delta between their two
// ground.elevation values, regardless of which of the three grades is
// asking. A connection between them is only real infrastructure if that
// climb is gentle (MAX_ELEVATION_DELTA — § Terrain elevation), checked at
// both auto-connect and manual Connect time. deepUnderground/airspace are
// flat global planes (elevationAt returns the same constant everywhere), so
// their delta is always 0 and this never blocks them.
function elevationBlocksConnection(x1,y1,x2,y2,grade){
  return Math.abs(elevationAt(x1,y1,grade) - elevationAt(x2,y2,grade)) > MAX_ELEVATION_DELTA;
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
//
// A Tunnel Ramp's rampEdge no longer caps how many OTHER directions this
// cell can also connect (§ Rail crossings' generalization — removed the
// old "straight-through-only" cap this function used to enforce via
// directionBlockedByRamp): a cell can be a Tunnel Ramp AND a full 4-way
// crossing AND anything in between, all 6 pairwise direction combinations
// (N-S/E-W/N-E/N-W/S-E/S-W) buildable at once. What travel is actually
// physically sensible through a shape like that is entirely pathfinding's
// job now (findLayerPath's `straightOnly`, applied uniformly to both the
// lateral edges and any rampEdge move at a genuine 4-way crossing), not a
// build-time restriction on which edges are even allowed to exist.
function connectNewTileEdges(x,y,layer,track){
  const [grade] = LAYER_GRADE_KIND[layer];
  for(const {dir,dx,dy,opp} of ROAD_DIRS){
    if(directionClaimedByOtherNetwork(x,y,layer,dir)) continue;
    if(directionClaimedByOtherNetwork(x+dx,y+dy,layer,opp)) continue;
    const nTrack = trackAt(x+dx,y+dy,layer);
    if(elevationBlocksConnection(x,y,x+dx,y+dy,grade)) continue;
    if(nTrack.track){ track.edges[dir] = true; nTrack.edges[opp] = true; }
  }
}
// Shared by cmdBuildRoad and cmdBuildTrack — laying a tile of any kind, at
// any grade, is the same shape: charge for it (elevated/underground each at
// their own per-grade multiplier), mark it built, auto-connect if asked.
// Ground-grade tiles additionally can't go under a building, regardless of
// kind — a building already occupies that physical ground space. Deeper
// underground levels beneath a building are usually still fine (a tunnel
// passing beneath one is fine, same as a bridge passing above one is —
// neither actually shares the building's own ground cell) UNLESS that
// building's own foundation reaches that deep (§ Building foundations —
// BUILDING_DEFS[type].blockedUndergroundLevels), in which case the
// building's own foundation occupies that level too, so track can't go
// there either. Returns whether the tile was actually built, since the two
// rail-block recompute calls (cmdBuildTrack only, road has no blocks) need
// to know whether anything actually changed.
function buildTrackTile(x,y,layer,autoConnect,costPerTile,label){
  if(autoConnect === undefined) autoConnect = true;
  const cell = getCell(x,y);
  const [grade] = LAYER_GRADE_KIND[layer];
  const track = trackAt(x,y,layer);
  if(track.track) return false;
  const building = cell.buildingId!=null ? world.entities.get(cell.buildingId) : null;
  if(grade==='ground' && building) return false; // can't lay ground-level track under a building
  const undergroundLevel = undergroundLevelOfGrade(grade);
  if(undergroundLevel && building){
    const blockedLevels = BUILDING_DEFS[building.type].blockedUndergroundLevels || 0;
    if(undergroundLevel <= blockedLevels){
      logEvent(`${BUILDING_DEFS[building.type].label}'s foundation reaches underground level ${blockedLevels} here — can't build ${label} at level ${undergroundLevel}.`, 'warn');
      return false;
    }
  }
  const multiplier = grade==='elevated' ? ELEVATED_COST_MULTIPLIER
    : undergroundLevel ? costMultiplierForUndergroundLevel(undergroundLevel)
    : grade==='airspace' ? AIRSPACE_COST_MULTIPLIER
    : grade==='deepUnderground' ? DEEP_UNDERGROUND_COST_MULTIPLIER
    : 1;
  const cost = costPerTile * multiplier;
  if(!canAfford(cost)){ logEvent(`Insufficient funds for ${label}.`, 'warn'); return false; }
  charge(cost, multiplier>1 ? `${grade} ${label}` : label);
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
    if(elevationBlocksConnection(x1,y1,x2,y2,LAYER_GRADE_KIND[layer][0])){
      logEvent(`Can't connect — the terrain here is too steep (max ${MAX_ELEVATION_DELTA} level difference).`, 'warn');
      return;
    }
    aTrack.edges[d.dir] = true; bTrack.edges[d.opp] = true; // new connections start two-way
    logEvent('Connection made.');
  }
  if(LAYER_GRADE_KIND[layer][1]==='rail') computeRailBlocks();
}
// Shared by cmdBuildRamp and cmdBuildRailRamp — a ramp of any kind links
// that SAME kind's ground and elevated tiles at one cell (RAMP_PAIRS'
// only entry — see world.js for why deepUnderground/airspace deliberately
// have no ramp pair of their own); different kinds' ramps are entirely
// independent of each other (a cell can have either, both, or neither).
// Rail's own ramp additionally recomputes blocks, since a Rail ramp cell
// is a hub (see railCellIsHub) — a plain road ramp has no block concept
// to update. Kept as a generic RAMP_PAIRS-driven helper (rather than
// collapsing back to a single-pair function) since it costs nothing to
// leave general and a future same-cell-shaped ramp pair — unlike
// airspace/deepUnderground's mode-specific access — would just need a new
// RAMP_PAIRS entry and a one-line wrapper here.
function buildVerticalRamp(x,y,kind,pairKey,cost,label){
  const pair = RAMP_PAIRS.find(p => p.key===pairKey);
  const cell = getCell(x,y);
  if(!cell.layers[pair.lo][kind].track || !cell.layers[pair.hi][kind].track){
    logEvent(`A ${label} needs both a ${pair.lo} and an ${pair.hi} ${kind} tile at the same cell.`, 'warn');
    return;
  }
  if(cell.ramps[kind][pairKey]){ logEvent(`There is already a ${label} here.`, 'warn'); return; }
  if(!canAfford(cost)){ logEvent(`Insufficient funds for ${label.toLowerCase()}.`, 'warn'); return; }
  charge(cost, label.toLowerCase());
  cell.ramps[kind][pairKey] = true;
  if(kind==='rail') computeRailBlocks(); // a Rail ramp cell is a hub — topology-equivalent to adding a signal
}
function cmdBuildRamp(x,y){ buildVerticalRamp(x,y,'road','groundElevated',RAMP_COST,'Ramp'); }
// Rail's own Ramp — links `rail` and `railElevated` at a cell exactly like
// a (road) Ramp links `ground` and `elevated`, entirely independent of it.
function cmdBuildRailRamp(x,y){ buildVerticalRamp(x,y,'rail','groundElevated',RAMP_COST,'Rail Ramp'); }
// A Tunnel Ramp is geometrically different from the (road) Ramp / Rail Ramp
// above: those link a kind's two tiles at the SAME cell (a vehicle
// transitions via a same-cell, different-layer step). A ramp into the
// underground stack instead slopes between two ADJACENT cells on
// different grades — the upper tile approaching it, and the lower tile it
// descends into one step over — since "both grades occupy the same physical
// point" doesn't read as a real ramp the way "the bridge passes overhead"
// does; a tunnel mouth is a stretch of track/road you drive down, not a
// teleport (see rampEdge in world.js).
//
// `level` (§ Multi-level tunnels) picks WHICH pair of adjacent grades this
// ramp connects: level 1 (the default, and the only option before
// multi-level tunnels existed) is ground<->underground; level N>1 is
// underground-level-(N-1)<->underground-level-N — always exactly one level
// at a time, never skipping one, the same way there's no direct
// elevated<->underground ramp.
//
// Constraints: (a) the two cells must be orthogonally adjacent (b) one must
// have the UPPER grade's track of this kind, the other the LOWER grade's —
// which cell is which is auto-detected, order-independent. Either side may
// already have any number of other lateral connections (a T-junction, a
// full 4-way crossing, whatever) — that used to be rejected outright (§
// Rail crossings' generalization removed the "must be a clean straight
// stretch" precondition, since it's pathfinding's job now to decide what
// travel through a busy cell is physically sensible, not a build-time cap
// on which edges may even exist).
function buildUndergroundRamp(x1,y1,x2,y2,kind,label,level){
  const upperGrade = level===1 ? 'ground' : undergroundGradeName(level-1);
  const lowerGrade = undergroundGradeName(level);
  const d = ROAD_DIRS.find(r => x1+r.dx===x2 && y1+r.dy===y2);
  if(!d){ logEvent(`A ${label} only works between two orthogonally adjacent tiles.`, 'warn'); return; }
  let upperX, upperY, lowerX, lowerY, dir;
  if(trackAt(x1,y1,GRADE_KIND_LAYER[upperGrade][kind]).track && trackAt(x2,y2,GRADE_KIND_LAYER[lowerGrade][kind]).track){
    upperX=x1; upperY=y1; lowerX=x2; lowerY=y2; dir=d.dir;
  } else if(trackAt(x1,y1,GRADE_KIND_LAYER[lowerGrade][kind]).track && trackAt(x2,y2,GRADE_KIND_LAYER[upperGrade][kind]).track){
    upperX=x2; upperY=y2; lowerX=x1; lowerY=y1; dir=d.opp;
  } else {
    logEvent(`A ${label} needs a ${upperGrade} ${kind} tile on one side and a ${lowerGrade} ${kind} tile on the other.`, 'warn');
    return;
  }
  const opp = ROAD_DIRS.find(r=>r.dir===dir).opp;
  const upperTrack = trackAt(upperX, upperY, GRADE_KIND_LAYER[upperGrade][kind]);
  const lowerTrack = trackAt(lowerX, lowerY, GRADE_KIND_LAYER[lowerGrade][kind]);
  if(upperTrack.rampEdge[dir] || lowerTrack.rampEdge[opp]){ logEvent(`There is already a ${label} here.`, 'warn'); return; }
  const cost = rampCostForUndergroundLevel(level);
  if(!canAfford(cost)){ logEvent(`Insufficient funds for ${label.toLowerCase()}.`, 'warn'); return; }
  charge(cost, label.toLowerCase());
  // Each direction stores the GRADE it leads to (not just a boolean) — a
  // cell partway down the underground stack can have one ramp edge going
  // up a level and a different one going down a level, in different
  // directions, so pathfinding needs to know which grade each one is
  // rather than guessing from a fixed swap (see findLayerPath).
  upperTrack.rampEdge[dir] = lowerGrade;
  lowerTrack.rampEdge[opp] = upperGrade;
  if(kind==='rail') computeRailBlocks(); // an underground ramp cell is a hub — see railCellIsHub
}
function cmdBuildUndergroundRamp(x1,y1,x2,y2,level){ buildUndergroundRamp(x1,y1,x2,y2,'road',level>1 ? `Level ${level} Tunnel Ramp` : 'Tunnel Ramp', level||1); }
// Rail's own tunnel ramp — links two adjacent underground-stack grades
// exactly like a (road) Tunnel Ramp does, entirely independent of it.
function cmdBuildRailUndergroundRamp(x1,y1,x2,y2,level){ buildUndergroundRamp(x1,y1,x2,y2,'rail',level>1 ? `Level ${level} Rail Tunnel Ramp` : 'Rail Tunnel Ramp', level||1); }
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
function cmdBuildBuilding(type, x, y, tier, facing, resource, length){
  const def = BUILDING_DEFS[type];
  if(type==='depot'){
    if(length===undefined) length = def.footprint.h; // no explicit choice made -> the pack's own canonical default
    if(def.platformLengths && !def.platformLengths.includes(length)){
      logEvent(`${length} is not a valid platform length for ${def.label}.`, 'warn');
      return;
    }
  }
  const {w,h} = effectiveFootprint(type, def, facing, length);
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
      // A building with a deep foundation (§ Building foundations) also
      // conflicts with any track ALREADY built at a level its foundation
      // would reach — the symmetric case of buildTrackTile refusing to lay
      // new track under an existing building's foundation. Buildings with
      // no foundation (blockedUndergroundLevels 0 or omitted) never check
      // this at all, exactly as before this feature existed.
      let foundationConflict = false;
      for(let level=1; level<=(def.blockedUndergroundLevels||0); level++){
        if(Object.values(cell.layers[undergroundGradeName(level)]).some(t => t.track)){ foundationConflict = true; break; }
      }
      if(groundOccupied || cell.buildingId || foundationConflict){ logEvent(`${def.label} footprint overlaps something at (${cx},${cy}).`, 'warn'); return; }
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
  createBuilding(type, x, y, tier, facing, resource, length);
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
    const [grade, kind] = LAYER_GRADE_KIND[layer];
    // Sever this tile's edges from whichever neighbors it was connected to,
    // so they don't retain a connection to track that no longer exists.
    // A ramp edge (§ Underground layer; § Multi-level tunnels) is a
    // cross-layer connection, not a same-layer one — its partner lives on
    // the SAME neighbor cell but a DIFFERENT grade, and rampEdge[dir]
    // already stores exactly which one (see buildUndergroundRamp), so no
    // guessing is needed here the way an older ground<->underground-only
    // version would have had to.
    for(const {dir,dx,dy,opp} of ROAD_DIRS){
      if(track.edges[dir]) trackAt(x+dx, y+dy, layer).edges[opp] = false;
      const targetGrade = track.rampEdge[dir];
      if(targetGrade) trackAt(x+dx, y+dy, GRADE_KIND_LAYER[targetGrade][kind]).rampEdge[opp] = null;
    }
    track.track = false;
    track.edges = {N:false, S:false, E:false, W:false};
    track.oneWayBlocked = {N:false, S:false, E:false, W:false};
    track.blockId = {N:null, S:null, E:null, W:null};
    track.rampEdge = {N:null, S:null, E:null, W:null};
    // This kind's same-cell vertical ramps need one of THEIR OWN two grades
    // present — demolishing this grade's track invalidates every RAMP_PAIRS
    // entry that touches it (elevated touches both groundElevated as its
    // hi and elevatedAirspace as its lo, so demolishing elevated clears
    // both), never a pair that doesn't mention this grade at all, and never
    // the other kind's ramps.
    for(const pair of RAMP_PAIRS){
      if((pair.lo===grade || pair.hi===grade) && cell.ramps[kind][pair.key]) cell.ramps[kind][pair.key] = false;
    }
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
// Raising/lowering terrain (§ Terrain elevation) changes cell.elevation by
// one level — every one of ground/elevated/underground's actual heights at
// this (x,y) moves together with it (see elevationAt in world.js). That
// means changing it while ANY track (any kind, any grade) or a building
// already occupies the cell could silently invalidate an edge whose delta
// was validated at BUILD time (elevationBlocksConnection above) with no
// mechanism here to re-check or notify the player — so terraforming
// instead requires a fully clear cell. Grade the land before you build on
// it, not instead of rebuilding what's already there.
function terraform(x,y,delta){
  const cell = getCell(x,y);
  if(cell.buildingId){ logEvent('Clear the building here before terraforming.', 'warn'); return; }
  for(const grade in cell.layers){
    for(const kind in cell.layers[grade]){
      if(cell.layers[grade][kind].track){ logEvent('Clear all track here before terraforming.', 'warn'); return; }
    }
  }
  const next = cell.elevation + delta;
  if(next < ELEVATION_MIN || next > ELEVATION_MAX){
    logEvent(`Elevation must stay between ${ELEVATION_MIN} and ${ELEVATION_MAX}.`, 'warn');
    return;
  }
  if(!canAfford(TERRAFORM_COST)){ logEvent('Insufficient funds for terraforming.', 'warn'); return; }
  charge(TERRAFORM_COST, delta>0 ? 'raise terrain' : 'lower terrain');
  cell.elevation = next;
}
function cmdRaiseTerrain(x,y){ terraform(x,y,1); }
function cmdLowerTerrain(x,y){ terraform(x,y,-1); }
