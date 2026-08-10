/* =====================================================================
   INFRASIM
   Implements:
     - single ground layer, road network + trucks (§6.2)
     - ECS-ish entities: buildings (Producer/Consumer/Storage), vehicles
     - fixed-timestep simulation loop, run in a Worker, decoupled from
       both rendering and the main thread (§8)
     - player-authored Orders lists — no auto-routing (§6.6)
     - player-chosen storage capacity at build time (§6.6)
     - backpressure: halted production / waiting vehicles (§6.6)
     - Treasury, construction costs, vehicle purchase+running cost,
       delivery income (§16)

   PROJECT STRUCTURE (§14 of specification.md, adapted): this used to be
   one giant inline <script> in index.html. It's now split across
   src/{content,sim,render,ui,worker}/*.js, loaded in dependency order as
   plain classic <script src="..."> tags — deliberately NOT `type="module"`,
   since module scripts are blocked by CORS under file:// in every major
   browser, which would break the "just double-click index.html" workflow
   this project has kept since Phase 1. Classic scripts have no such
   restriction and all share one global scope (top-level `const`/`function`
   in one file is visible to every later `<script>` on the same page,
   exactly as if they were one file), so this split changes nothing at
   runtime — same execution model, just organized into files matching what
   each piece actually is. Load order matters only for the small amount of
   top-level (not-inside-a-function) code — e.g. the CONTENT_PACK parsing
   below, or ui.js's final requestAnimationFrame(frame) call — since that
   runs immediately as each script loads; function bodies calling into a
   later-loaded file are fine regardless of order, since nothing actually
   *calls* them until the game loop starts, by which point every file has
   loaded. See index.html's own script tags for the exact load order.

   The simulation itself (sim/*.js + this file) now runs inside a Web
   Worker, not the main thread — see src/worker/worker-client.js for the
   Worker split and why sim/commands.js and sim/systems.js's simTick() are
   only ever invoked there. The main thread still loads every sim/*.js file
   too, because a handful of read-only helpers (render.js's getVehicleStats,
   ui.js's findLinkedIndustry, etc.) need to run against the shadow `world`
   snapshot the Worker sends back each tick; the mutating half of that same
   code (commands.js, simTick) simply never gets called from here.

   content/loader.js   — this file: content-pack parsing/validation + config constants
   sim/world.js        — grid + world state (§14's "World")
   sim/ecs.js          — component tables, entity handles, queries (§14's "Component, System, Query")
   sim/economy.js      — treasury + the event log
   sim/pathfinding.js  — road/rail BFS, dock-cell resolution, Station/industry chain-walking
   sim/rail-blocks.js  — rail mutual-exclusion segment computation
   sim/entities.js     — entity factories (buildings, trucks, trains) + vehicle-stat lookups
   sim/commands.js     — the only functions allowed to mutate world state (§7) — Worker-only, see above
   sim/systems.js       — the per-tick systems, run from simTick() — Worker-only, see above
   worker/worker-client.js — builds the Worker, ships it sim/*.js, and bridges postCommand()/snapshots to the main thread
   render/render.js    — the render loop + canvas rendering
   ui/ui.js            — tool wiring, click handling, inspector, and the loop's initial kickoff
   ===================================================================== */

