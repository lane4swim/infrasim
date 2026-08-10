// Headless regression tests for the Rail milestone (§2.7 of the Phase 2
// implementation plan), run against the real index.html code via
// test/harness.js — not a reimplementation of the sim.
'use strict';
const {newGameContext, run} = require('./harness.js');

let failures = 0;
function check(name, cond, detail){
  if(cond){ console.log(`  ok - ${name}`); }
  else { failures++; console.log(`  FAIL - ${name}${detail ? ' :: '+detail : ''}`); }
}
function section(name, fn){
  console.log(name);
  fn();
}

// Depot A -- Block1(west span) -- junction(8,5) -- Block2(east span) --
// Depot B's own siding, with a further branch off the FAR end of Depot B's
// siding (already a hub, since it touches Depot B) leading on to Depot C.
// The branch is what lets a train release Block2 by continuing on to a
// genuinely different block (Depot C) without ever needing to backtrack
// through the junction — avoiding a same-track physical deadlock with
// whatever else is waiting there (see the reasoning in Test 1). Each
// Depot gets its own dedicated siding (rather than sitting flush against
// the shared through-line) precisely so touching it doesn't fragment the
// shared spine's own block1/block2 identity — a real platform track is
// usually its own siding for exactly this reason.
function buildJunctionLine(ctx){
  return run(ctx, `
    for(let x=2; x<=16; x++) cmdBuildTrack(x, 5, 'rail', true);
    for(let y=6; y<=9; y++) cmdBuildTrack(2, y, 'rail', true);   // Depot A's siding
    cmdBuildBuilding('depot', 0, 6, 'large', 'ns', 'ore');
    cmdBuildTrack(8, 6, 'rail', true);                            // branch stub off the junction cell — used by Test 2
    for(let y=6; y<=9; y++) cmdBuildTrack(16, y, 'rail', true);   // Depot B's siding
    cmdBuildBuilding('depot', 17, 6, 'large', 'ns', 'ore');
    for(let y=10; y<=13; y++) cmdBuildTrack(16, y, 'rail', true); // branch off Depot B's siding to Depot C
    cmdBuildBuilding('depot', 14, 10, 'large', 'ns', 'ore');
    const depots = [...world.entities.values()].filter(e=>e.kind==='building' && e.type==='depot');
    return {
      depotAId: depots.find(d=>d.x===0).id,
      depotBId: depots.find(d=>d.x===17).id,
      depotCId: depots.find(d=>d.x===14).id,
    };
  `);
}

section('Test 1 — block mutual exclusion', () => {
  const ctx = newGameContext();
  const {depotAId, depotBId, depotCId} = buildJunctionLine(ctx);

  // Train A's route (Depot A -> Depot B -> Depot C) crosses Block2 once,
  // then leaves it for good via Depot B's own siding into the Depot C
  // branch — never needing to backtrack through the junction where Train B
  // will be waiting. Created directly via createTrain (not
  // cmdAssembleTrain/a Train Yard) since this test is about block
  // mechanics, not the assembly command — that has its own test below.
  const trainAId = run(ctx, `
    const trainA = createTrain(3, 5, 'diesel', 'ore_wagon', 3);
    cmdSetOrders(trainA, [
      {nodeId: ${depotBId}, action:'unload_all', resource:'ore'},
      {nodeId: ${depotCId}, action:'unload_all', resource:'ore'},
    ]);
    return trainA.id;
  `);

  // Run Train A alone until it's inside block2 (x between 10 and 13).
  // Budgets here are generous because per-vehicle stats are randomized at
  // creation (§ createVehicle) — actual tick counts vary run to run.
  let block2Id = null;
  for(let i=0;i<1000;i++){
    run(ctx, `simTick();`);
    const a = run(ctx, `const a = world.entities.get(${trainAId}); return {x:a.x, heldBlocks:a.heldBlocks};`);
    if(a.x >= 10 && a.x <= 13){
      block2Id = run(ctx, `return trackAt(9,5,'rail').blockId.E;`);
      check('train A holds block2 while crossing it', a.heldBlocks.includes(block2Id), `heldBlocks=${JSON.stringify(a.heldBlocks)} block2Id=${block2Id}`);
      break;
    }
  }
  check('found train A inside block2 within budget', block2Id !== null);

  // Spawn Train B right at the junction, approaching block2 from the
  // opposite end — it must NOT be able to enter while Train A holds it.
  const trainBId = run(ctx, `
    const trainB = createTrain(8, 5, 'diesel', 'ore_wagon', 3);
    cmdSetOrders(trainB, [{nodeId: ${depotBId}, action:'unload_all', resource:'ore'}]);
    return trainB.id;
  `);
  run(ctx, `simTick();`);
  let b = run(ctx, `const b = world.entities.get(${trainBId}); return {x:b.x, y:b.y};`);
  check('train B does not enter the block while train A holds it', b.x === 8 && b.y === 5, JSON.stringify(b));

  // Run until train A stops holding block2 (it diverted through Depot B's
  // siding onto the Depot C branch) and confirm train B proceeds shortly
  // after — not stalled indefinitely, and without needing a full
  // stop-and-reaccelerate cycle. Watched as "no longer held by A" rather
  // than "becomes null", since A's release and B's re-acquisition can
  // legitimately land in the SAME tick (A is processed first in
  // tickTrainMovement, frees the block, and B — processed right after in
  // that same call — can claim it immediately) — that's the best case, not
  // an edge case to special-case around.
  let releasedAtTick = -1, bMovedAtTick = -1;
  for(let i=0;i<2000;i++){
    const before = run(ctx, `return world.railBlocks.get(${block2Id}).occupiedBy;`);
    run(ctx, `simTick();`);
    const after = run(ctx, `return world.railBlocks.get(${block2Id}).occupiedBy;`);
    if(releasedAtTick===-1 && before===trainAId && after!==trainAId) releasedAtTick = i;
    if(releasedAtTick!==-1 && bMovedAtTick===-1){
      const bb = run(ctx, `const b = world.entities.get(${trainBId}); return {x:b.x, y:b.y};`);
      if(bb.x !== 8 || bb.y !== 5) bMovedAtTick = i;
    }
    if(releasedAtTick!==-1 && bMovedAtTick!==-1) break;
  }
  check('block2 was eventually released by train A', releasedAtTick !== -1);
  // Not "the very next tick" the way a single lightweight vehicle would —
  // an assembled 3-wagon consist has real mass, so Train B needs a few
  // ticks to build enough speed/frac to complete its first cell crossing
  // once unblocked. The bound here is "not stalled indefinitely, and not
  // an obviously-broken multi-hundred-tick stall", not "instant".
  check('train B starts moving within a bounded number of ticks of block2 releasing (not stalled indefinitely)',
    bMovedAtTick !== -1 && bMovedAtTick - releasedAtTick <= 40,
    `released@${releasedAtTick} moved@${bMovedAtTick}`);
});

