// Regression tests for building foundations (§ Building foundations) — an
// optional per-building content-pack field, blockedUndergroundLevels (a
// non-negative integer, default 0), saying how many underground levels
// (starting from level 1, right below ground) that building's own
// foundation physically occupies. Track can't be built there (in either
// order: existing building blocking new track, or existing track blocking
// a new building), but any level DEEPER than the foundation is unaffected.
// The shipped pack gives the Mine blockedUndergroundLevels:2 and the Mill
// blockedUndergroundLevels:1; every other building omits it (0, unchanged
// from before this feature existed). Run against the real index.html code
// via test/harness.js.
'use strict';
const {newGameContext, run, extractContentPackJson} = require('./harness.js');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'index.html');
const realPack = JSON.parse(extractContentPackJson(htmlPath));

let failures = 0;
function check(name, cond, detail){
  if(cond){ console.log(`  ok - ${name}`); }
  else { failures++; console.log(`  FAIL - ${name}${detail ? ' :: '+detail : ''}`); }
}
function section(name, fn){
  console.log(name);
  fn();
}

section('Test 1 — content-pack validation', () => {
  const ctx = newGameContext(); // validateContentPack is defined here; call it directly with bad data

  function tryPack(mutate){
    const pack = JSON.parse(JSON.stringify(realPack)); // deep clone, don't mutate the shared real pack
    mutate(pack);
    return run(ctx, `
      try {
        validateContentPack(${JSON.stringify(pack)});
        return {ok: true};
      } catch(e) {
        return {ok: false, message: e.message};
      }
    `);
  }

  const negative = tryPack(p => { p.buildings.mine.blockedUndergroundLevels = -1; });
  check('a negative blockedUndergroundLevels is rejected', !negative.ok && /blockedUndergroundLevels/.test(negative.message), JSON.stringify(negative));

  const fractional = tryPack(p => { p.buildings.mine.blockedUndergroundLevels = 1.5; });
  check('a non-integer blockedUndergroundLevels is rejected', !fractional.ok && /blockedUndergroundLevels/.test(fractional.message), JSON.stringify(fractional));

  const valid = tryPack(p => { p.buildings.mine.blockedUndergroundLevels = 3; });
  check('a valid non-negative integer is accepted', valid.ok, JSON.stringify(valid));

  const omitted = tryPack(p => { delete p.buildings.station.blockedUndergroundLevels; });
  check('omitting the field entirely is valid (defaults to 0)', omitted.ok, JSON.stringify(omitted));
});

section('Test 2 — the shipped Mine (blockedUndergroundLevels: 2) blocks levels 1-2, allows level 3', () => {
  const ctx = newGameContext();
  const setup = run(ctx, `
    cmdBuildBuilding('mine', 0, 0, 'small');
    return {blocked: BUILDING_DEFS.mine.blockedUndergroundLevels};
  `);
  check('the shipped Mine def has blockedUndergroundLevels 2', setup.blocked === 2, JSON.stringify(setup));

  const level1 = run(ctx, `
    cmdBuildRoad(0,0,'underground',true);
    return {built: trackAt(0,0,'underground').track, warnLogs: pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg)};
  `);
  check('level 1 track under the Mine is rejected', !level1.built, JSON.stringify(level1));
  check('rejection names the Mine and the blocked level', level1.warnLogs.some(m=>/Mine/.test(m) && /level 1/.test(m)), JSON.stringify(level1.warnLogs));

  const level2 = run(ctx, `
    cmdBuildRoad(0,0,'underground2',true);
    return {built: trackAt(0,0,'underground2').track};
  `);
  check('level 2 track under the Mine is also rejected', !level2.built, JSON.stringify(level2));

  // Fresh context — pendingLogs accumulates across run() calls within one
  // context (it's only ever drained by the real snapshot pipeline, which
  // this harness doesn't exercise), so checking "no warnings" here needs
  // a clean slate rather than the level1/level2 warnings still sitting in
  // the same array.
  const level3 = run(newGameContext(), `
    cmdBuildBuilding('mine', 0, 0, 'small');
    cmdBuildRoad(0,0,'underground3',true);
    return {built: trackAt(0,0,'underground3').track, warnLogs: pendingLogs.filter(l=>l.cls==='warn')};
  `);
  check('level 3 track under the Mine — deeper than its foundation — is allowed', level3.built === true, JSON.stringify(level3));
  check('no warnings building at the unblocked level', level3.warnLogs.length === 0, JSON.stringify(level3.warnLogs));
});

section('Test 3 — the shipped Mill (blockedUndergroundLevels: 1) blocks only level 1', () => {
  const ctx = newGameContext();
  run(ctx, `cmdBuildBuilding('mill', 0, 0, 'small');`);

  const level1 = run(ctx, `
    cmdBuildRoad(0,0,'underground',true);
    return trackAt(0,0,'underground').track;
  `);
  check('level 1 track under the Mill is rejected', level1 === false);

  const level2 = run(ctx, `
    cmdBuildRoad(0,0,'underground2',true);
    return trackAt(0,0,'underground2').track;
  `);
  check('level 2 track under the Mill — one level deeper than its foundation — is allowed', level2 === true);
});

section('Test 4 — a building with no foundation (omitted field) blocks nothing, exactly as before this feature', () => {
  const out = run(newGameContext(), `
    cmdBuildBuilding('station', 5, 5, 'small', 'S', 'ore');
    cmdBuildRoad(5,5,'underground',true);
    cmdBuildRoad(5,5,'underground2',true);
    return {
      hasField: BUILDING_DEFS.station.blockedUndergroundLevels,
      level1: trackAt(5,5,'underground').track,
      level2: trackAt(5,5,'underground2').track,
    };
  `);
  check('the Station def has no blockedUndergroundLevels set', !out.hasField, JSON.stringify(out));
  check('underground level 1 track under a Station is unaffected', out.level1 === true, JSON.stringify(out));
  check('underground level 2 track under a Station is unaffected', out.level2 === true, JSON.stringify(out));
});

section('Test 5 — the reverse case: a building can\'t be placed where a level its foundation would reach is already occupied', () => {
  const blockedByExisting = run(newGameContext(), `
    cmdBuildRoad(0,0,'underground2',true); // level 2 — within the Mine's 2-level foundation
    cmdBuildBuilding('mine', 0, 0, 'small');
    return {built: [...world.entities.values()].some(e=>e.type==='mine'), warnLogs: pendingLogs.filter(l=>l.cls==='warn').map(l=>l.msg)};
  `);
  check('placing a Mine over existing level-2 track is rejected', !blockedByExisting.built, JSON.stringify(blockedByExisting));
  check('rejection is the usual footprint-overlap message', blockedByExisting.warnLogs.some(m=>/overlaps/i.test(m)), JSON.stringify(blockedByExisting.warnLogs));

  const allowedDeeper = run(newGameContext(), `
    cmdBuildRoad(0,0,'underground3',true); // level 3 — deeper than the Mine's 2-level foundation
    cmdBuildBuilding('mine', 0, 0, 'small');
    return {built: [...world.entities.values()].some(e=>e.type==='mine'), warnLogs: pendingLogs.filter(l=>l.cls==='warn')};
  `);
  check('placing a Mine over track at a level deeper than its foundation is still allowed', allowedDeeper.built === true, JSON.stringify(allowedDeeper));
  check('no warnings placing it', allowedDeeper.warnLogs.length === 0, JSON.stringify(allowedDeeper.warnLogs));
});

console.log(failures===0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
