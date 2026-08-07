// Regression tests for terrain elevation (§ Terrain elevation) — a z
// coordinate per cell (cell.elevation), with ground/elevated/underground
// all following it (elevated always one level above local ground,
// underground one below) and two new FLAT global grades, deepUnderground
// and airspace, that ignore terrain entirely. Adjacent ground/elevated/
// underground tiles can only connect if their terrain differs by at most
// MAX_ELEVATION_DELTA. deepUnderground/airspace deliberately have NO ramp
// linking them to the rest of the network — RAMP_PAIRS has only the
// original groundElevated entry — since they're reserved for future
// non-road/rail modes (planes, mines) that will need their own access
// mechanism, not a truck/train ramp. Run against the real index.html code
// via test/harness.js.
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

section('Test 4 — deepUnderground/airspace have no ramp mechanism (RAMP_PAIRS has only groundElevated)', () => {
  const pairs = run(newGameContext(), `return RAMP_PAIRS.map(p=>p.key);`);
  check('RAMP_PAIRS contains only the original ground<->elevated pair', pairs.length===1 && pairs[0]==='groundElevated', JSON.stringify(pairs));

  const noRampCommands = run(newGameContext(), `
    return {
      airspaceRamp: typeof cmdBuildAirspaceRamp,
      railAirspaceRamp: typeof cmdBuildRailAirspaceRamp,
      deepRamp: typeof cmdBuildDeepRamp,
      railDeepRamp: typeof cmdBuildRailDeepRamp,
    };
  `);
  check('cmdBuildAirspaceRamp no longer exists', noRampCommands.airspaceRamp === 'undefined', JSON.stringify(noRampCommands));
  check('cmdBuildRailAirspaceRamp no longer exists', noRampCommands.railAirspaceRamp === 'undefined', JSON.stringify(noRampCommands));
  check('cmdBuildDeepRamp no longer exists', noRampCommands.deepRamp === 'undefined', JSON.stringify(noRampCommands));
  check('cmdBuildRailDeepRamp no longer exists', noRampCommands.railDeepRamp === 'undefined', JSON.stringify(noRampCommands));

  const rampShape = run(newGameContext(), `
    cmdBuildRoad(2,2,'ground',true);
    cmdBuildRoad(2,2,'elevated',true);
    cmdBuildRamp(2,2);
    return getCell(2,2).ramps.road;
  `);
  check('a cell\'s ramp state only ever has the groundElevated key', Object.keys(rampShape).length===1 && rampShape.groundElevated===true, JSON.stringify(rampShape));

  const stillBuildableButOrphaned = run(newGameContext(), `
    cmdBuildRoad(9,9,'elevated',true);
    cmdBuildRoad(9,9,'airspace',true);
    return {elevatedTrack: trackAt(9,9,'elevated').track, airspaceTrack: trackAt(9,9,'airspace').track, warnLogs: pendingLogs.filter(l=>l.cls==='warn')};
  `);
  check('road/track can still be laid on airspace directly (reserved for a future mode, not removed)', stillBuildableButOrphaned.airspaceTrack === true, JSON.stringify(stillBuildableButOrphaned));
  check('no warnings just from building on the reserved layer', stillBuildableButOrphaned.warnLogs.length === 0, JSON.stringify(stillBuildableButOrphaned.warnLogs));
});

section('Test 5 — pathfinding: the existing Ramp still crosses ground<->elevated; airspace/deepUnderground are unreachable', () => {
  const throughRamp = run(newGameContext(), `
    cmdBuildRoad(5,5,'ground',true);
    cmdBuildRoad(5,5,'elevated',true);
    cmdBuildRamp(5,5);
    const path = findRoadPath({x:5,y:5,layer:'ground'}, {x:5,y:5,layer:'elevated'});
    return {path: path && path.map(n=>n.layer)};
  `);
  check('a path still exists ground -> elevated via the original Ramp', throughRamp.path && throughRamp.path.join()==='ground,elevated', JSON.stringify(throughRamp));

  const airspaceUnreachable = run(newGameContext(), `
    cmdBuildRoad(5,5,'ground',true);
    cmdBuildRoad(5,5,'elevated',true);
    cmdBuildRamp(5,5);
    cmdBuildRoad(5,5,'airspace',true); // track exists, but nothing links it in
    return findRoadPath({x:5,y:5,layer:'ground'}, {x:5,y:5,layer:'airspace'});
  `);
  check('no path exists from ground/elevated to airspace at all, even at the same cell', airspaceUnreachable === null, JSON.stringify(airspaceUnreachable));

  const deepUnreachable = run(newGameContext(), `
    cmdBuildRoad(6,6,'ground',true);
    cmdBuildRoad(6,7,'underground',true);
    cmdBuildUndergroundRamp(6,6,6,7); // the lateral Tunnel Ramp still works, unaffected
    cmdBuildRoad(6,7,'deepUnderground',true); // track exists, but nothing links it in
    return findRoadPath({x:6,y:6,layer:'ground'}, {x:6,y:7,layer:'deepUnderground'});
  `);
  check('no path exists from ground/underground to deepUnderground at all, even via the Tunnel Ramp', deepUnreachable === null, JSON.stringify(deepUnreachable));
});

