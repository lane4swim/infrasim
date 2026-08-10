// ---------------------------------------------------------------------
// SIMULATION SYSTEMS — run once per fixed tick (§5, §8)
// ---------------------------------------------------------------------
function producerHalted(e){
  if(!e.producer) return false;
  const recipe = RECIPES[e.recipeId];
  const need = recipe.inputs[0], make = recipe.outputs[0];
  if(need && e.inStock < need.amount) return true;
  if(make && e.outStock + make.amount > e.outCap) return true;
  return false;
}

function tickProduction(){
  // Covers both extraction (Mine: no inputs) and processing (Mill: consumes
  // its `in` slot to produce its `out` slot) — the recipe determines which.
  // Halts if the required input isn't available yet, or if there's no room
  // for the output (§6.6) — either way, production just waits.
  for(const id of queryEntities('Producer','Storage')){
    const e = world.entities.get(id);
    const recipe = RECIPES[e.recipeId];
    const need = recipe.inputs[0]; // Phase 1 simplification: at most one input resource per recipe
    const make = recipe.outputs[0]; // and exactly one output resource
    if(need && e.inStock < need.amount) continue;      // halted: missing input
    if(make && e.outStock + make.amount > e.outCap) continue; // halted: no room (§6.6)
    e.ticksRemaining--;
    if(e.ticksRemaining <= 0){
      if(need) e.inStock -= need.amount;
      if(make) e.outStock += make.amount;
      e.ticksRemaining = recipe.durationTicks;
    }
  }
}

function tickConsumption(){
  // Towns eat into their own Storage.in every tick, independent of
  // deliveries — a town with no incoming trucks will run its storage down
  // to zero even though nothing is being loaded/unloaded there.
  for(const id of queryEntities('Consumer','Storage')){
    const e = world.entities.get(id);
    if(e.inStock===undefined) continue;
    e.inStock = Math.max(0, e.inStock - e.consumptionPerTick);
  }
}

function startMovingTo(vehicle, building){
  const dock = buildingRoadAccessCell(building);
  if(!dock){ vehicle.state='blocked'; return false; } // no road touches this building right now
  const path = findRoadPath({x:vehicle.x, y:vehicle.y, layer:vehicle.layer}, dock);
  if(!path){ vehicle.state='blocked'; return false; }
  vehicle.path = path;
  vehicle.pathIndex = 0;
  vehicle.frac = 0;
  vehicle.speed = 0; // a fresh leg starts from a stop, not carrying over prior velocity
  vehicle.state = 'moving';
  return true;
}

function currentOrder(vehicle){
  if(!vehicle.orders.length) return null;
  return vehicle.orders[vehicle.ordersIndex % vehicle.orders.length];
}
function advanceOrder(vehicle){
  if(!vehicle.orders.length) return;
  vehicle.ordersIndex = (vehicle.ordersIndex + 1) % vehicle.orders.length;
}

// A vehicle's own load/unload rate (VEHICLE_DEFS/WAGON_DEFS transferRate,
// fixed at creation on its Cargo component) and the Station/Depot it's
// docked at (BUILDING_DEFS transferRate, optional — Mine/Mill/Town/Train
// Yard never define one since nothing ever docks at them for this purpose)
// are two independent real-world bottlenecks — a vehicle can't unload
// faster than its own doors/pumps allow, and a dock can't load faster than
// its own crane/conveyor allows — so the effective rate is whichever is
// slower, not either one alone. `building` here is always the Station a
// truck is docked at or the Depot a train is docked at (never Mine/Mill/
// Town directly — see findLinkedIndustry), so DEFAULT_TRANSFER_RATE is
// only ever reached for a Station/Depot that omits the optional field.
function effectiveTransferRate(vehicle, building){
  const buildingRate = BUILDING_DEFS[building.type].transferRate ?? DEFAULT_TRANSFER_RATE;
  return Math.min(vehicle.transferRate, buildingRate);
}

// ---------------------------------------------------------------------
// SHARED MOVEMENT ENGINE — the physics, queueing, and cell-crossing rules
// below are identical for road vehicles and trains (§2.4/§2.7 test 4: reuse
// the physics, don't re-derive it for rail). tickVehicles and
// tickTrainMovement each build their own occupancy map (trucks never
// contend with trains for a cell, since they're never on the same layer)
// and call into these; a train's only real difference is layered on top,
// via advanceAlongPath's optional canEnter/onEnter hooks (the hard rail
// block rule — see tickTrainMovement).
// ---------------------------------------------------------------------
function posKey(x,y,layer){ return x+','+y+','+layer; }