section('Test 1b — a train\'s tail keeps the block it hasn\'t fully cleared held, even after its front has moved on to the next one', () => {
  const ctx = newGameContext();
  const {depotBId} = buildJunctionLine(ctx);

  // A single-wagon train: length = diesel(3) + ore_wagon(2.5) = 5.5 tiles,
  // so cellsNeeded = ceil(5.5) = 6 — exactly at the trail/blockTrail cap
  // (systems.js's advanceAlongPath caps `trail` at 6 entries), so this
  // scenario is covered exactly, not just approximately, by
  // updateHeldBlocks (rail-blocks.js). Long enough that once its front is
  // several cells into block2 (east of the junction at x=8), its tail is
  // still solidly inside block1 (west of the junction) — the exact
  // situation the old single-`currentBlock` logic got wrong, releasing
  // block1 the instant the FRONT crossed into block2 regardless of where
  // the tail physically was.
  const trainId = run(ctx, `
    const train = createTrain(3, 5, 'diesel', 'ore_wagon', 1);
    cmdSetOrders(train, [{nodeId: ${depotBId}, action:'unload_all', resource:'ore'}]);
    return train.id;
  `);
  const block1Id = run(ctx, `return trackAt(6,5,'rail').blockId.E;`); // west of the junction
  const block2Id = run(ctx, `return trackAt(9,5,'rail').blockId.E;`); // east of the junction

  let checked = false;
  for(let i=0;i<1000;i++){
    run(ctx, `simTick();`);
    const t = run(ctx, `
      const t = world.entities.get(${trainId});
      return {x:t.x, heldBlocks:t.heldBlocks, block1OccupiedBy: world.railBlocks.get(${block1Id}).occupiedBy};
    `);
    if(t.x >= 10 && t.x <= 11){
      checked = true;
      check('the front (several cells into block2) holds block2', t.heldBlocks.includes(block2Id), JSON.stringify(t.heldBlocks));
      check('the tail (still inside block1) keeps block1 held too — NOT released just because the front moved on',
        t.heldBlocks.includes(block1Id), JSON.stringify(t.heldBlocks));
      check('block1.occupiedBy is still this train, not null — a second train genuinely cannot be let in',
        t.block1OccupiedBy === trainId, `occupiedBy=${t.block1OccupiedBy} trainId=${trainId}`);
      break;
    }
  }
  check('train reached the check window within budget', checked);

  // The hold is delayed, not permanent — once the train has actually moved
  // far enough that no part of its body is in block1 anymore, it releases.
  let releasedAtTick = -1;
  for(let i=0;i<1000;i++){
    run(ctx, `simTick();`);
    const occupiedBy = run(ctx, `return world.railBlocks.get(${block1Id}).occupiedBy;`);
    if(occupiedBy===null){ releasedAtTick = i; break; }
  }
  check('block1 is eventually released once the train has fully cleared it (the hold isn\'t permanent)', releasedAtTick !== -1);
});

