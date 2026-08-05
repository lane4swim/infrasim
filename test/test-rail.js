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

// Depot A -- Block1 -- junction(6,5) -- Block2 -- Depot B, with a short
// branch off Depot B's own hub cell leading on to Depot C. The branch is
// what lets a train release Block2 by continuing on to a genuinely
// different block (Depot C) without ever needing to backtrack through the
// junction — avoiding a same-track physical deadlock with whatever else is
// waiting there (see the reasoning in Test 1).
function buildJunctionLine(ctx){
  return run(ctx, `
    cmdBuildBuilding('depot', 0, 5, 'large', null, 'ore');
    for(let x=2; x<=11; x++) cmdBuildTrack(x, 5, true);
    cmdBuildTrack(6, 6, true); // branch stub off the junction cell — used by Test 2
    cmdBuildBuilding('depot', 12, 5, 'large', null, 'ore');
    cmdBuildTrack(11, 6, true);
    cmdBuildTrack(11, 7, true);
    cmdBuildBuilding('depot', 10, 8, 'large', null, 'ore');
    const depots = [...world.entities.values()].filter(e=>e.kind==='building' && e.type==='depot');
    return {
      depotAId: depots.find(d=>d.x===0).id,
      depotBId: depots.find(d=>d.x===12).id,
      depotCId: depots.find(d=>d.x===10).id,
    };
  `);
}

