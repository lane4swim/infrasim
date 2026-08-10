// Regression tests for content-pack sprite sheets and infrastructure
// sprites (§ Content-pack sprite sheets, § SVG track sprites' content-pack
// addendum) — a pack can now ship one or more named SVG "sheets" (each
// holding any number of <symbol id="..."> pieces) and reference a symbol
// from any sprite slot (building/vehicle/engine/wagon `sprites`, or the new
// `infrastructureSprites` section for rail/road track material layers and
// the one-way-arrow/crossing-marker overlays), instead of needing separate
// inline markup per slot. Schema/validation only — the actual DOMParser-
// based symbol extraction and the rotation/mirror draw-time transform only
// run in a real browser (render.js), verified separately via Playwright.
// Run against the real index.html code via test/harness.js.
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
const realPack = JSON.parse(extractContentPackJson(htmlPath));

function expectResult(ctx, name, pack, expected){
  const result = run(ctx, `
    try {
      validateContentPack(${JSON.stringify(pack)});
      return {threw:false};
    } catch(e){
      return {threw:true, message:e.message};
    }
  `);
  if(expected===null){
    check(name, result.threw===false, `threw=${result.threw} message=${JSON.stringify(result.message)}`);
  } else {
    check(name, result.threw && result.message.includes(expected), `threw=${result.threw} message=${JSON.stringify(result.message)}`);
  }
}

const SAMPLE_SHEET_MARKUP = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40">' +
  '<symbol id="rail-ballast-straight" viewBox="0 0 80 40"><line x1="60" y1="10" x2="20" y2="30" stroke="#123" stroke-width="10"/></symbol>' +
  '<symbol id="yard-n" viewBox="0 0 100 100"><rect width="100" height="100" fill="#456"/></symbol>' +
  '</svg>';

section('Test 1 — a pack with a valid spriteSheets + infrastructureSprites section validates cleanly', () => {
  const ctx = newGameContext();
  const pack = JSON.parse(JSON.stringify(realPack));
  // Merged into the real pack's own spriteSheets, not replacing it outright
  // — the shipped buildings (mine/mill/town/... ) already reference their
  // own real sheets (baseIndustriesSheet/roadSheet/railSheet), so wholesale
  // replacing spriteSheets here would leave THOSE references dangling.
  pack.spriteSheets = { ...pack.spriteSheets, mySheet: { markup: SAMPLE_SHEET_MARKUP } };
  pack.infrastructureSprites = {
    rail: {
      ballast: { straight: { sheet:'mySheet', symbol:'rail-ballast-straight' } },
      nub: { type:'svg', markup: '<circle cx="40" cy="20" r="8" fill="#123"/>' },
    },
    road: {
      asphalt: { straight: { sheet:'mySheet', symbol:'rail-ballast-straight' } },
    },
    oneWayArrow: { type:'svg', markup: '<polygon points="12,5 0,0 0,10" fill="#f00"/>' },
    crossingMarker: { sheet:'mySheet', symbol:'yard-n' },
  };
  expectResult(ctx, 'validates with no error', pack, null);
});

section('Test 2 — a building sprite can reference a sprite sheet symbol too, not just inline markup', () => {
  const ctx = newGameContext();
  const pack = JSON.parse(JSON.stringify(realPack));
  pack.spriteSheets = { ...pack.spriteSheets, mySheet: { markup: SAMPLE_SHEET_MARKUP } };
  const someBuildingId = Object.keys(pack.buildings)[0];
  pack.buildings[someBuildingId].sprites = {
    n: { sheet:'mySheet', symbol:'yard-n' },
    s: { sheet:'mySheet', symbol:'yard-n' },
    e: { sheet:'mySheet', symbol:'yard-n' },
    w: { sheet:'mySheet', symbol:'yard-n' },
  };
  expectResult(ctx, 'validates with no error', pack, null);
});

