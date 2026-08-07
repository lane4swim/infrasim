// Regression tests for terrain elevation (§ Terrain elevation) — a z
// coordinate per cell (cell.elevation), with ground/elevated/underground
// all following it (elevated always one level above local ground,
// underground one below) and two new FLAT global grades, deepUnderground
// and airspace, that ignore terrain entirely and are reached only via a
// same-cell vertical ramp (RAMP_PAIRS: groundElevated, elevatedAirspace,
// undergroundDeep). Adjacent ground/elevated/underground tiles can only
// connect if their terrain differs by at most MAX_ELEVATION_DELTA. Run
// against the real index.html code via test/harness.js.
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

section('Test 1 — raising/lowering terrain: cost, bounds, and requiring a clear cell', () => {
  const ctx = newGameContext();
  const raised = run(ctx, `
    const before = world.treasury;
    cmdRaiseTerrain(5, 5);
    return {elevation: getCell(5,5).elevation, spent: before - world.treasury};
  `);
  check('raising once sets elevation to 1', raised.elevation === 1, JSON.stringify(raised));
  check('raising charges TERRAFORM_COST', raised.spent === run(newGameContext(), 'return TERRAFORM_COST;'), JSON.stringify(raised));

  const lowered = run(ctx, `
    cmdLowerTerrain(5, 5);
    cmdLowerTerrain(5, 5);
    return {elevation: getCell(5,5).elevation};
  `);
  check('lowering twice from 1 nets -1', lowered.elevation === -1, JSON.stringify(lowered));

  const bounds = run(newGameContext(), `
    for(let i=0;i<20;i++) cmdRaiseTerrain(6,6); // push well past ELEVATION_MAX
    return {elevation: getCell(6,6).elevation, max: ELEVATION_MAX, warnLogs: pendingLogs.filter(l=>l.cls==='warn')};
  `);
  check('elevation never exceeds ELEVATION_MAX', bounds.elevation === bounds.max, JSON.stringify(bounds));
  check('over-raising warns', bounds.warnLogs.length > 0);

  const blockedByTrack = run(newGameContext(), `
    cmdBuildRoad(7,7,'ground',true);
    cmdRaiseTerrain(7,7);
    return {elevation: getCell(7,7).elevation, warnLogs: pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg)};
  `);
  check('terraforming a cell with track is rejected', blockedByTrack.elevation === 0, JSON.stringify(blockedByTrack));
  check('rejection mentions clearing track', blockedByTrack.warnLogs.some(m=>/track/i.test(m)), JSON.stringify(blockedByTrack.warnLogs));

  const blockedByBuilding = run(newGameContext(), `
    cmdBuildBuilding('mine', 8, 8, 'small');
    cmdRaiseTerrain(8,8);
    return {elevation: getCell(8,8).elevation, warnLogs: pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg)};
  `);
  check('terraforming a cell with a building is rejected', blockedByBuilding.elevation === 0, JSON.stringify(blockedByBuilding));
  check('rejection mentions clearing the building', blockedByBuilding.warnLogs.some(m=>/building/i.test(m)), JSON.stringify(blockedByBuilding.warnLogs));
});

section('Test 2 — elevationAt: elevated/underground follow local terrain, deepUnderground/airspace are flat', () => {
  const out = run(newGameContext(), `
    cmdRaiseTerrain(4,4);
    cmdRaiseTerrain(4,4);
    return {
      ground: elevationAt(4,4,'ground'),
      elevated: elevationAt(4,4,'elevated'),
      underground: elevationAt(4,4,'underground'),
      deep: elevationAt(4,4,'deepUnderground'),
      sky: elevationAt(4,4,'airspace'),
      deepElsewhere: elevationAt(19,13,'deepUnderground'),
      skyElsewhere: elevationAt(19,13,'airspace'),
    };
  `);
  check('ground reads back raised elevation', out.ground === 2, JSON.stringify(out));
  check('elevated is exactly one level above local ground', out.elevated === 3, JSON.stringify(out));
  check('underground is exactly one level below local ground', out.underground === 1, JSON.stringify(out));
  check('deepUnderground is far below any regular depth', out.deep < -100, JSON.stringify(out));
  check('airspace is far above any regular height', out.sky > 100, JSON.stringify(out));
  check('deepUnderground is the same flat value everywhere, terrain or not', out.deep === out.deepElsewhere, JSON.stringify(out));
  check('airspace is the same flat value everywhere, terrain or not', out.sky === out.skyElsewhere, JSON.stringify(out));
});

