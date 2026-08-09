// Regression tests for the underground layer (§ Underground layer) — a
// third grade alongside ground/elevated, linked to ground by a sloped
// Tunnel Ramp between two ADJACENT cells (not a same-cell link like the
// existing Ramp/Rail Ramp). Run against the real index.html code via
// test/harness.js.
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

section('Test 1 — underground track costs more, and a Tunnel Ramp needs real adjacency + both grades', () => {
  const ctx = newGameContext();
  const out = run(ctx, `
    const before = world.treasury;
    cmdBuildRoad(5, 5, 'underground', true);
    const spent = before - world.treasury;
    return {spent, expected: ROAD_COST_PER_TILE * UNDERGROUND_COST_MULTIPLIER};
  `);
  check('underground road costs ROAD_COST_PER_TILE * UNDERGROUND_COST_MULTIPLIER', out.spent === out.expected, JSON.stringify(out));

  const nonAdjacent = run(newGameContext(), `
    cmdBuildRoad(2, 2, 'ground', true);
    cmdBuildRoad(5, 5, 'underground', true);
    cmdBuildUndergroundRamp(2, 2, 5, 5);
    return pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg);
  `);
  check('rejects two non-adjacent tiles', nonAdjacent.some(m => /adjacent/i.test(m)), JSON.stringify(nonAdjacent));

  const missingUnderground = run(newGameContext(), `
    cmdBuildRoad(2, 2, 'ground', true);
    cmdBuildRoad(2, 3, 'ground', true); // both ground, no underground tile at all
    cmdBuildUndergroundRamp(2, 2, 2, 3);
    return pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg);
  `);
  check('rejects two ground tiles (no underground side)', missingUnderground.some(m => /ground.*underground|underground.*ground/i.test(m)), JSON.stringify(missingUnderground));

  const valid = run(newGameContext(), `
    cmdBuildRoad(2, 2, 'ground', true);
    cmdBuildRoad(2, 3, 'underground', true);
    const before = world.treasury;
    cmdBuildUndergroundRamp(2, 2, 2, 3);
    return {
      spent: before - world.treasury,
      groundRampEdge: trackAt(2,2,'ground').rampEdge.S,
      undergroundRampEdge: trackAt(2,3,'underground').rampEdge.N,
      warnLogs: pendingLogs.filter(l=>l.cls==='warn'),
    };
  `);
  check('a valid ramp charges UNDERGROUND_RAMP_COST', valid.spent === run(newGameContext(),`return UNDERGROUND_RAMP_COST;`), JSON.stringify(valid));
  check('sets rampEdge on the ground cell toward the underground neighbor', valid.groundRampEdge === 'underground', JSON.stringify(valid));
  check('sets rampEdge on the underground cell back toward the ground neighbor', valid.undergroundRampEdge === 'ground', JSON.stringify(valid));
  check('no warnings on a valid build', valid.warnLogs.length === 0, JSON.stringify(valid.warnLogs));
});

section('Test 2 — a Tunnel Ramp works with the clicks in either order', () => {
  const ctx = newGameContext();
  const out = run(ctx, `
    cmdBuildRoad(2, 2, 'ground', true);
    cmdBuildRoad(2, 3, 'underground', true);
    cmdBuildUndergroundRamp(2, 3, 2, 2); // underground cell clicked FIRST
    return {groundRampEdge: trackAt(2,2,'ground').rampEdge.S, warnLogs: pendingLogs.filter(l=>l.cls==='warn')};
  `);
  check('order-independent: underground-first still builds correctly', out.groundRampEdge === 'underground', JSON.stringify(out));
  check('no warnings', out.warnLogs.length === 0, JSON.stringify(out.warnLogs));
});

section('Test 3 — a ramp cell may also carry a perpendicular connection (§ Rail crossings\' generalization)', () => {
  // The old "must be a clean straight stretch" precondition was removed —
  // a ramp cell can now sit right at a turn or a full crossing, exactly
  // like any other lateral connection is buildable there. What travel is
  // actually SENSIBLE through a busy cell like that is pathfinding's job
  // (findLayerPath's straightOnly, tested against a real rail crossing in
  // test-rail-crossing.js), not a build-time cap on which edges may exist.
  function tryRamp(setup){
    const ctx = newGameContext();
    return run(ctx, `${setup}
      cmdBuildUndergroundRamp(2, 2, 2, 3);
      return {built: trackAt(2,2,'ground').rampEdge.S, warnLogs: pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg)};
    `);
  }
  const perpAtGround = tryRamp(`
    cmdBuildRoad(2, 2, 'ground', true);
    cmdBuildRoad(1, 2, 'ground', true); // west neighbor at ground — a turn
    cmdBuildRoad(2, 3, 'underground', true);
  `);
  check('a Tunnel Ramp still builds when the ground cell already has a perpendicular connection', !!perpAtGround.built, JSON.stringify(perpAtGround));
  check('no warnings on that build', perpAtGround.warnLogs.length === 0, JSON.stringify(perpAtGround.warnLogs));

  const perpAtUnderground = tryRamp(`
    cmdBuildRoad(2, 2, 'ground', true);
    cmdBuildRoad(2, 3, 'underground', true);
    cmdBuildRoad(1, 3, 'underground', true); // west neighbor underground — a turn
  `);
  check('a Tunnel Ramp still builds when the underground cell already has a perpendicular connection', !!perpAtUnderground.built, JSON.stringify(perpAtUnderground));

  const straightContinuation = tryRamp(`
    cmdBuildRoad(2, 1, 'ground', true);
    cmdBuildRoad(2, 2, 'ground', true); // straight continuation north — still fine
    cmdBuildRoad(2, 3, 'underground', true);
    cmdBuildRoad(2, 4, 'underground', true); // straight continuation south — still fine
  `);
  check('a plain straight stretch still builds exactly as before', straightContinuation.built, JSON.stringify(straightContinuation));
});

