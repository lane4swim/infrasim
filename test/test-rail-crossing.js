// Regression tests for rail crossings (§ Rail crossings) — a rail cell with
// all 4 lateral directions connected (an N-S line and a W-E line sharing
// one tile) is always two independent straight lines crossing at grade,
// never a switch: this game has no points/switch equipment, so travel
// through such a cell is restricted to continuing straight on whichever
// line was actually entered on — no turning onto the other line. A T/3-way
// junction (still no such thing as "the other line" — only one line ever
// splits there) keeps its ordinary any-to-any behavior, unchanged. Run
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

section('Test 1 — a 4-way rail crossing allows straight-through travel but never a turn', () => {
  const ctx = newGameContext();
  const s = run(ctx, `
    // A "+" crossing at (5,5): N-S line y=2..8, W-E line x=2..8, both on
    // ground rail, both crossing through (5,5).
    for(let y=2; y<=8; y++) cmdBuildTrack(5, y, 'rail', true);
    for(let x=2; x<=8; x++) cmdBuildTrack(x, 5, 'rail', true);
    const crossing = getCell(5,5).layers.ground.rail;
    return {
      allFourConnected: crossing.edges.N && crossing.edges.S && crossing.edges.E && crossing.edges.W,
      nToS: !!findRailPath({x:5,y:2,layer:'rail'}, {x:5,y:8,layer:'rail'}),
      sToN: !!findRailPath({x:5,y:8,layer:'rail'}, {x:5,y:2,layer:'rail'}),
      eToW: !!findRailPath({x:8,y:5,layer:'rail'}, {x:2,y:5,layer:'rail'}),
      wToE: !!findRailPath({x:2,y:5,layer:'rail'}, {x:8,y:5,layer:'rail'}),
      nToE: !!findRailPath({x:5,y:2,layer:'rail'}, {x:8,y:5,layer:'rail'}),
      nToW: !!findRailPath({x:5,y:2,layer:'rail'}, {x:2,y:5,layer:'rail'}),
      sToE: !!findRailPath({x:5,y:8,layer:'rail'}, {x:8,y:5,layer:'rail'}),
      sToW: !!findRailPath({x:5,y:8,layer:'rail'}, {x:2,y:5,layer:'rail'}),
      eToN: !!findRailPath({x:8,y:5,layer:'rail'}, {x:5,y:2,layer:'rail'}),
      eToS: !!findRailPath({x:8,y:5,layer:'rail'}, {x:5,y:8,layer:'rail'}),
      wToN: !!findRailPath({x:2,y:5,layer:'rail'}, {x:5,y:2,layer:'rail'}),
      wToS: !!findRailPath({x:2,y:5,layer:'rail'}, {x:5,y:8,layer:'rail'}),
    };
  `);
  check('the crossing cell really does have all 4 directions connected (precondition)', s.allFourConnected);
  check('N-S straight through is allowed', s.nToS);
  check('S-N straight through is allowed', s.sToN);
  check('E-W straight through is allowed', s.eToW);
  check('W-E straight through is allowed', s.wToE);
  check('N-E turn is blocked (no path)', !s.nToE);
  check('N-W turn is blocked (no path)', !s.nToW);
  check('S-E turn is blocked (no path)', !s.sToE);
  check('S-W turn is blocked (no path)', !s.sToW);
  check('E-N turn is blocked (no path)', !s.eToN);
  check('E-S turn is blocked (no path)', !s.eToS);
  check('W-N turn is blocked (no path)', !s.wToN);
  check('W-S turn is blocked (no path)', !s.wToS);
});

section('Test 2 — a T/3-way rail junction is unaffected: turning is still fully allowed', () => {
  const ctx = newGameContext();
  const s = run(ctx, `
    // A T-junction at (5,5): N-S line y=2..8, plus a single east stub —
    // only 3 directions connected (N, S, E), never a full crossing.
    for(let y=2; y<=8; y++) cmdBuildTrack(5, y, 'rail', true);
    for(let x=5; x<=8; x++) cmdBuildTrack(x, 5, 'rail', true);
    const junction = getCell(5,5).layers.ground.rail;
    return {
      threeConnected: junction.edges.N && junction.edges.S && junction.edges.E && !junction.edges.W,
      nToS: !!findRailPath({x:5,y:2,layer:'rail'}, {x:5,y:8,layer:'rail'}),
      nToE: !!findRailPath({x:5,y:2,layer:'rail'}, {x:8,y:5,layer:'rail'}),
      sToE: !!findRailPath({x:5,y:8,layer:'rail'}, {x:8,y:5,layer:'rail'}),
      eToN: !!findRailPath({x:8,y:5,layer:'rail'}, {x:5,y:2,layer:'rail'}),
      eToS: !!findRailPath({x:8,y:5,layer:'rail'}, {x:5,y:8,layer:'rail'}),
    };
  `);
  check('the junction really only has 3 directions connected (precondition — not a crossing)', s.threeConnected);
  check('N-S straight through still works', s.nToS);
  check('N-E turn is still allowed (a real switch, not a crossing)', s.nToE);
  check('S-E turn is still allowed', s.sToE);
  check('E-N turn is still allowed', s.eToN);
  check('E-S turn is still allowed', s.eToS);
});