section('Test 3 — capped auto-connect: adjacent ground tiles only join within MAX_ELEVATION_DELTA', () => {
  const tooSteep = run(newGameContext(), `
    cmdRaiseTerrain(3,3);
    cmdRaiseTerrain(3,3); // (3,3) at elevation 2, (4,3) stays at 0 — delta 2
    cmdBuildRoad(3,3,'ground',true);
    cmdBuildRoad(4,3,'ground',true);
    return {connected: trackAt(3,3,'ground').edges.E};
  `);
  check('auto-connect refuses a delta-2 climb', tooSteep.connected === false, JSON.stringify(tooSteep));

  const manualTooSteep = run(newGameContext(), `
    cmdRaiseTerrain(3,3);
    cmdRaiseTerrain(3,3);
    cmdBuildRoad(3,3,'ground',false);
    cmdBuildRoad(4,3,'ground',false);
    cmdToggleConnection(3,3,4,3,'ground');
    return {connected: trackAt(3,3,'ground').edges.E, warnLogs: pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg)};
  `);
  check('manual Connect also refuses a delta-2 climb', manualTooSteep.connected === false, JSON.stringify(manualTooSteep));
  check('rejection message mentions the steepness', manualTooSteep.warnLogs.some(m=>/steep|elevation/i.test(m)), JSON.stringify(manualTooSteep.warnLogs));

  const exactlyOne = run(newGameContext(), `
    cmdRaiseTerrain(3,3); // delta 1 — right at MAX_ELEVATION_DELTA
    cmdBuildRoad(3,3,'ground',true);
    cmdBuildRoad(4,3,'ground',true);
    return {connected: trackAt(3,3,'ground').edges.E};
  `);
  check('a delta-1 climb is allowed', exactlyOne.connected === true, JSON.stringify(exactlyOne));

  const flatTerrain = run(newGameContext(), `
    cmdBuildRoad(3,3,'ground',true);
    cmdBuildRoad(4,3,'ground',true);
    return {connected: trackAt(3,3,'ground').edges.E};
  `);
  check('flat terrain (delta 0) still connects exactly as before this feature', flatTerrain.connected === true);

  const flatGradesUnaffected = run(newGameContext(), `
    cmdRaiseTerrain(3,3);
    cmdRaiseTerrain(3,3); // (3,3) elevation 2, (4,3) elevation 0 — would block ground/elevated/underground
    cmdBuildRoad(3,3,'airspace',true);
    cmdBuildRoad(4,3,'airspace',true);
    return {connected: trackAt(3,3,'airspace').edges.E};
  `);
  check('airspace (a flat global plane) connects regardless of the terrain underneath it', flatGradesUnaffected.connected === true, JSON.stringify(flatGradesUnaffected));
});

