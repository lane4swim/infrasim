// Regression tests for realistic ramp physics (§ Realistic ramp physics) —
// gradeForCurrentEdge/GRADE_ACCEL_PER_LEVEL/MIN_DECEL in systems.js. Climbing
// a real elevation change now measurably reduces net acceleration (and adds
// free braking power); descending does the opposite. deepUnderground/
// airspace are flat global planes — elevationAt returns a fixed Z for them
// regardless of local terrain, so any edge that stays on one of those grades
// must always read grade 0 ("burrowing into a hillside" is a render-only
// darkening tint, never a real elevation change). Run against the real
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

section('Test 1 — gradeForCurrentEdge computes the real elevationAt delta per edge type', () => {
  const ctx = newGameContext();

  const flatLateral = run(ctx, `
    cmdBuildRoad(0, 0, 'ground', true);
    cmdBuildRoad(1, 0, 'ground', true);
    const v = {x:0, y:0, layer:'ground', path:[{x:0,y:0,layer:'ground'}, {x:1,y:0,layer:'ground'}], pathIndex:0};
    return gradeForCurrentEdge(v);
  `);
  check('two adjacent ground cells at the same elevation: grade 0', flatLateral === 0, `got ${flatLateral}`);

  const slopedLateral = run(ctx, `
    cmdBuildRoad(3, 0, 'ground', true);
    cmdRaiseTerrain(4, 0);
    cmdBuildRoad(4, 0, 'ground', true);
    const climbing = gradeForCurrentEdge({x:3, y:0, layer:'ground', path:[{x:3,y:0,layer:'ground'},{x:4,y:0,layer:'ground'}], pathIndex:0});
    const descending = gradeForCurrentEdge({x:4, y:0, layer:'ground', path:[{x:4,y:0,layer:'ground'},{x:3,y:0,layer:'ground'}], pathIndex:0});
    return {climbing, descending};
  `);
  check('climbing onto a +1 neighbor: grade +1', slopedLateral.climbing === 1, JSON.stringify(slopedLateral));
  check('descending off a +1 neighbor: grade -1', slopedLateral.descending === -1, JSON.stringify(slopedLateral));

  const verticalRampFlat = run(ctx, `
    cmdBuildRoad(6, 0, 'ground', true);
    cmdBuildRoad(6, 0, 'elevated', true);
    return gradeForCurrentEdge({x:6, y:0, layer:'ground', path:[{x:6,y:0,layer:'ground'},{x:6,y:0,layer:'elevated'}], pathIndex:0});
  `);
  check('a same-cell Ramp at elevation 0: grade +1 (elevated is always local ground+1)', verticalRampFlat === 1, `got ${verticalRampFlat}`);

  const verticalRampRaised = run(ctx, `
    cmdRaiseTerrain(7, 0); cmdRaiseTerrain(7, 0);
    cmdBuildRoad(7, 0, 'ground', true);
    cmdBuildRoad(7, 0, 'elevated', true);
    return gradeForCurrentEdge({x:7, y:0, layer:'ground', path:[{x:7,y:0,layer:'ground'},{x:7,y:0,layer:'elevated'}], pathIndex:0});
  `);
  check('a same-cell Ramp at elevation 2: grade is STILL +1, not thrown off by the hill (elevated/ground move together)', verticalRampRaised === 1, `got ${verticalRampRaised}`);

  const tunnelRampMatched = run(ctx, `
    cmdBuildRoad(9, 0, 'ground', true);
    cmdBuildRoad(10, 0, 'underground', true);
    cmdBuildUndergroundRamp(9, 0, 10, 0, 1);
    return gradeForCurrentEdge({x:9, y:0, layer:'ground', path:[{x:9,y:0,layer:'ground'},{x:10,y:0,layer:'underground'}], pathIndex:0});
  `);
  check('a Tunnel Ramp between two cells at MATCHING local terrain: grade -1 (going underground is a descent — the clean case)', tunnelRampMatched === -1, `got ${tunnelRampMatched}`);

  // The LOWER cell's own terrain is raised +1 (not the upper cell's) —
  // elevationAt(lower,'underground') = (0+1) - 1 = 0, exactly matching
  // elevationAt(upper,'ground') = 0, so the terrain difference exactly
  // cancels the nominal one-level step. Demonstrates a Tunnel Ramp has no
  // rule requiring its two endpoint cells' own terrain to match.
  const tunnelRampMismatched = run(ctx, `
    cmdBuildRoad(12, 0, 'ground', true);
    cmdRaiseTerrain(13, 0);
    cmdBuildRoad(13, 0, 'underground', true);
    cmdBuildUndergroundRamp(12, 0, 13, 0, 1);
    return gradeForCurrentEdge({x:12, y:0, layer:'ground', path:[{x:12,y:0,layer:'ground'},{x:13,y:0,layer:'underground'}], pathIndex:0});
  `);
  check("a Tunnel Ramp where the LOWER cell's own terrain is +1: grade 0, not the nominal +1 (the terrain difference cancels the level change)",
    tunnelRampMismatched === 0, `got ${tunnelRampMismatched}`);

  const deepUndergroundUnderHill = run(ctx, `
    for(let i=0;i<4;i++) cmdRaiseTerrain(15, 0);
    cmdBuildRoad(15, 0, 'deepUnderground', true);
    for(let i=0;i<4;i++) cmdLowerTerrain(16, 0);
    cmdBuildRoad(16, 0, 'deepUnderground', true);
    return gradeForCurrentEdge({x:15, y:0, layer:'deepUnderground', path:[{x:15,y:0,layer:'deepUnderground'},{x:16,y:0,layer:'deepUnderground'}], pathIndex:0});
  `);
  check('deepUnderground stays grade 0 even moving from under a max-height hill to under a max-depth valley — flat, always ("burrowing into a hillside" is a render tint, not real elevation)',
    deepUndergroundUnderHill === 0, `got ${deepUndergroundUnderHill}`);

  const airspaceOverHill = run(ctx, `
    cmdRaiseTerrain(18, 0); cmdRaiseTerrain(18, 0);
    cmdBuildRoad(18, 0, 'airspace', true);
    cmdBuildRoad(19, 0, 'airspace', true);
    return gradeForCurrentEdge({x:18, y:0, layer:'airspace', path:[{x:18,y:0,layer:'airspace'},{x:19,y:0,layer:'airspace'}], pathIndex:0});
  `);
  check('airspace is flat too, regardless of the terrain underneath', airspaceOverHill === 0, `got ${airspaceOverHill}`);
});

