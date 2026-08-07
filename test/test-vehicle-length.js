// Regression tests for quarter-tile vehicle lengths (§ vehicle length
// quantization) — every truck, engine, and wagon's content-pack lengthTiles
// must be a multiple of 0.25, and an individual vehicle/train's own
// randomized length (Movement.length, see randomizedMovement) is snapped to
// the nearest 0.25 too, not left as an arbitrary float. Run against the
// real index.html code via test/harness.js.
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

function isQuarterTile(n){ return Math.abs(Math.round(n*4) - n*4) < 1e-9; }

section('Test 1 — the shipped content pack\'s lengthTiles are all quarter-tile multiples', () => {
  const ctx = newGameContext();
  const out = run(ctx, `
    return {
      vehicles: Object.entries(VEHICLE_DEFS).map(([id,v]) => [id, v.lengthTiles]),
      engines: Object.entries(ENGINE_DEFS).map(([id,e]) => [id, e.lengthTiles]),
      wagons: Object.entries(WAGON_DEFS).map(([id,w]) => [id, w.lengthTiles]),
    };
  `);
  for(const [id, len] of [...out.vehicles, ...out.engines, ...out.wagons]){
    check(`"${id}" lengthTiles (${len}) is a multiple of 0.25`, isQuarterTile(len));
  }
});

section('Test 2 — an individual truck\'s randomized length always snaps to a quarter tile', () => {
  // Uses the flatbed (base lengthTiles 1.5), not the bulk (1.25) — the
  // bulk's own +/-10% randomization window happens to fall entirely
  // within a single 0.25 bucket once snapped (there's no requirement that
  // every base length straddle a bucket boundary), so it alone wouldn't
  // demonstrate the snapping actually varies with the draw; the flatbed's
  // wider absolute window does.
  const ctx = newGameContext();
  const lengths = run(ctx, `
    world.treasury = 1000000;
    cmdBuildRoad(0, 0, 'ground', true);
    const out = [];
    for(let i=0;i<50;i++){
      cmdPurchaseVehicle(0, 0, 'flatbed');
    }
    for(const id of [...world.entities.values()].filter(e=>e.kind==='vehicle').map(e=>e.id)){
      out.push(world.entities.get(id).length);
    }
    return out;
  `);
  check('50 randomized trucks were actually created', lengths.length === 50, `got ${lengths.length}`);
  check('every one of them has a length that is an exact multiple of 0.25',
    lengths.every(isQuarterTile), JSON.stringify(lengths.filter(l=>!isQuarterTile(l))));
  check('the randomization still produces some variety across a wide enough base length',
    new Set(lengths).size > 1, JSON.stringify(lengths));
});

section('Test 3 — an assembled train\'s randomized length always snaps to a quarter tile too', () => {
  const ctx = newGameContext();
  const lengths = run(ctx, `
    const out = [];
    for(let i=0;i<30;i++){
      out.push(createTrain(0, 0, 'diesel', 'ore_wagon', 1 + (i%6)).length);
    }
    return out;
  `);
  check('every assembled train has a length that is an exact multiple of 0.25',
    lengths.every(isQuarterTile), JSON.stringify(lengths.filter(l=>!isQuarterTile(l))));
});

console.log(failures===0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
