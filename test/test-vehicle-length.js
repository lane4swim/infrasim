// Regression tests for vehicle lengths (§ vehicle length quantization; §
// Vehicle length randomization removed) — every truck, engine, and wagon's
// content-pack lengthTiles must be a multiple of 0.25, and an individual
// vehicle/train's own Movement.length is now exactly that (or, for a train,
// the exact engine+wagon*count sum) — deterministic, not randomized per
// instance. Run against the real index.html code via test/harness.js.
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

section('Test 2 — every truck\'s length is exactly its content-pack lengthTiles, not randomized', () => {
  const ctx = newGameContext();
  const result = run(ctx, `
    world.treasury = 1000000;
    cmdBuildRoad(0, 0, 'ground', true);
    for(let i=0;i<50;i++){
      cmdPurchaseVehicle(0, 0, 'flatbed');
    }
    const lengths = [...world.entities.values()].filter(e=>e.kind==='vehicle').map(e=>e.length);
    return {lengths, defLength: VEHICLE_DEFS.flatbed.lengthTiles};
  `);
  check('50 trucks were actually created', result.lengths.length === 50, `got ${result.lengths.length}`);
  check('every one of them has a length that is an exact multiple of 0.25',
    result.lengths.every(isQuarterTile), JSON.stringify(result.lengths.filter(l=>!isQuarterTile(l))));
  check('every truck\'s length is identical (deterministic, no per-instance variation)',
    new Set(result.lengths).size === 1, JSON.stringify(result.lengths));
  check('that one length is exactly the content pack\'s own flatbed lengthTiles',
    result.lengths[0] === result.defLength, `got ${result.lengths[0]}, expected ${result.defLength}`);
});

section('Test 3 — an assembled train\'s length is exactly engine + wagon*count, not randomized', () => {
  const ctx = newGameContext();
  const results = run(ctx, `
    const out = [];
    for(let i=1;i<=6;i++){
      const wagonCount = i;
      const train = createTrain(0, 0, 'diesel', 'ore_wagon', wagonCount);
      const expected = ENGINE_DEFS.diesel.lengthTiles + WAGON_DEFS.ore_wagon.lengthTiles * wagonCount;
      out.push({wagonCount, length: train.length, expected});
    }
    return out;
  `);
  for(const {wagonCount, length, expected} of results){
    check(`a train with ${wagonCount} wagon(s) has length exactly engine + wagon*count (${expected})`,
      length === expected, `got ${length}, expected ${expected}`);
  }
  check('every assembled train\'s length is still a quarter-tile multiple',
    results.every(r=>isQuarterTile(r.length)), JSON.stringify(results.filter(r=>!isQuarterTile(r.length))));
});

console.log(failures===0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