section('Test 2 — block computation correctness', () => {
  const ctx = newGameContext();
  buildJunctionLine(ctx);
  const edges = run(ctx, `
    return {
      block1_a: trackAt(3,5,'rail').blockId.E,
      block1_b: trackAt(6,5,'rail').blockId.E,
      block2_a: trackAt(9,5,'rail').blockId.E,
      block2_b: trackAt(13,5,'rail').blockId.E,
      branch:   trackAt(8,5,'rail').blockId.S,
    };
  `);
  check('block1 is one consistent id across its whole span', edges.block1_a === edges.block1_b && edges.block1_a != null);
  check('block2 is one consistent id across its whole span', edges.block2_a === edges.block2_b && edges.block2_a != null);
  check('the junction branch is its own block', edges.branch != null && edges.branch !== edges.block1_a && edges.branch !== edges.block2_a);
  check('block1 and block2 are distinct blocks, split exactly at the junction', edges.block1_a !== edges.block2_a);

  // Demolish a middle tile of block1's span (x=4) — it should split into
  // two separate blocks (a new dead end forms on each side), not silently
  // keep stale ids or merge across the gap.
  run(ctx, `cmdDemolish(4, 5, 'rail');`);
  const after = run(ctx, `
    return {
      leftStub:  trackAt(3,5,'rail').blockId.E,   // (3,5)-(4,5), now a dead end at x=4
      rightStub: trackAt(6,5,'rail').blockId.E,   // (6,5)-(7,5), unaffected span
      gapGone:   trackAt(4,5,'rail').track,
    };
  `);
  check('the demolished tile is no longer track', after.gapGone === false);
  // Block ids are reassigned from scratch on every recompute (they're not
  // meant to be stable identities across topology changes), so the
  // meaningful check is that demolishing actually split the block — not
  // that the id number happens to differ from before.
  check('the two remaining stubs are now separate blocks after the split', after.leftStub !== after.rightStub,
    `left=${after.leftStub} right=${after.rightStub}`);
});

section('Test 3 — Train Yard assembly (engines + wagons, not a fixed train def)', () => {
  const ctx = newGameContext();
  run(ctx, `
    cmdBuildBuilding('trainyard', 0, 0, 'small');
    cmdBuildTrack(3, 0, 'rail', true);  // touches the Yard's footprint (0,0)-(2,1) at (2,0)
    cmdBuildTrack(3, 3, 'rail', true);  // NOT touching any Yard
  `);

  const rejected = run(ctx, `
    const before = world.treasury;
    cmdAssembleTrain(3, 3, 'diesel', 'ore_wagon', 3); // track exists but doesn't touch a Yard
    return {trainCount: [...world.entities.values()].filter(e=>e.kind==='vehicle').length, spent: before - world.treasury};
  `);
  check('assembling away from a Train Yard is rejected (no train, no charge)',
    rejected.trainCount === 0 && rejected.spent === 0, JSON.stringify(rejected));

  const assembled = run(ctx, `
    const before = world.treasury;
    cmdAssembleTrain(3, 0, 'diesel', 'ore_wagon', 3);
    const train = [...world.entities.values()].find(e=>e.kind==='vehicle');
    return train ? {
      spent: before - world.treasury,
      expectedCost: ENGINE_DEFS.diesel.purchaseCost + WAGON_DEFS.ore_wagon.purchaseCost*3,
      capacity: train.capacity,
      expectedCapacity: WAGON_DEFS.ore_wagon.capacity*3,
      resource: train.cargoResource,
      engineForce: train.engineForce, // randomized, but should track the engine's base, not the wagon's (wagons carry no propulsion)
      consist: train.consist,
    } : null;
  `);
  check('assembling on track touching a Yard creates a train', assembled !== null);
  check('charges exactly engine + N*wagon cost, nothing else', assembled && assembled.spent === assembled.expectedCost,
    assembled && `spent=${assembled.spent} expected=${assembled.expectedCost}`);
  check("the train's capacity is N * the wagon's capacity", assembled && assembled.capacity === assembled.expectedCapacity);
  check("the train's cargo resource is the wagon's resource, fixed like a truck's", assembled && assembled.resource === 'ore');
  check('the Consist component records exactly what was assembled', assembled &&
    assembled.consist.engineType==='diesel' && assembled.consist.wagonType==='ore_wagon' && assembled.consist.wagonCount===3,
    assembled && JSON.stringify(assembled.consist));

  const invalid = run(ctx, `
    const before = [...world.entities.values()].filter(e=>e.kind==='vehicle').length;
    cmdAssembleTrain(3, 0, 'no_such_engine', 'ore_wagon', 3);
    cmdAssembleTrain(3, 0, 'diesel', 'ore_wagon', 0);
    return [...world.entities.values()].filter(e=>e.kind==='vehicle').length - before;
  `);
  check('an unknown engine or a zero wagon count is rejected, not silently accepted', invalid === 0, `created ${invalid} extra trains`);
});

