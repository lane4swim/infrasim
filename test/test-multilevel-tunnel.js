// Regression tests for multi-level tunnels (§ Multi-level tunnels) —
// UNDERGROUND_LEVELS (loader.js, default 3) stacked underground grades
// instead of just one, each level reached from the one above it by its
// own Tunnel Ramp, never skipping a level. Level 1 keeps the original
// 'underground'/'railUnderground' names for backward compatibility;
// level N>1 is 'underground'+N / 'railUnderground'+N. Deeper levels cost
// progressively more, both per-tile and per-ramp. Run against the real
// index.html code via test/harness.js.
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

section('Test 1 — level 1 is fully unchanged; deeper levels cost progressively more', () => {
  const out = run(newGameContext(), `
    return {
      levels: UNDERGROUND_LEVELS,
      grade1: undergroundGradeName(1),
      grade2: undergroundGradeName(2),
      rail1: undergroundRailLayerName(1),
      rail2: undergroundRailLayerName(2),
      costMult1: costMultiplierForUndergroundLevel(1),
      costMult2: costMultiplierForUndergroundLevel(2),
      costMult3: costMultiplierForUndergroundLevel(3),
      rampCost1: rampCostForUndergroundLevel(1),
      rampCost2: rampCostForUndergroundLevel(2),
      rampCost3: rampCostForUndergroundLevel(3),
    };
  `);
  check('at least 3 underground levels exist by default', out.levels >= 3, JSON.stringify(out));
  check('level 1 keeps the original road layer name', out.grade1 === 'underground', JSON.stringify(out));
  check('level 2 gets a numbered name', out.grade2 === 'underground2', JSON.stringify(out));
  check('level 1 keeps the original rail layer name', out.rail1 === 'railUnderground', JSON.stringify(out));
  check('level 2 rail gets a numbered name', out.rail2 === 'railUnderground2', JSON.stringify(out));
  check('level 1 cost multiplier is unchanged', out.costMult1 === 3, JSON.stringify(out));
  check('level 1 ramp cost is unchanged', out.rampCost1 === 80, JSON.stringify(out));
  check('each deeper level costs strictly more per tile', out.costMult2 > out.costMult1 && out.costMult3 > out.costMult2, JSON.stringify(out));
  check('each deeper level\'s ramp costs strictly more', out.rampCost2 > out.rampCost1 && out.rampCost3 > out.rampCost2, JSON.stringify(out));

  const buildCost = run(newGameContext(), `
    const before = world.treasury;
    cmdBuildRoad(5,5,'underground2',true);
    return before - world.treasury;
  `);
  check('building on level 2 actually charges the level-2 multiplier', buildCost === run(newGameContext(),'return ROAD_COST_PER_TILE * costMultiplierForUndergroundLevel(2);'), buildCost);
});