// ---------------------------------------------------------------------
// DATA DEFINITIONS  (§9 / §16 content pack — parsed from the
// application/json <script id="content-pack"> block above the page markup,
// not inline JS objects. See that block's own comment for why this is a
// JSON-block-in-the-page rather than real data/*.json files.)
// ---------------------------------------------------------------------
// Lightweight schema check, not real JSON Schema validation (§9) — cheap
// to write, and enough to catch the actual failure mode (a hand-edited
// content block with a typo or a dangling reference) with a clear error
// naming the exact field, instead of an obscure crash three systems away
// the first time something reads the missing/malformed value.
function validateContentPack(pack){
  const fail = msg => { throw new Error('Content pack invalid: ' + msg); };
  const need = (cond, msg) => { if(!cond) fail(msg); };
  // A vehicle's physical length is quantized to quarter-tile increments —
  // real rolling stock/trucks come in standard length classes, not
  // arbitrary continuous sizes, and it keeps every rendered/reserved
  // footprint (§ shared movement engine's footprintKeysFor) a "clean"
  // number instead of an arbitrary float. Floating-point-safe: compares
  // the rounded quarter-count back against the original rather than
  // testing divisibility directly.
  const isQuarterTile = n => Math.abs(Math.round(n*4) - n*4) < 1e-9;
  for(const section of ['resources','recipes','buildings','vehicles','rail','engines','wagons']){
    need(pack && typeof pack[section]==='object' && pack[section]!==null, `missing "${section}" section`);
  }
  // spriteSheets validated up front — every other sprite-slot validation
  // below (building/vehicle/engine/wagon `sprites`, and infrastructureSprites
  // further down) needs pack.spriteSheets already checked to confirm a
  // {sheet,symbol} reference actually points at something real.
  validateSpriteSheets(pack.spriteSheets);
  // Isometric per-direction sprites (§ Isometric sprites) — optional on any
  // renderable entity def (building/vehicle/engine/wagon). Only n/s/e/w are
  // ever actually selectable today: the sim grid is strictly 4-connected
  // (see pathfinding.js's ROAD_DIRS — no diagonal edge exists anywhere), so
  // a vehicle only ever travels, and a building only ever faces, one of
  // those four. ne/nw/se/sw are RESERVED key names for a possible future
  // diagonal-movement mode — validated if present (so a typo'd key is still
  // caught), but never required and never drawn by anything today; an
  // author who only cares about the reachable four isn't forced to draw
  // four sprites nothing can select. `menu` is the toolbar-icon sprite —
  // also optional, also independent of the direction keys.
  const SPRITE_DIRECTION_KEYS = ['n','s','e','w','ne','nw','se','sw'];
  const REQUIRED_SPRITE_DIRECTION_KEYS = ['n','s','e','w'];
  // Sprite sheets (§ Content-pack sprite sheets) — a named `spriteSheets`
  // entry is one SVG document a pack ships once, holding any number of
  // named `<symbol id="...">` pieces; a real art pack ships one (or a
  // handful of) cohesive sheet(s) covering everything it draws — a Train
  // Yard's 4 directions, a Station's 4, rail's ballast/ties/rails, road's
  // asphalt/markings — rather than one wholly separate file per sprite
  // slot. Only validated for shape here (real, non-empty SVG markup); the
  // actual `<symbol id>` lookup happens at render time (render.js), where
  // a browser's DOMParser is available to parse it for real.
  function validateSpriteSheets(sheets){
    if(sheets===undefined) return;
    need(typeof sheets==='object' && sheets!==null && !Array.isArray(sheets), `spriteSheets must be an object`);
    for(const [id, sheet] of Object.entries(sheets)){
      need(sheet && typeof sheet==='object', `sprite sheet "${id}" must be an object`);
      need(typeof sheet.markup==='string' && sheet.markup.includes('<svg'), `sprite sheet "${id}" is missing "markup" (must be a full <svg>...</svg> document)`);
    }
  }
  // One sprite slot's value, shared by the per-direction `sprites` object
  // below and § SVG track sprites' `infrastructureSprites` (further down):
  // either art inline (the original {type,markup|dataUri} shape) or a
  // {sheet,symbol} reference into a spriteSheets entry validated above —
  // the two forms are interchangeable everywhere a sprite slot is accepted,
  // so an author can mix "most sprites come from one shared sheet, but this
  // one-off slot gets its own inline markup" freely.
  function validateSpriteSpec(ownerLabel, spec){
    need(spec && typeof spec==='object', `${ownerLabel} must be an object`);
    if(spec.sheet!==undefined || spec.symbol!==undefined){
      need(typeof spec.sheet==='string' && spec.sheet.length>0, `${ownerLabel} "sheet" must be a non-empty string`);
      need(typeof spec.symbol==='string' && spec.symbol.length>0, `${ownerLabel} "symbol" must be a non-empty string`);
      need(pack.spriteSheets && pack.spriteSheets[spec.sheet], `${ownerLabel} references undefined sprite sheet "${spec.sheet}"`);
      return;
    }
    need(spec.type==='svg' || spec.type==='png', `${ownerLabel} has an invalid "type" (must be "svg", "png", or a {sheet,symbol} reference)`);
    if(spec.type==='svg') need(typeof spec.markup==='string' && spec.markup.length>0, `${ownerLabel} is missing "markup"`);
    else need(typeof spec.dataUri==='string' && spec.dataUri.startsWith('data:image/png'), `${ownerLabel} is missing a valid "dataUri" (must start with "data:image/png")`);
  }
  function validateSprites(ownerLabel, sprites){
    if(sprites===undefined) return;
    need(typeof sprites==='object' && sprites!==null && !Array.isArray(sprites), `${ownerLabel} has an invalid "sprites" — must be an object`);
    for(const key of Object.keys(sprites)){
      need(SPRITE_DIRECTION_KEYS.includes(key) || key==='menu', `${ownerLabel} sprites has an unknown key "${key}" (expected one of ${SPRITE_DIRECTION_KEYS.join('/')}, or "menu")`);
    }
    for(const key of REQUIRED_SPRITE_DIRECTION_KEYS){
      need(sprites[key]!==undefined, `${ownerLabel} sprites is missing required direction "${key}" (n/s/e/w are mandatory once "sprites" is present at all — ne/nw/se/sw and menu stay optional)`);
    }
    for(const [key, sprite] of Object.entries(sprites)) validateSpriteSpec(`${ownerLabel} sprite "${key}"`, sprite);
  }
  // Infrastructure sprites (§ SVG track sprites' content-pack addendum) —
  // optional, engine-default-if-absent art for rail/road track and its
  // connecting overlays. Unlike building/vehicle sprites (one whole image
  // per direction, stretched into a footprint bbox), a rail/road MATERIAL
  // layer (ballast, ties, rails; asphalt, markings) is authored once per
  // SHAPE CATEGORY — straight, corner, or spoke — at a fixed canonical
  // orientation (straight=N-S, corner=N-E, spoke=pointing N), and reused
  // for every actual direction via a rotation/mirror the renderer applies
  // (see SEGMENT_SHAPE_TRANSFORM, render.js) — an author draws 3 shapes per
  // layer, not up to 10 (2 straight + 4 corner + 4 spoke) separate
  // directional variants. `nub` (the isolated/dead-end/hub core) has no
  // shape variants — it's symmetric — so it's a single spec, not nested
  // under a layer. The dashed "X-ray hint" underground/airspace look is
  // deliberately NOT overridable (see render.js) — there's nothing to
  // texture through solid ground.
  const INFRA_SHAPE_KEYS = ['straight','corner','spoke'];
  const INFRA_RAIL_LAYER_KEYS = ['ballast','ties','rails'];
  const INFRA_ROAD_LAYER_KEYS = ['asphalt','markings'];
  const INFRA_MARKER_KEYS = ['oneWayArrow','crossingMarker'];
  function validateInfrastructureSprites(infra){
    if(infra===undefined) return;
    need(typeof infra==='object' && infra!==null && !Array.isArray(infra), `infrastructureSprites must be an object`);
    for(const key of Object.keys(infra)){
      need(key==='rail' || key==='road' || INFRA_MARKER_KEYS.includes(key), `infrastructureSprites has an unknown key "${key}" (expected "rail", "road", or one of ${INFRA_MARKER_KEYS.join('/')})`);
    }
    for(const kind of ['rail','road']){
      if(infra[kind]===undefined) continue;
      need(typeof infra[kind]==='object' && infra[kind]!==null, `infrastructureSprites.${kind} must be an object`);
      const layerKeys = kind==='rail' ? INFRA_RAIL_LAYER_KEYS : INFRA_ROAD_LAYER_KEYS;
      for(const key of Object.keys(infra[kind])){
        need(layerKeys.includes(key) || key==='nub', `infrastructureSprites.${kind} has an unknown key "${key}" (expected one of ${layerKeys.join('/')}, or "nub")`);
      }
      for(const layer of layerKeys){
        if(infra[kind][layer]===undefined) continue;
        const shapes = infra[kind][layer];
        need(typeof shapes==='object' && shapes!==null && !Array.isArray(shapes), `infrastructureSprites.${kind}.${layer} must be an object of {straight,corner,spoke}`);
        for(const shapeKey of Object.keys(shapes)){
          need(INFRA_SHAPE_KEYS.includes(shapeKey), `infrastructureSprites.${kind}.${layer} has an unknown shape "${shapeKey}" (expected one of ${INFRA_SHAPE_KEYS.join('/')})`);
        }
        for(const [shapeKey, spec] of Object.entries(shapes)) validateSpriteSpec(`infrastructureSprites.${kind}.${layer}.${shapeKey}`, spec);
      }
      if(infra[kind].nub!==undefined) validateSpriteSpec(`infrastructureSprites.${kind}.nub`, infra[kind].nub);
    }
    for(const key of INFRA_MARKER_KEYS){
      if(infra[key]===undefined) continue;
      validateSpriteSpec(`infrastructureSprites.${key}`, infra[key]);
    }
  }
  for(const [id, r] of Object.entries(pack.resources)){
    need(typeof r.name==='string', `resource "${id}" is missing a name`);
    need(typeof r.baseValue==='number', `resource "${id}" is missing a numeric baseValue`);
    need(typeof r.unitWeight==='number', `resource "${id}" is missing a numeric unitWeight`);
  }
  for(const [id, r] of Object.entries(pack.recipes)){
    need(Array.isArray(r.inputs), `recipe "${id}" is missing an inputs array`);
    need(Array.isArray(r.outputs), `recipe "${id}" is missing an outputs array`);
    need(typeof r.durationTicks==='number', `recipe "${id}" is missing a numeric durationTicks`);
    for(const io of [...r.inputs, ...r.outputs]){
      need(pack.resources[io.resource], `recipe "${id}" references undefined resource "${io.resource}"`);
    }
  }
  for(const [id, b] of Object.entries(pack.buildings)){
    need(typeof b.buildCost==='number', `building "${id}" is missing a numeric buildCost`);
    need(b.tiers && typeof b.tiers==='object', `building "${id}" is missing a tiers object`);
    need(b.footprint && typeof b.footprint.w==='number' && typeof b.footprint.h==='number', `building "${id}" is missing a valid footprint {w,h}`);
    if(b.recipe!==undefined) need(pack.recipes[b.recipe], `building "${id}" references undefined recipe "${b.recipe}"`);
    // Optional — only a Rail Depot's build-time length choice ever reads
    // this (§ Depot configurable platform length); every other building
    // type just doesn't define it, same as `recipe` above.
    if(b.platformLengths!==undefined) need(Array.isArray(b.platformLengths) && b.platformLengths.length>0 && b.platformLengths.every(n=>Number.isInteger(n) && n>0),
      `building "${id}" has an invalid platformLengths — must be a nonempty array of positive integers`);
    // Optional — how many underground levels (starting from level 1, the
    // one right below ground) this building's foundation physically
    // occupies, blocking track from ever being built there beneath its
    // footprint (§ Building foundations). 0 or omitted means "no deep
    // foundation" — track can be built at any underground level below it,
    // the same as every building before this feature existed.
    if(b.blockedUndergroundLevels!==undefined) need(Number.isInteger(b.blockedUndergroundLevels) && b.blockedUndergroundLevels>=0,
      `building "${id}" has an invalid blockedUndergroundLevels — must be a non-negative integer`);
    validateSprites(`building "${id}"`, b.sprites);
  }
  for(const [id, v] of Object.entries(pack.vehicles)){
    need(typeof v.purchaseCost==='number', `vehicle "${id}" is missing a numeric purchaseCost`);
    need(typeof v.capacity==='number', `vehicle "${id}" is missing a numeric capacity`);
    need(typeof v.engineForce==='number', `vehicle "${id}" is missing a numeric engineForce`);
    need(typeof v.brakeForce==='number', `vehicle "${id}" is missing a numeric brakeForce`);
    need(v.brakeForce > v.engineForce, `vehicle "${id}" has brakeForce (${v.brakeForce}) <= engineForce (${v.engineForce}) — decel must exceed accel at any mass`);
    need(pack.resources[v.resource], `vehicle "${id}" references undefined resource "${v.resource}"`);
    need(typeof v.transferRate==='number', `vehicle "${id}" is missing a numeric transferRate`);
    need(typeof v.lengthTiles==='number', `vehicle "${id}" is missing a numeric lengthTiles`);
    need(isQuarterTile(v.lengthTiles), `vehicle "${id}" lengthTiles (${v.lengthTiles}) must be a multiple of 0.25`);
    validateSprites(`vehicle "${id}"`, v.sprites);
  }
  for(const [id, t] of Object.entries(pack.rail)){
    need(typeof t.costPerTile==='number', `rail def "${id}" is missing a numeric costPerTile`);
  }
  // A train is assembled from one engine (physics only — no cargo) plus N
  // identical wagons (cargo only — no propulsion); see getTrainStats.
  for(const [id, e] of Object.entries(pack.engines)){
    need(typeof e.purchaseCost==='number', `engine "${id}" is missing a numeric purchaseCost`);
    need(typeof e.engineForce==='number', `engine "${id}" is missing a numeric engineForce`);
    need(typeof e.brakeForce==='number', `engine "${id}" is missing a numeric brakeForce`);
    need(e.brakeForce > e.engineForce, `engine "${id}" has brakeForce (${e.brakeForce}) <= engineForce (${e.engineForce}) — decel must exceed accel at any mass`);
    need(typeof e.maxSpeedTilesPerTick==='number', `engine "${id}" is missing a numeric maxSpeedTilesPerTick`);
    need(typeof e.massEmpty==='number', `engine "${id}" is missing a numeric massEmpty`);
    need(typeof e.lengthTiles==='number', `engine "${id}" is missing a numeric lengthTiles`);
    need(isQuarterTile(e.lengthTiles), `engine "${id}" lengthTiles (${e.lengthTiles}) must be a multiple of 0.25`);
    validateSprites(`engine "${id}"`, e.sprites);
  }
  for(const [id, w] of Object.entries(pack.wagons)){
    need(typeof w.purchaseCost==='number', `wagon "${id}" is missing a numeric purchaseCost`);
    need(typeof w.capacity==='number', `wagon "${id}" is missing a numeric capacity`);
    need(pack.resources[w.resource], `wagon "${id}" references undefined resource "${w.resource}"`);
    need(typeof w.massEmpty==='number', `wagon "${id}" is missing a numeric massEmpty`);
    need(typeof w.lengthTiles==='number', `wagon "${id}" is missing a numeric lengthTiles`);
    need(isQuarterTile(w.lengthTiles), `wagon "${id}" lengthTiles (${w.lengthTiles}) must be a multiple of 0.25`);
    need(typeof w.transferRate==='number', `wagon "${id}" is missing a numeric transferRate`);
    // Validated for schema consistency with every other entity type, but
    // not yet drawn by anything: a train renders as one single rectangle
    // spanning engine+wagons (§ Vehicle length's own "one big literal
    // rectangle" choice — wagons were never individually rendered even
    // before sprites existed), using the ENGINE's sprite stretched over the
    // whole train's length (see spriteDefForVehicle, render.js). Per-wagon
    // sprites are reserved for a possible future segmented-train renderer.
    validateSprites(`wagon "${id}"`, w.sprites);
  }
  validateInfrastructureSprites(pack.infrastructureSprites);
}

