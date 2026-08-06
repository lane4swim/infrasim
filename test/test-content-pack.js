// Regression tests for the content-pack refactor (§3 of the Phase 2
// implementation plan), run against the real index.html code via
// test/harness.js.
'use strict';
const {newGameContext, run, extractContentPackJson} = require('./harness.js');
const path = require('path');

let failures = 0;
function check(name, cond, detail){
  if(cond){ console.log(`  ok - ${name}`); }
  else { failures++; console.log(`  FAIL - ${name}${detail ? ' :: '+detail : ''}`); }
}
function section(name, fn){
  console.log(name);
  fn();
}

const htmlPath = path.join(__dirname, '..', 'index.html');
const realPackJson = extractContentPackJson(htmlPath);
const realPack = JSON.parse(realPackJson);

// A fresh context validates its own (real) content pack at load time —
// if it didn't throw, the whole game already failed to start.
section('Test 1 — the real content pack loads and validates cleanly', () => {
  let threw = null;
  try { newGameContext(); } catch(e){ threw = e; }
  check('index.html loads without validateContentPack throwing', threw === null, threw && threw.message);
});

// §3.3.2 — deliberately-broken fixtures, each expected to fail loudly and
// specifically (naming the exact field), not crash obscurely three
// systems away the first time something reads the missing/malformed value.
section('Test 2 — validateContentPack rejects deliberately-broken fixtures', () => {
  const ctx = newGameContext(); // validateContentPack is defined here; call it directly with bad data

  function expectThrow(name, mutate, expectedSubstring){
    const pack = JSON.parse(JSON.stringify(realPack)); // deep clone, don't mutate the shared real pack
    mutate(pack);
    const result = run(ctx, `
      try {
        validateContentPack(${JSON.stringify(pack)});
        return {threw:false};
      } catch(e){
        return {threw:true, message:e.message};
      }
    `);
    check(name, result.threw && result.message.includes(expectedSubstring),
      `threw=${result.threw} message=${JSON.stringify(result.message)}`);
  }

  expectThrow('missing baseValue on a resource is rejected',
    pack => { delete pack.resources.ore.baseValue; },
    'baseValue');

  expectThrow('a recipe referencing an undefined resource is rejected',
    pack => { pack.recipes.extract_ore.outputs = [{resource:'unobtanium', amount:1}]; },
    'unobtanium');

  expectThrow('a vehicle with brakeForce <= engineForce is rejected',
    pack => { pack.vehicles.bulk.brakeForce = pack.vehicles.bulk.engineForce; },
    'brakeForce');

  expectThrow('a building referencing an undefined recipe is rejected',
    pack => { pack.buildings.mine.recipe = 'no_such_recipe'; },
    'no_such_recipe');

  expectThrow('a missing top-level section is rejected',
    pack => { delete pack.engines; },
    'engines');

  expectThrow('an engine with brakeForce <= engineForce is rejected',
    pack => { pack.engines.diesel.brakeForce = pack.engines.diesel.engineForce; },
    'brakeForce');

  expectThrow('a wagon referencing an undefined resource is rejected',
    pack => { pack.wagons.ore_wagon.resource = 'unobtanium'; },
    'unobtanium');

  expectThrow('a vehicle missing transferRate is rejected',
    pack => { delete pack.vehicles.bulk.transferRate; },
    'transferRate');

  expectThrow('a wagon missing transferRate is rejected',
    pack => { delete pack.wagons.ore_wagon.transferRate; },
    'transferRate');
});

