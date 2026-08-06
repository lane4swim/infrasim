// Regression tests for the Rail Depot parallel-track requirement (§ Depot
// platform) — a Depot must run alongside a straight, unbroken length of
// track on one of its long sides, not just touch it at a corner, and a
// longer train docked along more of that platform loads/unloads faster.
// Run against the real index.html code via test/harness.js.
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

// Attempts to build a 'large' ore Depot at (2,2) (orientation 'ns', the
// content pack's canonical 2x4 footprint — long sides are its west/east
// columns) against whatever track `setupCode` laid down first, and reports
// whether it actually got built.
function tryBuildDepot(setupCode){
  const ctx = newGameContext();
  run(ctx, setupCode);
  return run(ctx, `
    cmdBuildBuilding('depot', 2, 2, 'large', 'ns', 'ore');
    return {
      built: [...world.entities.values()].some(e=>e.type==='depot'),
      warnLogs: pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg),
    };
  `);
}

section('Test 1 — a Depot must run alongside a full, unbroken parallel track run', () => {
  const noTrack = tryBuildDepot(``);
  check('rejected with no track anywhere nearby', !noTrack.built);
  check('the rejection names the parallel-track requirement', noTrack.warnLogs.some(m => /alongside/i.test(m)), JSON.stringify(noTrack.warnLogs));

  // A single tile touching the SHORT end (north cap) — the old "any
  // touching corner" rule would have accepted this; the new rule never
  // even looks at the short ends, only the two long sides.
  const shortEnd = tryBuildDepot(`cmdBuildTrack(2, 1, 'rail', true);`);
  check('rejected when track only touches a short end, not a long side', !shortEnd.built);

  // A single tile on a LONG side, but not spanning the whole footprint
  // length — a real platform can't be shorter than the track it claims to
  // run alongside.
  const partialRun = tryBuildDepot(`cmdBuildTrack(1, 2, 'rail', true);`);
  check('rejected when a long side has only a partial track run', !partialRun.built);

  // A full 4-cell run on the WEST long side.
  const westFull = tryBuildDepot(`for(let y=2;y<=5;y++) cmdBuildTrack(1, y, 'rail', true);`);
  check('accepted with a full run on the west long side', westFull.built);

  // A full 4-cell run on the EAST long side instead — either long side works.
  const eastFull = tryBuildDepot(`for(let y=2;y<=5;y++) cmdBuildTrack(4, y, 'rail', true);`);
  check('accepted with a full run on the east long side (either long side qualifies)', eastFull.built);
});

section('Test 2 — orientation swaps the footprint, and with it which sides are "long"', () => {
  const ctx = newGameContext();
  const out = run(ctx, `
    for(let x=2;x<=5;x++) cmdBuildTrack(x, 1, 'rail', true); // north long side, full 4-cell run
    cmdBuildBuilding('depot', 2, 2, 'large', 'ew', 'ore');
    const d = [...world.entities.values()].find(e=>e.type==='depot');
    return {built: !!d, footprint: d && {w:d.footprint.w, h:d.footprint.h}};
  `);
  check('an "ew" Depot is built wider than tall (footprint w/h swapped from the canonical n-s shape)',
    out.built && out.footprint.w > out.footprint.h, JSON.stringify(out));

  // The SAME north-side track run would NOT satisfy an 'ns' Depot at the
  // same anchor, since for 'ns' the long sides are west/east, not north —
  // proving orientation actually changes which sides count, not just the
  // footprint's raw dimensions.
  const nsRejected = tryBuildDepot(`for(let x=2;x<=5;x++) cmdBuildTrack(x, 1, 'rail', true);`);
  check('the same north-side track run does NOT satisfy the default "ns" orientation (long sides are west/east there)',
    !nsRejected.built);
});

section('Test 3 — a longer train docked alongside more of the platform loads faster', () => {
  const ctx = newGameContext();
  const ids = run(ctx, `
    cmdBuildBuilding('mine', 0, 0, 'large');
    for(let y=0; y<=3; y++) cmdBuildTrack(4, y, 'rail', true); // Depot's 4-cell platform siding (east side)
    cmdBuildBuilding('depot', 2, 0, 'large', 'ns', 'ore');     // touches the mine directly on its west side
    cmdBuildTrack(4, 4, 'rail', true);
    cmdBuildBuilding('trainyard', 4, 5, 'small');              // touches (4,4)

    cmdAssembleTrain(4, 4, 'diesel', 'ore_wagon', 1);
    const train = [...world.entities.values()].find(e=>e.kind==='vehicle' && isTrain(e.id));
    const depot = [...world.entities.values()].find(e=>e.type==='depot');
    const mine = [...world.entities.values()].find(e=>e.type==='mine');
    mine.outCap = 100000; mine.outStock = 100000; // never runs dry — isolates the transfer-rate question
    cmdSetOrders(train, [{nodeId: depot.id, action:'load_full', resource:'ore'}]);
    return {trainId: train.id, depotId: depot.id};
  `);

  // Drive it until the train has actually docked (state === 'loading')
  // with its full body alongside the platform, then measure exactly how
  // much cargo one further tick adds — this is the effective transfer
  // rate (min of the train's own transferRate and the Depot's) multiplied
  // by however many of the train's own cells overlap the platform right now.
  let dockedCellCount = null, perTickGain = null, baseRate = null;
  for(let i=0;i<200;i++){
    run(ctx, `simTick();`);
    const s = run(ctx, `
      const t = world.entities.get(${ids.trainId});
      const d = world.entities.get(${ids.depotId});
      return {state: t.state, docked: dockedPlatformCellCount(t, d), cargo: t.cargoAmount, rate: effectiveTransferRate(t, d)};
    `);
    if(s.state === 'loading' && s.docked > 1){
      const before = s.cargo;
      run(ctx, `simTick();`);
      const after = run(ctx, `return world.entities.get(${ids.trainId}).cargoAmount;`);
      dockedCellCount = s.docked;
      baseRate = s.rate;
      perTickGain = after - before;
      break;
    }
  }
  check('the train ends up docked with more than 1 of its own cells alongside the platform', dockedCellCount !== null && dockedCellCount > 1,
    `dockedCellCount=${dockedCellCount}`);
  check('one tick of loading transfers dockedCellCount * effectiveTransferRate, not a flat rate',
    perTickGain !== null && Math.abs(perTickGain - dockedCellCount * baseRate) < 1e-9,
    `perTickGain=${perTickGain} dockedCellCount=${dockedCellCount} baseRate=${baseRate}`);
  check('the multi-cell rate is genuinely faster than the single-cell base rate would have been',
    perTickGain !== null && perTickGain > baseRate, `perTickGain=${perTickGain} baseRate=${baseRate}`);
});

