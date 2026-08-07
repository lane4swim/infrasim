// Headless test harness for infrasim's simulation core.
//
// The code lives in src/{content,sim,render,ui,worker}/*.js, loaded as
// ordered classic <script src="..."> tags in the real page (see loader.js's
// own header comment for why classic, not module, scripts) — but since the
// Worker split (see src/worker/worker-client.js), index.html's own script
// list no longer includes every file this harness needs: sim/commands.js
// only ever runs inside the Worker now, loaded there via importScripts
// rather than a <script src> tag on the page. Testing "the simulation
// core" headlessly is exactly the case the Worker split's own design
// doc calls out as staying easy regardless — the core is still plain
// functions hung off a `world` object, runnable synchronously with no
// Worker, no postMessage, and no browser at all. So this harness ignores
// index.html's <script> tags entirely and instead concatenates loader.js
// plus every sim/*.js file, in the fixed dependency order below (the same
// order the Worker itself uses) — real shipped code, not a
// reimplementation, just assembled the way the Worker assembles it rather
// than the way the page does.
//
// The trick: the combined script's top-level `const`/`function`
// declarations become lexical bindings tied to this vm context, not
// enumerable properties of it — so a single context is created once and
// reused across every `run()` call, letting later snippets reference
// `world`, `cmdBuildRoad`, `simTick`, etc. by name, exactly as if they were
// later statements in the same script. requestAnimationFrame is stubbed to
// a no-op specifically so the render loop never actually starts (nothing
// in a test needs a canvas).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The simulation core's files, in dependency order — same list and order
// as worker-client.js's own WORKER_LOADER_URL + WORKER_SIM_URLS, since
// that's the real environment this code actually runs in now.
const SIM_SCRIPT_FILES = [
  'src/content/loader.js',
  'src/sim/world.js',
  'src/sim/ecs.js',
  'src/sim/economy.js',
  'src/sim/pathfinding.js',
  'src/sim/rail-blocks.js',
  'src/sim/entities.js',
  'src/sim/commands.js',
  'src/sim/systems.js',
  'src/sim/persistence.js',
];

// Concatenates the simulation core's files (resolved relative to
// index.html's own directory, i.e. the project root) into one script —
// the harness's view of "the game's code."
function extractScript(htmlPath){
  const baseDir = path.dirname(htmlPath);
  return SIM_SCRIPT_FILES.map(src => fs.readFileSync(path.join(baseDir, src), 'utf8')).join('\n');
}

// The content-pack <script> tags (class="content-pack", any number of them)
// have a type/class attribute, so they never match extractScript's bare
// `<script>` pattern above — this pulls them separately, the same way a
// real browser's document.querySelectorAll('script.content-pack') would.
function extractContentPackBlocks(htmlPath){
  const html = fs.readFileSync(htmlPath, 'utf8');
  const re = /<script type="application\/json" class="content-pack"[^>]*>([\s\S]*?)<\/script>/g;
  const blocks = [];
  let m;
  while((m = re.exec(html))) blocks.push(m[1]);
  if(blocks.length===0) throw new Error(`No content-pack <script> blocks found in ${htmlPath}`);
  return blocks;
}

// Mirrors loader.js's own mergeContentPacks — duplicated rather than
// required from loader.js, since that file expects to run inside the
// sandboxed vm context (or a browser), not plain Node, and has no
// module.exports. Used here only to answer "what's the real, fully-merged
// shipped pack" for tests that clone-and-mutate it (test-content-pack.js,
// test-building-foundation.js) — the actual merge CODE PATH under test
// always runs for real, inside the vm context via newGameContext below.
const CONTENT_PACK_SECTIONS = ['resources','recipes','buildings','vehicles','rail','engines','wagons'];
function mergeContentPackBlocks(blocks){
  const merged = {};
  for(const section of CONTENT_PACK_SECTIONS) merged[section] = {};
  for(const block of blocks){
    const pack = JSON.parse(block);
    if(pack.version !== undefined) merged.version = pack.version;
    for(const section of CONTENT_PACK_SECTIONS){
      if(pack[section]) Object.assign(merged[section], pack[section]);
    }
  }
  return merged;
}

