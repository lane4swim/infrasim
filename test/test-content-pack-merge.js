// Regression tests for content-pack layering (§9 — "A ContentPack loader
// merges base-game data with any additional packs"). Until now that was
// aspirational: the shipped game read exactly one JSON block. Now index.html
// ships any number of application/json <script class="content-pack">
// blocks, merged by loader.js's mergeContentPacks in document order — this
// file proves the merge mechanism itself (union across packs, later-pack
// override, per-pack partial sections, cross-pack references, and merged-
// level validation) using synthetic packs, then proves the real shipped
// coal addon (content-pack-coal in index.html) is actually live and usable
// through the same command API every other content-pack test uses.
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
const realPack = JSON.parse(extractContentPackJson(htmlPath));

// A minimal, self-contained base pack (all 7 sections, one entry each) used
// as the foundation for every synthetic-merge check below — isolates these
// tests from the real shipped content, so they keep testing the merge
// mechanism itself even if the real base pack's data changes later.
const MINI_BASE = {
  version: '1',
  resources: { widget: { id:'widget', name:'Widget', baseValue:5, unitWeight:0.3 } },
  recipes: { make_widget: { inputs:[], outputs:[{resource:'widget', amount:1}], durationTicks:3 } },
  buildings: { factory: { buildCost:100, tiers:{small:{cap:20,add:0}, large:{cap:40,add:50}}, color:'#111111', label:'Factory', footprint:{w:2,h:2}, recipe:'make_widget' } },
  vehicles: { cart: { purchaseCost:100, runningCostPerTick:1, capacity:5, sellFraction:0.4, label:'Cart', resource:'widget', color:'#222222', maxSpeedTilesPerTick:1, massEmpty:3, engineForce:0.4, brakeForce:1, lengthTiles:1, transferRate:4 } },
  rail: { track: { costPerTile: 25 } },
  engines: { loco: { purchaseCost:500, runningCostPerTick:2, sellFraction:0.4, label:'Loco', color:'#333333', maxSpeedTilesPerTick:1.5, massEmpty:20, engineForce:2, brakeForce:4, lengthTiles:3 } },
  wagons: { hopper: { purchaseCost:100, capacity:10, resource:'widget', label:'Hopper', color:'#444444', massEmpty:5, lengthTiles:2, transferRate:4 } },
};

section('Test 1 — a second pack that only adds a new resource+recipe merges cleanly with the base pack', () => {
  const addon = {
    resources: { gizmo: { id:'gizmo', name:'Gizmo', baseValue:7, unitWeight:0.2 } },
    recipes: { make_gizmo: { inputs:[], outputs:[{resource:'gizmo', amount:1}], durationTicks:2 } },
  };
  const ctx = newGameContext({contentPacks: [JSON.stringify(MINI_BASE), JSON.stringify(addon)]});
  const loaded = run(ctx, `
    return {
      baseResourceStillThere: RESOURCES.widget,
      baseBuildingStillThere: BUILDING_DEFS.factory,
      addedResource: RESOURCES.gizmo,
      addedRecipe: RECIPES.make_gizmo,
    };
  `);
  check('the base pack\'s resource survives the merge unchanged', loaded.baseResourceStillThere && loaded.baseResourceStillThere.baseValue === 5);
  check('the base pack\'s building survives the merge unchanged', loaded.baseBuildingStillThere && loaded.baseBuildingStillThere.buildCost === 100);
  check('the addon-only resource is live', loaded.addedResource && loaded.addedResource.baseValue === 7);
  check('the addon-only recipe is live', loaded.addedRecipe && loaded.addedRecipe.durationTicks === 2);
});

section('Test 2 — a later pack reusing an earlier id overrides that entry entirely', () => {
  const override = {
    buildings: { factory: { buildCost:9999, tiers:{small:{cap:1,add:0}, large:{cap:1,add:0}}, color:'#ffffff', label:'Overridden Factory', footprint:{w:1,h:1}, recipe:'make_widget' } },
  };
  const ctx = newGameContext({contentPacks: [JSON.stringify(MINI_BASE), JSON.stringify(override)]});
  const loaded = run(ctx, `return { factory: BUILDING_DEFS.factory };`);
  check('the overriding pack\'s entry wins entirely (buildCost)', loaded.factory.buildCost === 9999, JSON.stringify(loaded.factory));
  check('the overriding pack\'s entry wins entirely (label)', loaded.factory.label === 'Overridden Factory');
  check('the overriding pack\'s entry wins entirely (footprint, not merged field-by-field)', loaded.factory.footprint.w === 1 && loaded.factory.footprint.h === 1);
});

section('Test 3 — an addon pack may omit sections entirely; only the MERGED result needs every section', () => {
  // MINI_BASE alone (one pack, all sections) should validate fine —
  // sanity precondition before testing that a second, section-sparse pack
  // doesn't break anything by omitting sections it has nothing to add to.
  let threw = null;
  try { newGameContext({contentPacks: [JSON.stringify(MINI_BASE)]}); } catch(e){ threw = e; }
  check('the base pack alone still validates (precondition)', threw === null, threw && threw.message);

  const sparseAddon = { resources: { dust: { id:'dust', name:'Dust', baseValue:1, unitWeight:0.1 } } }; // no recipes/buildings/vehicles/rail/engines/wagons at all
  let threw2 = null;
  let ctx2;
  try { ctx2 = newGameContext({contentPacks: [JSON.stringify(MINI_BASE), JSON.stringify(sparseAddon)]}); } catch(e){ threw2 = e; }
  check('a pack with only a resources section merges without error', threw2 === null, threw2 && threw2.message);
  const loaded = run(ctx2, `return { dust: RESOURCES.dust, engineStillThere: ENGINE_DEFS.loco };`);
  check('the sparse addon\'s resource is live', loaded.dust && loaded.dust.baseValue === 1);
  check('sections the sparse addon omitted still come from the base pack', loaded.engineStillThere && loaded.engineStillThere.purchaseCost === 500);
});

