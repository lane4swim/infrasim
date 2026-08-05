// ---------------------------------------------------------------------
// WORLD STATE
// ---------------------------------------------------------------------
const GRID_W = 22, GRID_H = 14, CELL = 40;
const world = {
  treasury: INITIAL_TREASURY,
  tick: 0,
  grid: new Map(),          // "x,y" -> { buildingId, ramp, railRamp, layers:{ground,elevated,rail,railElevated} }
  entities: new Map(),      // id -> entity handle (see makeEntityHandle below)
  components: {},           // componentName -> Map<entityId, componentData> — the real storage
  // blockId -> {occupiedBy: entityId|null}. Rail's mutual-exclusion state
  // (§ Block segmentation) is deliberately NOT an ECS component: a block is
  // a property of a *track segment*, and track — like roads — was already a
  // deliberate non-entity (§ Track as grid data) because it's uniform,
  // position-indexed, and numerous. This table is the direct analog of a
  // component table (recomputed wholesale on track topology change; each
  // rail edge's `blockId` in the grid points into it), just keyed by block
  // id instead of entity id, for the same reason components are keyed by
  // entity id — independent, queryable storage.
  railBlocks: new Map(),
  nextId: 1,
};

function cellKey(x,y){ return x+','+y; }
// `track` (was `road` in Phase 1) is a generic "is there a network tile
// here" flag — the same {track,edges,oneWayBlocked} shape now backs the
// ground/elevated ROAD layers and the RAIL layer, since nothing about
// per-edge connectivity, one-way blocking, or BFS pathfinding is actually
// road-specific (see the Rail milestone notes below). `blockId` is only
// ever populated for the rail layer (mutual-exclusion segment id per
// edge) but lives on every layer's track object for shape-uniformity.
function newTrack(){
  return {
    track:false,
    edges:{N:false,S:false,E:false,W:false},
    oneWayBlocked:{N:false,S:false,E:false,W:false},
    blockId:{N:null,S:null,E:null,W:null},
  };
}
function getCell(x,y){
  const k = cellKey(x,y);
  if(!world.grid.has(k)) world.grid.set(k,{
    buildingId: null,
    ramp: false,             // true if ground and elevated ROAD tracks are linked vertically here
    railRamp: false,         // true if rail and railElevated tracks are linked vertically here — the rail network's own Ramp, entirely independent of the road one above
    // Rail gets the same ground/elevated split road already has (rail
    // bridges) — `rail` is ground-level track, `railElevated` a separate
    // bridge layer, linked only at a railRamp cell, exactly mirroring how
    // `ground`/`elevated` only link at a (road) Ramp. Four independent
    // layers, not a 2x2 nested structure, so every existing piece of code
    // that already treats "a layer" as a flat string key into this object
    // (pathfinding, rendering, block computation) needed no restructuring,
    // just one more key to iterate.
    layers: { ground:newTrack(), elevated:newTrack(), rail:newTrack(), railElevated:newTrack() },
  });
  return world.grid.get(k);
}
function inBounds(x,y){ return x>=0 && y>=0 && x<GRID_W && y<GRID_H; }
