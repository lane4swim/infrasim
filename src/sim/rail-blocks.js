// ---------------------------------------------------------------------
// RAIL BLOCKS — mutual-exclusion segments, recomputed on track edit only
// (§ Block segmentation), never per tick. A block is a maximal run of rail
// edges between two "hubs." A cell is a hub — a block boundary — if it's a
// junction or dead end (its own degree isn't exactly 2), has a signal on
// any of its edges (a signal IS a boundary, not just a direction filter),
// touches a Rail Depot or Train Yard (so a train's approach to either is
// always its own segment, never shared with unrelated through-traffic), or
// has a same-cell vertical ramp or ground<->underground ramp edge touching
// this grade (railCellHasVerticalRamp/railCellHasRampEdge below — any such
// vertical transition is as natural a block boundary as a signal — see
// computeRailBlocks below for why every rail layer gets this treatment
// independently). Two trains can
// never hold the same block at once, regardless of the softer
// velocity-gap spacing trains also use for smooth car-following — the
// block is a hard guarantee on top of that, not a replacement for it (see
// tickTrainMovement).
// ---------------------------------------------------------------------
function railCellDegree(x,y,layer){
  const track = trackAt(x,y,layer);
  let n = 0;
  for(const {dir} of ROAD_DIRS) if(track.edges[dir]) n++;
  return n;
}
function railCellHasSignal(x,y,layer){
  const track = trackAt(x,y,layer);
  for(const {dir} of ROAD_DIRS) if(track.edges[dir] && track.oneWayBlocked[dir]) return true;
  return false;
}
// Any building with real rail engagement — a Depot (RailNode) or a Train
// Yard (TrainYard) — is a natural block boundary: a train's approach to
// either is always its own segment, never shared with unrelated
// through-traffic. Depot and Yard stay separate components (different
// things touching them means different things — a truck chain vs. an
// assembly command), but both count here. Grid-adjacency only, regardless
// of which rail layer is asking — a Depot/Yard is always a ground
// building, so this can never actually trigger for a railElevated cell in
// practice (nothing elevated is ever adjacent to a ground building at the
// same (x,y)), but it costs nothing to leave layer-agnostic here rather
// than adding a check that can never fire.
function railCellTouchesRailEndpoint(x,y){
  for(const [nx,ny] of neighbors4(x,y)){
    const buildingId = getCell(nx,ny).buildingId;
    if(buildingId!=null && (hasComponent(buildingId,'RailNode') || hasComponent(buildingId,'TrainYard'))) return true;
  }
  return false;
}
function railCellTouchesYard(x,y){
  for(const [nx,ny] of neighbors4(x,y)){
    const buildingId = getCell(nx,ny).buildingId;
    if(buildingId!=null && hasComponent(buildingId,'TrainYard')) return true;
  }
  return false;
}
// A rail cell with any ramp edge (§ Underground layer) is a boundary for
// the same reason a same-cell Rail Ramp is: the transition itself is
// always its own segment, shared with no unrelated through-traffic —
// see railCellIsHub.
function railCellHasRampEdge(x,y,layer){
  const track = trackAt(x,y,layer);
  for(const {dir} of ROAD_DIRS) if(track.rampEdge[dir]) return true;
  return false;
}
// A rail cell with any same-cell vertical ramp touching this layer's grade
// (§ Terrain elevation — RAMP_PAIRS in world.js: groundElevated,
// elevatedAirspace, or undergroundDeep) is a hub for the same reason a
// same-cell ground<->elevated Rail Ramp always was — see railCellIsHub.
function railCellHasVerticalRamp(x,y,grade){
  const ramps = getCell(x,y).ramps.rail;
  return RAMP_PAIRS.some(pair => (pair.lo===grade || pair.hi===grade) && ramps[pair.key]);
}
function railCellIsHub(x,y,layer){
  const [grade] = LAYER_GRADE_KIND[layer];
  return railCellDegree(x,y,layer) !== 2 || railCellHasSignal(x,y,layer) || railCellTouchesRailEndpoint(x,y) || railCellHasVerticalRamp(x,y,grade) || railCellHasRampEdge(x,y,layer);
}