// Returns the real shipped content pack — every content-pack block in
// index.html, merged — as a JSON string. Existing callers that want "the
// real pack" (to clone and mutate for a fixture) get the fully-merged
// result, same as the running game actually uses.
function extractContentPackJson(htmlPath){
  return JSON.stringify(mergeContentPackBlocks(extractContentPackBlocks(htmlPath)));
}

function makeFakeElement(){
  const store = {};
  return new Proxy(store, {
    get(target, prop){
      if(prop in target) return target[prop];
      if(prop==='classList') return {add(){}, remove(){}, toggle(){}};
      if(prop==='dataset') return {};
      if(prop==='style') return {};
      if(prop==='children') return [];
      if(prop==='getContext') return () => makeFakeElement();
      if(prop==='getBoundingClientRect') return () => ({left:0, top:0});
      if(prop==='querySelector') return () => makeFakeElement();
      if(typeof prop === 'string') return () => {}; // any other method (addEventListener, appendChild, ...) -> no-op
      return undefined;
    },
    set(target, prop, value){ target[prop] = value; return true; },
  });
}

// Creates a fresh vm context with index.html's simulation code loaded into
// it. Returns the context — pass it to run() for every subsequent snippet
// in the same test so they share world state; create a new context per
// test for a clean world.
//
// `contentPacks`, if given, is an array of JSON strings — each becomes its
// own fake <script class="content-pack"> block, merged by the real
// mergeContentPacks in loader.js exactly as document.querySelectorAll would
// find them on the page — this is what lets a test exercise the multi-pack
// merge/override behavior directly (not a harness reimplementation of it).
// `contentPackJson`, if given (and `contentPacks` isn't), is shorthand for
// a single pack — replaces the content index.html itself ships with just
// that one block; kept for tests written before multi-pack support that
// prove the extensibility claim by swapping in one whole replacement pack.
// Neither given: loads the real shipped blocks from index.html, in order.
function newGameContext({contentPackJson, contentPacks} = {}){
  const htmlPath = path.join(__dirname, '..', 'index.html');
  const packTexts = contentPacks !== undefined ? contentPacks
    : contentPackJson !== undefined ? [contentPackJson]
    : extractContentPackBlocks(htmlPath);
  const packElements = packTexts.map(text => ({textContent: text}));
  const sandbox = {
    console,
    document: {
      getElementById: () => makeFakeElement(),
      querySelectorAll: (sel) => sel==='script.content-pack' ? packElements : [],
      documentElement: makeFakeElement(),
      createElement: () => makeFakeElement(),
    },
    window: {addEventListener(){}},
    performance: {now: () => Date.now()},
    requestAnimationFrame(){}, // deliberately never invokes its callback — render() never runs
    setInterval(){},           // the "keep side panel live" poller — no panel to keep live in a test
    getComputedStyle: () => ({getPropertyValue: () => ''}),
  };
  const context = vm.createContext(sandbox);
  const script = extractScript(htmlPath);
  vm.runInContext(script, context, {filename: 'src/*.js (concatenated per index.html script order)'});
  return context;
}

// Runs a snippet of code against an existing game context. The snippet can
// reference any top-level binding from index.html directly (world,
// cmdBuildRoad, simTick, RESOURCES, ...). Whatever the snippet assigns to
// `__out` (a plain identifier, not `const`/`let`) is returned to the caller
// — an implicit-global assignment in a vm context attaches to the sandbox
// object, which IS visible from Node.
function run(context, code){
  vm.runInContext(`__out = (function(){ ${code} })();`, context);
  return context.__out;
}

module.exports = {newGameContext, run, extractContentPackJson, extractContentPackBlocks};