section('Test 6 — rail blocks: the ground<->elevated Rail Ramp is still a hub; the two reserved layers still compute without a ramp', () => {
  const hubCheck = run(newGameContext(), `
    cmdBuildTrack(5,0,'rail',true);
    cmdBuildTrack(5,1,'rail',true);
    cmdBuildTrack(5,1,'railElevated',true);
    cmdBuildRailRamp(5,1);
    return {groundBlock: trackAt(5,0,'rail').blockId.S};
  `);
  check('the ground-side edge into the ramp cell still gets a real block id', hubCheck.groundBlock !== null, JSON.stringify(hubCheck));

  const reservedLayersStillCompute = run(newGameContext(), `
    cmdBuildTrack(4,0,'railDeepUnderground',true);
    cmdBuildTrack(4,1,'railDeepUnderground',true);
    cmdBuildTrack(6,0,'railAirspace',true);
    cmdBuildTrack(6,1,'railAirspace',true);
    return {
      deepEdge: trackAt(4,0,'railDeepUnderground').blockId.S,
      airspaceEdge: trackAt(6,0,'railAirspace').blockId.S,
    };
  `);
  check('railDeepUnderground track still gets a block id with no ramp available', reservedLayersStillCompute.deepEdge !== null, JSON.stringify(reservedLayersStillCompute));
  check('railAirspace track still gets a block id with no ramp available', reservedLayersStillCompute.airspaceEdge !== null, JSON.stringify(reservedLayersStillCompute));
});

section('Test 7 — demolishing elevated still clears the groundElevated ramp, and only at that cell', () => {
  const ctx = newGameContext();
  const setup = run(ctx, `
    cmdBuildRoad(2,2,'ground',true);
    cmdBuildRoad(2,2,'elevated',true);
    cmdBuildRamp(2,2);
    cmdBuildRoad(9,9,'ground',true);
    cmdBuildRoad(9,9,'elevated',true);
    cmdBuildRamp(9,9); // unrelated control cell
    return {
      ramp: getCell(2,2).ramps.road.groundElevated,
      controlRamp: getCell(9,9).ramps.road.groundElevated,
    };
  `);
  check('the ramp exists as precondition', setup.ramp && setup.controlRamp, JSON.stringify(setup));

  const afterDemolish = run(ctx, `
    cmdDemolish(2,2,'elevated');
    return {
      ramp: getCell(2,2).ramps.road.groundElevated,
      controlRampUntouched: getCell(9,9).ramps.road.groundElevated,
    };
  `);
  check('demolishing elevated clears the groundElevated ramp', afterDemolish.ramp === false, JSON.stringify(afterDemolish));
  check('an unrelated cell\'s ramp is untouched', afterDemolish.controlRampUntouched === true, JSON.stringify(afterDemolish));
});

section('Test 8 — a real truck delivers cargo across ground -> elevated -> ground via the (unchanged) Ramp', () => {
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
    cmdBuildRoad(2, 6, 'ground', true);
    cmdBuildRamp(2, 6);
    cmdBuildRoad(2, 7, 'ground', true);
    cmdBuildRoad(2, 8, 'ground', true);
    cmdBuildBuilding('town', 4, 8, 'large', null, 'ore');
    cmdBuildBuilding('station', 3, 8, 'small', 'W', 'ore'); // dock west at (2,8), touches town east
    cmdPurchaseVehicle(2, 3, 'bulk');
    const stationA = [...world.entities.values()].find(e=>e.type==='station' && e.y===1);
    const stationB = [...world.entities.values()].find(e=>e.type==='station' && e.y===8);
    const truck = [...world.entities.values()].find(e=>e.kind==='vehicle');
    cmdSetOrders(truck, [
      {nodeId: stationA.id, action:'load_full', resource:'ore'},
      {nodeId: stationB.id, action:'unload_all', resource:'ore'},
    ]);
    return {truckId: truck.id, townId: [...world.entities.values()].find(e=>e.type==='town').id, warnLogs: pendingLogs.filter(l=>l.cls==='warn')};
  `);
  check('the whole layout built with no warnings', ids.warnLogs.length === 0, JSON.stringify(ids.warnLogs));

  let sawElevated = false, sawGroundAgain = false, delivered = false;
  for(let i=0;i<6000;i++){
    run(ctx, 'simTick();');
    const t = run(ctx, `
      const v = world.entities.get(${ids.truckId});
      const town = world.entities.get(${ids.townId});
      return {layer:v.layer, townStock: town.inStock};
    `);
    if(t.layer==='elevated') sawElevated = true;
    if(sawElevated && t.layer==='ground') sawGroundAgain = true;
    if(t.townStock > 0) delivered = true;
  }
  check('the truck climbed onto elevated road', sawElevated);
  check('the truck came back down to ground on the far side', sawGroundAgain);
  check('ore was delivered to the Town, having crossed elevated in between', delivered);
});

console.log(failures===0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