section('Test 4 — cross-mode chain end to end (Mine -> truck -> Depot -> train -> Depot -> truck -> Town)', () => {
  const ctx = newGameContext();
  const ids = run(ctx, `
    function roadRun(x, y1, y2){ for(let y=Math.min(y1,y2); y<=Math.max(y1,y2); y++) cmdBuildRoad(x,y,'ground',true); }

    // West side (road): Mine -> Station(facing S) -> road -> Station(facing N) -> Depot A
    // (Stations must be built AFTER whatever they touch already exists —
    // touchesIndustryOrStation checks at build time, not retroactively;
    // a Depot's own platform track must exist before the Depot too.)
    cmdBuildBuilding('mine', 0, 0, 'large');
    cmdBuildBuilding('station', 2, 1, 'small', 'S', 'ore');   // touches mine at (1,1)
    roadRun(2, 2, 4);
    for(let y=5; y<=8; y++) cmdBuildTrack(5, y, 'rail', true); // Depot A's platform siding (east side)
    cmdBuildBuilding('depot', 3, 5, 'large', 'ns', 'ore');
    cmdBuildBuilding('station', 2, 5, 'small', 'N', 'ore');   // touches road at (2,4), touches Depot A at (3,5)

    // Rail spine: Depot A's siding -> Train Yard -> Depot B's siding.
    for(let x=6; x<=11; x++) cmdBuildTrack(x, 8, 'rail', true);
    cmdBuildBuilding('trainyard', 6, 9, 'small'); // touches the spine at (6,8)/(7,8)/(8,8)
    for(let y=9; y<=12; y++) cmdBuildTrack(11, y, 'rail', true); // Depot B's platform siding
    cmdBuildBuilding('depot', 9, 9, 'large', 'ns', 'ore');

    // East side (road): Depot B -> Station -> road -> Station -> Town
    cmdBuildBuilding('station', 10, 13, 'small', 'E', 'ore');  // touches Depot B at (10,12)
    roadRun(11, 13, 13);
    roadRun(12, 13, 13);
    cmdBuildBuilding('town', 13, 12, 'large', null, 'ore');
    cmdBuildBuilding('station', 12, 12, 'small', 'S', 'ore');  // touches road at (12,13), touches Town at (13,12)

    const byType = t => [...world.entities.values()].filter(e=>e.kind==='building' && e.type===t);
    const stations = byType('station');
    const findStationAt = (x,y) => stations.find(s=>s.x===x && s.y===y);
    return {
      mineStationId: findStationAt(2,1).id,
      depotAStationId: findStationAt(2,5).id,
      depotAId: byType('depot')[0].id,
      depotBId: byType('depot')[1].id,
      depotBStationId: findStationAt(10,13).id,
      townStationId: findStationAt(12,12).id,
      townId: byType('town')[0].id,
    };
  `);

  run(ctx, `
    cmdPurchaseVehicle(2, 3, 'bulk');
    const truck1 = [...world.entities.values()].find(e=>e.kind==='vehicle' && e.x===2 && e.y===3);
    cmdSetOrders(truck1, [
      {nodeId: ${ids.mineStationId}, action:'load_full', resource:'ore'},
      {nodeId: ${ids.depotAStationId}, action:'unload_all', resource:'ore'},
    ]);

    cmdPurchaseVehicle(11, 13, 'bulk');
    const truck2 = [...world.entities.values()].find(e=>e.kind==='vehicle' && e.x===11 && e.y===13);
    cmdSetOrders(truck2, [
      {nodeId: ${ids.depotBStationId}, action:'load_full', resource:'ore'},
      {nodeId: ${ids.townStationId}, action:'unload_all', resource:'ore'},
    ]);

    cmdAssembleTrain(6, 8, 'diesel', 'ore_wagon', 4); // 4 wagons: capacity comfortably above a truck's, to make the buffering effect visible
    const train = [...world.entities.values()].find(e=>e.kind==='vehicle' && isTrain(e.id));
    cmdSetOrders(train, [
      {nodeId: ${ids.depotAId}, action:'load_full', resource:'ore'},
      {nodeId: ${ids.depotBId}, action:'unload_all', resource:'ore'},
    ]);
  `);

  // The train effectively lives at Depot A, so Depot A's own stock number
  // never shows one big single-tick drop — the train nibbles at whatever's
  // there in real time, same as a truck would. The buffer absorbing the
  // rate mismatch shows up in the TRAIN's own cargo instead: it keeps
  // whatever it's picked up across many small, spread-out pickups (nothing
  // resets it while waiting) until it reaches a load far bigger than any
  // single truck's 10-unit capacity, then delivers all of it at once.
  let prevDepotA = 0, sawTruckSizedRise = false, maxTrainCargo = 0, townEverGotOre = false;
  for(let i=0;i<3000;i++){
    run(ctx, `simTick();`);
    const s = run(ctx, `
      const a = world.entities.get(${ids.depotAId});
      const t = world.entities.get(${ids.townId});
      const train = [...world.entities.values()].find(e=>e.kind==='vehicle' && isTrain(e.id));
      return {depotAStock: a.outStock, townStock: t.inStock, trainCargo: train.cargoAmount};
    `);
    if(s.depotAStock > prevDepotA + 3) sawTruckSizedRise = true; // a bulk truck holds up to 10 ore, delivered a few units at a time up to that
    prevDepotA = s.depotAStock;
    maxTrainCargo = Math.max(maxTrainCargo, s.trainCargo);
    if(s.townStock > 0) townEverGotOre = true;
  }
  const depotAHasConsumer = run(ctx, `return hasComponent(${ids.depotAId}, 'Consumer');`);
  const depotBHasConsumer = run(ctx, `return hasComponent(${ids.depotBId}, 'Consumer');`);
  const bulkCapacity = run(ctx, `return VEHICLE_DEFS.bulk.capacity;`);

  check('ore reaches the Town at the far end of the chain', townEverGotOre);
  check("Depot A's shared buffer rose in truck-sized increments (truck drop-off)", sawTruckSizedRise);
  check('the train accumulated a load far bigger than any single truck (buffer absorbs the rate mismatch)',
    maxTrainCargo > bulkCapacity, `maxTrainCargo=${maxTrainCargo} bulkCapacity=${bulkCapacity}`);
  check('a Rail Depot has no Consumer component — it never itself triggers delivery income', !depotAHasConsumer && !depotBHasConsumer);
});