// Computes blocks for one rail layer ('rail' or 'railElevated') into the
// shared world.railBlocks map, continuing the block-id sequence a caller
// hands in rather than restarting at 1 — see computeRailBlocks below,
// which runs this once per layer so ids from either never collide.
function computeRailBlocksForLayer(layer, blockIdCounter){
  const visitedEdge = new Set(); // "x,y,dir" — each directed edge is visited exactly once across both walking passes below
  const railCells = [];
  for(const [k] of world.grid){
    const [x,y] = k.split(',').map(Number);
    const track = trackAt(x,y,layer);
    if(!track.track) continue;
    railCells.push({x,y});
    for(const {dir} of ROAD_DIRS) track.blockId[dir] = null; // stale ids from the previous topology
  }
  // Walk every edge out of a hub cell until the next hub, assigning one
  // shared block id to every edge crossed along the way (both directions —
  // block membership doesn't depend on direction of travel).
  function walkBlock(startX, startY, startDir){
    const blockId = blockIdCounter.next++;
    world.railBlocks.set(blockId, {occupiedBy:null});
    let x = startX, y = startY, dir = startDir;
    while(true){
      const d = ROAD_DIRS.find(r=>r.dir===dir);
      const nx = x+d.dx, ny = y+d.dy;
      trackAt(x,y,layer).blockId[dir] = blockId;
      trackAt(nx,ny,layer).blockId[d.opp] = blockId;
      visitedEdge.add(x+','+y+','+dir);
      visitedEdge.add(nx+','+ny+','+d.opp);
      if(railCellIsHub(nx,ny,layer)) break;
      const track = trackAt(nx,ny,layer);
      const forward = ROAD_DIRS.find(r=>r.dir!==d.opp && track.edges[r.dir]);
      if(!forward || visitedEdge.has(nx+','+ny+','+forward.dir)) break; // dead end, or a hub-less loop closing back on itself
      x = nx; y = ny; dir = forward.dir;
    }
  }
  // Pass 1: every edge reachable from an actual hub.
  for(const {x,y} of railCells){
    if(!railCellIsHub(x,y,layer)) continue;
    const track = trackAt(x,y,layer);
    for(const {dir} of ROAD_DIRS){
      if(!track.edges[dir] || visitedEdge.has(x+','+y+','+dir)) continue;
      walkBlock(x,y,dir);
    }
  }
  // Pass 2: whatever's left is a closed loop of degree-2 track with no
  // signal, depot, or ramp anywhere on it — no natural boundary, so it
  // becomes one block, split arbitrarily at whichever edge is encountered
  // first.
  for(const {x,y} of railCells){
    const track = trackAt(x,y,layer);
    for(const {dir} of ROAD_DIRS){
      if(!track.edges[dir] || visitedEdge.has(x+','+y+','+dir)) continue;
      walkBlock(x,y,dir);
    }
  }
}
// Rail's layers — 'rail', 'railElevated', one 'railUnderground'[N] per
// underground level (§ Multi-level tunnels), 'railDeepUnderground', and
// 'railAirspace' (see world.js) — each get their own independent block
// graph — a ramp cell (same-cell vertical ramp OR a ramp edge between two
// underground-stack grades) is a hub on BOTH layers it touches (see
// railCellIsHub above), so a train transitioning between any two of them
// always crosses a block boundary there anyway; there's no need for one
// combined graph spanning the transition itself (tickTrainMovement treats
// a layer-changing step as always allowed, with no edge/block of its own —
// see its canEnter/onEnter callbacks, which key off `cur.layer !==
// next.layer` regardless of whether that step also changed x/y, as a
// ramp-edge step does). Every layer's blocks share one world.railBlocks
// map and one continuous id sequence, exactly like before this existed for
// a single layer.
function computeRailBlocks(){
  world.railBlocks = new Map();
  const blockIdCounter = {next: 1};
  computeRailBlocksForLayer('rail', blockIdCounter);
  computeRailBlocksForLayer('railElevated', blockIdCounter);
  for(let level=1; level<=UNDERGROUND_LEVELS; level++){
    computeRailBlocksForLayer(undergroundRailLayerName(level), blockIdCounter);
  }
  computeRailBlocksForLayer('railDeepUnderground', blockIdCounter);
  computeRailBlocksForLayer('railAirspace', blockIdCounter);
}
// A train holds every block its body currently spans, not just whichever
// one its FRONT most recently entered — a train longer than one block's
// remaining stretch still has its TAIL sitting in the previous block for a
// while after its front has already crossed into the next one, and that
// previous block has to stay held until the tail has cleared it too, or a
// second train could be let onto a block this train's own tail is still
// physically occupying. `v.blockTrail` mirrors `v.trail` (systems.js) —
// index i is the block of the edge crossed i steps ago — so the trailing
// edges still "under" the train's body are exactly its first `cellsNeeded`
// entries, the same `Math.ceil(v.length)` formula footprintKeysFor
// (systems.js) already uses for the soft per-cell reservation, so this
// always covers at least as much of the train as that does. Only PRUNES
// blocks that fell out of that window — acquiring a newly-entered block is
// still done at the point of crossing (tickTrainMovement's onEnter), since
// that's the one place that actually knows a new edge was just crossed.
function updateHeldBlocks(v){
  const cellsNeeded = Math.max(1, Math.ceil(v.length));
  const edgesToConsider = Math.min(cellsNeeded, v.blockTrail.length);
  const stillNeeded = new Set(v.blockTrail.slice(0, edgesToConsider).filter(b => b!=null));
  for(const blockId of v.heldBlocks){
    if(stillNeeded.has(blockId)) continue;
    const block = world.railBlocks.get(blockId);
    if(block && block.occupiedBy===v.id) block.occupiedBy = null;
  }
  v.heldBlocks = [...stillNeeded];
}
// Releases every block this train currently holds — used when a train is
// sold/demolished, so it never leaves a block locked with no train left to
// eventually clear it.
function releaseBlock(v){
  for(const blockId of v.heldBlocks){
    const block = world.railBlocks.get(blockId);
    if(block && block.occupiedBy===v.id) block.occupiedBy = null;
  }
  v.heldBlocks = [];
}
