// ---------------------------------------------------------------------
// WORKER CLIENT — runs the simulation core (sim/*.js) inside a Web
// Worker, off the main thread, so a busy tick (many trucks/trains
// pathfinding at once) never stalls rendering or input (§8).
//
// Message protocol, main <-> worker:
//   -> {type:'init', contentPack}       sent once, right after construction
//   -> {type:'command', name, args}     one per player action (was a direct
//                                        cmdXxx(...) call pre-Worker-split)
//   <- {type:'snapshot', treasury, tick, grid, components, railBlocks,
//       entityIds, logs}                sent after 'init' and after every
//                                        command and every tick
//
// Why a Blob-constructed Worker, not `new Worker('src/worker/....js')`:
// a same-origin-looking relative path is rejected under file:// — every
// document there has origin "null", and the browser refuses to load a
// worker script "from" a null origin even though it's the same file tree
// as the page (verified empirically; see the Phase 2 §Worker Split README
// section). A Blob URL sidesteps that: the Worker's initial script is this
// page's own in-memory string, not a file:// fetch, so the null-origin
// check never applies. That initial script is deliberately tiny (just the
// bootstrap below) — it pulls in the REAL simulation code, unmodified and
// un-duplicated, via importScripts() with each sim/*.js file's resolved
// file:// URL. importScripts() *can* load file:// URLs even under a
// blob:null worker (also verified empirically) — the resolution just has
// to be absolute, since a blob: URL has no base path to resolve a
// relative one against (`importScripts('sim/world.js')` throws "the URL
// ... is invalid" from inside a blob-sourced worker). Hence `abs()`
// resolving every path against document.baseURI on the main thread,
// before it ever gets handed to the Worker.
//
// Two-phase importScripts, not one: the Worker's very first statement
// loads content/loader.js ALONE and stops — loader.js's own top-level
// bootstrap is guarded on `typeof document !== 'undefined'`, so this
// leaves initContentPack/validateContentPack defined but not yet called.
// Only once the 'init' message actually arrives (carrying the content
// pack this page already parsed) does the Worker call initContentPack()
// itself, THEN importScripts() the rest of sim/*.js. This order matters:
// world.js's very first statement reads INITIAL_TREASURY, which doesn't
// exist until initContentPack() has run — importing world.js any earlier
// would throw. Loading it all in one batch, before the pack has arrived,
// isn't possible at all: postMessage delivery is asynchronous but
// importScripts is synchronous, so there's no way to block the first
// batch on the pack without this split.
//
// Shadow world: the main thread keeps its own `world` (from world.js,
// loaded here same as always) purely as a render target — render.js and
// ui.js read it exactly as before, they just never mutate it directly
// anymore. Each snapshot overwrites world's mutable pieces in place
// (world's own `const` binding never changes, only its properties) with
// what the Worker actually computed. `world.entities` can't be one of
// those properties verbatim — its values are Proxy handles (see
// makeEntityHandle in ecs.js), and Proxies aren't structured-clone-able —
// so the Worker instead ships a plain `entityIds` array, and this file
// rebuilds `world.entities` as a fresh Map of freshly made handles. That's
// safe even for a handle some other code (ui.js's `selected`) is still
// holding onto from a previous snapshot: every property access on a
// handle re-reads `world.components` live, never caches, so an "old"
// handle instance keeps working correctly once `world.components` itself
// has been swapped to the latest snapshot.
//
// cmdSellVehicle/cmdSetOrders are the only two commands whose signature
// takes an entity handle rather than plain values — also not structured-
// clone-able. Callers (ui.js) send the entity's plain `.id` instead; the
// Worker's command dispatcher below resolves that id back to a handle
// (via its OWN world.entities, not this page's) before invoking the real
// function, exactly the translation the function bodies expect.
// ---------------------------------------------------------------------

function abs(relPath){ return new URL(relPath, document.baseURI).href; }

const WORKER_LOADER_URL = abs('src/content/loader.js');
const WORKER_SIM_URLS = [
  'src/sim/world.js',
  'src/sim/ecs.js',
  'src/sim/economy.js',
  'src/sim/pathfinding.js',
  'src/sim/rail-blocks.js',
  'src/sim/entities.js',
  'src/sim/commands.js',
  'src/sim/systems.js',
].map(abs);

const workerBootstrap = `
'use strict';
importScripts(${JSON.stringify(WORKER_LOADER_URL)});

function postSnapshot(){
  postMessage({
    type: 'snapshot',
    treasury: world.treasury,
    tick: world.tick,
    grid: world.grid,
    components: world.components,
    railBlocks: world.railBlocks,
    entityIds: [...world.entities.keys()],
    logs: pendingLogs,
  });
  pendingLogs = [];
}

self.onmessage = function(evt){
  const msg = evt.data;
  if(msg.type === 'init'){
    initContentPack(msg.contentPack);
    importScripts(${WORKER_SIM_URLS.map(u => JSON.stringify(u)).join(',')});
    postSnapshot();
    setInterval(function(){ simTick(); postSnapshot(); }, TICK_MS);
  } else if(msg.type === 'command'){
    let args = msg.args;
    if(msg.name === 'cmdSellVehicle' || msg.name === 'cmdSetOrders'){
      args = [world.entities.get(args[0]), ...args.slice(1)];
    }
    self[msg.name](...args);
    postSnapshot();
  }
};
`;

const worker = new Worker(URL.createObjectURL(new Blob([workerBootstrap], {type: 'application/javascript'})));

worker.onerror = function(e){
  logEvent(`Simulation worker error: ${e.message}`, 'warn');
  console.error('Simulation worker error:', e);
};

worker.onmessage = function(evt){
  const msg = evt.data;
  if(msg.type !== 'snapshot') return;
  world.treasury = msg.treasury;
  world.tick = msg.tick;
  world.grid = msg.grid;
  world.components = msg.components;
  world.railBlocks = msg.railBlocks;
  world.entities = new Map(msg.entityIds.map(id => [id, makeEntityHandle(id)]));
  for(const log of msg.logs) logEvent(log.msg, log.cls);
};

function postCommand(name, args){
  worker.postMessage({type:'command', name, args: args || []});
}

// Overrides economy.js's queue-based logEvent (the definition the Worker
// actually runs with — see that file's own comment) with one that writes
// straight to the real #log element. Classic <script> tags share one
// global scope, so this later top-level `function logEvent` simply
// replaces the earlier one for every caller on the main thread — both
// this file's own snapshot-flushing loop above and every direct call
// elsewhere (e.g. ui.js's click-handler feedback, which never goes
// through the Worker at all, and needs to show up with no extra latency).
const logEl = document.getElementById('log');
function logEvent(msg, cls){
  const d = document.createElement('div');
  if(cls) d.className = cls;
  d.textContent = msg;
  logEl.appendChild(d);
  while(logEl.children.length > 40) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

worker.postMessage({type:'init', contentPack: CONTENT_PACK});