// The cell a vehicle is currently in, plus enough cells from its actual
// recent trail to cover its length. Using the physical trail (not the
// current path array) matters right when a vehicle starts a fresh path leg
// — pathIndex resets to 0 then, but the vehicle still has real cells behind
// it that its body occupies. A vehicle with length 1.3 reserves 2 cells
// (ceil(1.3)); length 1 reserves just its own cell.
function footprintKeysFor(v){
  const cellsNeeded = Math.max(1, Math.ceil(v.length));
  const keys = [posKey(v.x, v.y, v.layer)];
  for(let i=0; i<v.trail.length && keys.length<cellsNeeded; i++){
    const c = v.trail[i];
    keys.push(posKey(c.x, c.y, c.layer));
  }
  return keys;
}
function buildOccupancyMap(entityIds){
  // "x,y,layer" -> vehicleId. Reservations are seeded from positions before
  // anyone moves this tick, then kept in sync as vehicles commit steps in
  // advanceAlongPath, so a whole queue can advance together in one tick
  // when there's room.
  const occupied = new Map();
  for(const id of entityIds){
    const v = world.entities.get(id);
    for(const k of footprintKeysFor(v)) occupied.set(k, v.id);
  }
  return occupied;
}
// Distance (in tile-units) from a vehicle's current continuous position to
// the nearest thing ahead of it on its path — another vehicle's reserved
// footprint, or the path's own end (so it brakes smoothly into its stop
// instead of arriving at full speed). Capped at LOOKAHEAD tiles; beyond
// that we just treat the network as clear. Also returns the safety buffer
// to require beyond pure stopping distance: 0 when the "obstacle" is just
// the vehicle's own destination (fully closing that gap to zero is the
// correct, safe outcome — arriving), but a small positive cushion when
// it's another vehicle (don't plan to stop exactly touching it).
const LOOKAHEAD = 15;
function gapAheadFor(v, occupied){
  if(!v.path) return {gap:Infinity, buffer:0.5};
  const currentPos = v.pathIndex + v.frac;
  for(let i=1; i<=LOOKAHEAD; i++){
    const idx = v.pathIndex + i;
    if(idx >= v.path.length) return {gap:(v.path.length-1) - currentPos, buffer:0};
    const node = v.path[idx];
    const occupant = occupied.get(posKey(node.x, node.y, node.layer!==undefined ? node.layer : v.layer));
    if(occupant !== undefined && occupant !== v.id) return {gap: idx - currentPos, buffer:0.5};
  }
  return {gap: LOOKAHEAD - v.frac, buffer:0.5};
}
// Real slope physics, approximated (§ Realistic ramp physics): gravity
// along a grade opposes forward motion when climbing and aids it when
// descending — it works AGAINST the engine (less net accel) but WITH the
// brakes (more net decel) when climbing, and the reverse when descending
// (more accel, less effective braking — the classic "runaway truck on a
// downgrade" a real driver has to respect). GRADE_ACCEL_PER_LEVEL is a
// game-balance constant, not a derived physical one — an elevation level
// has no defined real-world height anywhere in this game, only an integer
// used for connectivity/rendering — chosen so the steepest grade an
// ordinary lateral connection ever allows (MAX_ELEVATION_DELTA=1, world.js)
// meaningfully affects the weakest shipped vehicle without making climbing
// effectively impossible.
const GRADE_ACCEL_PER_LEVEL = 0.05;
// decel's hard floor — however steep the downgrade, braking must never
// fully vanish (a vehicle that literally can't stop would break the
// gap/occupancy safety net every other system in this file relies on;
// requiredGap below also divides by decel, so it must stay strictly
// positive regardless of how grade-adjusted it gets).
const MIN_DECEL = 0.02;
// The real elevation change (elevationAt, world.js) the vehicle is about to
// cross on its CURRENT path edge — not a lookahead average, just the one
// edge `frac` is progressing along right now. elevationAt already treats
// deepUnderground/airspace as flat global planes (a fixed Z regardless of
// local terrain), so any edge that stays within one of those always reads
// grade 0 here — "burrowing into a hillside" (the burial-depth darkening
// those two layers get in render.js) is a render-only tint derived from
// local GROUND elevation, not a real elevation of the deepUnderground/
// airspace track itself, and must never leak into physics. Every other
// grade (ground/elevated/every underground level) genuinely moves with
// local terrain, so ordinary lateral travel there picks up whatever real
// slope the terrain has (bounded by MAX_ELEVATION_DELTA, since nothing
// steeper can ever be connected in the first place), and a same-cell
// vertical Ramp or a lateral Tunnel/Rail Ramp picks up the real vertical
// distance actually covered between its two endpoint cells — not always
// exactly one level, since a Tunnel/Rail Ramp has no rule requiring its
// two cells' own local terrain to match.
function gradeForCurrentEdge(v){
  if(!v.path || v.pathIndex >= v.path.length-1) return 0;
  const next = v.path[v.pathIndex+1];
  const nextLayer = next.layer!==undefined ? next.layer : v.layer;
  // elevationAt takes a GRADE ('ground', 'elevated', 'underground', ...),
  // not a LAYER ('rail', 'railElevated', 'underground2', ...) — v.layer/
  // path nodes always store the layer (trucks and trains alike need to
  // know road vs rail, not just the grade), so it has to go through
  // LAYER_GRADE_KIND first, same as trackAt (world.js) does for every
  // other grid lookup.
  const curGrade = LAYER_GRADE_KIND[v.layer][0];
  const nextGrade = LAYER_GRADE_KIND[nextLayer][0];
  return elevationAt(next.x, next.y, nextGrade) - elevationAt(v.x, v.y, curGrade);
}
// Adjusts v.speed for this tick via F = ma, now grade-aware. Accel/decel
// aren't fixed per vehicle — they're derived every tick: a heavier vehicle
// (more cargo currently loaded, since mass = massEmpty + cargo weight) gets
// less acceleration AND less deceleration out of the same engine/brake
// force, exactly like a real loaded truck (or train); grade then shifts
// both further, in opposite directions, per gradeForCurrentEdge above.
// decel is floored at MIN_DECEL rather than left to possibly go non-
// positive on a steep enough downgrade — see that constant's own comment.
// accel is allowed to go negative (a heavy vehicle can genuinely fail to
// out-climb a steep enough grade and slow down while nominally
// "accelerating," exactly like a real underpowered vehicle stalling on a
// hill) but speed itself is always floored at 0 in both branches — this
// game has no reverse gear, a vehicle that can't keep climbing just stops,
// it never rolls backward. Decelerates if the gap ahead isn't enough room
// to stop from the current speed (d = v²/2a, the same physics as real
// braking distance, plus a small buffer, using the grade-adjusted decel so
// a downgrade correctly demands a longer stopping distance and an upgrade
// a shorter one), otherwise accelerates toward this vehicle's own max
// speed — required stopping distance grows with the SQUARE of speed, so a
// faster (or heavier) vehicle needs a disproportionately bigger gap.
function applySpeedStep(v, occupied){
  const unitWeight = v.cargoResource ? RESOURCES[v.cargoResource].unitWeight : 0; // a train between loads carries no resource yet
  const mass = v.massEmpty + v.cargoAmount * unitWeight;
  const gradeAccel = GRADE_ACCEL_PER_LEVEL * gradeForCurrentEdge(v);
  const accel = v.engineForce / mass - gradeAccel;
  const decel = Math.max(MIN_DECEL, v.brakeForce / mass + gradeAccel);
  const {gap, buffer} = gapAheadFor(v, occupied);
  const requiredGap = (v.speed*v.speed) / (2*decel) + buffer;
  if(gap < requiredGap) v.speed = Math.max(0, v.speed - decel);
  else v.speed = Math.max(0, Math.min(v.maxSpeed, v.speed + accel));
}
// Advances v along its path by its current speed, crossing cell boundaries
// one at a time. Each crossing is checked against the occupancy map as a
// hard safety net (independent of the soft speed regulation in
// applySpeedStep) — and, if `canEnter` is given, against any additional
// per-network rule (trains' block exclusivity). `onEnter`, if given, fires
// after a crossing actually commits (trains use it to acquire/release
// blocks). Queues right at a cell boundary — never overshoots into a cell
// it can't enter.
function advanceAlongPath(v, occupied, canEnter, onEnter){
  v.frac += v.speed;
  while(v.frac >= 1 && v.pathIndex < v.path.length-1){
    const cur = v.path[v.pathIndex];
    const next = v.path[v.pathIndex+1];
    const nextLayer = next.layer!==undefined ? next.layer : v.layer;
    const nextKey = posKey(next.x, next.y, nextLayer);
    const occupant = occupied.get(nextKey);
    const blocked = (occupant !== undefined && occupant !== v.id) || (canEnter && !canEnter(cur, next));
    if(blocked){
      v.frac = Math.min(v.frac, 0.999);
      break;
    }
    const oldFootprint = footprintKeysFor(v);
    v.trail.unshift({x:v.x, y:v.y, layer:v.layer});
    if(v.trail.length > 6) v.trail.length = 6; // generous cap — no vehicle in this build needs more
    v.pathIndex++;
    v.x = next.x; v.y = next.y; v.layer = nextLayer;
    v.frac -= 1;
    if(onEnter) onEnter(cur, next);
    const newFootprint = footprintKeysFor(v);
    const newSet = new Set(newFootprint);
    for(const k of oldFootprint) if(!newSet.has(k)) occupied.delete(k);
    for(const k of newFootprint) occupied.set(k, v.id);
  }
  if(v.pathIndex >= v.path.length-1) v.frac = 0; // discard any leftover speed at the very end
}