section('Test 2 — a level-2 Tunnel Ramp connects level 1 to level 2, never ground to level 2 directly', () => {
  const wrongPair = run(newGameContext(), `
    cmdBuildRoad(2,2,'ground',true);
    cmdBuildRoad(2,3,'underground2',true); // level 2, but the ramp is asked for level 2 (expects level1<->level2, not ground<->level2)
    cmdBuildUndergroundRamp(2,2,2,3,2);
    return {built: trackAt(2,2,'ground').rampEdge.S, warnLogs: pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg)};
  `);
  check('a level-2 ramp rejects a ground/level-2 pair (wrong grades for that level)', !wrongPair.built, JSON.stringify(wrongPair));
  check('rejection names the expected grades', wrongPair.warnLogs.some(m=>/underground.*underground2|underground2.*underground/i.test(m)), JSON.stringify(wrongPair.warnLogs));

  const rightPair = run(newGameContext(), `
    cmdBuildRoad(2,2,'underground',true);
    cmdBuildRoad(2,3,'underground2',true);
    const before = world.treasury;
    cmdBuildUndergroundRamp(2,2,2,3,2);
    return {
      spent: before - world.treasury,
      upperEdge: trackAt(2,2,'underground').rampEdge.S,
      lowerEdge: trackAt(2,3,'underground2').rampEdge.N,
      warnLogs: pendingLogs.filter(l=>l.cls==='warn'),
    };
  `);
  check('a valid level-1<->level-2 ramp charges the level-2 ramp cost', rightPair.spent === run(newGameContext(),'return rampCostForUndergroundLevel(2);'), JSON.stringify(rightPair));
  check('the upper (level 1) side stores "underground2" as its target grade', rightPair.upperEdge === 'underground2', JSON.stringify(rightPair));
  check('the lower (level 2) side stores "underground" as its target grade', rightPair.lowerEdge === 'underground', JSON.stringify(rightPair));
  check('no warnings on a valid build', rightPair.warnLogs.length === 0, JSON.stringify(rightPair.warnLogs));

  const defaultLevel = run(newGameContext(), `
    cmdBuildRoad(2,2,'ground',true);
    cmdBuildRoad(2,3,'underground',true);
    cmdBuildUndergroundRamp(2,2,2,3); // no level arg — must still default to 1, exactly like before multi-level tunnels existed
    return trackAt(2,2,'ground').rampEdge.S;
  `);
  check('omitting the level argument still defaults to level 1', defaultLevel === 'underground', defaultLevel);
});

section('Test 3 — straight-through-only still applies at a level-2 ramp, and a cell can be both a lower and an upper side at once', () => {
  const perpendicular = run(newGameContext(), `
    cmdBuildRoad(2,2,'underground',true);
    cmdBuildRoad(1,2,'underground',true); // a turn at the level-1 side
    cmdBuildRoad(2,3,'underground2',true);
    cmdBuildUndergroundRamp(2,2,2,3,2);
    return {built: trackAt(2,2,'underground').rampEdge.S, warnLogs: pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg)};
  `);
  check('rejected when the level-1 side has a perpendicular connection', !perpendicular.built, JSON.stringify(perpendicular));
  check('rejection names the straight-through requirement', perpendicular.warnLogs.some(m=>/straight/i.test(m)), JSON.stringify(perpendicular.warnLogs));

  // A continuous straight tunnel through three levels: the level-1 cell at
  // (2,5) is simultaneously the LOWER side of the ground<->level-1 ramp
  // (rampEdge.N) and the UPPER side of the level-1<->level-2 ramp
  // (rampEdge.S) — two different directions on the same cell.
  const continuous = run(newGameContext(), `
    cmdBuildRoad(2,4,'ground',true);
    cmdBuildRoad(2,5,'underground',true);
    cmdBuildUndergroundRamp(2,4,2,5,1);
    cmdBuildRoad(2,6,'underground2',true);
    cmdBuildUndergroundRamp(2,5,2,6,2);
    return {
      upToGround: trackAt(2,5,'underground').rampEdge.N,
      downToLevel2: trackAt(2,5,'underground').rampEdge.S,
      warnLogs: pendingLogs.filter(l=>l.cls==='warn'),
    };
  `);
  check('the middle cell keeps its ramp toward ground', continuous.upToGround === 'ground', JSON.stringify(continuous));
  check('the same cell also gets a ramp toward level 2, in a different direction', continuous.downToLevel2 === 'underground2', JSON.stringify(continuous));
  check('no warnings building a continuous multi-level straight tunnel', continuous.warnLogs.length === 0, JSON.stringify(continuous.warnLogs));
});