section('Test 4 — a ramp cell accepts a NEW perpendicular connection afterward too (auto-connect and manual)', () => {
  const ctx = newGameContext();
  const setup = run(ctx, `
    cmdBuildRoad(2, 2, 'ground', true);
    cmdBuildRoad(2, 3, 'underground', true);
    cmdBuildUndergroundRamp(2, 2, 2, 3);
    return {rampBuilt: trackAt(2,2,'ground').rampEdge.S};
  `);
  check('ramp built as precondition', setup.rampBuilt);

  const autoConnectAttempt = run(ctx, `
    cmdBuildRoad(1, 2, 'ground', true); // west neighbor, auto-connect on by default
    return {connected: trackAt(2,2,'ground').edges.W};
  `);
  check('auto-connect now joins a perpendicular direction at a ramp cell too', autoConnectAttempt.connected === true, JSON.stringify(autoConnectAttempt));

  const manualCtx = newGameContext();
  const manualSetup = run(manualCtx, `
    cmdBuildRoad(2, 2, 'ground', true);
    cmdBuildRoad(2, 3, 'underground', true);
    cmdBuildUndergroundRamp(2, 2, 2, 3);
    cmdBuildRoad(1, 2, 'ground', false); // built isolated (no auto-connect) so the manual toggle below is the only thing joining it
    return {rampBuilt: trackAt(2,2,'ground').rampEdge.S, preConnected: trackAt(2,2,'ground').edges.W};
  `);
  check('manual-connect setup: isolated west neighbor built, not yet connected', manualSetup.rampBuilt && manualSetup.preConnected===false, JSON.stringify(manualSetup));
  const manualAttempt = run(manualCtx, `
    cmdToggleConnection(2,2, 1,2, 'ground');
    return {connected: trackAt(2,2,'ground').edges.W, warnLogs: pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg)};
  `);
  check('manual Connect now joins it too, with no rejection', manualAttempt.connected === true && manualAttempt.warnLogs.length === 0, JSON.stringify(manualAttempt));
});

section('Test 5 — pathfinding crosses ground<->underground via the ramp; there is no direct elevated<->underground path', () => {
  const ctx = newGameContext();
  const out = run(ctx, `
    cmdBuildRoad(5, 0, 'ground', true);
    cmdBuildRoad(5, 1, 'ground', true);
    cmdBuildRoad(5, 2, 'underground', true);
    cmdBuildRoad(5, 3, 'underground', true);
    cmdBuildUndergroundRamp(5, 1, 5, 2);
    const path = findRoadPath({x:5,y:0,layer:'ground'}, {x:5,y:3,layer:'underground'});
    return {path: path && path.map(n=>n.layer+':'+n.x+','+n.y)};
  `);
  check('a path exists from ground to underground crossing the ramp', out.path !== null, JSON.stringify(out));
  check('the path actually passes through both layers in the right order', out.path && out.path[0].startsWith('ground') && out.path[out.path.length-1].startsWith('underground'), JSON.stringify(out.path));

  const noDirect = run(newGameContext(), `
    for(let x=3;x<=7;x++) cmdBuildRoad(x, 5, 'elevated', true);
    cmdBuildRoad(5, 6, 'underground', true);
    // No ground tile connecting them at all — elevated and underground never share a direct ramp.
    return findRoadPath({x:3,y:5,layer:'elevated'}, {x:5,y:6,layer:'underground'});
  `);
  check('no path exists directly between elevated and underground with no ground link', noDirect === null);
});

