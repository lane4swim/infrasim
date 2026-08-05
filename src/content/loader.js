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
  for(const section of ['resources','recipes','buildings','vehicles','rail','engines','wagons']){
    need(pack && typeof pack[section]==='object' && pack[section]!==null, `missing "${section}" section`);
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
  }
  for(const [id, v] of Object.entries(pack.vehicles)){
    need(typeof v.purchaseCost==='number', `vehicle "${id}" is missing a numeric purchaseCost`);
    need(typeof v.capacity==='number', `vehicle "${id}" is missing a numeric capacity`);
    need(typeof v.engineForce==='number', `vehicle "${id}" is missing a numeric engineForce`);
    need(typeof v.brakeForce==='number', `vehicle "${id}" is missing a numeric brakeForce`);
    need(v.brakeForce > v.engineForce, `vehicle "${id}" has brakeForce (${v.brakeForce}) <= engineForce (${v.engineForce}) — decel must exceed accel at any mass`);
    need(pack.resources[v.resource], `vehicle "${id}" references undefined resource "${v.resource}"`);
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
  }
  for(const [id, w] of Object.entries(pack.wagons)){
    need(typeof w.purchaseCost==='number', `wagon "${id}" is missing a numeric purchaseCost`);
    need(typeof w.capacity==='number', `wagon "${id}" is missing a numeric capacity`);
    need(pack.resources[w.resource], `wagon "${id}" references undefined resource "${w.resource}"`);
    need(typeof w.massEmpty==='number', `wagon "${id}" is missing a numeric massEmpty`);
    need(typeof w.lengthTiles==='number', `wagon "${id}" is missing a numeric lengthTiles`);
  }
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
let CONTENT_PACK, RESOURCES, RESOURCE, RECIPES, BUILDING_DEFS, VEHICLE_DEFS, RAIL_DEFS, ENGINE_DEFS, WAGON_DEFS;
let INITIAL_TREASURY, ROAD_COST_PER_TILE, ELEVATED_COST_MULTIPLIER, RAMP_COST, TRANSFER_RATE, TICK_MS, CONSUMPTION_PER_CAPITA;

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

  INITIAL_TREASURY = 5000; // starting cash — bumped up from 1000 now that a Mine->Mill->Town chain needs multiple buildings, stations, and trucks before any income comes in
  ROAD_COST_PER_TILE = 10;
  ELEVATED_COST_MULTIPLIER = 2; // bridges cost more per tile (§16.2-style layer multiplier)
  RAMP_COST = 40;               // one-time cost to link ground<->elevated at a single cell
  TRANSFER_RATE = 4;           // units moved per tick during load/unload
  TICK_MS = 300;               // fixed simulation timestep
  CONSUMPTION_PER_CAPITA = 0.02; // resource drained per tick, per resident (§16-style: data-defined rate)
}

// Main-thread bootstrap: parse the page's own content-pack block immediately,
// same as before this function existed. Guarded on `document` so this file
// no-ops when loaded into the Worker via importScripts (no DOM there) —
// the Worker calls initContentPack(pack) itself after receiving the pack
// over postMessage instead.
if(typeof document !== 'undefined'){
  initContentPack(JSON.parse(document.getElementById('content-pack').textContent));
}