section('Test 4 — cross-pack references resolve, and validation runs against the MERGED pack', () => {
  const addonWithCrossRef = {
    recipes: { refine_widget: { inputs:[{resource:'widget', amount:2}], outputs:[{resource:'widget', amount:1}], durationTicks:1 } },
  };
  let threw = null;
  try { newGameContext({contentPacks: [JSON.stringify(MINI_BASE), JSON.stringify(addonWithCrossRef)]}); } catch(e){ threw = e; }
  check('an addon recipe referencing a resource defined in the BASE pack validates fine', threw === null, threw && threw.message);

  // The mirror-image failure: an addon pack referencing a resource that
  // doesn't exist ANYWHERE in the merged result should still be rejected,
  // by name, exactly like a single-pack validation failure always has been.
  const brokenAddon = {
    recipes: { broken: { inputs:[], outputs:[{resource:'unobtanium', amount:1}], durationTicks:1 } },
  };
  let threw2 = null;
  try { newGameContext({contentPacks: [JSON.stringify(MINI_BASE), JSON.stringify(brokenAddon)]}); } catch(e){ threw2 = e; }
  check('an addon recipe referencing an undefined resource is still rejected after merging', threw2 && threw2.message.includes('unobtanium'), threw2 && threw2.message);
});

// From here on: the REAL shipped coal addon (content-pack-coal in
// index.html), loaded exactly as the running game loads it — every
// content-pack block on the real page, merged, via a default
// newGameContext() with no override.
section('Test 5 — the real shipped coal addon pack is live alongside the unmodified base pack', () => {
  const ctx = newGameContext();
  const loaded = run(ctx, `
    return {
      coalResource: RESOURCES.coal,
      coalRecipe: RECIPES.mine_coal,
      collieryDef: BUILDING_DEFS.colliery,
      coalHaulerDef: VEHICLE_DEFS.coalhauler,
      coalHopperDef: WAGON_DEFS.coal_hopper,
      oreStillThere: RESOURCES.ore,
      mineStillThere: BUILDING_DEFS.mine,
    };
  `);
  check('the addon resource RESOURCES.coal is live', loaded.coalResource && loaded.coalResource.baseValue === 8);
  check('the addon recipe RECIPES.mine_coal is live', loaded.coalRecipe && loaded.coalRecipe.durationTicks === 5);
  check('the addon building BUILDING_DEFS.colliery is live', loaded.collieryDef && loaded.collieryDef.label === 'Colliery');
  check('the addon vehicle VEHICLE_DEFS.coalhauler is live', loaded.coalHaulerDef && loaded.coalHaulerDef.resource === 'coal');
  check('the addon wagon WAGON_DEFS.coal_hopper is live', loaded.coalHopperDef && loaded.coalHopperDef.resource === 'coal');
  check('the base pack\'s ore resource is unaffected by the addon', loaded.oreStillThere && loaded.oreStillThere.baseValue === 6);
  check('the base pack\'s Mine building is unaffected by the addon', loaded.mineStillThere && loaded.mineStillThere.buildCost === 150);
});

section('Test 6 — end to end: a Colliery produces coal, a purchased Coal Hauler is correctly typed, and a train assembles from Coal Hopper wagons', () => {
  const ctx = newGameContext();
  const result = run(ctx, `
    cmdBuildBuilding('colliery', 0, 0, 'large');
    cmdBuildBuilding('station', 0, 2, 'small', 'N', 'coal');
    cmdBuildRoad(0, 3, 'ground', true);
    cmdPurchaseVehicle(0, 3, 'coalhauler');
    cmdBuildTrack(2, 3, 'rail', true);
    const train = createTrain(2, 3, 'diesel', 'coal_hopper', 2);
    const colliery = [...world.entities.values()].find(e=>e.kind==='building' && e.type==='colliery');
    const hauler = [...world.entities.values()].find(e=>e.kind==='vehicle' && e.type==='coalhauler');
    for(let i=0;i<50;i++) simTick();
    return {
      collieryOutStock: colliery.outStock, collieryOutResource: colliery.outResource,
      haulerResource: hauler.cargoResource,
      trainCapacity: train.capacity, trainResource: train.cargoResource,
    };
  `);
  check('the Colliery (from the addon pack) actually produces coal',
    result.collieryOutResource === 'coal' && result.collieryOutStock > 0, JSON.stringify(result));
  check('the purchased Coal Hauler is typed to carry coal', result.haulerResource === 'coal');
  check('a train assembled with Coal Hopper wagons carries coal at the addon\'s capacity',
    result.trainResource === 'coal' && result.trainCapacity === 34, JSON.stringify(result));
});

console.log(failures===0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