section('Test 5 — train physics reuse (same F=ma model as trucks, parameterized over an assembled consist)', () => {
  const ctx = newGameContext();
  const out = run(ctx, `
    for(let x=0;x<=13;x++) cmdBuildTrack(x, 0, 'rail', true);
    for(let y=1;y<=4;y++) cmdBuildTrack(13, y, 'rail', true); // Depot's platform siding
    cmdBuildBuilding('depot', 11, 1, 'large', 'ns', 'ore');
    const train = createTrain(0, 0, 'diesel', 'ore_wagon', 3);
    const depot = [...world.entities.values()].find(e=>e.type==='depot');
    cmdSetOrders(train, [{nodeId: depot.id, action:'unload_all', resource:'ore'}]);
    const speeds = [];
    for(let i=0;i<20;i++){ simTick(); speeds.push(train.speed); }
    return {brakeGtEngine: train.brakeForce > train.engineForce, speeds, maxSpeed: train.maxSpeed};
  `);
  check('an assembled train has brakeForce > engineForce, like trucks (guarantees decel > accel at any mass)', out.brakeGtEngine === true);
  check('an assembled train starts at rest and accelerates under the shared physics model', out.speeds[0] >= 0 && out.speeds[out.speeds.length-1] > out.speeds[0],
    JSON.stringify(out.speeds));
  check('speed never exceeds maxSpeed', out.speeds.every(s=>s <= out.maxSpeed + 1e-9));
});

section('Test 6 — no regressions in the road-only chain (Mine -> truck -> Mill -> truck -> Town)', () => {
  // Phase 1's own manual verification scenario (see README), run headlessly
  // as a stand-in for "re-run the existing suites unmodified" — this repo
  // doesn't have Phase 1's suites checked in, so this exercises the same
  // path instead: confirms the track/Storage/vehicle-def refactors this
  // milestone made didn't disturb the non-rail game at all.
  const ctx = newGameContext();
  const ids = run(ctx, `
    function roadRun(x, y1, y2){ for(let y=Math.min(y1,y2); y<=Math.max(y1,y2); y++) cmdBuildRoad(x,y,'ground',true); }
    cmdBuildBuilding('mine', 0, 0, 'large');
    cmdBuildBuilding('station', 2, 1, 'small', 'S', 'ore');
    roadRun(2, 2, 4);
    cmdBuildBuilding('mill', 3, 5, 'large');
    cmdBuildBuilding('station', 2, 5, 'small', 'N', 'ore');
    cmdBuildBuilding('station', 6, 5, 'small', 'E', 'steel'); // touches mill (west side); road is to its east at (7,5)
    roadRun(7, 5, 7);
    cmdBuildBuilding('town', 8, 8, 'large', null, 'steel');
    cmdBuildBuilding('station', 7, 8, 'small', 'N', 'steel');
    const byType = t => [...world.entities.values()].filter(e=>e.kind==='building' && e.type===t);
    const stations = byType('station');
    const at = (x,y) => stations.find(s=>s.x===x && s.y===y);
    return {
      oreStationId: at(2,1).id, millOreStationId: at(2,5).id,
      millSteelStationId: at(6,5).id, townStationId: at(7,8).id,
      townId: byType('town')[0].id,
    };
  `);
  run(ctx, `
    cmdPurchaseVehicle(2, 3, 'bulk');
    const bulk = [...world.entities.values()].find(e=>e.kind==='vehicle' && e.type==='bulk');
    cmdSetOrders(bulk, [
      {nodeId: ${ids.oreStationId}, action:'load_full', resource:'ore'},
      {nodeId: ${ids.millOreStationId}, action:'unload_all', resource:'ore'},
    ]);
    cmdPurchaseVehicle(7, 6, 'flatbed');
    const flat = [...world.entities.values()].find(e=>e.kind==='vehicle' && e.type==='flatbed');
    cmdSetOrders(flat, [
      {nodeId: ${ids.millSteelStationId}, action:'load_full', resource:'steel'},
      {nodeId: ${ids.townStationId}, action:'unload_all', resource:'steel'},
    ]);
  `);
  let delivered = false;
  for(let i=0;i<4000;i++){
    run(ctx, `simTick();`);
    const stock = run(ctx, `return world.entities.get(${ids.townId}).inStock;`);
    if(stock > 0){ delivered = true; break; }
  }
  check('the non-rail Mine -> Mill -> Town chain still delivers steel end to end', delivered);
});

