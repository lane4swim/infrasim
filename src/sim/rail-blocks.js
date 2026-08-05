// ---------------------------------------------------------------------
// RAIL BLOCKS — mutual-exclusion segments, recomputed on track edit only
// (§ Block segmentation), never per tick. A block is a maximal run of rail
// edges between two "hubs." A cell is a hub — a block boundary — if it's a
// junction or dead end (its own degree isn't exactly 2), has a signal on
// any of its edges (a signal IS a boundary, not just a direction filter),
// or touches a Rail Depot (so a train's approach to a depot is always its
// own segment, never shared with unrelated through-traffic). Two trains
// can never hold the same block at once, regardless of the softer
// velocity-gap spacing trains also use for smooth car-following — the
// block is a hard guarantee on top of that, not a replacement for it (see
// tickTrainMovement).
// ---------------------------------------------------------------------
function railCellDegree(x,y){
  const track = getCell(x,y).layers.rail;
  let n = 0;
  for(const {dir} of ROAD_DIRS) if(track.edges[dir]) n++;
  return n;
}
function railCellHasSignal(x,y){
  const track = getCell(x,y).layers.rail;
  for(const {dir} of ROAD_DIRS) if(track.edges[dir] && track.oneWayBlocked[dir]) return true;
  return false;
}
// Any building with real rail engagement — a Depot (RailNode) or a Train
// Yard (TrainYard) — is a natural block boundary: a train's approach to
// either is always its own segment, never shared with unrelated
// through-traffic. Depot and Yard stay separate components (different
// things touching them means different things — a truck chain vs. an
// assembly command), but both count here.
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
function railCellIsHub(x,y){
  return railCellDegree(x,y) !== 2 || railCellHasSignal(x,y) || railCellTouchesRailEndpoint(x,y);
}

function computeRailBlocks(){
  world.railBlocks = new Map();
  let nextBlockId = 1;
  const visitedEdge = new Set(); // "x,y,dir" — each directed edge is visited exactly once across both walking passes below
  const railCells = [];
  for(const [k,cell] of world.grid){
    const track = cell.layers.rail;
    if(!track.track) continue;
    const [x,y] = k.split(',').map(Number);
    railCells.push({x,y});
    for(const {dir} of ROAD_DIRS) track.blockId[dir] = null; // stale ids from the previous topology
  }
  // Walk every edge out of a hub cell until the next hub, assigning one
  // shared block id to every edge crossed along the way (both directions —
  // block membership doesn't depend on direction of travel).
  function walkBlock(startX, startY, startDir){
    const blockId = nextBlockId++;
    world.railBlocks.set(blockId, {occupiedBy:null});
    let x = startX, y = startY, dir = startDir;
    while(true){
      const d = ROAD_DIRS.find(r=>r.dir===dir);
      const nx = x+d.dx, ny = y+d.dy;
      getCell(x,y).layers.rail.blockId[dir] = blockId;
      getCell(nx,ny).layers.rail.blockId[d.opp] = blockId;
      visitedEdge.add(x+','+y+','+dir);
      visitedEdge.add(nx+','+ny+','+d.opp);
      if(railCellIsHub(nx,ny)) break;
      const track = getCell(nx,ny).layers.rail;
      const forward = ROAD_DIRS.find(r=>r.dir!==d.opp && track.edges[r.dir]);
      if(!forward || visitedEdge.has(nx+','+ny+','+forward.dir)) break; // dead end, or a hub-less loop closing back on itself
      x = nx; y = ny; dir = forward.dir;
    }
  }
  // Pass 1: every edge reachable from an actual hub.
  for(const {x,y} of railCells){
    if(!railCellIsHub(x,y)) continue;
    const track = getCell(x,y).layers.rail;
    for(const {dir} of ROAD_DIRS){
      if(!track.edges[dir] || visitedEdge.has(x+','+y+','+dir)) continue;
      walkBlock(x,y,dir);
    }
  }
  // Pass 2: whatever's left is a closed loop of degree-2 track with no
  // signal or depot anywhere on it — no natural boundary, so it becomes one
  // block, split arbitrarily at whichever edge is encountered first.
  for(const {x,y} of railCells){
    const track = getCell(x,y).layers.rail;
    for(const {dir} of ROAD_DIRS){
      if(!track.edges[dir] || visitedEdge.has(x+','+y+','+dir)) continue;
      walkBlock(x,y,dir);
    }
  }
}
function releaseBlock(v){
  if(v.currentBlock==null) return;
  const block = world.railBlocks.get(v.currentBlock);
  if(block && block.occupiedBy===v.id) block.occupiedBy = null;
  v.currentBlock = null;
}