section('Test 2 — climbing measurably slows a truck; descending measurably speeds it up', () => {
  // One fixed physical layout — a Mine (+ its own Station) at the LOW end
  // (x=0) of a staircase (elevation 0,1,2,3,4 across x=0..4 at y=5 — every
  // one of the 5 available integer levels used exactly once, so every
  // single step is genuinely graded, no flat plateau at either end to
  // dilute an early sample), a Town (+ its own Station) at the HIGH end
  // (x=4) — reused for both directions: "climbing" points a truck's order
  // from the low Station to the high one, "descending" just starts the
  // truck at the high end and points it at the low one. A flat (elevation
  // 0 throughout) control with the identical building layout isolates the
  // grade effect from ordinary random per-instance engine/mass/speed
  // variation, which is pinned to a fixed value on every truck below so
  // the comparison isn't noise.
  function buildLayout(ctx, staircase){
    run(ctx, `
      ${staircase ? `
        cmdRaiseTerrain(1, 5);
        cmdRaiseTerrain(2, 5); cmdRaiseTerrain(2, 5);
        cmdRaiseTerrain(3, 5); cmdRaiseTerrain(3, 5); cmdRaiseTerrain(3, 5);
        cmdRaiseTerrain(4, 5); cmdRaiseTerrain(4, 5); cmdRaiseTerrain(4, 5); cmdRaiseTerrain(4, 5);
      ` : ''}
      for(let x=0;x<=4;x++) cmdBuildRoad(x, 5, 'ground', true);
      cmdBuildBuilding('mine', 0, 2, 'small');
      cmdBuildBuilding('station', 0, 4, 'small', 'S', 'ore');
      cmdBuildBuilding('town', 4, 2, 'small', null, 'ore');
      cmdBuildBuilding('station', 4, 4, 'small', 'S', 'ore');
    `);
  }
  // Pins every random per-instance Movement stat (maxSpeed/mass/engine/
  // brakeForce still vary randomly — only length stopped being randomized,
  // § Remove per-instance randomized vehicle length) to the content pack's
  // own base values, so this comparison isolates the grade effect instead
  // of getting lost in that independent randomization. Assumes a `truck`
  // const is already in scope at the call site.
  const PIN_STATS = `
    truck.maxSpeed = VEHICLE_DEFS.bulk.maxSpeedTilesPerTick;
    truck.massEmpty = VEHICLE_DEFS.bulk.massEmpty;
    truck.engineForce = VEHICLE_DEFS.bulk.engineForce;
    truck.brakeForce = VEHICLE_DEFS.bulk.brakeForce;
  `;
  // Compares raw speed after a small, fixed number of ticks from a
  // standing start — not full-trip arrival time. A 5-6 tile trip lets a
  // truck reach its maxSpeed cap almost immediately regardless of grade,
  // which can hide a real accel difference behind identical whole-tick
  // arrival counts; reading `.speed` directly a few ticks in, well before
  // any truck could plausibly hit its cap, isolates the accel effect
  // itself instead of a trip-completion time that can round the same way
  // for two genuinely different accelerations.
  const SAMPLE_TICKS = 4;
  function speedAfterTicks(ctx, truckId, n){
    for(let i=0;i<n;i++) run(ctx, `simTick();`);
    return run(ctx, `return world.entities.get(${truckId}).speed;`);
  }
  function purchaseAndOrder(ctx, startX, targetX){
    return run(ctx, `
      cmdPurchaseVehicle(${startX}, 5, 'bulk');
      const target = [...world.entities.values()].find(e=>e.type==='station' && e.x===${targetX});
      const truck = [...world.entities.values()].find(e=>e.kind==='vehicle');
      ${PIN_STATS}
      cmdSetOrders(truck, [{nodeId: target.id, action:'unload_all', resource:'ore'}]);
      return {truckId: truck.id, warnLogs: pendingLogs.filter(l=>l.cls==='warn')};
    `);
  }

  const climbCtx = newGameContext();
  buildLayout(climbCtx, true);
  const climbIds = purchaseAndOrder(climbCtx, 0, 4); // low -> high: climbing
  check('climbing layout built with no warnings', climbIds.warnLogs.length === 0, JSON.stringify(climbIds.warnLogs));
  const climbSpeed = speedAfterTicks(climbCtx, climbIds.truckId, SAMPLE_TICKS);

  const descCtx = newGameContext();
  buildLayout(descCtx, true);
  const descIds = purchaseAndOrder(descCtx, 4, 0); // high -> low: descending
  check('descending layout built with no warnings', descIds.warnLogs.length === 0, JSON.stringify(descIds.warnLogs));
  const descSpeed = speedAfterTicks(descCtx, descIds.truckId, SAMPLE_TICKS);

  const flatCtx = newGameContext();
  buildLayout(flatCtx, false); // same buildings, no elevation anywhere
  const flatIds = purchaseAndOrder(flatCtx, 0, 4);
  const flatSpeed = speedAfterTicks(flatCtx, flatIds.truckId, SAMPLE_TICKS);

  check('all three trucks are actually moving after 4 ticks (precondition)',
    climbSpeed > 0 && descSpeed > 0 && flatSpeed > 0, `climb=${climbSpeed} desc=${descSpeed} flat=${flatSpeed}`);
  check('climbing reaches measurably LOWER speed than the flat control after the same number of ticks',
    climbSpeed < flatSpeed, `climb=${climbSpeed} flat=${flatSpeed}`);
  check('descending reaches measurably HIGHER speed than the flat control after the same number of ticks',
    descSpeed > flatSpeed, `descend=${descSpeed} flat=${flatSpeed}`);
});