section('Test 3 — validateContentPack rejects deliberately-broken sprite-sheet/infrastructure fixtures', () => {
  const ctx = newGameContext();

  function withSheet(){
    return { mySheet: { markup: SAMPLE_SHEET_MARKUP } };
  }

  let pack = JSON.parse(JSON.stringify(realPack));
  pack.spriteSheets = { badSheet: { markup: 'not an svg document' } };
  expectResult(ctx, 'a sprite sheet whose markup is not an <svg> document is rejected', pack, '<svg>');

  pack = JSON.parse(JSON.stringify(realPack));
  pack.spriteSheets = { ...pack.spriteSheets, ...withSheet() };
  pack.infrastructureSprites = { rail: { ballast: { straight: { sheet:'doesNotExist', symbol:'x' } } } };
  expectResult(ctx, 'infrastructureSprites referencing an undefined sprite sheet is rejected', pack, 'doesNotExist');

  pack = JSON.parse(JSON.stringify(realPack));
  pack.infrastructureSprites = { rail: { notARealLayer: { straight:{type:'svg',markup:'<circle/>'} } } };
  expectResult(ctx, 'infrastructureSprites.rail with an unknown layer key is rejected', pack, 'notARealLayer');

  pack = JSON.parse(JSON.stringify(realPack));
  pack.infrastructureSprites = { rail: { ballast: { notARealShape: {type:'svg',markup:'<circle/>'} } } };
  expectResult(ctx, 'infrastructureSprites.rail.ballast with an unknown shape key is rejected', pack, 'notARealShape');

  pack = JSON.parse(JSON.stringify(realPack));
  pack.infrastructureSprites = { road: { ballast: { straight: {type:'svg',markup:'<circle/>'} } } }; // 'ballast' is a rail-only layer name
  expectResult(ctx, 'infrastructureSprites.road with a rail-only layer key is rejected', pack, 'ballast');

  pack = JSON.parse(JSON.stringify(realPack));
  pack.infrastructureSprites = { notAValidTopKey: {} };
  expectResult(ctx, 'infrastructureSprites with an unknown top-level key is rejected', pack, 'notAValidTopKey');

  pack = JSON.parse(JSON.stringify(realPack));
  pack.infrastructureSprites = { oneWayArrow: { type:'svg' } }; // missing markup
  expectResult(ctx, 'a malformed marker spec (missing markup) is rejected', pack, 'markup');

  pack = JSON.parse(JSON.stringify(realPack));
  const someBuildingId = Object.keys(pack.buildings)[0];
  pack.buildings[someBuildingId].sprites = { n:{sheet:'doesNotExist',symbol:'x'}, s:{type:'svg',markup:'<circle/>'}, e:{type:'svg',markup:'<circle/>'}, w:{type:'svg',markup:'<circle/>'} };
  expectResult(ctx, 'a building sprite referencing an undefined sprite sheet is rejected', pack, 'doesNotExist');
});

section('Test 4 — multi-pack merge: an addon pack can override just infrastructureSprites.rail, leaving other sections/kinds from the base pack untouched', () => {
  const basePackJson = extractContentPackJson(htmlPath);
  const realInfra = JSON.parse(basePackJson).infrastructureSprites;
  const addonPack = {
    infrastructureSprites: {
      rail: { nub: { type:'svg', markup: '<circle cx="40" cy="20" r="9" fill="#0f0"/>' } },
    },
  };
  const ctx = newGameContext({contentPacks: [basePackJson, JSON.stringify(addonPack)]});
  const result = run(ctx, `
    return {
      hasRailOverride: !!(INFRASTRUCTURE_SPRITES.rail && INFRASTRUCTURE_SPRITES.rail.nub),
      railNubMarkup: INFRASTRUCTURE_SPRITES.rail.nub.markup,
      railBallastGone: INFRASTRUCTURE_SPRITES.rail.ballast === undefined,
      roadUntouched: JSON.stringify(INFRASTRUCTURE_SPRITES.road),
    };
  `);
  check('the addon pack\'s infrastructureSprites.rail.nub override is present', result.hasRailOverride);
  check('it is exactly the addon\'s markup, not the base pack\'s', result.railNubMarkup.includes('#0f0'), result.railNubMarkup);
  // A pack section merge REPLACES a whole subtree on override, it doesn't
  // deep-merge field by field (same contract a `buildings` id override has)
  // — so the addon's infrastructureSprites.rail entirely replaces the real
  // pack's own {ballast,ties,rails,nub}, not just adding/overwriting nub.
  check('overriding infrastructureSprites.rail replaces the WHOLE rail subtree — the base pack\'s ballast/ties/rails are gone, not merged alongside the addon\'s nub', result.railBallastGone);
  check('infrastructureSprites.road is untouched — the base pack\'s own real road art survives unchanged, since the addon never mentioned road', result.roadUntouched === JSON.stringify(realInfra.road));
});

console.log(failures===0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures===0 ? 0 : 1);