section('Test 7 — Rail Depot forwards to a directly/chain-linked industry, like a Station', () => {
  const ctx = newGameContext();
  const ids = run(ctx, `
    // Mine -- Depot A, touching directly, no Station at all on that side;
    // Depot A's platform siding sits on its OTHER side, so the mine touch
    // and the rail access are two entirely independent sides.
    cmdBuildBuilding('mine', 0, 0, 'large');
    for(let y=0; y<=3; y++) cmdBuildTrack(4, y, 'rail', true); // Depot A's platform siding (east side)
    cmdBuildBuilding('depot', 2, 0, 'large', 'ns', 'ore');     // touches the Mine at (1,0)/(1,1) on its west side

    // Rail spine, a Train Yard touching it, and Depot B at the far end.
    cmdBuildTrack(4, 3, 'rail', true); // ties the siding into the spine
    for(let x=5; x<=14; x++) cmdBuildTrack(x, 3, 'rail', true);
    cmdBuildBuilding('trainyard', 5, 4, 'small'); // touches the spine at (5,3)/(6,3)/(7,3)
    for(let y=4; y<=7; y++) cmdBuildTrack(14, y, 'rail', true); // Depot B's platform siding
    cmdBuildBuilding('depot', 12, 4, 'large', 'ns', 'ore');

    // Depot B -- Station -- Town: a chain of Stations reaching an
    // industry, exactly the mechanism a truck's Station already used —
    // no truck anywhere in this test, on either end.
    cmdBuildBuilding('station', 13, 8, 'small', 'E', 'ore'); // touches Depot B at (13,7)
    cmdBuildBuilding('town', 14, 8, 'large', null, 'ore');   // touches the Station at (14,8)

    cmdAssembleTrain(5, 3, 'diesel', 'ore_wagon', 3);
    const train = [...world.entities.values()].find(e=>e.kind==='vehicle' && isTrain(e.id));
    const byType = t => [...world.entities.values()].filter(e=>e.kind==='building' && e.type===t);
    const depots = byType('depot');
    const ids = {
      mineId: byType('mine')[0].id,
      depotAId: depots.find(d=>d.x===2).id,
      depotBId: depots.find(d=>d.x===12).id,
      townId: byType('town')[0].id,
    };
    cmdSetOrders(train, [
      {nodeId: ids.depotAId, action:'load_full', resource:'ore'},
      {nodeId: ids.depotBId, action:'unload_all', resource:'ore'},
    ]);
    return ids;
  `);

  let mineDrawnDown = false, depotABufferUntouched = true, depotBBufferUntouched = true, townGotOre = false, treasuryCredited = false;
  let maxMineStockSeen = 0, prevTreasury = run(ctx, `return world.treasury;`);
  for(let i=0;i<4000;i++){
    run(ctx, `simTick();`);
    const s = run(ctx, `
      return {
        mineStock: world.entities.get(${ids.mineId}).outStock,
        depotAStock: world.entities.get(${ids.depotAId}).outStock,
        depotBStock: world.entities.get(${ids.depotBId}).outStock,
        townStock: world.entities.get(${ids.townId}).inStock,
        treasury: world.treasury,
      };
    `);
    // Compared against a running peak/previous value, not a fixed baseline
    // — the Mine's stock climbs from 0 regardless, and treasury drains
    // every tick from the train's own running cost, so either one dipping
    // below a *fixed* starting number wouldn't reliably show up. A drop
    // from the highest point seen so far, or a tick where treasury rises
    // instead of falling, can only mean the train actually pulled ore
    // straight from the Mine, and the Town actually paid for delivered
    // ore, respectively — nothing else moves either number in this test.
    if(s.mineStock > maxMineStockSeen) maxMineStockSeen = s.mineStock;
    else if(s.mineStock < maxMineStockSeen) mineDrawnDown = true;
    if(s.depotAStock !== 0) depotABufferUntouched = false;    // Depot A's own buffer was never used — forwarding bypassed it
    if(s.depotBStock !== 0) depotBBufferUntouched = false;    // same for Depot B, on the unload side
    if(s.townStock > 0) townGotOre = true;                    // reached the Town through Depot B -> Station -> Town, no truck
    if(s.treasury > prevTreasury) treasuryCredited = true;     // the Town, a real Consumer, paid for what it received
    prevTreasury = s.treasury;
  }
  check('the train drew ore straight from the Mine\'s own Storage through Depot A, with no truck involved', mineDrawnDown);
  check('Depot A\'s own buffer was never touched — the link bypassed it entirely', depotABufferUntouched);
  check('Depot B\'s own buffer was never touched either, on the unload side', depotBBufferUntouched);
  check('ore reached the Town through Depot B -> Station -> Town, with no truck involved', townGotOre);
  check('the Town paid delivery income for ore it actually received', treasuryCredited);
});

section('Test 8 — road and rail cross only at a right angle, sharing the same grade', () => {
  const ctx = newGameContext();
  const s = run(ctx, `
    // Ground road running E-W through (5,5); rail running N-S through the
    // exact same cell — a clean perpendicular crossing.
    for(let x=3; x<=7; x++) cmdBuildRoad(x, 5, 'ground', true);
    for(let y=2; y<=8; y++) cmdBuildTrack(5, y, 'rail', true);

    const crossing = getCell(5,5);
    const roadPath = findRoadPath({x:3,y:5,layer:'ground'}, {x:7,y:5,layer:'ground'});
    const railPath = findRailPath({x:5,y:2,layer:'rail'}, {x:5,y:8,layer:'rail'});

    // Now try to run a SECOND rail tile parallel to the road, through the
    // same crossing cell (6,5 is already ground road) — this should place
    // the tile but fail to connect through the crossing, since that
    // direction is already the road's.
    cmdBuildTrack(6, 5, 'rail', true);
    const eastOfCrossing = getCell(6,5);

    return {
      roadConnectsThrough: crossing.layers.ground.road.edges.E && crossing.layers.ground.road.edges.W,
      railConnectsThrough: crossing.layers.ground.rail.edges.N && crossing.layers.ground.rail.edges.S,
      roadPathLength: roadPath ? roadPath.length : -1,
      railPathLength: railPath ? railPath.length : -1,
      parallelRailTilePlaced: eastOfCrossing.layers.ground.rail.track,
      parallelRailBlockedAtCrossing: !crossing.layers.ground.rail.edges.E && !eastOfCrossing.layers.ground.rail.edges.W,
    };
  `);
  check('the road still connects straight through the crossing cell (E-W)', s.roadConnectsThrough);
  check('the rail still connects straight through the crossing cell (N-S), independently', s.railConnectsThrough);
  check('a truck can still path the full length of the road through the crossing', s.roadPathLength === 5, `got ${s.roadPathLength}`);
  check('a train can still path the full length of the track through the crossing', s.railPathLength === 7, `got ${s.railPathLength}`);
  check('a rail tile placed parallel to the road (same direction) still gets placed...', s.parallelRailTilePlaced);
  check('...but does not connect through the crossing — no same-direction overlap allowed', s.parallelRailBlockedAtCrossing);

  // The manual Connect tool must reject the same parallel overlap, not just
  // auto-connect — otherwise a player could route around the restriction
  // with Connect/Disconnect.
  const manual = run(ctx, `
    cmdToggleConnection(5,5, 6,5, 'rail');
    return trackAt(5,5,'rail').edges.E;
  `);
  check('manually connecting the same parallel overlap is rejected too', manual === false);
});