section('Test 6 — rail blocks treat a ramp cell as a hub on both layers', () => {
  const ctx = newGameContext();
  const out = run(ctx, `
    cmdBuildTrack(5, 0, 'rail', true);
    cmdBuildTrack(5, 1, 'rail', true);
    cmdBuildTrack(5, 2, 'railUnderground', true);
    cmdBuildTrack(5, 3, 'railUnderground', true);
    cmdBuildRailUndergroundRamp(5, 1, 5, 2);
    return {
      groundBlock: trackAt(5,0,'rail').blockId.S,
      undergroundBlock: trackAt(5,2,'railUnderground').blockId.S,
    };
  `);
  check('the ground-side and underground-side edges get DISTINCT block ids (ramp is a boundary on both)',
    out.groundBlock !== null && out.undergroundBlock !== null && out.groundBlock !== out.undergroundBlock, JSON.stringify(out));
});

section('Test 7 — a real train travels ground -> underground -> ground and delivers cargo', () => {
  const ctx = newGameContext();
  const ids = run(ctx, `
    for(let y=0;y<=3;y++) cmdBuildTrack(2, y, 'rail', true);
    cmdBuildBuilding('depot', 0, 0, 'large', 'ns', 'ore');
    cmdBuildTrack(2, 4, 'rail', true);
    cmdBuildBuilding('trainyard', 3, 4, 'small'); // touches (2,4)
    cmdBuildTrack(2, 5, 'railUnderground', true);
    cmdBuildTrack(2, 6, 'railUnderground', true);
    cmdBuildTrack(2, 7, 'railUnderground', true);
    cmdBuildRailUndergroundRamp(2, 4, 2, 5);
    cmdBuildTrack(2, 8, 'rail', true);
    cmdBuildRailUndergroundRamp(2, 8, 2, 7);
    for(let y=9;y<=12;y++) cmdBuildTrack(2, y, 'rail', true);
    cmdBuildBuilding('depot', 0, 9, 'large', 'ns', 'ore');
    const depots = [...world.entities.values()].filter(e=>e.type==='depot');
    cmdAssembleTrain(2, 4, 'diesel', 'ore_wagon', 1);
    const train = [...world.entities.values()].find(e=>e.kind==='vehicle' && isTrain(e.id));
    const depotA = depots.find(d=>d.y===0), depotB = depots.find(d=>d.y===9);
    depotA.outStock = 100; depotA.outCap = 1000;
    cmdSetOrders(train, [
      {nodeId: depotA.id, action:'load_full', resource:'ore'},
      {nodeId: depotB.id, action:'unload_all', resource:'ore'},
    ]);
    return {trainId: train.id, depotBId: depotB.id, warnLogs: pendingLogs.filter(l=>l.cls==='warn')};
  `);
  check('the whole layout built with no warnings', ids.warnLogs.length === 0, JSON.stringify(ids.warnLogs));

  let sawUnderground = false, sawGroundAfterUnderground = false, delivered = false;
  for(let i=0;i<3000;i++){
    run(ctx, 'simTick();');
    const t = run(ctx, `
      const t = world.entities.get(${ids.trainId});
      const b = world.entities.get(${ids.depotBId});
      return {layer:t.layer, y:t.y, depotBStock: b.outStock};
    `);
    if(t.layer==='railUnderground') sawUnderground = true;
    if(sawUnderground && t.layer==='rail' && t.y > 8) sawGroundAfterUnderground = true;
    if(t.depotBStock > 0) delivered = true;
  }
  check('the train actually went underground', sawUnderground);
  check('the train came back up to ground rail on the far side', sawGroundAfterUnderground);
  check('ore was delivered at the far Depot, having crossed underground in between', delivered);
});

section('Test 8 — demolishing either side of a ramp clears rampEdge symmetrically', () => {
  const ctx = newGameContext();
  const before = run(ctx, `
    cmdBuildRoad(2, 2, 'ground', true);
    cmdBuildRoad(2, 3, 'underground', true);
    cmdBuildUndergroundRamp(2, 2, 2, 3);
    return {ground: trackAt(2,2,'ground').rampEdge.S, underground: trackAt(2,3,'underground').rampEdge.N};
  `);
  check('ramp exists as precondition', before.ground && before.underground);

  const afterDemolishGround = run(ctx, `
    cmdDemolish(2, 2, 'ground');
    return {undergroundSideCleared: trackAt(2,3,'underground').rampEdge.N};
  `);
  check('demolishing the GROUND side clears the ramp edge on the underground side too',
    afterDemolishGround.undergroundSideCleared === null, JSON.stringify(afterDemolishGround));

  // Rebuild and demolish from the other side this time.
  const afterDemolishUnderground = run(ctx, `
    cmdBuildRoad(2, 2, 'ground', true);
    cmdBuildUndergroundRamp(2, 2, 2, 3);
    cmdDemolish(2, 3, 'underground');
    return {groundSideCleared: trackAt(2,2,'ground').rampEdge.S};
  `);
  check('demolishing the UNDERGROUND side clears the ramp edge on the ground side too',
    afterDemolishUnderground.groundSideCleared === null, JSON.stringify(afterDemolishUnderground));
});

console.log(failures===0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