// A train blocks road traffic at a road/rail crossing — real
// level-crossing right-of-way, trains always win, never the reverse
// (trains never check truck occupancy at all). Seeds the SAME occupied
// map trucks already check in gapAheadFor/advanceAlongPath with a
// sentinel value distinct from any real vehicle id, at the *ground*-layer
// key for the crossing — trucks get both smooth braking on approach and
// a hard stop at the boundary for free, no new physics needed.
//
// Reserved starting well before the train physically gets there, not
// just while its footprint already covers the cell — a real crossing's
// gates come down before the train arrives, precisely so nothing is
// still sitting on the tracks when it does. A truck's own gapAheadFor
// never looks further than LOOKAHEAD tiles down ITS OWN path regardless
// of how early a hazard actually appeared, so reserving the crossing any
// earlier than that (relative to the train's remaining distance along
// ITS path) couldn't change what a truck can actually see and react to —
// LOOKAHEAD is exactly the right amount of lead time, not a new number to
// invent. Checked against the train's `path`/`pathIndex` rather than its
// current position, so this covers a train that's still approaching, not
// only one already on top of the crossing.
//
// There's nothing to separately "release" here either: this map is
// rebuilt from scratch every tick (same as the rest of
// buildOccupancyMap), so a crossing simply stops appearing in it the
// moment it's no longer within the train's current footprint or its
// upcoming LOOKAHEAD-tile reservation window.
function markTrainCrossingsOccupied(occupied){
  for(const id of queryEntities('Movement').filter(isTrain)){
    const train = world.entities.get(id);
    for(const key of footprintKeysFor(train)){
      const [xStr,yStr,railLayer] = key.split(',');
      const x = Number(xStr), y = Number(yStr);
      const [grade] = LAYER_GRADE_KIND[railLayer];
      if(isRoadRailCrossing(x,y,railLayer)) occupied.set(posKey(x,y,GRADE_KIND_LAYER[grade].road), `crossing-${id}`);
    }
    if(train.path){
      for(let i=1; i<=LOOKAHEAD && train.pathIndex+i < train.path.length; i++){
        const node = train.path[train.pathIndex+i];
        const railLayer = node.layer!==undefined ? node.layer : train.layer;
        const [grade] = LAYER_GRADE_KIND[railLayer];
        if(isRoadRailCrossing(node.x, node.y, railLayer)) occupied.set(posKey(node.x, node.y, GRADE_KIND_LAYER[grade].road), `crossing-${id}`);
      }
    }
  }
}