section('Test 3 — a one-way block on the straight-through side still applies at a crossing', () => {
  const ctx = newGameContext();
  const s = run(ctx, `
    for(let y=2; y<=8; y++) cmdBuildTrack(5, y, 'rail', true);
    for(let x=2; x<=8; x++) cmdBuildTrack(x, 5, 'rail', true);
    // cmdToggleOneWay(x1,y1,x2,y2,...) allows the x1->x2 direction and
    // blocks its reverse — (5,4)->(5,5) allowed, (5,5)->(5,4) (northbound
    // departure from the crossing) blocked.
    cmdToggleOneWay(5, 4, 5, 5, 'rail');
    return {
      sToNBlocked: !findRailPath({x:5,y:8,layer:'rail'}, {x:5,y:2,layer:'rail'}), // needs to depart north through (5,5)
      nToSStillWorks: !!findRailPath({x:5,y:2,layer:'rail'}, {x:5,y:8,layer:'rail'}), // departs south, untouched
    };
  `);
  check('a one-way block on the straight-through exit still blocks that direction at a crossing', s.sToNBlocked);
  check('the other straight-through direction is unaffected', s.nToSStillWorks);
});

section('Test 4 — end to end: a real train can load at a depot reached straight through a crossing, but is blocked from a depot only reachable by turning at one', () => {
  const ctx = newGameContext();
  // "+" crossing at (10,6): north arm x=10,y=2..6; south arm x=10,y=6..9;
  // east arm y=6,x=10..18. A Train Yard sits just north of the north arm;
  // Depot A is straight-through south of the crossing (reached via a plain
  // 2-degree corner off the south arm, never a 4-way cell); Depot B sits
  // off the east arm, pushed well clear of Depot A (§ Rail Depot
  // forwarding's findLinkedIndustry walks any TOUCHING building with
  // Storage, which includes another Depot — the two must not be adjacent,
  // or Depot A would "forward" straight to Depot B's own stock regardless
  // of track) — reachable from the Yard/Depot A side ONLY by turning
  // (N<->E) at the crossing itself, which should never be possible.
  const ids = run(ctx, `
    world.treasury = 1000000;
    for(let y=2; y<=6; y++) cmdBuildTrack(10, y, 'rail', true); // north arm
    for(let y=6; y<=9; y++) cmdBuildTrack(10, y, 'rail', true); // south arm
    for(let x=10; x<=18; x++) cmdBuildTrack(x, 6, 'rail', true); // east arm
    for(let x=6; x<=10; x++) cmdBuildTrack(x, 6, 'rail', true); // west arm — needed so (10,6) is a genuine 4-way crossing, not just a T-junction

    cmdBuildBuilding('trainyard', 9, 0, 'small'); // touches (10,2), the north arm's top tile

    // Depot A: siding column x=11,y=9..12, its top tile (11,9) touching the
    // south arm's bottom tile (10,9) — a plain corner, not a crossing.
    for(let y=9; y<=12; y++) cmdBuildTrack(11, y, 'rail', true);
    cmdBuildBuilding('depot', 12, 9, 'large', 'ns', 'ore');

    // Depot B: siding row y=7,x=18..21, its west tile (18,7) touching the
    // east arm's end tile (18,6) — also a plain corner, and far enough
    // from Depot A (x=12..13) that the two buildings never touch.
    for(let x=18; x<=21; x++) cmdBuildTrack(x, 7, 'rail', true);
    cmdBuildBuilding('depot', 18, 8, 'large', 'ew', 'ore');

    const depots = [...world.entities.values()].filter(e=>e.kind==='building' && e.type==='depot');
    const depotAId = depots.find(d=>d.x===12).id;
    const depotBId = depots.find(d=>d.x===18).id;
    world.entities.get(depotAId).outStock = 50;

    cmdAssembleTrain(10, 2, 'diesel', 'ore_wagon', 1); // track tile touching the Yard
    const train = [...world.entities.values()].find(e=>e.kind==='vehicle' && isTrain(e.id));
    cmdSetOrders(train, [
      {nodeId: depotAId, action:'load_full', resource:'ore'},
      {nodeId: depotBId, action:'unload_all', resource:'ore'},
    ]);
    return {trainId: train.id, depotAId, depotBId};
  `);

  let reachedDepotA = false;
  for(let i=0;i<400;i++){
    run(ctx, `simTick();`);
    const t = run(ctx, `const t = world.entities.get(${ids.trainId}); return {x:t.x, y:t.y, cargoAmount:t.cargoAmount};`);
    if(t.cargoAmount > 0) reachedDepotA = true;
  }
  check('the train successfully reached Depot A straight through the crossing and loaded ore', reachedDepotA);
  const finalState = run(ctx, `const t = world.entities.get(${ids.trainId}); return {state: t.state, cargoAmount: t.cargoAmount};`);
  check('the train is blocked trying to reach Depot B (never turns at the crossing to get there)',
    finalState.state==='blocked' && finalState.cargoAmount > 0, `finalState=${JSON.stringify(finalState)}`);
  const depotBStock = run(ctx, `return world.entities.get(${ids.depotBId}).outStock;`);
  check('no ore was ever delivered to Depot B', depotBStock === 0, `depotB stock: ${depotBStock}`);
});

console.log(failures===0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
