// Regression tests for isometric sprites (§ Isometric sprites) — content
// packs can optionally give any building/vehicle/engine/wagon a `sprites`
// object with one entry per direction (n/s/e/w mandatory once `sprites` is
// present at all; ne/nw/se/sw reserved-but-optional, since the sim grid is
// strictly 4-connected and never selects them; `menu` optional too) plus
// the shared spriteDataUri decoder both render.js and ui.js use. Run
// against the real index.html code via test/harness.js.
//
// render.js's actual drawing (direction resolution, the Image cache,
// drawImage) isn't exercised here — it needs a real canvas, which this
// headless harness deliberately doesn't provide (see harness.js's own
// header comment: it loads loader.js + sim/*.js only). That side is
// verified in a real browser via Playwright instead.
'use strict';
const {newGameContext, run, extractContentPackJson} = require('./harness.js');
const path = require('path');

let failures = 0;
function check(name, cond, detail){
  if(cond){ console.log(`  ok - ${name}`); }
  else { failures++; console.log(`  FAIL - ${name}${detail ? ' :: '+detail : ''}`); }
}
function section(name, fn){
  console.log(name);
  fn();
}

const htmlPath = path.join(__dirname, '..', 'index.html');
const realPackJson = extractContentPackJson(htmlPath);
const realPack = JSON.parse(realPackJson);

const svgSprite = {type:'svg', markup:'<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'};
const pngSprite = {type:'png', dataUri:'data:image/png;base64,AAAA'};
const validSprites = {n:svgSprite, s:svgSprite, e:svgSprite, w:svgSprite, menu:pngSprite};

section('Test 1 — validateSprites accepts a well-formed sprites object on every entity type', () => {
  const ctx = newGameContext();

  function expectOk(name, mutate){
    const pack = JSON.parse(JSON.stringify(realPack));
    mutate(pack);
    const result = run(ctx, `
      try {
        validateContentPack(${JSON.stringify(pack)});
        return {threw:false};
      } catch(e){
        return {threw:true, message:e.message};
      }
    `);
    check(name, !result.threw, result.message);
  }

  expectOk('a building with n/s/e/w + menu sprites validates',
    pack => { pack.buildings.mine.sprites = validSprites; });
  expectOk('a vehicle with n/s/e/w + menu sprites validates',
    pack => { pack.vehicles.bulk.sprites = validSprites; });
  expectOk('an engine with n/s/e/w + menu sprites validates',
    pack => { pack.engines.diesel.sprites = validSprites; });
  expectOk('a wagon with n/s/e/w + menu sprites validates',
    pack => { pack.wagons.ore_wagon.sprites = validSprites; });
  expectOk('the reserved diagonal keys (ne/nw/se/sw) are accepted when present',
    pack => { pack.buildings.mine.sprites = {...validSprites, ne:svgSprite, nw:svgSprite, se:svgSprite, sw:svgSprite}; });
  expectOk('omitting sprites entirely still validates (every existing def)',
    pack => {});
});

section('Test 2 — validateSprites rejects deliberately-broken fixtures', () => {
  const ctx = newGameContext();

  function expectThrow(name, mutate, expectedSubstring){
    const pack = JSON.parse(JSON.stringify(realPack));
    mutate(pack);
    const result = run(ctx, `
      try {
        validateContentPack(${JSON.stringify(pack)});
        return {threw:false};
      } catch(e){
        return {threw:true, message:e.message};
      }
    `);
    check(name, result.threw && result.message.includes(expectedSubstring),
      `threw=${result.threw} message=${JSON.stringify(result.message)}`);
  }

  expectThrow('missing the required "n" direction is rejected',
    pack => { const {n, ...rest} = validSprites; pack.buildings.mine.sprites = rest; },
    'missing required direction "n"');

  expectThrow('missing the required "e" direction is rejected',
    pack => { const {e, ...rest} = validSprites; pack.vehicles.bulk.sprites = rest; },
    'missing required direction "e"');

  expectThrow('an unknown sprite key is rejected',
    pack => { pack.buildings.mine.sprites = {...validSprites, northeast:svgSprite}; },
    'unknown key "northeast"');

  expectThrow('an invalid sprite type is rejected',
    pack => { pack.buildings.mine.sprites = {...validSprites, n:{type:'gif', markup:'x'}}; },
    'invalid "type"');

  expectThrow('an svg sprite missing markup is rejected',
    pack => { pack.buildings.mine.sprites = {...validSprites, n:{type:'svg'}}; },
    'missing "markup"');

  expectThrow('a png sprite missing dataUri is rejected',
    pack => { pack.buildings.mine.sprites = {...validSprites, n:{type:'png'}}; },
    'valid "dataUri"');

  expectThrow('a png sprite with a non-PNG dataUri is rejected',
    pack => { pack.buildings.mine.sprites = {...validSprites, n:{type:'png', dataUri:'data:image/jpeg;base64,AAAA'}}; },
    'valid "dataUri"');

  expectThrow('sprites as a non-object (e.g. an array) is rejected',
    pack => { pack.buildings.mine.sprites = ['not', 'an', 'object']; },
    'invalid "sprites"');

  expectThrow('the reserved diagonal keys stay optional even without n/s/e/w missing, but a malformed one is still caught',
    pack => { pack.buildings.mine.sprites = {...validSprites, ne:{type:'svg'}}; },
    'missing "markup"');
});

section('Test 3 — spriteDataUri decodes both sprite types, matching what render.js/ui.js consume', () => {
  const ctx = newGameContext();

  const svgResult = run(ctx, `return spriteDataUri(${JSON.stringify(svgSprite)});`);
  check('an svg sprite decodes to a data:image/svg+xml URI', svgResult.startsWith('data:image/svg+xml,'));
  check('the svg URI percent-encodes the markup (round-trips via decodeURIComponent)',
    decodeURIComponent(svgResult.slice('data:image/svg+xml,'.length)) === svgSprite.markup);

  const pngResult = run(ctx, `return spriteDataUri(${JSON.stringify(pngSprite)});`);
  check('a png sprite passes its dataUri straight through unchanged', pngResult === pngSprite.dataUri);

  const nullResult = run(ctx, `return spriteDataUri(undefined);`);
  check('no sprite decodes to null (the "draw the procedural fallback" signal)', nullResult === null);
});

section('Test 4 — a later content-pack block overriding a building by id carries its own sprites through the merge', () => {
  // mergeContentPacks replaces an id's entry wholesale (not a per-field
  // merge — see loader.js's own comment on this), so the override pack
  // must restate the whole mine definition, sprites included, exactly like
  // any other override-style addon pack would.
  const overrideMine = JSON.parse(JSON.stringify(realPack.buildings.mine));
  overrideMine.sprites = validSprites;
  const overridePack = JSON.stringify({buildings: {mine: overrideMine}});

  const ctx = newGameContext({contentPacks: [realPackJson, overridePack]});
  const result = run(ctx, `return BUILDING_DEFS.mine.sprites;`);
  check('the merged BUILDING_DEFS.mine carries the override pack\'s sprites', result && result.menu && result.menu.type==='png',
    JSON.stringify(result));
  check('the merged BUILDING_DEFS.mine keeps its original non-sprite fields (buildCost survived the merge)',
    run(ctx, `return BUILDING_DEFS.mine.buildCost;`) === realPack.buildings.mine.buildCost);
});

console.log(failures===0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