section('Test 4 — a docked train stays put on re-evaluation instead of shuttling across the platform', () => {
  // Regression for a real bug found while building this feature:
  // resolveTrainDock originally re-derived "whichever platform endpoint is
  // farther from the train's CURRENT position" on every idle/blocked tick,
  // which made an already-docked train (re-evaluating the same repeating
  // order right after finishing a load) treat the end it just arrived FROM
  // as newly "farther," sending it back across the whole platform forever
  // instead of just staying docked.
  const ctx = newGameContext();
  const ids = run(ctx, `
    cmdBuildBuilding('mine', 0, 0, 'large');
    for(let y=0; y<=3; y++) cmdBuildTrack(4, y, 'rail', true);
    cmdBuildBuilding('depot', 2, 0, 'large', 'ns', 'ore');
    cmdBuildTrack(4, 4, 'rail', true);
    cmdBuildBuilding('trainyard', 4, 5, 'small');

    cmdAssembleTrain(4, 4, 'diesel', 'ore_wagon', 1);
    const train = [...world.entities.values()].find(e=>e.kind==='vehicle' && isTrain(e.id));
    const depot = [...world.entities.values()].find(e=>e.type==='depot');
    const mine = [...world.entities.values()].find(e=>e.type==='mine');
    mine.outCap = 100000; mine.outStock = 100000;
    cmdSetOrders(train, [{nodeId: depot.id, action:'load_full', resource:'ore'}]); // single repeating stop
    return {trainId: train.id};
  `);

  // Run well past the point the train first reaches capacity (and so
  // starts re-evaluating the same order over and over) — it must settle
  // onto a stable platform cell, not keep re-entering 'moving' forever.
  let settledStateStreak = 0, sawMovingAfterFull = false, everFull = false;
  for(let i=0;i<500;i++){
    run(ctx, `simTick();`);
    const s = run(ctx, `const t = world.entities.get(${ids.trainId}); return {state:t.state, full: t.cargoAmount >= t.capacity};`);
    if(s.full){
      everFull = true;
      if(s.state === 'moving') sawMovingAfterFull = true;
      settledStateStreak = (s.state === 'loading' || s.state === 'idle') ? settledStateStreak + 1 : 0;
    }
  }
  check('the train actually reached capacity at some point (precondition for this test)', everFull);
  check('a full, already-docked train never re-enters "moving" just from re-evaluating its own repeating order',
    !sawMovingAfterFull);
  check('the train settles into a stable idle/loading state, not oscillating', settledStateStreak > 50, `streak=${settledStateStreak}`);
});

section('Test 5 — effective transfer rate is the bottleneck: min(vehicle, Station/Depot)', () => {
  // Truck <-> Station: a slow truck through a fast Station is capped by the
  // truck; a fast truck through a slow Station is capped by the Station.
  function truckRate(truckTransferRate, stationTransferRate){
    const ctx = newGameContext();
    return run(ctx, `
      VEHICLE_DEFS.bulk.transferRate = ${truckTransferRate};
      BUILDING_DEFS.station.transferRate = ${stationTransferRate};
      cmdBuildBuilding('mine', 0, 0, 'large');
      cmdBuildBuilding('station', 2, 1, 'small', 'S', 'ore');
      cmdBuildRoad(2, 2, 'ground', true);
      cmdPurchaseVehicle(2, 2, 'bulk');
      const truck = [...world.entities.values()].find(e=>e.kind==='vehicle');
      const station = [...world.entities.values()].find(e=>e.type==='station');
      return effectiveTransferRate(truck, station);
    `);
  }
  check('a slow truck through a fast Station is capped by the truck', truckRate(2, 10) === 2);
  check('a fast truck through a slow Station is capped by the Station', truckRate(10, 2) === 2);
  check('equal rates pass through unchanged', truckRate(5, 5) === 5);

  // A Depot that omits transferRate entirely falls back to DEFAULT_TRANSFER_RATE.
  const fallback = run(newGameContext(), `
    delete BUILDING_DEFS.depot.transferRate;
    for(let y=0;y<=3;y++) cmdBuildTrack(4,y,'rail',true);
    cmdBuildBuilding('depot', 2, 0, 'large', 'ns', 'ore');
    const depot = [...world.entities.values()].find(e=>e.type==='depot');
    const train = createTrain(4, 0, 'diesel', 'ore_wagon', 1);
    return {rate: effectiveTransferRate(train, depot), defaultRate: DEFAULT_TRANSFER_RATE, trainOwnRate: train.transferRate};
  `);
  check('a Depot with no transferRate field falls back to DEFAULT_TRANSFER_RATE',
    fallback.rate === Math.min(fallback.trainOwnRate, fallback.defaultRate), JSON.stringify(fallback));
});

console.log(failures===0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