// Extracts one <symbol id="..."> piece out of a sprite sheet's SVG markup
// (§ Content-pack sprite sheets) as its own standalone, drawable <svg>
// document — the one place that knows how to turn a {sheet,symbol}
// reference into real markup, shared by render.js and ui.js the same way
// spriteDataUri below is. Needs a real DOMParser (a standard browser API,
// available on the main thread in both the real page and Playwright — but
// NOT in the headless sim-test harness's vm sandbox, which is fine: nothing
// in sim/*.js ever resolves a sprite, only render.js/ui.js do, and neither
// loads into that harness). The symbol's OWN viewBox wins if it declares
// one (letting each symbol in a sheet use whatever local coordinate space
// its art was drawn in); falling back to the sheet's outer viewBox keeps a
// symbol that omits its own from silently becoming unbounded. Cached
// forever per (sheet,symbol) pair — sheets don't change at runtime, so
// there's nothing to invalidate, same contract every sprite cache in this
// codebase already follows.
const spriteSheetSymbolCache = new Map();
function extractSpriteSheetSymbol(sheetId, symbolId){
  const cacheKey = sheetId + '::' + symbolId;
  if(spriteSheetSymbolCache.has(cacheKey)) return spriteSheetSymbolCache.get(cacheKey);
  let result = null;
  const sheet = SPRITE_SHEETS && SPRITE_SHEETS[sheetId];
  if(sheet){
    const doc = new DOMParser().parseFromString(sheet.markup, 'image/svg+xml');
    const symbolEl = doc.getElementById(symbolId);
    if(symbolEl){
      const viewBox = symbolEl.getAttribute('viewBox') || doc.documentElement.getAttribute('viewBox') || '0 0 100 100';
      result = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${symbolEl.innerHTML}</svg>`;
    }
  }
  spriteSheetSymbolCache.set(cacheKey, result);
  return result;
}
// Decodes one validated sprite entry (§ Isometric sprites) into a `src`
// string an <img> element or a canvas Image can load directly — the one
// place that knows how to turn any sprite form into a data URI, shared
// by render.js (canvas Image objects, drawn per building/vehicle/track
// segment) and ui.js (toolbar <img> tags, the "menu" sprite). SVG markup is
// percent-encoded rather than base64'd (`btoa` throws on any non-Latin1
// character, which arbitrary hand-authored SVG text — a stray em dash in a
// <title>, non-ASCII content — would easily contain); PNG sprites already
// arrive as a full data URI (validateSprites requires the "data:image/png"
// prefix), so there's nothing to do but pass it through. A {sheet,symbol}
// reference (§ Content-pack sprite sheets) resolves through
// extractSpriteSheetSymbol first — same encoding after that, since the
// extracted result is just more SVG markup.
function spriteDataUri(sprite){
  if(!sprite) return null;
  if(sprite.sheet){
    const markup = extractSpriteSheetSymbol(sprite.sheet, sprite.symbol);
    return markup ? 'data:image/svg+xml,' + encodeURIComponent(markup) : null;
  }
  return sprite.type==='svg' ? 'data:image/svg+xml,' + encodeURIComponent(sprite.markup) : sprite.dataUri;
}

// Multiple content packs (§9 — "A ContentPack loader merges base-game data
// with any additional packs") — the page can ship any number of
// application/json <script class="content-pack"> blocks, each a partial or
// complete pack, merged here into the one pack object validateContentPack/
// initContentPack actually consume. Merging is per-section, per-id: a pack
// only has to include the sections/ids it actually touches (the "missing
// section" check in validateContentPack runs against the MERGED result, not
// each individual pack, so an addon pack can be as small as one new
// resource), and a later pack reusing an earlier pack's id for the same
// section entirely replaces that entry — the seam an override-style mod
// uses, exactly like a later JS property assignment winning over an
// earlier one. Load order is document order (see the DOM bootstrap below).
// spriteSheets and infrastructureSprites (§ Content-pack sprite sheets, §
// SVG track sprites) merge the exact same shallow, per-top-level-key way
// every other section does — an addon pack overriding just
// infrastructureSprites.road replaces that WHOLE subtree (rail's stays
// from the base pack), the same "whole entry replaced, not deep-merged
// field by field" contract a `buildings` id override already has.
const CONTENT_PACK_SECTIONS = ['resources','recipes','buildings','vehicles','rail','engines','wagons','spriteSheets','infrastructureSprites'];
function mergeContentPacks(packs){
  const merged = {};
  for(const section of CONTENT_PACK_SECTIONS) merged[section] = {};
  for(const pack of packs){
    if(pack.version !== undefined) merged.version = pack.version;
    for(const section of CONTENT_PACK_SECTIONS){
      if(pack[section]) Object.assign(merged[section], pack[section]);
    }
  }
  return merged;
}

// Populated by initContentPack() below — `let`, not `const`, because the
// Worker (see src/worker/worker-client.js) can't read the page's DOM to
// parse the content pack itself. It receives the pack over postMessage
// instead and calls initContentPack(pack) directly once it arrives, so
// these bindings exist (as declarations) the moment this file loads via
// importScripts, but are only populated once the pack is actually known —
// on the main thread that happens synchronously below; in the Worker it
// happens on the first 'init' message (see worker-client.js's protocol
// comment for why that has to be a separate later step).
let CONTENT_PACK, RESOURCES, RESOURCE, RECIPES, BUILDING_DEFS, VEHICLE_DEFS, RAIL_DEFS, ENGINE_DEFS, WAGON_DEFS, SPRITE_SHEETS, INFRASTRUCTURE_SPRITES;
let INITIAL_TREASURY, ROAD_COST_PER_TILE, ELEVATED_COST_MULTIPLIER, RAMP_COST, UNDERGROUND_COST_MULTIPLIER, UNDERGROUND_RAMP_COST, UNDERGROUND_LEVELS, UNDERGROUND_LEVEL_COST_STEP, UNDERGROUND_RAMP_LEVEL_STEP, DEEP_UNDERGROUND_COST_MULTIPLIER, AIRSPACE_COST_MULTIPLIER, TERRAFORM_COST, DEFAULT_TRANSFER_RATE, TICK_MS, CONSUMPTION_PER_CAPITA;

function initContentPack(pack){
  validateContentPack(pack);
  CONTENT_PACK = pack;
  RESOURCES = pack.resources;
  RESOURCE = RESOURCES.ore; // back-compat alias: code/data written for the single-resource era still works
  RECIPES = pack.recipes;
  BUILDING_DEFS = pack.buildings;
  VEHICLE_DEFS = pack.vehicles;
  RAIL_DEFS = pack.rail;
  ENGINE_DEFS = pack.engines;
  WAGON_DEFS = pack.wagons;
  SPRITE_SHEETS = pack.spriteSheets;
  INFRASTRUCTURE_SPRITES = pack.infrastructureSprites;

  INITIAL_TREASURY = 5000; // starting cash — bumped up from 1000 now that a Mine->Mill->Town chain needs multiple buildings, stations, and trucks before any income comes in
  ROAD_COST_PER_TILE = 10;
  ELEVATED_COST_MULTIPLIER = 2; // bridges cost more per tile (§16.2-style layer multiplier)
  UNDERGROUND_COST_MULTIPLIER = 3; // tunneling costs even more per tile than bridging
  RAMP_COST = 40;               // one-time cost to link ground<->elevated at a single cell
  UNDERGROUND_RAMP_COST = 80;   // one-time cost for a sloped ground<->underground ramp (§ Underground layer) — a tunnel entrance costs more than a bridge Ramp
  // Multi-level tunnels (§ Multi-level tunnels) — how many underground
  // grades stack below ground, each one reached from the one above it by
  // its own Tunnel Ramp, never skipping a level. Level 1 is the original
  // 'underground' grade (UNDERGROUND_COST_MULTIPLIER/UNDERGROUND_RAMP_COST
  // above, unchanged); level N>1 costs progressively more per tile and per
  // ramp, reflecting that digging deeper is harder — see
  // costMultiplierForUndergroundLevel/rampCostForUndergroundLevel in
  // world.js, the one place these two step constants are actually applied.
  UNDERGROUND_LEVELS = 3;
  UNDERGROUND_LEVEL_COST_STEP = 1;    // added to UNDERGROUND_COST_MULTIPLIER per level beyond 1 (level 3 tunneling ends up as costly per-tile as the reserved deepUnderground grade — a deliberate signal that level 3 is about as deep as "regular" tunneling reasonably goes)
  UNDERGROUND_RAMP_LEVEL_STEP = 20;   // added to UNDERGROUND_RAMP_COST per level beyond 1
  // Terrain elevation (§ Terrain elevation) — deepUnderground and airspace
  // are flat global planes reserved for future non-road/rail modes (a
  // Plane mode, a Mine reaching into deepUnderground — see RAMP_PAIRS in
  // world.js for why road/rail can't ramp into them), but road/rail track
  // can still be laid there ahead of that, at a cost reflecting how far
  // outside the terrain-following grades they sit: tunneling deeper than
  // the regular underground grade costs the most of any per-tile rate (a
  // real deep-bore subway tunnel), airspace less than that but still more
  // than a regular elevated bridge.
  DEEP_UNDERGROUND_COST_MULTIPLIER = 5;
  AIRSPACE_COST_MULTIPLIER = 4;
  TERRAFORM_COST = 30;          // one-time cost to raise or lower one cell's terrain by one level (cmdRaiseTerrain/cmdLowerTerrain)
  // Load/unload rate is now a per-vehicle (VEHICLE_DEFS/WAGON_DEFS
  // transferRate) and per-Station/Depot (BUILDING_DEFS transferRate) content
  // field — the effective rate is whichever is slower (§ adjustable transfer
  // rate), modeling a real bottleneck: a vehicle can't unload faster than
  // its own doors/pumps allow, and a dock can't load faster than its own
  // crane/conveyor allows. transferRate is REQUIRED on every vehicle/wagon
  // (validateContentPack) but optional on buildings — only Station and
  // Depot ever actually use it, so forcing it onto Mine/Mill/Town/Train
  // Yard would be a meaningless field on types nothing ever docks at; this
  // is the fallback for a Station/Depot that omits it.
  DEFAULT_TRANSFER_RATE = 4;
  TICK_MS = 300;               // fixed simulation timestep
  CONSUMPTION_PER_CAPITA = 0.02; // resource drained per tick, per resident (§16-style: data-defined rate)
}

// Main-thread bootstrap: parse the page's own content-pack block immediately,
// same as before this function existed. Guarded on `document` so this file
// no-ops when loaded into the Worker via importScripts (no DOM there) —
// the Worker calls initContentPack(pack) itself after receiving the pack
// over postMessage instead.
if(typeof document !== 'undefined'){
  const packs = Array.from(document.querySelectorAll('script.content-pack')).map(el => JSON.parse(el.textContent));
  initContentPack(mergeContentPacks(packs));
}
