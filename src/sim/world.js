// ---------------------------------------------------------------------
// WORLD STATE
// ---------------------------------------------------------------------
const GRID_W = 22, GRID_H = 14, CELL = 40;
const world = {
  treasury: INITIAL_TREASURY,
  tick: 0,
  grid: new Map(),          // "x,y" -> { buildingId, ramps, layers:{ground,elevated} }
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
// here" flag — the same {track,edges,oneWayBlocked} shape backs every
// kind of infrastructure at every grade (road and rail today; whatever
// comes next tomorrow), since nothing about per-edge connectivity,
// one-way blocking, or BFS pathfinding is actually road- or rail-specific.
// `blockId` is only ever populated for rail (mutual-exclusion segment id
// per edge) but lives on every kind's track object for shape-uniformity.
function newTrack(){
  return {
    track:false,
    edges:{N:false,S:false,E:false,W:false},
    oneWayBlocked:{N:false,S:false,E:false,W:false},
    blockId:{N:null,S:null,E:null,W:null},
  };
}
// One physical grade (ground or elevated) holds every KIND of
// infrastructure that can exist at that height — road and rail today.
// This is the merge: road and rail used to be entirely separate
// top-level layers (four of them: ground, elevated, rail, railElevated),
// which meant the "can't run two networks parallel through the same
// cell" rule and the rail-block/crossing machinery both had to name each
// pairing explicitly, and adding a third kind (a pipeline, a power line —
// §15's later transport modes) would have meant two MORE top-level
// layers plus another explicit pairing. Now a grade is just a bag of
// kinds, and every kind in that bag automatically participates in the
// same crossing rule and the same rendering/block logic — adding
// `pipeline: newTrack()` here is the entire grid-side cost of a new
// infrastructure type; see directionClaimedByOtherNetwork in commands.js
// for the part of the crossing rule this actually pays off.
function newGradeLayer(){
  return { road: newTrack(), rail: newTrack() };
}
// A "layer" is what every vehicle-, command-, and render-facing piece of
// code already calls the thing a vehicle sits on or a tile belongs to —
// 'ground'/'elevated' for trucks, 'rail'/'railElevated' for trains. That
// flat 4-name vocabulary didn't need to change just because the grid's
// own storage merged underneath it (renaming it everywhere would have
// been churn for no behavioral gain) — LAYER_GRADE_KIND is the one place
// that translates a flat layer name to the (grade, kind) pair the grid
// actually stores it under, and trackAt is the one place every piece of
// grid-reading/writing code should go through instead of indexing
// world.grid directly by a flat name.
const LAYER_GRADE_KIND = {
  ground: ['ground', 'road'],
  elevated: ['elevated', 'road'],
  rail: ['ground', 'rail'],
  railElevated: ['elevated', 'rail'],
};
// The inverse of LAYER_GRADE_KIND — given a (grade, kind), which flat
// layer name is that? Used wherever a vertical (ramp) move needs "the
// same kind, the other grade" (see findLayerPath in pathfinding.js).
const GRADE_KIND_LAYER = {
  ground: { road: 'ground', rail: 'rail' },
  elevated: { road: 'elevated', rail: 'railElevated' },
};
function trackAt(x,y,layer){
  const [grade, kind] = LAYER_GRADE_KIND[layer];
  return getCell(x,y).layers[grade][kind];
}
function getCell(x,y){
  const k = cellKey(x,y);
  if(!world.grid.has(k)) world.grid.set(k,{
    buildingId: null,
    // Which KIND is linked vertically here — a road Ramp and a rail Ramp
    // are entirely independent (a cell can have either, both, or
    // neither), the same way road and rail track themselves are
    // independent at a given grade. One map instead of a `ramp` +
    // `railRamp` boolean pair for the same reason layers merged: a third
    // kind just adds a third key here, not a third named boolean.
    ramps: { road: false, rail: false },
    layers: { ground: newGradeLayer(), elevated: newGradeLayer() },
  });
  return world.grid.get(k);
}
function inBounds(x,y){ return x>=0 && y>=0 && x<GRID_W && y<GRID_H; }