section('Test 3 — decel never goes non-positive, even on an extreme mismatched-terrain grade', () => {
  // A Tunnel Ramp has no rule requiring its two cells' local terrain to
  // match (Test 1 above) — push that as far as it goes (upper cell at
  // ELEVATION_MAX, lower cell's own terrain at ELEVATION_MIN) so the real
  // elevationAt delta is far steeper than the nominal one level, then run a
  // real truck down it into a dead end and confirm it still comes under
  // control (speed never negative/NaN) instead of the grade term breaking
  // braking entirely.
  const ctx = newGameContext();
  const ids = run(ctx, `
    for(let i=0;i<4;i++) cmdRaiseTerrain(0, 0);
    cmdBuildRoad(0, 0, 'ground', true);
    for(let i=0;i<4;i++) cmdLowerTerrain(1, 0); // as low as ELEVATION_MIN allows
    cmdBuildRoad(1, 0, 'underground', true);
    cmdBuildUndergroundRamp(0, 0, 1, 0, 1);
    cmdBuildRoad(2, 0, 'underground', true); // dead end beyond the ramp — nothing past it
    const grade = gradeForCurrentEdge({x:0, y:0, layer:'ground', path:[{x:0,y:0,layer:'ground'},{x:1,y:0,layer:'underground'}], pathIndex:0});
    cmdBuildBuilding('mine', 0, 2, 'small');
    cmdBuildBuilding('station', 0, 1, 'small', 'N', 'ore');
    cmdBuildBuilding('town', 2, 2, 'small', null, 'ore');
    cmdBuildBuilding('station', 2, 1, 'small', 'N', 'ore');
    cmdPurchaseVehicle(0, 0, 'bulk');
    const stationB = [...world.entities.values()].find(e=>e.type==='station' && e.x===2);
    const truck = [...world.entities.values()].find(e=>e.kind==='vehicle');
    cmdSetOrders(truck, [{nodeId: stationB.id, action:'unload_all', resource:'ore'}]);
    return {truckId: truck.id, grade, warnLogs: pendingLogs.filter(l=>l.cls==='warn')};
  `);
  check('layout built with no warnings', ids.warnLogs.length === 0, JSON.stringify(ids.warnLogs));
  check('the constructed grade really is far steeper than a nominal single level (proves this is a real stress test)',
    Math.abs(ids.grade) > 3, `grade=${ids.grade}`);

  let sawNegativeSpeed = false, sawNaN = false, finalState = null;
  for(let i=0;i<3000;i++){
    run(ctx, `simTick();`);
    const t = run(ctx, `const v = world.entities.get(${ids.truckId}); return {speed: v.speed, state: v.state};`);
    if(t.speed < 0) sawNegativeSpeed = true;
    if(Number.isNaN(t.speed)) sawNaN = true;
    finalState = t.state;
  }
  check('speed never went negative despite the extreme downgrade', !sawNegativeSpeed);
  check('speed never became NaN', !sawNaN);
  check('the truck reached a settled, non-crashed state (unloading or blocked, not stuck mid-transit forever)',
    finalState === 'unloading' || finalState === 'blocked', `finalState=${finalState}`);
});

console.log(failures===0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
