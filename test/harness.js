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
];

// Concatenates the simulation core's files (resolved relative to
// index.html's own directory, i.e. the project root) into one script —
// the harness's view of "the game's code."
function extractScript(htmlPath){
  const baseDir = path.dirname(htmlPath);
  return SIM_SCRIPT_FILES.map(src => fs.readFileSync(path.join(baseDir, src), 'utf8')).join('\n');
}

// The content-pack <script> tag has a type/id attribute, so it never
// matches extractScript's bare `<script>` pattern above — this pulls it
// separately, the same way a real browser's document.getElementById would.
function extractContentPackJson(htmlPath){
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/<script type="application\/json" id="content-pack">([\s\S]*?)<\/script>/);
  if(!m) throw new Error(`No content-pack <script> block found in ${htmlPath}`);
  return m[1];
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
// `contentPackJson`, if given, replaces the content-pack text index.html
// itself ships — this is what lets a test prove the extensibility claim
// directly (§3.3.3): swap in a different pack, zero changes to the script,
// and confirm the swapped-in content is what the game actually uses.
function newGameContext({contentPackJson} = {}){
  const htmlPath = path.join(__dirname, '..', 'index.html');
  const contentPackText = contentPackJson !== undefined ? contentPackJson : extractContentPackJson(htmlPath);
  const sandbox = {
    console,
    document: {
      getElementById: (id) => id==='content-pack' ? {textContent: contentPackText} : makeFakeElement(),
      querySelectorAll: () => [],
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

module.exports = {newGameContext, run, extractContentPackJson};