function tickVehicles(){
  const occupied = buildOccupancyMap(queryEntities('Movement').filter(id=>!isTrain(id)));
  markTrainCrossingsOccupied(occupied);

  for(const id of queryEntities('Movement','Orders','Cargo','Status')){
    if(isTrain(id)) continue; // trains run their own tickTrainMovement below
    const v = world.entities.get(id);

    const order = currentOrder(v);
    if(!order){ v.state='idle'; v.path=null; continue; }
    const target = world.entities.get(order.nodeId);
    if(!target){ advanceOrder(v); v.path=null; continue; } // stop was demolished

    if(v.state==='idle' || v.state==='blocked'){
      // (Re)try to reach, or act on, the current order's target. 'blocked'
      // retries every tick until the resource/space it's waiting on frees up.
      const dock = buildingRoadAccessCell(target);
      if(!dock){ v.state='blocked'; continue; } // building has no road access right now
      if(v.x===dock.x && v.y===dock.y && v.layer===dock.layer){
        v.state = order.action==='load_full' ? 'loading' : 'unloading';
      } else {
        startMovingTo(v, target); // -> 'moving', or 'blocked' if unreachable
      }
      continue;
    }

    if(v.state==='moving'){
      if(!v.path){ startMovingTo(v, target); continue; }
      if(v.pathIndex >= v.path.length-1){
        // Fully arrived — settle into the stop's action next tick.
        v.state = order.action==='load_full' ? 'loading' : 'unloading';
        v.path = null; v.frac = 0;
        continue;
      }
      applySpeedStep(v, occupied);
      advanceAlongPath(v, occupied);
      continue;
    }

    if(v.state==='loading'){
      // Vehicle is docked at a Station; the Station forwards to whichever
      // industry it (or its chain of touching Stations) connects to (§ Stations).
      // Always pulls from the industry's OUTPUT slot — what it offers for pickup.
      const industry = findLinkedIndustry(target);
      if(!industry || industry.outStock===undefined){ v.state='blocked'; continue; } // wait: nothing to pick up here
      if(industry.outStock <= 0){ v.state='blocked'; continue; } // wait: source empty
      const room = v.capacity - v.cargoAmount;
      if(room <= 0){ advanceOrder(v); v.state='idle'; continue; } // full, move on
      const amt = Math.min(effectiveTransferRate(v, target), industry.outStock, room);
      industry.outStock -= amt;
      v.cargoAmount += amt;
      if(v.cargoAmount >= v.capacity){ advanceOrder(v); v.state='idle'; }
      continue;
    }

    if(v.state==='unloading'){
      // Always pushes into the industry's INPUT slot — what it accepts for
      // drop-off (a Mill's ore input, or a Town's demand).
      const industry = findLinkedIndustry(target);
      if(!industry || industry.inStock===undefined){ v.state='blocked'; continue; } // wait: nothing accepts this here
      if(v.cargoAmount<=0){ advanceOrder(v); v.state='idle'; continue; }
      const room = industry.inCap - industry.inStock;
      if(room <= 0){ v.state='blocked'; continue; } // wait: destination full (§6.6)
      const amt = Math.min(effectiveTransferRate(v, target), v.cargoAmount, room);
      industry.inStock += amt;
      v.cargoAmount -= amt;
      if(industry.consumer){
        // Only a true final Consumer (a Town) pays for what it receives —
        // an intermediate industrial input (e.g. a Mill's ore) doesn't.
        const resource = order.resource || v.cargoResource || industry.inResource;
        const income = Math.round(amt * RESOURCES[resource].baseValue * industry.priceMultiplier);
        credit(income, `delivery to ${BUILDING_DEFS[industry.type].label} #${industry.id}`);
      }
      if(v.cargoAmount<=0){ advanceOrder(v); v.state='idle'; }
      continue;
    }
  }
}