section('Test 4 — pathfinding chains through every level, one at a time, never skipping one', () => {
  const chain = run(newGameContext(), `
    cmdBuildRoad(2,2,'ground',true);
    cmdBuildRoad(2,3,'underground',true);
    cmdBuildUndergroundRamp(2,2,2,3,1);
    cmdBuildRoad(2,4,'underground2',true);
    cmdBuildUndergroundRamp(2,3,2,4,2);
    cmdBuildRoad(2,5,'underground3',true);
    cmdBuildUndergroundRamp(2,4,2,5,3);
    const path = findRoadPath({x:2,y:2,layer:'ground'}, {x:2,y:5,layer:'underground3'});
    return {path: path && path.map(n=>n.layer)};
  `);
  check('a path exists ground -> level1 -> level2 -> level3', chain.path && chain.path.join()==='ground,underground,underground2,underground3', JSON.stringify(chain));

  const noSkip = run(newGameContext(), `
    cmdBuildRoad(2,2,'underground',true);
    cmdBuildRoad(2,3,'underground3',true);
    // no level-2 tile and no ramp at all — level1<->level3 is never one ramp
    return findRoadPath({x:2,y:2,layer:'underground'}, {x:2,y:3,layer:'underground3'});
  `);
  check('no direct level-1<->level-3 path skipping level 2', noSkip === null);
});

section('Test 5 — rail blocks: every underground level gets its own independent block graph, ramps are hubs on both sides', () => {
  // Extra track beyond each side of the ramp (4,0)-(4,1) and (4,2)-(4,3)
  // so there's an actual same-grade lateral edge on each side to check —
  // the ramp edge itself never gets a blockId (only same-layer `edges`
  // do); what this proves is that the ramp cell pair acts as a HUB,
  // splitting the level-1 track and the level-2 track into separate
  // blocks rather than one block spanning the transition.
  const setup = run(newGameContext(), `
    cmdBuildTrack(4,0,'railUnderground',true);
    cmdBuildTrack(4,1,'railUnderground',true);
    cmdBuildTrack(4,2,'railUnderground2',true);
    cmdBuildTrack(4,3,'railUnderground2',true);
    cmdBuildRailUndergroundRamp(4,1,4,2,2);
    return {
      level1Block: trackAt(4,0,'railUnderground').blockId.S,
      level2Block: trackAt(4,2,'railUnderground2').blockId.S,
    };
  `);
  check('the level-1-side and level-2-side edges get DISTINCT block ids (the ramp is a hub on both)',
    setup.level1Block !== null && setup.level2Block !== null && setup.level1Block !== setup.level2Block,
    JSON.stringify(setup));
});

section('Test 6 — demolishing a mid-stack cell clears BOTH its ramps (up and down), and only those', () => {
  const ctx = newGameContext();
  const setup = run(ctx, `
    cmdBuildRoad(2,4,'ground',true);
    cmdBuildRoad(2,5,'underground',true);
    cmdBuildUndergroundRamp(2,4,2,5,1);
    cmdBuildRoad(2,6,'underground2',true);
    cmdBuildUndergroundRamp(2,5,2,6,2);
    cmdBuildRoad(9,9,'ground',true); // unrelated control cell
    cmdBuildRoad(9,10,'underground',true);
    cmdBuildUndergroundRamp(9,9,9,10,1);
    return {
      upToGround: trackAt(2,5,'underground').rampEdge.N,
      downToLevel2: trackAt(2,5,'underground').rampEdge.S,
      controlRamp: trackAt(9,9,'ground').rampEdge.S,
    };
  `);
  check('both ramps exist on the mid-stack cell as precondition', setup.upToGround && setup.downToLevel2 && setup.controlRamp, JSON.stringify(setup));

  const afterDemolish = run(ctx, `
    cmdDemolish(2,5,'underground');
    return {
      groundSideCleared: trackAt(2,4,'ground').rampEdge.S,
      level2SideCleared: trackAt(2,6,'underground2').rampEdge.N,
      controlRampUntouched: trackAt(9,9,'ground').rampEdge.S,
    };
  `);
  check('demolishing the mid-stack cell clears the ramp edge up toward ground', afterDemolish.groundSideCleared === null, JSON.stringify(afterDemolish));
  check('demolishing the mid-stack cell ALSO clears the ramp edge down toward level 2', afterDemolish.level2SideCleared === null, JSON.stringify(afterDemolish));
  check('an unrelated ramp elsewhere is untouched', afterDemolish.controlRampUntouched === 'underground', JSON.stringify(afterDemolish));
});