section('Test 4 — Airspace Ramp and Deep Ramp: adjacency-free same-cell build validation', () => {
  const missingAirspace = run(newGameContext(), `
    cmdBuildRoad(2,2,'elevated',true); // only the elevated side, no airspace tile yet
    cmdBuildAirspaceRamp(2,2);
    return {built: getCell(2,2).ramps.road.elevatedAirspace, warnLogs: pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg)};
  `);
  check('Airspace Ramp rejected without both tiles present', !missingAirspace.built, JSON.stringify(missingAirspace));
  check('rejection names both grades', missingAirspace.warnLogs.some(m=>/elevated.*airspace/i.test(m)), JSON.stringify(missingAirspace.warnLogs));

  const validAirspace = run(newGameContext(), `
    cmdBuildRoad(2,2,'elevated',true);
    cmdBuildRoad(2,2,'airspace',true);
    const before = world.treasury;
    cmdBuildAirspaceRamp(2,2);
    return {
      spent: before - world.treasury,
      built: getCell(2,2).ramps.road.elevatedAirspace,
      warnLogs: pendingLogs.filter(l=>l.cls==='warn'),
    };
  `);
  check('a valid Airspace Ramp charges AIRSPACE_RAMP_COST', validAirspace.spent === run(newGameContext(),'return AIRSPACE_RAMP_COST;'), JSON.stringify(validAirspace));
  check('sets the elevatedAirspace ramp flag', validAirspace.built === true);
  check('no warnings on a valid build', validAirspace.warnLogs.length === 0, JSON.stringify(validAirspace.warnLogs));

  const duplicateAirspace = run(newGameContext(), `
    cmdBuildRoad(2,2,'elevated',true);
    cmdBuildRoad(2,2,'airspace',true);
    cmdBuildAirspaceRamp(2,2);
    cmdBuildAirspaceRamp(2,2);
    return pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg);
  `);
  check('a second Airspace Ramp at the same cell is rejected as a duplicate', duplicateAirspace.some(m=>/already/i.test(m)), JSON.stringify(duplicateAirspace));

  const validDeep = run(newGameContext(), `
    cmdBuildRoad(2,2,'underground',true);
    cmdBuildRoad(2,2,'deepUnderground',true);
    const before = world.treasury;
    cmdBuildDeepRamp(2,2);
    return {
      spent: before - world.treasury,
      built: getCell(2,2).ramps.road.undergroundDeep,
    };
  `);
  check('a valid Deep Ramp charges DEEP_RAMP_COST', validDeep.spent === run(newGameContext(),'return DEEP_RAMP_COST;'), JSON.stringify(validDeep));
  check('sets the undergroundDeep ramp flag', validDeep.built === true);

  const railSmoke = run(newGameContext(), `
    cmdBuildTrack(2,2,'railElevated',true);
    cmdBuildTrack(2,2,'railAirspace',true);
    cmdBuildRailAirspaceRamp(2,2);
    cmdBuildTrack(2,3,'railUnderground',true);
    cmdBuildTrack(2,3,'railDeepUnderground',true);
    cmdBuildRailDeepRamp(2,3);
    return {
      airspaceRamp: getCell(2,2).ramps.rail.elevatedAirspace,
      deepRamp: getCell(2,3).ramps.rail.undergroundDeep,
      roadRampsUntouched: getCell(2,2).ramps.road.elevatedAirspace === false,
    };
  `);
  check('rail Airspace Ramp works independently of the road one', railSmoke.airspaceRamp === true, JSON.stringify(railSmoke));
  check('rail Deep Ramp works independently of the road one', railSmoke.deepRamp === true, JSON.stringify(railSmoke));
  check('the rail ramps never set the road ramps at the same cell', railSmoke.roadRampsUntouched, JSON.stringify(railSmoke));
});

section('Test 5 — pathfinding crosses every RAMP_PAIRS transition, including two independent pairs at one cell', () => {
  const throughAirspace = run(newGameContext(), `
    cmdBuildRoad(5,5,'ground',true);
    cmdBuildRoad(5,5,'elevated',true);
    cmdBuildRamp(5,5);
    cmdBuildRoad(5,5,'airspace',true);
    cmdBuildAirspaceRamp(5,5);
    const path = findRoadPath({x:5,y:5,layer:'ground'}, {x:5,y:5,layer:'airspace'});
    return {path: path && path.map(n=>n.layer)};
  `);
  check('a path exists ground -> elevated -> airspace, all at one cell, via two independent ramps', throughAirspace.path && throughAirspace.path.length===3 && throughAirspace.path.join()==='ground,elevated,airspace', JSON.stringify(throughAirspace));

  const throughDeep = run(newGameContext(), `
    cmdBuildRoad(6,6,'ground',true);
    cmdBuildRoad(6,7,'underground',true);
    cmdBuildUndergroundRamp(6,6,6,7); // lateral, unaffected by RAMP_PAIRS generalization
    cmdBuildRoad(6,7,'deepUnderground',true);
    cmdBuildDeepRamp(6,7);
    const path = findRoadPath({x:6,y:6,layer:'ground'}, {x:6,y:7,layer:'deepUnderground'});
    return {path: path && path.map(n=>n.layer+':'+n.x+','+n.y)};
  `);
  check('a path exists ground -> (lateral tunnel ramp) -> underground -> (deep ramp) -> deepUnderground', throughDeep.path !== null, JSON.stringify(throughDeep));
  check('it actually visits all four layer states in order', throughDeep.path && throughDeep.path.map(n=>n.split(':')[0]).join()==='ground,underground,deepUnderground', JSON.stringify(throughDeep.path));

  const noDirectSkip = run(newGameContext(), `
    cmdBuildRoad(7,7,'ground',true);
    cmdBuildRoad(7,7,'airspace',true);
    // no elevated tile at all — ground<->airspace is two ramps apart, never one
    return findRoadPath({x:7,y:7,layer:'ground'}, {x:7,y:7,layer:'airspace'});
  `);
  check('no direct ground<->airspace path skipping elevated', noDirectSkip === null);
});

