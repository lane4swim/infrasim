// Headless test harness for index.html's simulation core.
//
// Phase 1 stayed a single self-contained index.html (no build step, opens
// via file://) — the simulation code isn't factored into a separate module.
// Rather than pulling it apart (which the content-pack/Worker-split
// workstreams already plan to revisit for other reasons), this harness runs
// the *actual* <script> contents from index.html inside a Node vm context
// stubbed with just enough of a DOM to let the file load without executing
// any rendering or event-wiring — real shipped code, not a reimplementation.
//
// The trick: index.html's top-level `const`/`function` declarations become
// lexical bindings tied to this vm context, not enumerable properties of
// it — so a single context is created once and reused across every
// `run()` call, letting later snippets reference `world`, `cmdBuildRoad`,
// `simTick`, etc. by name, exactly as if they were later statements in the
// same script. requestAnimationFrame is stubbed to a no-op specifically so
// the render loop never actually starts (nothing in a test needs a canvas).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function extractScript(htmlPath){
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if(!m) throw new Error(`No <script> block found in ${htmlPath}`);
  return m[1];
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
  vm.runInContext(script, context, {filename: 'index.html'});
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