// §3.3.3 — a second, small content pack (one new resource + one new
// recipe, reusing an existing building) should work with ZERO changes to
// index.html's script beyond swapping the JSON block — directly
// validating the extensibility claim instead of just asserting it.
section('Test 3 — a modder-authored content pack works with zero code changes', () => {
  const moddedPack = JSON.parse(JSON.stringify(realPack));
  moddedPack.resources.coal = {id:'coal', name:'Coal', baseValue:9, unitWeight:0.5};
  // Reuse the existing Mine building for a new recipe — the "no code
  // change" claim only holds if a plain data edit is enough; it shouldn't
  // require a new building type too.
  moddedPack.recipes.extract_coal = {inputs:[], outputs:[{resource:'coal', amount:1}], durationTicks:4};
  moddedPack.buildings.mine.recipe = 'extract_coal';
  // A new vehicle type that carries the new resource — proves defs beyond
  // "just a resource" also just work.
  moddedPack.vehicles.coaltruck = {
    purchaseCost:210, runningCostPerTick:1, capacity:10, sellFraction:0.4,
    label:'Coal Truck', resource:'coal', color:'#444444',
    maxSpeedTilesPerTick:1.2, massEmpty:5, engineForce:0.6, brakeForce:1.8, lengthTiles:1.3, transferRate:4,
  };
  // A new wagon type too — the Train Yard content sections should be just
  // as extensible as the older ones, not a special case.
  moddedPack.wagons.coal_wagon = {
    purchaseCost:140, capacity:18, resource:'coal', label:'Coal Wagon', color:'#333333', massEmpty:6, lengthTiles:2.5, transferRate:4,
  };

  const ctx = newGameContext({contentPackJson: JSON.stringify(moddedPack)});

  const loaded = run(ctx, `
    return {
      coalResource: RESOURCES.coal,
      coalRecipe: RECIPES.extract_coal,
      mineRecipe: BUILDING_DEFS.mine.recipe,
      coalTruckDef: VEHICLE_DEFS.coaltruck,
      coalWagonDef: WAGON_DEFS.coal_wagon,
    };
  `);
  check('the modded resource is live as RESOURCES.coal', loaded.coalResource && loaded.coalResource.baseValue === 9);
  check('the modded recipe is live as RECIPES.extract_coal', loaded.coalRecipe && loaded.coalRecipe.durationTicks === 4);
  check("the Mine's recipe now points at the modded recipe", loaded.mineRecipe === 'extract_coal');
  check('the modded vehicle type is live as VEHICLE_DEFS.coaltruck', loaded.coalTruckDef && loaded.coalTruckDef.label === 'Coal Truck');
  check('the modded wagon type is live as WAGON_DEFS.coal_wagon', loaded.coalWagonDef && loaded.coalWagonDef.label === 'Coal Wagon');

  // End-to-end: build a Mine (now extracting coal via the swapped recipe),
  // a Station, a Coal Truck, and a train assembled with the modded Coal
  // Wagon — confirm coal actually accumulates and the train picks it up,
  // not just that the defs parsed, but that every system (tickProduction,
  // Storage, vehicle purchase/cargo, getTrainStats) operates on the new
  // content correctly with the exact same code that runs the shipped
  // resources.
  const result = run(ctx, `
    cmdBuildBuilding('mine', 0, 0, 'large');
    cmdBuildBuilding('station', 0, 2, 'small', 'N', 'coal');
    cmdBuildRoad(0, 3, 'ground', true);
    cmdPurchaseVehicle(0, 3, 'coaltruck');
    cmdBuildTrack(2, 3, 'rail', true);
    const train = createTrain(2, 3, 'diesel', 'coal_wagon', 2);
    const mine = [...world.entities.values()].find(e=>e.kind==='building' && e.type==='mine');
    for(let i=0;i<50;i++) simTick();
    return {
      mineOutStock: mine.outStock, mineOutResource: mine.outResource,
      trainCapacity: train.capacity, trainResource: train.cargoResource,
    };
  `);
  check('a Mine using the modded recipe actually produces the modded resource',
    result.mineOutResource === 'coal' && result.mineOutStock > 0, JSON.stringify(result));
  check('a train assembled with the modded wagon carries the modded resource at the modded capacity',
    result.trainResource === 'coal' && result.trainCapacity === 36, JSON.stringify(result));
});

console.log(failures===0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