section('Test 6 — rail blocks: vertical ramp pairs are hubs; all five layers get computed', () => {
  const hubCheck = run(newGameContext(), `
    cmdBuildTrack(5,0,'rail',true);
    cmdBuildTrack(5,1,'rail',true);
    cmdBuildTrack(5,1,'railElevated',true);
    cmdBuildRailRamp(5,1);
    cmdBuildTrack(5,1,'railAirspace',true);
    cmdBuildRailAirspaceRamp(5,1);
    return {
      groundBlock: trackAt(5,0,'rail').blockId.S,
      elevatedHasOwnEdges: trackAt(5,1,'railElevated').blockId,
    };
  `);
  check('the ground-side edge into the ramp cell gets a real block id', hubCheck.groundBlock !== null, JSON.stringify(hubCheck));

  const distinctBlocks = run(newGameContext(), `
    cmdBuildTrack(4,0,'railUnderground',true);
    cmdBuildTrack(4,1,'railUnderground',true);
    cmdBuildTrack(4,1,'railDeepUnderground',true);
    cmdBuildTrack(4,2,'railDeepUnderground',true);
    cmdBuildRailDeepRamp(4,1);
    return {
      undergroundBlock: trackAt(4,0,'railUnderground').blockId.S,
      deepBlock: trackAt(4,2,'railDeepUnderground').blockId.N,
    };
  `);
  check('the underground-side and deepUnderground-side edges get DISTINCT block ids (the ramp is a hub on both)',
    distinctBlocks.undergroundBlock !== null && distinctBlocks.deepBlock !== null && distinctBlocks.undergroundBlock !== distinctBlocks.deepBlock,
    JSON.stringify(distinctBlocks));
});

section('Test 7 — demolishing a grade clears every ramp pair that touches it, and only those', () => {
  const ctx = newGameContext();
  const setup = run(ctx, `
    cmdBuildRoad(2,2,'ground',true);
    cmdBuildRoad(2,2,'elevated',true);
    cmdBuildRamp(2,2);                 // groundElevated — touches 'elevated'
    cmdBuildRoad(2,2,'airspace',true);
    cmdBuildAirspaceRamp(2,2);         // elevatedAirspace — also touches 'elevated'
    cmdBuildRoad(9,9,'ground',true);
    cmdBuildRoad(9,9,'elevated',true);
    cmdBuildRamp(9,9);                 // unrelated control cell, untouched by anything below
    return {
      groundElevated: getCell(2,2).ramps.road.groundElevated,
      elevatedAirspace: getCell(2,2).ramps.road.elevatedAirspace,
      controlRamp: getCell(9,9).ramps.road.groundElevated,
    };
  `);
  check('both ramps exist as precondition', setup.groundElevated && setup.elevatedAirspace && setup.controlRamp, JSON.stringify(setup));

  const afterDemolish = run(ctx, `
    cmdDemolish(2,2,'elevated');
    return {
      groundElevated: getCell(2,2).ramps.road.groundElevated,
      elevatedAirspace: getCell(2,2).ramps.road.elevatedAirspace,
      controlRampUntouched: getCell(9,9).ramps.road.groundElevated,
    };
  `);
  check('demolishing elevated clears the groundElevated ramp (elevated is its hi)', afterDemolish.groundElevated === false, JSON.stringify(afterDemolish));
  check('demolishing elevated ALSO clears the elevatedAirspace ramp (elevated is its lo)', afterDemolish.elevatedAirspace === false, JSON.stringify(afterDemolish));
  check('an unrelated cell\'s ramp is untouched', afterDemolish.controlRampUntouched === true, JSON.stringify(afterDemolish));
});