section('Test 7 — a real train delivers cargo through a continuous ground -> level1 -> level2 -> level1 -> ground tunnel', () => {
  const ctx = newGameContext();
  const ids = run(ctx, `
    cmdBuildTrack(2, 0, 'rail', true);
    cmdBuildTrack(2, 1, 'rail', true);
    cmdBuildBuilding('depot', 0, 0, 'large', 'ns', 'ore', 2);
    cmdBuildTrack(2, 2, 'rail', true);
    cmdBuildBuilding('trainyard', 3, 2, 'small');
    cmdBuildTrack(2, 3, 'rail', true);
    cmdBuildTrack(2, 4, 'rail', true);
    cmdBuildTrack(2, 5, 'railUnderground', true);
    cmdBuildRailUndergroundRamp(2, 4, 2, 5, 1);
    cmdBuildTrack(2, 6, 'railUnderground2', true);
    cmdBuildRailUndergroundRamp(2, 5, 2, 6, 2);
    cmdBuildTrack(2, 7, 'railUnderground2', true);
    cmdBuildTrack(2, 8, 'railUnderground2', true);
    cmdBuildTrack(2, 9, 'railUnderground', true);
    cmdBuildRailUndergroundRamp(2, 8, 2, 9, 2);
    cmdBuildTrack(2, 10, 'rail', true);
    cmdBuildRailUndergroundRamp(2, 9, 2, 10, 1);
    cmdBuildTrack(2, 11, 'rail', true);
    cmdBuildTrack(2, 12, 'rail', true);
    cmdBuildTrack(2, 13, 'rail', true);
    cmdBuildBuilding('depot', 0, 12, 'large', 'ns', 'ore', 2);
    const depots = [...world.entities.values()].filter(e=>e.type==='depot');
    cmdAssembleTrain(2, 2, 'diesel', 'ore_wagon', 1);
    const train = [...world.entities.values()].find(e=>e.kind==='vehicle' && isTrain(e.id));
    const depotA = depots.find(d=>d.y===0), depotB = depots.find(d=>d.y===12);
    depotA.outStock = 100; depotA.outCap = 1000;
    cmdSetOrders(train, [
      {nodeId: depotA.id, action:'load_full', resource:'ore'},
      {nodeId: depotB.id, action:'unload_all', resource:'ore'},
    ]);
    return {trainId: train.id, depotBId: depotB.id, warnLogs: pendingLogs.filter(l=>l.cls==='warn')};
  `);
  check('the whole multi-level layout built with no warnings', ids.warnLogs.length === 0, JSON.stringify(ids.warnLogs));

  let sawLevel1 = false, sawLevel2 = false, sawGroundAfter = false, delivered = false;
  for(let i=0;i<4000;i++){
    run(ctx, 'simTick();');
    const t = run(ctx, `
      const t = world.entities.get(${ids.trainId});
      const b = world.entities.get(${ids.depotBId});
      return {layer:t.layer, y:t.y, depotBStock: b.outStock};
    `);
    if(t.layer==='railUnderground') sawLevel1 = true;
    if(t.layer==='railUnderground2') sawLevel2 = true;
    if(sawLevel2 && t.layer==='rail' && t.y > 9) sawGroundAfter = true;
    if(t.depotBStock > 0) delivered = true;
  }
  check('the train reached underground level 1', sawLevel1);
  check('the train reached underground level 2', sawLevel2);
  check('the train came back up to ground rail on the far side', sawGroundAfter);
  check('ore was delivered at the far Depot, having crossed two underground levels', delivered);
});

console.log(failures===0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
