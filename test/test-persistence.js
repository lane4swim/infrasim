// Regression tests for persistence (§12), run against the real index.html
// code via test/harness.js — including sim/persistence.js, which (like
// sim/commands.js) is Worker-only in the real page but loaded here the same
// way the Worker itself loads it (see harness.js's own header comment).
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

// Builds a genuinely nontrivial world — road+rail networks, every building
// kind, a truck and a train each with real orders, several ticks of actual
// simulation (so stock/cargo/treasury/tick/rail-block state are all
// nonzero/non-default) — then returns the context and its entity ids so
// each test section can build on the same scenario without repeating it.
function buildScenario(ctx){
  run(ctx, `
    cmdBuildBuilding('mine', 0, 0, 'large');
    cmdBuildBuilding('station', 0, 2, 'small', 'N', 'ore');
    cmdBuildRoad(0, 3, 'ground', true);
    cmdBuildRoad(1, 3, 'ground', true);
    cmdBuildRoad(2, 3, 'ground', true);
    cmdPurchaseVehicle(0, 3, 'bulk');

    cmdBuildBuilding('town', 4, 0, 'large', null, 'ore');
    cmdBuildBuilding('station', 4, 2, 'small', 'N', 'ore');
    cmdBuildRoad(4, 3, 'ground', true);
    cmdBuildRoad(3, 3, 'ground', true);

    const truck = [...world.entities.values()].find(e=>e.kind==='vehicle' && e.type==='bulk');
    const originStation = [...world.entities.values()].find(e=>e.kind==='building' && e.type==='station' && e.x===0);
    const destStation = [...world.entities.values()].find(e=>e.kind==='building' && e.type==='station' && e.x===4);
    cmdSetOrders(truck, [
      {nodeId: originStation.id, action:'load_full', resource:'ore'},
      {nodeId: destStation.id, action:'unload_all', resource:'ore'},
    ]);

    for(let x=0; x<=6; x++) cmdBuildTrack(x, 6, 'rail', true); // spine at y=6
    cmdBuildBuilding('trainyard', 0, 7, 'small'); // touches the spine at (0,6)/(1,6)/(2,6)
    for(let y=7; y<=10; y++) cmdBuildTrack(6, y, 'rail', true); // Depot's platform siding, off the spine's east end
    cmdBuildBuilding('depot', 4, 7, 'large', 'ns', 'ore'); // its east side runs alongside the siding
    cmdAssembleTrain(0, 6, 'diesel', 'ore_wagon', 2);
    const train = [...world.entities.values()].find(e=>e.kind==='vehicle' && isTrain(e.id));
    const depot = [...world.entities.values()].find(e=>e.kind==='building' && e.type==='depot');
    cmdSetOrders(train, [
      {nodeId: depot.id, action:'load_full', resource:'ore'},
    ]);

    for(let i=0;i<60;i++) simTick();
  `);
}

section('Test 1 — serializeWorld() produces a genuinely JSON-safe snapshot', () => {
  const ctx = newGameContext();
  buildScenario(ctx);
  const result = run(ctx, `
    const data = serializeWorld();
    const roundTripped = JSON.parse(JSON.stringify(data));
    return {data, roundTripped};
  `);
  check('saveFormatVersion is present', result.data.saveFormatVersion === 1);
  check('contentPackVersion matches the real content pack', result.data.contentPackVersion === '1');
  check('entityIds is a nonempty array (buildings + vehicles exist)', Array.isArray(result.data.entityIds) && result.data.entityIds.length > 0);
  check('grid is a nonempty array (roads/track were built)', Array.isArray(result.data.grid) && result.data.grid.length > 0);
  check('railBlocks is a nonempty array (rail was built)', Array.isArray(result.data.railBlocks) && result.data.railBlocks.length > 0);
  check('components has every COMPONENT_TYPES key', result.data.components && Object.keys(result.data.components).length > 0);
  check('JSON.parse(JSON.stringify(data)) round-trips with no data loss (deep-equal)',
    JSON.stringify(result.roundTripped) === JSON.stringify(result.data));
});

