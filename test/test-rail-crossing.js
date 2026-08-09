// Regression tests for rail crossings and switches (§ Rail crossings, §
// Addendum — Diagonal connections, § Addendum — T-junctions are switches
// too) — a rail cell with 3 or more of its 4 lateral directions connected
// (a T/3-way junction just as much as a genuine 4-way crossing) is always
// independent straight-through line(s), never automatically a switch: this
// game has no points/switch equipment, so travel through such a cell is
// restricted to continuing straight on whichever line was actually entered
// on, UNLESS the player has thrown a corner switch there (§ Addendum —
// Diagonal connections) enabling that specific turn. Run against the real
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

section('Test 2 — a T/3-way rail junction behaves exactly like a 4-way crossing: straight-through works, every turn is blocked by default', () => {
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
      sToN: !!findRailPath({x:5,y:8,layer:'rail'}, {x:5,y:2,layer:'rail'}),
      nToE: !!findRailPath({x:5,y:2,layer:'rail'}, {x:8,y:5,layer:'rail'}),
      sToE: !!findRailPath({x:5,y:8,layer:'rail'}, {x:8,y:5,layer:'rail'}),
      eToN: !!findRailPath({x:8,y:5,layer:'rail'}, {x:5,y:2,layer:'rail'}),
      eToS: !!findRailPath({x:8,y:5,layer:'rail'}, {x:5,y:8,layer:'rail'}),
    };
  `);
  check('the junction really only has 3 directions connected (precondition)', s.threeConnected);
  check('N-S straight through is allowed', s.nToS);
  check('S-N straight through is allowed', s.sToN);
  check('N-E turn is blocked by default (no path)', !s.nToE);
  check('S-E turn is blocked by default (no path)', !s.sToE);
  check('E-N turn is blocked by default (no path)', !s.eToN);
  check('E-S turn is blocked by default (no path)', !s.eToS);
});

section('Test 2b — cmdToggleDiagonalConnection works at a T-junction the same way it does at a 4-way crossing, one corner at a time', () => {
  const ctx = newGameContext();
  const s = run(ctx, `
    // Same T-junction as Test 2: N-S line y=2..8, east stub x=5..8,y=5 —
    // missing the west side entirely, so only NE and SE are ever
    // buildable corners here (NW/SW would need a west side that was never
    // built).
    for(let y=2; y<=8; y++) cmdBuildTrack(5, y, 'rail', true);
    for(let x=5; x<=8; x++) cmdBuildTrack(x, 5, 'rail', true);

    cmdToggleDiagonalConnection(5,5, 6,4, 'rail'); // NE corner: (6,4) is diagonally NE of the junction
    const withNE = {
      nToE: !!findRailPath({x:5,y:2,layer:'rail'}, {x:8,y:5,layer:'rail'}),
      eToN: !!findRailPath({x:8,y:5,layer:'rail'}, {x:5,y:2,layer:'rail'}),
      sToE: !!findRailPath({x:5,y:8,layer:'rail'}, {x:8,y:5,layer:'rail'}), // SE still off
      nToS: !!findRailPath({x:5,y:2,layer:'rail'}, {x:5,y:8,layer:'rail'}), // straight-through unaffected
    };
    cmdToggleDiagonalConnection(5,5, 6,4, 'rail'); // toggle NE back off
    const afterToggleOff = { nToE: !!findRailPath({x:5,y:2,layer:'rail'}, {x:8,y:5,layer:'rail'}) };

    cmdToggleDiagonalConnection(5,5, 6,6, 'rail'); // SE corner: (6,6) is diagonally SE of the junction
    const withSE = { sToE: !!findRailPath({x:5,y:8,layer:'rail'}, {x:8,y:5,layer:'rail'}) };

    // NW/SW have no west side to connect to here — rejected, not silently
    // toggled on as a switch that could never actually do anything.
    const nwRejected = (() => {
      cmdToggleDiagonalConnection(5,5, 4,4, 'rail'); // NW corner: (4,4)
      return {changed: trackAt(5,5,'rail').diagonalPairs.NW, warnLogs: pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg)};
    })();

    return {withNE, afterToggleOff, withSE, nwRejected};
  `);
  check('enabling the NE pair at a T-junction allows N<->E turning', s.withNE.nToE && s.withNE.eToN, JSON.stringify(s.withNE));
  check('enabling NE does not enable SE', !s.withNE.sToE);
  check('straight-through is unaffected by NE being enabled', s.withNE.nToS);
  check('toggling NE again turns it back off', !s.afterToggleOff.nToE);
  check('the SE pair works the same way, independently', s.withSE.sToE);
  check('NW is rejected — this T-junction has no west side to connect', !s.nwRejected.changed, JSON.stringify(s.nwRejected));
  check('the rejection explains the missing side', s.nwRejected.warnLogs.some(m=>/corner|side/i.test(m)), JSON.stringify(s.nwRejected.warnLogs));
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
    for(let x=6; x<=10; x++) cmdBuildTrack(x, 6, 'rail', true); // west arm — completes (10,6) to a genuine 4-way crossing

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

section('Test 5 — cmdToggleDiagonalConnection selectively enables turning through one corner of a crossing at a time', () => {
  const ctx = newGameContext();
  const s = run(ctx, `
    for(let y=2; y<=8; y++) cmdBuildTrack(5, y, 'rail', true);
    for(let x=2; x<=8; x++) cmdBuildTrack(x, 5, 'rail', true);
    const beforeAny = {
      nToE: !!findRailPath({x:5,y:2,layer:'rail'}, {x:8,y:5,layer:'rail'}),
      nToW: !!findRailPath({x:5,y:2,layer:'rail'}, {x:2,y:5,layer:'rail'}),
      sToE: !!findRailPath({x:5,y:8,layer:'rail'}, {x:8,y:5,layer:'rail'}),
      sToW: !!findRailPath({x:5,y:8,layer:'rail'}, {x:2,y:5,layer:'rail'}),
      nToS: !!findRailPath({x:5,y:2,layer:'rail'}, {x:5,y:8,layer:'rail'}),
    };

    cmdToggleDiagonalConnection(5,5, 6,4, 'rail'); // NE corner: (6,4) is diagonally NE of the crossing
    const withNE = {
      nToE: !!findRailPath({x:5,y:2,layer:'rail'}, {x:8,y:5,layer:'rail'}), // N side <-> E side: enabled
      eToN: !!findRailPath({x:8,y:5,layer:'rail'}, {x:5,y:2,layer:'rail'}), // same pair, reverse direction
      nToW: !!findRailPath({x:5,y:2,layer:'rail'}, {x:2,y:5,layer:'rail'}), // NW still off
      sToE: !!findRailPath({x:5,y:8,layer:'rail'}, {x:8,y:5,layer:'rail'}), // SE still off
      nToS: !!findRailPath({x:5,y:2,layer:'rail'}, {x:5,y:8,layer:'rail'}), // straight-through unaffected
      diagonalPairs: {...trackAt(5,5,'rail').diagonalPairs}, // snapshot now — track.diagonalPairs is a live reference, and later toggles below would otherwise be reflected retroactively in this same captured object
    };

    cmdToggleDiagonalConnection(5,5, 6,4, 'rail'); // toggle NE back off
    const afterToggleOff = {
      nToE: !!findRailPath({x:5,y:2,layer:'rail'}, {x:8,y:5,layer:'rail'}),
    };

    // The other 3 corners, one at a time.
    cmdToggleDiagonalConnection(5,5, 4,4, 'rail'); // NW: (4,4) is diagonally NW of the crossing
    const withNW = { nToW: !!findRailPath({x:5,y:2,layer:'rail'}, {x:2,y:5,layer:'rail'}) };
    cmdToggleDiagonalConnection(5,5, 4,4, 'rail');

    cmdToggleDiagonalConnection(5,5, 6,6, 'rail'); // SE: (6,6) is diagonally SE of the crossing
    const withSE = { sToE: !!findRailPath({x:5,y:8,layer:'rail'}, {x:8,y:5,layer:'rail'}) };
    cmdToggleDiagonalConnection(5,5, 6,6, 'rail');

    cmdToggleDiagonalConnection(5,5, 4,6, 'rail'); // SW: (4,6) is diagonally SW of the crossing
    const withSW = { sToW: !!findRailPath({x:5,y:8,layer:'rail'}, {x:2,y:5,layer:'rail'}) };
    cmdToggleDiagonalConnection(5,5, 4,6, 'rail');

    return {beforeAny, withNE, afterToggleOff, withNW, withSE, withSW};
  `);
  check('before any toggle, every turn is blocked (baseline crossing behavior)',
    !s.beforeAny.nToE && !s.beforeAny.nToW && !s.beforeAny.sToE && !s.beforeAny.sToW, JSON.stringify(s.beforeAny));
  check('straight-through still works before any toggle', s.beforeAny.nToS);
  check('enabling the NE pair allows N<->E turning', s.withNE.nToE && s.withNE.eToN, JSON.stringify(s.withNE));
  check('enabling NE does not enable NW', !s.withNE.nToW);
  check('enabling NE does not enable SE', !s.withNE.sToE);
  check('straight-through is unaffected by NE being enabled', s.withNE.nToS);
  check('the diagonalPairs record reflects exactly NE enabled', s.withNE.diagonalPairs.NE===true && !s.withNE.diagonalPairs.NW && !s.withNE.diagonalPairs.SE && !s.withNE.diagonalPairs.SW, JSON.stringify(s.withNE.diagonalPairs));
  check('toggling NE again turns it back off', !s.afterToggleOff.nToE);
  check('the NW pair works the same way, independently', s.withNW.nToW);
  check('the SE pair works the same way, independently', s.withSE.sToE);
  check('the SW pair works the same way, independently', s.withSW.sToW);
});

section('Test 6 — cmdToggleDiagonalConnection rejects invalid targets with a clear message', () => {
  const ctx = newGameContext();
  const out = run(ctx, `
    for(let y=2; y<=8; y++) cmdBuildTrack(5, y, 'rail', true);
    for(let x=2; x<=8; x++) cmdBuildTrack(x, 5, 'rail', true); // a real 4-way crossing at (5,5)
    for(let y=2; y<=8; y++) cmdBuildTrack(15, y, 'rail', true); // a plain straight line elsewhere, not a crossing

    const notDiagonal = (() => {
      cmdToggleDiagonalConnection(5,5, 5,4, 'rail'); // (5,4) is orthogonally, not diagonally, adjacent
      return {changed: trackAt(5,5,'rail').diagonalPairs.NE, warnLogs: pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg)};
    })();

    const notACrossing = (() => {
      cmdToggleDiagonalConnection(15,5, 16,4, 'rail'); // (15,5) only has 2 directions connected
      return {changed: trackAt(15,5,'rail').diagonalPairs.NE, warnLogs: pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg)};
    })();

    const wrongKind = (() => {
      cmdBuildRoad(20, 5, 'ground', true);
      cmdToggleDiagonalConnection(20,5, 21,4, 'ground');
      return {warnLogs: pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg)};
    })();

    return {notDiagonal, notACrossing, wrongKind};
  `);
  check('a non-diagonal second click is rejected, no pair changed', !out.notDiagonal.changed, JSON.stringify(out.notDiagonal));
  check('rejection names the corner-click requirement', out.notDiagonal.warnLogs.some(m=>/diagonal|corner/i.test(m)), JSON.stringify(out.notDiagonal.warnLogs));
  check('a non-crossing first tile is rejected, no pair changed', !out.notACrossing.changed, JSON.stringify(out.notACrossing));
  check('rejection names the crossing requirement', out.notACrossing.warnLogs.some(m=>/crossing/i.test(m)), JSON.stringify(out.notACrossing.warnLogs));
  check('a road-layer attempt is rejected — diagonal connections are rail-only', out.wrongKind.warnLogs.some(m=>/rail/i.test(m)), JSON.stringify(out.wrongKind.warnLogs));
});

section('Test 7 — end to end: a real train uses an enabled diagonal switch to reach a depot that plain straight-through crossing behavior can\'t', () => {
  const ctx = newGameContext();
  // Same "+" crossing layout as Test 4, but this time Depot B (off the east
  // arm) becomes reachable once the crossing's SE corner switch is enabled.
  // The train's actual route to Depot B departs FROM Depot A, heading back
  // NORTH up the south arm — so it enters the crossing via its SOUTH side
  // this time (not the north side it used on the very first, straight-
  // through leg from the Yard) — turning onto the east arm from the south
  // side is the SE pair, not NE.
  const ids = run(ctx, `
    world.treasury = 1000000;
    for(let y=2; y<=6; y++) cmdBuildTrack(10, y, 'rail', true); // north arm
    for(let y=6; y<=9; y++) cmdBuildTrack(10, y, 'rail', true); // south arm
    for(let x=10; x<=18; x++) cmdBuildTrack(x, 6, 'rail', true); // east arm
    for(let x=6; x<=10; x++) cmdBuildTrack(x, 6, 'rail', true); // west arm

    cmdBuildBuilding('trainyard', 9, 0, 'small'); // touches (10,2)

    for(let y=9; y<=12; y++) cmdBuildTrack(11, y, 'rail', true);
    cmdBuildBuilding('depot', 12, 9, 'large', 'ns', 'ore'); // Depot A, off the south arm

    for(let x=18; x<=21; x++) cmdBuildTrack(x, 7, 'rail', true);
    cmdBuildBuilding('depot', 18, 8, 'large', 'ew', 'ore'); // Depot B, off the east arm

    // Enable the SE corner: (11,7) is diagonally SE of the crossing (10,6)
    // — entering the crossing from the south (heading north, on the way
    // back from Depot A) can now turn onto the east arm.
    cmdToggleDiagonalConnection(10, 6, 11, 7, 'rail');

    const depots = [...world.entities.values()].filter(e=>e.kind==='building' && e.type==='depot');
    const depotAId = depots.find(d=>d.x===12).id;
    const depotBId = depots.find(d=>d.x===18).id;
    world.entities.get(depotAId).outStock = 50;

    cmdAssembleTrain(10, 2, 'diesel', 'ore_wagon', 1);
    const train = [...world.entities.values()].find(e=>e.kind==='vehicle' && isTrain(e.id));
    cmdSetOrders(train, [
      {nodeId: depotAId, action:'load_full', resource:'ore'},
      {nodeId: depotBId, action:'unload_all', resource:'ore'},
    ]);
    return {trainId: train.id, depotBId};
  `);

  for(let i=0;i<400;i++) run(ctx, `simTick();`);
  const depotBStock = run(ctx, `return world.entities.get(${ids.depotBId}).outStock;`);
  check('ore actually reached Depot B, now that the SE switch is enabled', depotBStock > 0, `depotB stock: ${depotBStock}`);
});

console.log(failures===0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