section('Test 9 — a train sitting on a road/rail crossing blocks trucks through it, releasing it once clear', () => {
  const ctx = newGameContext();
  const ids = run(ctx, `
    cmdBuildBuilding('mine', 11, 3, 'small');
    cmdBuildBuilding('station', 10, 3, 'small', 'S', 'ore'); // touches the Mine at (11,3); road dock at (10,4)
    for(let x=2; x<=10; x++) cmdBuildRoad(x, 4, 'ground', true); // crosses the rail at (5,4)
    for(let y=1; y<=8; y++) cmdBuildTrack(5, y, 'rail', true);

    cmdPurchaseVehicle(2, 4, 'bulk');
    const truck = [...world.entities.values()].find(e=>e.kind==='vehicle' && e.type==='bulk');
    const station = [...world.entities.values()].find(e=>e.kind==='building' && e.type==='station');
    cmdSetOrders(truck, [{nodeId: station.id, action:'unload_all', resource:'ore'}]);

    // Teleported straight onto the crossing cell rather than driven there —
    // this test is about the blocking mechanism itself, not about timing
    // two vehicles into organic coincidence.
    const train = createTrain(5, 4, 'diesel', 'ore_wagon', 2);

    return {truckId: truck.id, trainId: train.id};
  `);

  let maxTruckX = -1;
  for(let i=0;i<80;i++){
    run(ctx, `simTick();`);
    const x = run(ctx, `return world.entities.get(${ids.truckId}).x;`);
    if(x > maxTruckX) maxTruckX = x;
  }
  check('the truck never advances past the crossing while the train occupies it', maxTruckX <= 4, `truck reached x=${maxTruckX}`);

  // Move the train off the crossing entirely — nothing should have
  // latched the block permanently; the truck must now proceed on its own,
  // no new command or nudge needed.
  run(ctx, `
    const train = world.entities.get(${ids.trainId});
    train.x = 5; train.y = 2;
  `);
  let truckCrossed = false;
  for(let i=0;i<200;i++){
    run(ctx, `simTick();`);
    const x = run(ctx, `return world.entities.get(${ids.truckId}).x;`);
    if(x > 5){ truckCrossed = true; break; }
  }
  check('the truck proceeds through the crossing on its own once the train has cleared it', truckCrossed);
});

section('Test 10 — a train reserves a crossing well before it physically arrives', () => {
  const ctx = newGameContext();
  const ids = run(ctx, `
    cmdBuildBuilding('mine', 11, 3, 'small');
    cmdBuildBuilding('station', 10, 3, 'small', 'S', 'ore'); // road dock at (10,4)
    for(let x=2; x<=10; x++) cmdBuildRoad(x, 4, 'ground', true); // crosses the rail at (5,4)
    for(let y=0; y<=8; y++) cmdBuildTrack(5, y, 'rail', true);

    cmdPurchaseVehicle(2, 4, 'bulk');
    const truck = [...world.entities.values()].find(e=>e.kind==='vehicle' && e.type==='bulk');
    const station = [...world.entities.values()].find(e=>e.kind==='building' && e.type==='station');
    cmdSetOrders(truck, [{nodeId: station.id, action:'unload_all', resource:'ore'}]);

    // The train is nowhere near the crossing physically (y=8, 4 tiles south
    // of it), and deliberately left with NO orders and 'idle' state so
    // tickTrainMovement's own state machine never touches it — this test
    // drives the truck via tickVehicles() alone (see the loop below) to
    // isolate the crossing-reservation mechanism from the train actually
    // moving. Its manually-set path already runs through the crossing a
    // few steps ahead. If reservation only ever looked at where a train
    // currently *is*, this train wouldn't register at the crossing yet.
    const train = createTrain(5, 8, 'diesel', 'ore_wagon', 2);
    train.path = [{x:5,y:8},{x:5,y:7},{x:5,y:6},{x:5,y:5},{x:5,y:4},{x:5,y:3},{x:5,y:2},{x:5,y:1},{x:5,y:0}];
    train.pathIndex = 0;

    return {truckId: truck.id, trainId: train.id};
  `);

  let maxTruckX = -1;
  for(let i=0;i<80;i++){
    run(ctx, `tickVehicles();`);
    const x = run(ctx, `return world.entities.get(${ids.truckId}).x;`);
    if(x > maxTruckX) maxTruckX = x;
  }
  check('the truck is held before the crossing even though the train is 4 tiles away and not moving', maxTruckX <= 4, `truck reached x=${maxTruckX}`);

  // Clear the reservation (train no longer has a path bringing it toward
  // the crossing at all) — the truck must proceed on its own.
  run(ctx, `
    const train = world.entities.get(${ids.trainId});
    train.path = null;
  `);
  let truckCrossed = false;
  for(let i=0;i<200;i++){
    run(ctx, `tickVehicles();`);
    const x = run(ctx, `return world.entities.get(${ids.truckId}).x;`);
    if(x > 5){ truckCrossed = true; break; }
  }
  check('the truck proceeds once the train no longer has a path reserving the crossing', truckCrossed);
});