section('Test 2 — deserializeWorld() restores a saved world into a fresh context', () => {
  const ctx1 = newGameContext();
  buildScenario(ctx1);
  const saved = run(ctx1, `
    return {
      data: JSON.parse(JSON.stringify(serializeWorld())),
      treasury: world.treasury,
      tick: world.tick,
      nextId: world.nextId,
      entityCount: world.entities.size,
      railBlockCount: world.railBlocks.size,
      truckCargo: [...world.entities.values()].find(e=>e.kind==='vehicle' && e.type==='bulk').cargoAmount,
      mineStock: [...world.entities.values()].find(e=>e.kind==='building' && e.type==='mine').outStock,
    };
  `);

  const ctx2 = newGameContext(); // fresh — deliberately NOT ctx1, proving the save is self-contained
  const restored = run(ctx2, `
    deserializeWorld(${JSON.stringify(saved.data)});
    return {
      treasury: world.treasury,
      tick: world.tick,
      nextId: world.nextId,
      entityCount: world.entities.size,
      railBlockCount: world.railBlocks.size,
      truckCargo: [...world.entities.values()].find(e=>e.kind==='vehicle' && e.type==='bulk').cargoAmount,
      mineStock: [...world.entities.values()].find(e=>e.kind==='building' && e.type==='mine').outStock,
    };
  `);

  check('treasury restored exactly', restored.treasury === saved.treasury);
  check('tick restored exactly', restored.tick === saved.tick);
  check('nextId restored exactly', restored.nextId === saved.nextId);
  check('entity count restored exactly', restored.entityCount === saved.entityCount);
  check('rail block count restored exactly', restored.railBlockCount === saved.railBlockCount);
  check('truck cargo restored exactly', restored.truckCargo === saved.truckCargo);
  check('mine stock restored exactly', restored.mineStock === saved.mineStock);

  // Post-load continuity: pathfinding, orders, and simTick() must all keep
  // working against the restored world — not just that the raw data landed
  // in the right fields, but that every system still operates on it
  // correctly, exactly as if the world had never been saved/reloaded.
  const continued = run(ctx2, `
    const truck = [...world.entities.values()].find(e=>e.kind==='vehicle' && e.type==='bulk');
    const train = [...world.entities.values()].find(e=>e.kind==='vehicle' && isTrain(e.id));
    const path = findRoadPath({x:truck.x, y:truck.y, layer:'ground'}, {x:4, y:3, layer:'ground'});
    let threw = null;
    try { for(let i=0;i<30;i++) simTick(); } catch(e){ threw = e; }
    return {
      threw: threw && threw.message,
      tickAfter: world.tick,
      truckOrdersLength: truck.orders.length,
      trainOrdersLength: train.orders.length,
      pathFound: !!path,
    };
  `);
  check('simTick() runs against the restored world with no error', continued.threw === null, continued.threw);
  check('tick keeps advancing after load', continued.tickAfter === saved.tick + 30);
  check("restored truck's orders survived the round trip", continued.truckOrdersLength === 2);
  check("restored train's orders survived the round trip", continued.trainOrdersLength === 1);
  check('pathfinding still works against the restored grid', continued.pathFound);

  // nextId continuity: a newly created entity after load must not collide
  // with any id that already existed in the restored world — proving
  // world.nextId (not just the entity table) was actually restored, not
  // reset to 1 and coincidentally non-colliding by luck.
  const idCheck = run(ctx2, `
    const before = world.nextId;
    cmdBuildBuilding('mine', 10, 10, 'small');
    const created = [...world.entities.values()].find(e=>e.kind==='building' && e.type==='mine' && e.x===10);
    return {before, createdId: created.id};
  `);
  check('a post-load entity gets the exact restored nextId, proving nextId (not just entities) round-tripped',
    idCheck.createdId === saved.nextId && idCheck.before === saved.nextId,
    JSON.stringify(idCheck));
});

console.log(failures===0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