// A Rail Depot's dock is train-length-aware: reaching whichever end of the
// platform (see depotPlatformCells) is FARTHER from the train — more path
// hops, not straight-line distance — means the approach necessarily passes
// through the nearer platform cells first, so by the time the train stops,
// its trailing body (footprintKeysFor) already covers as much of the
// platform as its own length allows, instead of stopping at the very first
// platform cell reached with nothing of the platform actually behind it.
// A Train Yard (or anything else without a platform) has no such choice to
// make — this is just buildingRailAccessCell for it.
function resolveTrainDock(train, building){
  if(building.type !== 'depot') return buildingRailAccessCell(building);
  const platform = depotPlatformCells(building.x, building.y, building.footprint.w, building.footprint.h);
  if(!platform) return null;
  // Already standing somewhere on the platform (e.g. re-evaluating the
  // same order right after finishing a load/unload cycle) — stay exactly
  // where it is. Without this, re-deriving "farther endpoint" from the
  // train's CURRENT position would see whichever end it just arrived
  // FROM as now being the farther one, sending an already-docked train
  // shuttling back and forth across the platform every cycle instead of
  // just staying put.
  if(train.layer==='rail' && platform.some(c => c.x===train.x && c.y===train.y)) return {x:train.x, y:train.y, layer:'rail'};
  const first = {x:platform[0].x, y:platform[0].y, layer:'rail'};
  if(platform.length === 1) return first;
  const last = {x:platform[platform.length-1].x, y:platform[platform.length-1].y, layer:'rail'};
  const start = {x:train.x, y:train.y, layer:train.layer};
  const pathToFirst = findRailPath(start, first);
  const pathToLast = findRailPath(start, last);
  if(!pathToFirst && !pathToLast) return null;
  if(!pathToFirst) return last;
  if(!pathToLast) return first;
  return pathToFirst.length >= pathToLast.length ? first : last;
}
// A real platform loads/unloads its whole length at once, not through one
// bottleneck point — so a train's per-tick transfer rate scales with how
// many of its OWN currently-occupied cells (footprintKeysFor — the same
// physical-length reservation used for collision) are actually alongside
// the Depot's platform right now, not a flat constant. A Train Yard (or
// any non-Depot target) has no platform concept, so it's always exactly 1
// (today's flat rate, unchanged) — this only ever speeds up Depot transfers,
// never anything else.
function dockedPlatformCellCount(train, building){
  if(building.type !== 'depot') return 1;
  const platform = depotPlatformCells(building.x, building.y, building.footprint.w, building.footprint.h);
  if(!platform) return 1;
  const platformKeys = new Set(platform.map(c => posKey(c.x, c.y, 'rail')));
  let count = 0;
  for(const k of footprintKeysFor(train)) if(platformKeys.has(k)) count++;
  return Math.max(1, count);
}
function startMovingToRail(train, building){
  const dock = resolveTrainDock(train, building);
  if(!dock){ train.state='blocked'; return false; } // no rail track touches this building right now
  const path = findRailPath({x:train.x, y:train.y, layer:train.layer}, dock);
  if(!path){ train.state='blocked'; return false; }
  train.path = path;
  train.pathIndex = 0;
  train.frac = 0;
  train.speed = 0;
  train.state = 'moving';
  return true;
}