section('Test 11 — rail also runs on ground and elevated layers, linked by its own Rail Ramp', () => {
  const ctx = newGameContext();
  const s = run(ctx, `
    // Elevated road E-W crossing elevated rail N-S at (5,5) — the same
    // perpendicular-only crossing rule Test 8 proved for ground, now
    // checked at the elevated grade instead.
    for(let x=3; x<=7; x++) cmdBuildRoad(x, 5, 'elevated', true);
    for(let y=2; y<=8; y++) cmdBuildTrack(5, y, 'railElevated', true);
    const crossing = getCell(5,5);

    // A signal on railElevated is its own block boundary, independent of
    // any ground-rail blocks elsewhere on the map.
    cmdBuildTrack(10, 0, 'railElevated', true);
    cmdBuildTrack(11, 0, 'railElevated', true);
    cmdBuildTrack(12, 0, 'railElevated', true);
    cmdToggleOneWay(10, 0, 11, 0, 'railElevated');
    const elevatedBlockA = trackAt(10,0,'railElevated').blockId.E;
    const elevatedBlockB = trackAt(11,0,'railElevated').blockId.E;

    return {
      roadConnectsThrough: crossing.layers.elevated.road.edges.E && crossing.layers.elevated.road.edges.W,
      railConnectsThrough: crossing.layers.elevated.rail.edges.N && crossing.layers.elevated.rail.edges.S,
      elevatedBlocksSplitBySignal: elevatedBlockA !== elevatedBlockB && elevatedBlockA != null && elevatedBlockB != null,
    };
  `);
  check('elevated road and elevated rail cross at a right angle, both staying fully connected', s.roadConnectsThrough && s.railConnectsThrough);
  check('a signal on the elevated rail layer splits blocks there too, independent of ground rail', s.elevatedBlocksSplitBySignal);

  // A Rail Ramp links rail and railElevated exactly like a (road) Ramp
  // links ground and elevated — proven end to end with a real train,
  // organically driven by simTick(), not just a pathfinding check: it
  // must actually climb onto the elevated bridge and come back down to
  // reach a second, ground-level Depot. Each Depot gets its own siding
  // (as elsewhere in this file), tied into the ground->bridge->ground line
  // via a plain connector tile.
  const ids = run(ctx, `
    for(let y=3; y<=6; y++) cmdBuildTrack(2, y, 'rail', true); // Depot A's siding (east side)
    cmdBuildBuilding('depot', 0, 3, 'large', 'ns', 'ore');
    cmdBuildTrack(3, 3, 'rail', true); // ties the siding into the main line
    cmdBuildBuilding('trainyard', 3, 4, 'small'); // touches the main line at (3,3)

    cmdBuildTrack(4, 3, 'rail', true);
    for(let x=4; x<=8; x++) cmdBuildTrack(x, 3, 'railElevated', true);
    cmdBuildRailRamp(4, 3);
    for(let x=8; x<=10; x++) cmdBuildTrack(x, 3, 'rail', true);
    cmdBuildRailRamp(8, 3);

    cmdBuildTrack(11, 3, 'rail', true); // connector to Depot B's siding
    for(let y=3; y<=6; y++) cmdBuildTrack(12, y, 'rail', true); // Depot B's siding (west side)
    cmdBuildBuilding('depot', 13, 3, 'large', 'ns', 'ore');

    const depots = [...world.entities.values()].filter(e=>e.kind==='building' && e.type==='depot');
    const depotAId = depots.find(d=>d.x===0).id;
    const depotBId = depots.find(d=>d.x===13).id;
    world.entities.get(depotAId).outStock = 50; // seed cargo directly — this test is about the ramp, not production

    cmdAssembleTrain(3, 3, 'diesel', 'ore_wagon', 2);
    const train = [...world.entities.values()].find(e=>e.kind==='vehicle' && isTrain(e.id));
    cmdSetOrders(train, [
      {nodeId: depotAId, action:'load_full', resource:'ore'},
      {nodeId: depotBId, action:'unload_all', resource:'ore'},
    ]);
    return {trainId: train.id, depotAId, depotBId};
  `);

  let sawElevated = false, sawGroundAfterElevated = false;
  for(let i=0;i<3000;i++){
    run(ctx, `simTick();`);
    const t = run(ctx, `const t = world.entities.get(${ids.trainId}); return {x:t.x, layer:t.layer};`);
    if(t.layer==='railElevated') sawElevated = true;
    if(sawElevated && t.layer==='rail' && t.x > 8) sawGroundAfterElevated = true;
  }
  check('the train climbed onto the elevated rail bridge via the first Rail Ramp', sawElevated);
  check('the train came back down to ground rail via the second Rail Ramp, past the bridge', sawGroundAfterElevated);
  const depotBStock = run(ctx, `return world.entities.get(${ids.depotBId}).outStock;`);
  check('the ore actually made it across the bridge and was delivered at the far Depot', depotBStock > 0, `depotB stock: ${depotBStock}`);
});

console.log(failures===0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