section('Test 1 — block mutual exclusion', () => {
  const ctx = newGameContext();
  const {depotAId, depotBId, depotCId} = buildJunctionLine(ctx);

  // Train A's route (Depot A -> Depot B -> Depot C) crosses Block2 once,
  // then leaves it for good via the Depot C branch — never needing to
  // backtrack through the junction where Train B will be waiting. Created
  // directly via createTrain (not cmdAssembleTrain/a Train Yard) since this
  // test is about block mechanics, not the assembly command — that has its
  // own test below.
  const trainAId = run(ctx, `
    const trainA = createTrain(2, 5, 'diesel', 'ore_wagon', 3);
    cmdSetOrders(trainA, [
      {nodeId: ${depotBId}, action:'unload_all', resource:'ore'},
      {nodeId: ${depotCId}, action:'unload_all', resource:'ore'},
    ]);
    return trainA.id;
  `);

  // Run Train A alone until it's inside block2 (x between 7 and 9). Budgets
  // here are generous because per-vehicle stats are randomized at creation
  // (§ createVehicle) — actual tick counts vary run to run.
  let block2Id = null;
  for(let i=0;i<1000;i++){
    run(ctx, `simTick();`);
    const a = run(ctx, `const a = world.entities.get(${trainAId}); return {x:a.x, currentBlock:a.currentBlock};`);
    if(a.x >= 7 && a.x <= 9){
      block2Id = run(ctx, `return getCell(6,5).layers.rail.blockId.E;`);
      check('train A holds block2 while crossing it', a.currentBlock === block2Id, `currentBlock=${a.currentBlock} block2Id=${block2Id}`);
      break;
    }
  }
  check('found train A inside block2 within budget', block2Id !== null);

  // Spawn Train B right at the junction, approaching block2 from the
  // opposite end — it must NOT be able to enter while Train A holds it.
  const trainBId = run(ctx, `
    const trainB = createTrain(6, 5, 'diesel', 'ore_wagon', 3);
    cmdSetOrders(trainB, [{nodeId: ${depotBId}, action:'unload_all', resource:'ore'}]);
    return trainB.id;
  `);
  run(ctx, `simTick();`);
  let b = run(ctx, `const b = world.entities.get(${trainBId}); return {x:b.x, y:b.y};`);
  check('train B does not enter the block while train A holds it', b.x === 6 && b.y === 5, JSON.stringify(b));

  // Run until train A stops holding block2 (it diverted onto the Depot C
  // branch) and confirm train B proceeds shortly after — not stalled
  // indefinitely, and without needing a full stop-and-reaccelerate cycle.
  // Watched as "no longer held by A" rather than "becomes null", since A's
  // release and B's re-acquisition can legitimately land in the SAME tick
  // (A is processed first in tickTrainMovement, frees the block, and B —
  // processed right after in that same call — can claim it immediately) —
  // that's the best case, not an edge case to special-case around.
  let releasedAtTick = -1, bMovedAtTick = -1;
  for(let i=0;i<2000;i++){
    const before = run(ctx, `return world.railBlocks.get(${block2Id}).occupiedBy;`);
    run(ctx, `simTick();`);
    const after = run(ctx, `return world.railBlocks.get(${block2Id}).occupiedBy;`);
    if(releasedAtTick===-1 && before===trainAId && after!==trainAId) releasedAtTick = i;
    if(releasedAtTick!==-1 && bMovedAtTick===-1){
      const bb = run(ctx, `const b = world.entities.get(${trainBId}); return {x:b.x, y:b.y};`);
      if(bb.x !== 6 || bb.y !== 5) bMovedAtTick = i;
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

section('Test 2 — block computation correctness', () => {
  const ctx = newGameContext();
  buildJunctionLine(ctx);
  const edges = run(ctx, `
    return {
      block1_a: getCell(2,5).layers.rail.blockId.E,
      block1_b: getCell(5,5).layers.rail.blockId.E,
      block2_a: getCell(6,5).layers.rail.blockId.E,
      block2_b: getCell(10,5).layers.rail.blockId.E,
      branch:   getCell(6,5).layers.rail.blockId.S,
    };
  `);
  check('block1 is one consistent id across its whole span', edges.block1_a === edges.block1_b && edges.block1_a != null);
  check('block2 is one consistent id across its whole span', edges.block2_a === edges.block2_b && edges.block2_a != null);
  check('the junction branch is its own block', edges.branch != null && edges.branch !== edges.block1_a && edges.branch !== edges.block2_a);
  check('block1 and block2 are distinct blocks, split exactly at the junction', edges.block1_a !== edges.block2_a);

  // Demolish a middle tile of block1 (x=4) — it should split into two
  // separate blocks (a new dead end forms on each side), not silently
  // keep stale ids or merge across the gap.
  run(ctx, `cmdDemolish(4, 5, 'rail');`);
  const after = run(ctx, `
    return {
      leftStub:  getCell(2,5).layers.rail.blockId.E,   // (2,5)-(3,5), now a dead end at x=3
      rightStub: getCell(5,5).layers.rail.blockId.E,   // (5,5)-(6,5), unaffected span
      gapGone:   getCell(4,5).layers.rail.track,
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
    cmdBuildTrack(3, 0, true);  // touches the Yard's footprint (0,0)-(2,1) at (2,0)
    cmdBuildTrack(3, 3, true);  // NOT touching any Yard
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
    function railRun(x1, x2, y){ for(let x=Math.min(x1,x2); x<=Math.max(x1,x2); x++) cmdBuildTrack(x,y,true); }

    // West side (road): Mine -> Station(facing S) -> road -> Station(facing N) -> Depot A
    // (Stations must be built AFTER whatever they touch already exists —
    // touchesIndustryOrStation checks at build time, not retroactively.)
    cmdBuildBuilding('mine', 0, 0, 'large');
    cmdBuildBuilding('station', 2, 1, 'small', 'S', 'ore');   // touches mine at (1,1)
    roadRun(2, 2, 4);
    cmdBuildBuilding('depot', 3, 5, 'large', null, 'ore');
    cmdBuildBuilding('station', 2, 5, 'small', 'N', 'ore');   // touches road at (2,4), touches Depot A at (3,5)

    // Rail spine: Depot A -> Depot B, with a Train Yard touching the line
    // partway along (8,7)) so a train can actually be assembled onto it.
    railRun(3, 15, 7); // touches Depot A at (3,6) via (3,7), Depot B at (16,7) via (15,7)
    cmdBuildBuilding('depot', 16, 7, 'large', null, 'ore');
    cmdBuildBuilding('trainyard', 8, 8, 'small'); // touches the rail spine at (8,7) via (8,8)

    // East side (road): Depot B -> Station(facing S) -> road -> Station(facing S) -> Town
    cmdBuildBuilding('station', 18, 8, 'small', 'S', 'ore');  // touches Depot B at (17,8)
    roadRun(18, 9, 10);
    cmdBuildBuilding('town', 19, 10, 'large', null, 'ore');
    cmdBuildBuilding('station', 18, 11, 'small', 'N', 'ore'); // touches road at (18,10), touches Town at (19,11)

    const byType = t => [...world.entities.values()].filter(e=>e.kind==='building' && e.type===t);
    const stations = byType('station');
    const findStationAt = (x,y) => stations.find(s=>s.x===x && s.y===y);
    return {
      mineStationId: findStationAt(2,1).id,
      depotAStationId: findStationAt(2,5).id,
      depotAId: byType('depot')[0].id,
      depotBId: byType('depot')[1].id,
      depotBStationId: findStationAt(18,8).id,
      townStationId: findStationAt(18,11).id,
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

    cmdPurchaseVehicle(18, 9, 'bulk');
    const truck2 = [...world.entities.values()].find(e=>e.kind==='vehicle' && e.x===18 && e.y===9);
    cmdSetOrders(truck2, [
      {nodeId: ${ids.depotBStationId}, action:'load_full', resource:'ore'},
      {nodeId: ${ids.townStationId}, action:'unload_all', resource:'ore'},
    ]);

    cmdAssembleTrain(8, 7, 'diesel', 'ore_wagon', 4); // 4 wagons: capacity comfortably above a truck's, to make the buffering effect visible
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
    for(let x=0;x<=15;x++) cmdBuildTrack(x, 0, true);
    cmdBuildBuilding('depot', 16, 0, 'large', null, 'ore');
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
    // Mine -- Depot A, touching directly, no Station at all on that side.
    cmdBuildBuilding('mine', 0, 1, 'large');
    cmdBuildBuilding('depot', 2, 1, 'large', null, 'ore'); // touches the Mine at (1,1)/(1,2)

    // Rail spine, a Train Yard touching it, and Depot B at the far end.
    for(let x=2; x<=14; x++) cmdBuildTrack(x, 3, true); // touches Depot A at (2,2)/(3,2)
    cmdBuildBuilding('trainyard', 4, 4, 'small');        // touches the spine at (4,3)/(5,3)/(6,3)
    cmdBuildBuilding('depot', 14, 1, 'large', null, 'ore'); // touches the spine at (14,2)/(15,2)

    // Depot B -- Station -- Town: a chain of Stations reaching an
    // industry, exactly the mechanism a truck's Station already used —
    // no truck anywhere in this test, on either end.
    cmdBuildBuilding('station', 16, 1, 'small', 'W', 'ore'); // touches Depot B at (15,1)
    cmdBuildBuilding('town', 17, 1, 'large', null, 'ore');   // touches the Station at (17,1)

    cmdAssembleTrain(4, 3, 'diesel', 'ore_wagon', 3);
    const train = [...world.entities.values()].find(e=>e.kind==='vehicle' && isTrain(e.id));
    const byType = t => [...world.entities.values()].filter(e=>e.kind==='building' && e.type===t);
    const depots = byType('depot');
    const ids = {
      mineId: byType('mine')[0].id,
      depotAId: depots.find(d=>d.x===2).id,
      depotBId: depots.find(d=>d.x===14).id,
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
    for(let y=2; y<=8; y++) cmdBuildTrack(5, y, true);

    const crossing = getCell(5,5);
    const roadPath = findRoadPath({x:3,y:5,layer:'ground'}, {x:7,y:5,layer:'ground'});
    const railPath = findRailPath({x:5,y:2}, {x:5,y:8});

    // Now try to run a SECOND rail tile parallel to the road, through the
    // same crossing cell (6,5 is already ground road) — this should place
    // the tile but fail to connect through the crossing, since that
    // direction is already the road's.
    cmdBuildTrack(6, 5, true);
    const eastOfCrossing = getCell(6,5);

    return {
      roadConnectsThrough: crossing.layers.ground.edges.E && crossing.layers.ground.edges.W,
      railConnectsThrough: crossing.layers.rail.edges.N && crossing.layers.rail.edges.S,
      roadPathLength: roadPath ? roadPath.length : -1,
      railPathLength: railPath ? railPath.length : -1,
      parallelRailTilePlaced: eastOfCrossing.layers.rail.track,
      parallelRailBlockedAtCrossing: !crossing.layers.rail.edges.E && !eastOfCrossing.layers.rail.edges.W,
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
    return getCell(5,5).layers.rail.edges.E;
  `);
  check('manually connecting the same parallel overlap is rejected too', manual === false);
});

section('Test 9 — a train sitting on a road/rail crossing blocks trucks through it, releasing it once clear', () => {
  const ctx = newGameContext();
  const ids = run(ctx, `
    cmdBuildBuilding('mine', 11, 3, 'small');
    cmdBuildBuilding('station', 10, 3, 'small', 'S', 'ore'); // touches the Mine at (11,3); road dock at (10,4)
    for(let x=2; x<=10; x++) cmdBuildRoad(x, 4, 'ground', true); // crosses the rail at (5,4)
    for(let y=1; y<=8; y++) cmdBuildTrack(5, y, true);

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
    for(let y=0; y<=8; y++) cmdBuildTrack(5, y, true);

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

console.log(failures===0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
