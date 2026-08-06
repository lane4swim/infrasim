// Single lookup point for "what def table is this vehicle type in" — used
// everywhere a truck-or-train's stats/cost/label are needed, so adding a
// third vehicle family (ship, plane) later only means adding one more def
// table and one more branch here, not touching every call site.
function getVehicleDef(type){ return VEHICLE_DEFS[type]; } // trucks only — a train has no single def, see getTrainStats
// A train is an entity carrying a Consist component (engineType, wagonType,
// wagonCount) rather than a fixed VEHICLE_DEFS-style type — this is the one
// place that distinction is made, so every other system/render/command call
// site asks "does this vehicle have a Consist" instead of comparing type
// strings against a table that no longer exists for trains.
function isTrain(id){ return hasComponent(id, 'Consist'); }
// Combines one engine (physics: speed/mass/engine+brake force) with N
// identical wagons (cargo: capacity + the one resource they carry) into the
// same shape getVehicleDef returns for a truck — every call site that reads
// a vehicle's stats (rendering, upkeep, sell, inspector) can stay a single
// dispatcher (getVehicleStats below) instead of branching everywhere.
function getTrainStats(consist){
  const engine = ENGINE_DEFS[consist.engineType];
  const wagon = WAGON_DEFS[consist.wagonType];
  const n = consist.wagonCount;
  return {
    label: `${engine.label} + ${n}× ${wagon.label}`,
    color: engine.color,
    purchaseCost: engine.purchaseCost + wagon.purchaseCost * n,
    runningCostPerTick: engine.runningCostPerTick,
    sellFraction: engine.sellFraction,
    capacity: wagon.capacity * n,
    resource: wagon.resource,
    maxSpeedTilesPerTick: engine.maxSpeedTilesPerTick,
    massEmpty: engine.massEmpty + wagon.massEmpty * n,
    engineForce: engine.engineForce,
    brakeForce: engine.brakeForce,
    lengthTiles: engine.lengthTiles + wagon.lengthTiles * n,
  };
}
// Single lookup point for "what are this vehicle's stats" regardless of
// whether it's a truck (one VEHICLE_DEFS entry) or a train (derived from
// its Consist) — the general-purpose successor to the old getVehicleDef(type)
// call sites now that a train's type isn't a table key.
function getVehicleStats(v){ return isTrain(v.id) ? getTrainStats(v.consist) : getVehicleDef(v.type); }
// ENTITY FACTORIES
// ---------------------------------------------------------------------
// A Rail Depot's footprint is authored long-axis-N-S in the content pack
// (see depotPlatformCells in pathfinding.js for why only the pair of sides
// PARALLEL to the long axis can ever be its rail side); building it 'ew'
// instead just swaps w/h, so the same footprint data serves either
// orientation with no second content-pack entry. Every other building type
// is unaffected — this is a no-op for them, returning the def's footprint
// verbatim. Shared between createBuilding (below) and cmdBuildBuilding's
// pre-creation bounds/overlap check (commands.js), so both agree on what
// "this building's footprint" actually means before and after it exists.
function effectiveFootprint(type, def, orientation){
  if(type==='depot' && orientation==='ew') return {w:def.footprint.h, h:def.footprint.w};
  return def.footprint;
}
function createBuilding(type, x, y, tier, facing, resource){
  const def = BUILDING_DEFS[type];
  const id = world.nextId++;
  addComponent(id, 'Identity', {kind:'building', type});
  addComponent(id, 'Transform', {x, y, layer:'ground'});
  // `facing` doubles as a Depot's orientation ('ns'|'ew') — Depots have no
  // road-facing side of their own (a Station touching one handles that,
  // same as any other industry), so the slot Station already uses this
  // parameter for was free to repurpose rather than adding a new one.
  const fp = effectiveFootprint(type, def, facing);
  addComponent(id, 'Footprint', {w:fp.w, h:fp.h}); // cells occupied, anchored at (x,y)
  if(type==='station'){
    addComponent(id, 'Facing', facing); // which single side can ever touch a road (Stations only)
    addComponent(id, 'StationResource', resource || 'ore'); // which single resource this Station handles
  }
  if(type==='mine' || type==='mill'){
    // Producer covers both extraction (no inputs) and processing (has
    // inputs) — the recipe is what tells tickProduction which applies.
    const recipe = RECIPES[def.recipe];
    addComponent(id, 'Producer', {recipeId: def.recipe, ticksRemaining: recipe.durationTicks});
    const cap = def.tiers[tier].cap;
    addComponent(id, 'Storage', {
      out: recipe.outputs.length ? {resource: recipe.outputs[0].resource, stock:0, cap} : null,
      in: recipe.inputs.length ? {resource: recipe.inputs[0].resource, stock:0, cap} : null,
    });
  }
  if(type==='town'){
    const population = def.tiers[tier].population;
    addComponent(id, 'Consumer', {population, consumptionPerTick: population*CONSUMPTION_PER_CAPITA, priceMultiplier:1.0});
    // A Town's accepted resource is configurable at build time (defaults to
    // ore for back-compat); it's whatever its population actually wants
    // delivered, and what its Storage.in buffer/consumption operate on.
    addComponent(id, 'Storage', {out:null, in:{resource: resource || 'ore', stock:0, cap: def.tiers[tier].cap}});
  }
  if(type==='depot'){
    // `out` and `in` are literally the SAME slot object (not two separate
    // counters that happen to share a resource id) — a Depot doesn't
    // convert anything, so there's only one physical pile of the resource
    // it buffers. Aliasing them means a truck's drop-off (which writes
    // `in.stock`) and a train's pickup (which reads `out.stock`) are
    // reading/writing the exact same number, in either direction, using
    // the existing Storage machinery completely unchanged — no special
    // casing needed anywhere else in the codebase.
    const cap = def.tiers[tier].cap;
    const slot = {resource: resource || 'ore', stock:0, cap};
    addComponent(id, 'Storage', {out: slot, in: slot});
    addComponent(id, 'RailNode', {});
  }
  if(type==='trainyard'){
    // No Storage, no road side, no Station requirement to touch anything —
    // a Yard doesn't move cargo at all, it's purely where a train's parts
    // (paid for directly, not physically delivered) get assembled into one
    // vehicle. Full-perimeter rail access, same as a Depot's rail side.
    addComponent(id, 'TrainYard', {});
  }
  const handle = makeEntityHandle(id);
  world.entities.set(id, handle);
  for(const cell of footprintCells(handle)) getCell(cell.x, cell.y).buildingId = id;
  return handle;
}
// Shared by createTruck/createTrain: the individual, fractional per-vehicle
// Movement values (not shared constants) that make two vehicles of the same
// spec end up slightly different, the same way real vehicles of the same
// model aren't perfectly identical.
function randomizedMovement(spec){
  return {
    speed: 0, // current velocity, tiles/tick — starts at rest and accelerates (see tickVehicles/tickTrainMovement)
    maxSpeed: spec.maxSpeedTilesPerTick * (0.85 + Math.random()*0.3),
    massEmpty: spec.massEmpty * (0.9 + Math.random()*0.2),
    engineForce: spec.engineForce * (0.85 + Math.random()*0.3),
    brakeForce: spec.brakeForce * (0.85 + Math.random()*0.3), // always > engineForce by construction (base brakeForce > base engineForce)
    length: spec.lengthTiles * (0.9 + Math.random()*0.2),     // tile-units this vehicle's body occupies
    path:null, pathIndex:0,
    frac:0,                // 0..1 progress from path[pathIndex] toward path[pathIndex+1]
    trail:[],               // recently-occupied {x,y,layer} cells, most recent first — the physical
                             // basis for this vehicle's trailing-length reservation (see tickVehicles)
    currentBlock: null,     // rail-only: the Block id this train currently holds (see tickTrainMovement)
  };
}
function createTruck(x,y,vehicleType){
  vehicleType = vehicleType || 'bulk'; // back-compat: old call sites / tests that omit this get a bulk (ore) truck
  const def = getVehicleDef(vehicleType);
  const id = world.nextId++;
  addComponent(id, 'Identity', {kind:'vehicle', type:vehicleType});
  addComponent(id, 'Transform', {x, y, layer:'ground'});
  addComponent(id, 'Movement', randomizedMovement(def));
  addComponent(id, 'Status', {state:'idle'}); // idle|moving|loading|unloading|blocked
  addComponent(id, 'Orders', {list:[], index:0}); // [{nodeId, action, resource}] — player authored, §6.6
  addComponent(id, 'Cargo', {amount:0, capacity:def.capacity, resource:def.resource}); // fixed for this truck's life
  const handle = makeEntityHandle(id);
  world.entities.set(id, handle);
  return handle;
}
// A train is assembled, not bought off a fixed def — one engine (physics)
// plus N identical wagons (cargo capacity + resource). getTrainStats derives
// the same shape a truck's def has, so randomizedMovement/Cargo below don't
// need to know or care that the numbers came from a Yard assembly instead
// of a single VEHICLE_DEFS entry.
function createTrain(x,y,engineType,wagonType,wagonCount){
  const stats = getTrainStats({engineType, wagonType, wagonCount});
  const id = world.nextId++;
  addComponent(id, 'Identity', {kind:'vehicle', type:'train'});
  addComponent(id, 'Consist', {engineType, wagonType, wagonCount});
  addComponent(id, 'Transform', {x, y, layer:'rail'});
  addComponent(id, 'Movement', randomizedMovement(stats));
  addComponent(id, 'Status', {state:'idle'});
  addComponent(id, 'Orders', {list:[], index:0});
  addComponent(id, 'Cargo', {amount:0, capacity:stats.capacity, resource:stats.resource}); // fixed by wagon type, like a truck
  const handle = makeEntityHandle(id);
  world.entities.set(id, handle);
  return handle;
}