section('Test 8 — a real truck delivers cargo across ground -> elevated -> airspace -> elevated -> ground', () => {
  const ctx = newGameContext();
  const ids = run(ctx, `
    cmdBuildBuilding('mine', 0, 0, 'large');
    cmdBuildBuilding('station', 2, 1, 'small', 'S', 'ore'); // touches mine west, road dock south
    cmdBuildRoad(2, 2, 'ground', true);
    cmdBuildRoad(2, 3, 'ground', true);
    cmdBuildRoad(2, 4, 'ground', true);
    cmdBuildRoad(2, 4, 'elevated', true);
    cmdBuildRamp(2, 4);
    cmdBuildRoad(2, 5, 'elevated', true);
    cmdBuildRoad(2, 6, 'elevated', true);
    cmdBuildRoad(2, 6, 'airspace', true);
    cmdBuildAirspaceRamp(2, 6);
    cmdBuildRoad(2, 7, 'airspace', true);
    cmdBuildRoad(2, 8, 'airspace', true);
    cmdBuildRoad(2, 8, 'elevated', true);
    cmdBuildAirspaceRamp(2, 8);
    cmdBuildRoad(2, 9, 'elevated', true);
    cmdBuildRoad(2, 10, 'elevated', true);
    cmdBuildRoad(2, 10, 'ground', true);
    cmdBuildRamp(2, 10);
    cmdBuildRoad(2, 11, 'ground', true);
    cmdBuildRoad(2, 12, 'ground', true);
    cmdBuildBuilding('town', 4, 12, 'large', null, 'ore');
    cmdBuildBuilding('station', 3, 12, 'small', 'W', 'ore'); // dock west at (2,12), touches town east
    cmdPurchaseVehicle(2, 3, 'bulk');
    const stationA = [...world.entities.values()].find(e=>e.type==='station' && e.y===1);
    const stationB = [...world.entities.values()].find(e=>e.type==='station' && e.y===12);
    const truck = [...world.entities.values()].find(e=>e.kind==='vehicle');
    cmdSetOrders(truck, [
      {nodeId: stationA.id, action:'load_full', resource:'ore'},
      {nodeId: stationB.id, action:'unload_all', resource:'ore'},
    ]);
    return {truckId: truck.id, townId: [...world.entities.values()].find(e=>e.type==='town').id, warnLogs: pendingLogs.filter(l=>l.cls==='warn')};
  `);
  check('the whole layout built with no warnings', ids.warnLogs.length === 0, JSON.stringify(ids.warnLogs));

  let sawElevated = false, sawAirspace = false, sawGroundAgain = false, delivered = false;
  for(let i=0;i<6000;i++){
    run(ctx, 'simTick();');
    const t = run(ctx, `
      const v = world.entities.get(${ids.truckId});
      const town = world.entities.get(${ids.townId});
      return {layer:v.layer, townStock: town.inStock};
    `);
    if(t.layer==='elevated') sawElevated = true;
    if(t.layer==='airspace') sawAirspace = true;
    if(sawAirspace && t.layer==='ground') sawGroundAgain = true;
    if(t.townStock > 0) delivered = true;
  }
  check('the truck climbed onto elevated road', sawElevated);
  check('the truck actually reached airspace', sawAirspace);
  check('the truck came back down to ground on the far side', sawGroundAgain);
  check('ore was delivered to the Town, having crossed airspace in between', delivered);
});

console.log(failures===0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