function tickTrainMovement(){
  const occupied = buildOccupancyMap(queryEntities('Movement').filter(isTrain));

  for(const id of queryEntities('Movement','Orders','Cargo','Status')){
    if(!isTrain(id)) continue;
    const v = world.entities.get(id);

    const order = currentOrder(v);
    if(!order){ v.state='idle'; v.path=null; continue; }
    // order.nodeId is always the Depot itself, never whatever it's linked
    // to — the link can change (track/Stations built or demolished) after
    // the order was set, so it's re-resolved fresh at load/unload time
    // below, exactly like a truck's Station (§2.4).
    const target = world.entities.get(order.nodeId);
    if(!target){ advanceOrder(v); v.path=null; continue; } // stop was demolished

    if(v.state==='idle' || v.state==='blocked'){
      const dock = resolveTrainDock(v, target);
      if(!dock){ v.state='blocked'; continue; }
      if(v.x===dock.x && v.y===dock.y && v.layer===dock.layer){
        v.state = order.action==='load_full' ? 'loading' : 'unloading';
      } else {
        startMovingToRail(v, target);
      }
      continue;
    }

    if(v.state==='moving'){
      if(!v.path){ startMovingToRail(v, target); continue; }
      if(v.pathIndex >= v.path.length-1){
        v.state = order.action==='load_full' ? 'loading' : 'unloading';
        v.path = null; v.frac = 0;
        continue;
      }
      applySpeedStep(v, occupied);
      // The hard rule on top of the soft gap above: a train may only enter
      // the next cell if the BLOCK that edge belongs to is unheld (or
      // already held by this same train) — never "as close as physics
      // allows," always a full stop at the block boundary. `cur.layer`
      // (not a hardcoded 'rail') since a train can now be on 'railElevated'
      // too; a vertical move through a railRamp (same x,y, different layer
      // — dirBetween has no entry for that) has no lateral edge or block of
      // its own to check — the ramp cell is already a hub on each layer's
      // own independent block graph (see railCellIsHub in rail-blocks.js),
      // so the vertical step itself is always allowed.
      //
      // Every step (whether it crosses a block boundary or not) records
      // its edge's block in `v.blockTrail`, then prunes `v.heldBlocks` down
      // to whatever's still under the train's own length (updateHeldBlocks,
      // rail-blocks.js) — a PREVIOUS block stays held for as long as the
      // train's tail is still physically inside it, not just until the
      // front has moved on, so a second train can never be let onto a
      // block this train hasn't fully cleared yet.
      advanceAlongPath(v, occupied,
        (cur,next) => {
          if(cur.layer !== next.layer) return true;
          const dir = dirBetween(cur,next).dir;
          const blockId = trackAt(cur.x,cur.y,cur.layer).blockId[dir];
          const block = blockId!=null ? world.railBlocks.get(blockId) : null;
          return !block || block.occupiedBy===null || block.occupiedBy===v.id;
        },
        (cur,next) => {
          let blockId = null;
          if(cur.layer === next.layer){
            const dir = dirBetween(cur,next).dir;
            blockId = trackAt(cur.x,cur.y,cur.layer).blockId[dir] ?? null;
            if(blockId!=null){
              const block = world.railBlocks.get(blockId);
              if(block) block.occupiedBy = v.id; // canEnter above already verified free-or-self
            }
          }
          v.blockTrail.unshift(blockId);
          if(v.blockTrail.length > 6) v.blockTrail.length = 6; // stays in lockstep with v.trail's own cap
          updateHeldBlocks(v);
        }
      );
      continue;
    }

    if(v.state==='loading'){
      // A Depot forwards to whatever it (or its chain of touching Stations)
      // connects to — exactly the same findLinkedIndustry chain-walk a
      // truck's Station uses (§ Rail Depot forwarding) — falling back to
      // the Depot's own real Storage when nothing's linked, which is what
      // lets a standalone Depot still work as a buffer between two
      // separate truck legs, same as before this existed.
      const source = findLinkedIndustry(target) || target;
      if(source.outStock===undefined){ v.state='blocked'; continue; }
      if(source.outStock <= 0){ v.state='blocked'; continue; }
      const room = v.capacity - v.cargoAmount;
      if(room <= 0){ advanceOrder(v); v.state='idle'; continue; }
      const rate = effectiveTransferRate(v, target) * dockedPlatformCellCount(v, target);
      const amt = Math.min(rate, source.outStock, room);
      source.outStock -= amt;
      v.cargoAmount += amt;
      if(v.cargoAmount >= v.capacity){ advanceOrder(v); v.state='idle'; }
      continue;
    }

    if(v.state==='unloading'){
      const dest = findLinkedIndustry(target) || target;
      if(dest.inStock===undefined){ v.state='blocked'; continue; }
      if(v.cargoAmount<=0){ advanceOrder(v); v.state='idle'; continue; }
      const room = dest.inCap - dest.inStock;
      if(room <= 0){ v.state='blocked'; continue; }
      const rate = effectiveTransferRate(v, target) * dockedPlatformCellCount(v, target);
      const amt = Math.min(rate, v.cargoAmount, room);
      dest.inStock += amt;
      v.cargoAmount -= amt;
      if(dest.consumer){
        // Only a true final Consumer (a Town) pays for what it receives —
        // same rule a truck's delivery follows (§6.6), now that a train
        // can reach one directly through a Depot instead of only ever
        // depositing into the Depot's own intermediate buffer.
        const resource = order.resource || v.cargoResource || dest.inResource;
        const income = Math.round(amt * RESOURCES[resource].baseValue * dest.priceMultiplier);
        credit(income, `delivery to ${BUILDING_DEFS[dest.type].label} #${dest.id}`);
      }
      if(v.cargoAmount<=0){ advanceOrder(v); v.state='idle'; }
      continue;
    }
  }
}

function tickUpkeep(){
  for(const id of queryEntities('Movement','Orders')){
    const v = world.entities.get(id);
    if(v.orders.length===0) continue; // parked/unassigned vehicles don't burn cash
    world.treasury -= getVehicleStats(v).runningCostPerTick;
  }
}

function simTick(){
  tickProduction();
  tickVehicles();
  tickTrainMovement();
  tickConsumption();
  tickUpkeep();
  world.tick++;
}

