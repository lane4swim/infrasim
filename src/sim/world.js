// ---------------------------------------------------------------------
// WORLD STATE
// ---------------------------------------------------------------------
const GRID_W = 22, GRID_H = 14, CELL = 40;
const world = {
  treasury: INITIAL_TREASURY,
  tick: 0,
  grid: new Map(),          // "x,y" -> { buildingId, elevation, ramps, layers:{ground,elevated,airspace,deepUnderground,underground[,underground2,...]} }
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
// Multi-level tunnels (§ Multi-level tunnels) — the underground stack is
// no longer a single grade: UNDERGROUND_LEVELS (loader.js) of them, level
// 1 nearest the surface. Level 1 keeps the ORIGINAL 'underground'/
// 'railUnderground' names (every save file, test, and piece of code
// written before multi-level tunnels existed already means "level 1" by
// that name); level N>1 is 'underground'+N / 'railUnderground'+N. These
// two functions are the one place that naming convention lives — every
// other file goes through them (or through LAYER_GRADE_KIND/
// GRADE_KIND_LAYER, which are themselves built from these below) rather
// than constructing the string itself.
function undergroundGradeName(level){
  return level===1 ? 'underground' : 'underground'+level;
}
function undergroundRailLayerName(level){
  return level===1 ? 'railUnderground' : 'railUnderground'+level;
}
// The inverse — given a grade name, which underground level is it (1 for
// the original 'underground', 2 for 'underground2', ...)? Returns null for
// a grade that isn't part of the underground stack at all (ground,
// elevated, airspace, deepUnderground). Used wherever code needs to go
// from "the layer the player has selected" to "which Tunnel Ramp level
// pair that implies" (see cmdBuildUndergroundRamp's level param and
// currentUndergroundLevel in ui.js).
function undergroundLevelOfGrade(grade){
  if(grade==='underground') return 1;
  const m = /^underground(\d+)$/.exec(grade);
  return m ? parseInt(m[1],10) : null;
}
// Deeper underground levels cost more, both per-tile and per-ramp — see
// UNDERGROUND_LEVEL_COST_STEP/UNDERGROUND_RAMP_LEVEL_STEP (loader.js) for
// why. Level 1 always resolves to exactly UNDERGROUND_COST_MULTIPLIER/
// UNDERGROUND_RAMP_COST, unchanged from before multi-level tunnels existed.
function costMultiplierForUndergroundLevel(level){
  return UNDERGROUND_COST_MULTIPLIER + (level-1)*UNDERGROUND_LEVEL_COST_STEP;
}
function rampCostForUndergroundLevel(level){
  return UNDERGROUND_RAMP_COST + (level-1)*UNDERGROUND_RAMP_LEVEL_STEP;
}
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
    // A ramp edge (§ Underground layer; § Multi-level tunnels) is a
    // DIFFERENT thing from a normal `edges` connection: it's a sloped
    // transition to the SAME kind's track one grade away, at the ADJACENT
    // cell in that direction — ground track descending into its neighbor's
    // underground track, or underground level 1 descending into its
    // neighbor's level 2, or the reverse of either — rather than a
    // same-grade connection at the same neighbor. Deliberately kept out of
    // `edges` (which stays "same-grade connectivity" everywhere else —
    // degree counts, one-way, Connect/Disconnect) rather than overloading
    // it, so every piece of code that already reads `edges` for same-grade
    // purposes doesn't need to learn a new exception.
    //
    // Each direction holds the NAME of the grade it connects to (e.g.
    // 'underground2'), not just a boolean — a cell in the underground
    // stack can have a ramp edge going UP one level and a completely
    // different one going DOWN one level (in different directions), so
    // pathfinding needs to know which grade each direction actually leads
    // to rather than guessing from a fixed ground<->underground swap. null
    // means no ramp edge that way. Only ever set on ground-grade or
    // underground-grade (any level) track — never elevated/airspace/
    // deepUnderground, since a ramp edge always steps toward/away from the
    // underground stack specifically (see connectNewTileEdges/
    // cmdBuildUndergroundRamp in commands.js and findLayerPath in
    // pathfinding.js for the two places this is read).
    rampEdge:{N:null,S:null,E:null,W:null},
    // Diagonal pairs (§ Rail crossings' selective diagonal connections) —
    // only ever meaningful at a genuine 4-way RAIL crossing (isRailCrossing,
    // pathfinding.js): the two straight pairs (N-S, E-W) are always
    // connected there by default (a plain crossing, no switch), but a
    // player can additionally enable one or more of the 4 "corner" pairs —
    // NE, NW, SE, SW — via cmdToggleDiagonalConnection, modeling a real
    // switch/points at that crossing. False for every pair by default, and
    // meaningless (never read) anywhere the cell isn't a genuine 4-way rail
    // crossing right now — present on every track object (road included)
    // purely for shape-uniformity, the same reason `blockId`/`rampEdge` are.
    diagonalPairs:{NE:false, NW:false, SE:false, SW:false},
  };
}
// Terrain elevation (§ Terrain elevation) — an integer height per (x,y)
// column, relative to an arbitrary 0 ("sea level"). Ground-grade track
// literally sits at this height; elevated/underground sit a fixed offset
// above/below it (see ELEVATION_OFFSET/elevationAt below), so a hill's
// elevated bridge and a valley's elevated bridge are each still exactly
// one level above their OWN local ground, never a fixed absolute height.
// Bounded (ELEVATION_MIN/MAX below) purely to keep the terrain fill/cliff
// rendering and the raise/lower terrain tool (cmdRaiseTerrain/
// cmdLowerTerrain in commands.js) sane, not for any simulation reason.
const ELEVATION_MIN = -4, ELEVATION_MAX = 4;
// The single rule that makes elevation matter for connectivity, not just
// looks: two adjacent ground/elevated/underground tiles can only connect
// (auto- or manually — see elevationBlocksConnection in commands.js) if
// their terrain heights differ by at most this many levels — a real slope
// a road/track can actually climb, rather than a cliff. Deliberately a
// flat constant, not a per-vehicle or content-pack field (unlike
// transferRate/lengthTiles) — how steep a connection can be is a property
// of the infrastructure itself, the same way the straight-through-only
// rule for a Tunnel Ramp is, not something a vehicle def would vary.
const MAX_ELEVATION_DELTA = 1;
// deepUnderground and airspace (below) are FLAT global planes — every
// cell's deepUnderground/airspace track sits at the same absolute height
// regardless of local terrain, unlike ground/elevated/underground which
// all move together with the terrain beneath them. These two constants
// just need to stay outside the full ELEVATION_MIN/MAX + offset range so
// "below all regular depths" / "above all regular heights" holds no
// matter how the terrain is shaped.
const DEEP_UNDERGROUND_Z = -1000;
const AIRSPACE_Z = 1000;
// elevated is always exactly one level above local ground; each
// underground level is exactly that many levels below (level 1 is -1,
// level 2 is -2, ...) — see ELEVATION_MIN/MAX above for why "one level" is
// the unit. Only ground/elevated/the underground stack read cell.elevation
// at all; deepUnderground/airspace ignore it entirely (see elevationAt
// below).
const ELEVATION_OFFSET = { ground: 0, elevated: 1 };
for(let level=1; level<=UNDERGROUND_LEVELS; level++){
  ELEVATION_OFFSET[undergroundGradeName(level)] = -level;
}
// The real height of one grade's track at one cell — the one function
// every elevation-aware piece of code (the connectivity cap, terrain/cliff
// rendering) should call rather than reaching into cell.elevation or the
// offset table directly.
function elevationAt(x,y,grade){
  if(grade==='deepUnderground') return DEEP_UNDERGROUND_Z;
  if(grade==='airspace') return AIRSPACE_Z;
  return getCell(x,y).elevation + ELEVATION_OFFSET[grade];
}
// Same-cell vertical ramps (§ Terrain elevation) link two ADJACENT grades
// in the vertical stack at the SAME (x,y) — currently just the original
// pylon ramp, ground<->elevated. deepUnderground and airspace are grades
// in the vertical stack (deepUnderground < underground < ground < elevated
// < airspace) but deliberately have NO ramp pair here: they're reserved
// for future non-road/rail modes (a Plane mode for airspace, a Mine
// extending into deepUnderground) that will need their own access
// mechanism, not a truck/train ramp — a real plane doesn't climb a ramp
// from a bridge, and a mine shaft isn't a road. ground<->underground is
// also deliberately absent — that pair has its own lateral, sloped Tunnel
// Ramp (rampEdge, see newTrack below) instead. Shared by buildVerticalRamp/
// cmdDemolish (commands.js), findLayerPath (pathfinding.js), and
// railCellHasVerticalRamp (rail-blocks.js) — the one place that lists which
// pairs exist, so a future grade's own access mechanism only ever needs a
// new entry here if it turns out to be this same same-cell-vertical shape.
const RAMP_PAIRS = [
  {key:'groundElevated', lo:'ground', hi:'elevated'},
];
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
// (UNDERGROUND_LEVELS + 4) grades now (§ Terrain elevation; § Multi-level
// tunnels): deepUnderground, then UNDERGROUND_LEVELS underground grades
// (deepest first), then ground, elevated, airspace — in that vertical
// order. A ramp, of either kind (same-cell vertical Ramp — RAMP_PAIRS
// above — or sloped ramp edge between adjacent underground levels, or
// between ground and the topmost underground level — see rampEdge below),
// only ever links two ADJACENT grades; there is no direct elevated<->
// underground (or underground level 1 <-> level 3, or deepUnderground<->
// ground, etc.) transition, only via two-or-more ramps in series through
// the grades between — the natural consequence of every ramp reading its
// "other grade" as literally the neighboring entry in this same vertical
// order, never skipping one.
const LAYER_GRADE_KIND = {
  deepUnderground: ['deepUnderground', 'road'],
  ground: ['ground', 'road'],
  elevated: ['elevated', 'road'],
  airspace: ['airspace', 'road'],
  railDeepUnderground: ['deepUnderground', 'rail'],
  rail: ['ground', 'rail'],
  railElevated: ['elevated', 'rail'],
  railAirspace: ['airspace', 'rail'],
};
// The inverse of LAYER_GRADE_KIND — given a (grade, kind), which flat
// layer name is that? Used wherever a ramp move needs "the same kind, the
// other grade" (see findLayerPath in pathfinding.js).
const GRADE_KIND_LAYER = {
  deepUnderground: { road: 'deepUnderground', rail: 'railDeepUnderground' },
  ground: { road: 'ground', rail: 'rail' },
  elevated: { road: 'elevated', rail: 'railElevated' },
  airspace: { road: 'airspace', rail: 'railAirspace' },
};
// Underground levels are generated rather than listed by hand, one entry
// per level 1..UNDERGROUND_LEVELS — level 1 resolves to the original
// 'underground'/'railUnderground' names via undergroundGradeName/
// undergroundRailLayerName above, so this is a pure extension of what
// already existed, not a rename.
for(let level=1; level<=UNDERGROUND_LEVELS; level++){
  const grade = undergroundGradeName(level);
  const railLayer = undergroundRailLayerName(level);
  LAYER_GRADE_KIND[grade] = [grade, 'road'];
  LAYER_GRADE_KIND[railLayer] = [grade, 'rail'];
  GRADE_KIND_LAYER[grade] = { road: grade, rail: railLayer };
}
function trackAt(x,y,layer){
  const [grade, kind] = LAYER_GRADE_KIND[layer];
  return getCell(x,y).layers[grade][kind];
}
function newRampState(){
  // One boolean per RAMP_PAIRS entry (currently just groundElevated — see
  // RAMP_PAIRS above for why deepUnderground/airspace don't get one) — a
  // cell can have any combination, entirely independently, the same way a
  // cell's road and rail track are independent at a given grade.
  const state = {};
  for(const pair of RAMP_PAIRS) state[pair.key] = false;
  return state;
}
function newLayersObject(){
  // deepUnderground/ground/elevated/airspace plus one entry per
  // underground level (§ Multi-level tunnels) — generated the same way
  // LAYER_GRADE_KIND's underground entries are, so a cell always has
  // exactly the grades LAYER_GRADE_KIND knows about.
  const layers = {
    deepUnderground: newGradeLayer(),
    ground: newGradeLayer(),
    elevated: newGradeLayer(),
    airspace: newGradeLayer(),
  };
  for(let level=1; level<=UNDERGROUND_LEVELS; level++){
    layers[undergroundGradeName(level)] = newGradeLayer();
  }
  return layers;
}
function getCell(x,y){
  const k = cellKey(x,y);
  if(!world.grid.has(k)) world.grid.set(k,{
    buildingId: null,
    elevation: 0, // terrain height at this column — see ELEVATION_MIN/MAX above
    // Which KIND is linked vertically here, and which PAIR of grades —
    // road and rail ramps are entirely independent (a cell can have
    // either, both, or neither), same as road/rail track itself.
    ramps: { road: newRampState(), rail: newRampState() },
    layers: newLayersObject(),
  });
  return world.grid.get(k);
}
function inBounds(x,y){ return x>=0 && y>=0 && x<GRID_W && y<GRID_H; }
