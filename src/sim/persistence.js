// ---------------------------------------------------------------------
// PERSISTENCE (§12) — save/load the whole simulation state as plain,
// JSON-safe data. Worker-only (like commands.js): loaded into the
// simulation Worker and the test harness, but never onto the main
// thread, since serializeWorld/deserializeWorld only ever need to run
// where `world` and the sim tables actually live.
//
// Maps aren't JSON-safe, so every Map on `world` is converted to a plain
// [key,value][] array (via `.entries()`) on save and rebuilt with `new
// Map(...)` on load. This is a stricter requirement than the snapshot
// protocol's structured-clone safety (structured clone preserves Maps
// natively) — a save file has to survive `JSON.stringify`/`JSON.parse`
// round-trips (download to disk, read back from an <input type=file>).
//
// world.entities (Proxies over the component tables, see makeEntityHandle
// in ecs.js) isn't saved directly either — like the snapshot protocol, we
// save just the id list and rebuild handles with makeEntityHandle on load.
// railBlocks doesn't need recomputing on load: each rail edge's blockId
// (in world.grid) and world.railBlocks' occupiedBy state are saved and
// restored together, so they stay mutually consistent as of save time.
const SAVE_FORMAT_VERSION = 1;

function serializeWorld(){
  return {
    saveFormatVersion: SAVE_FORMAT_VERSION,
    contentPackVersion: (typeof CONTENT_PACK !== 'undefined' && CONTENT_PACK.version) || null,
    treasury: world.treasury,
    tick: world.tick,
    nextId: world.nextId,
    entityIds: [...world.entities.keys()],
    components: Object.fromEntries(COMPONENT_TYPES.map(name => [name, [...world.components[name].entries()]])),
    grid: [...world.grid.entries()],
    railBlocks: [...world.railBlocks.entries()],
  };
}

function deserializeWorld(data){
  world.treasury = data.treasury;
  world.tick = data.tick;
  world.nextId = data.nextId;
  world.grid = new Map(data.grid);
  world.railBlocks = new Map(data.railBlocks || []);
  for(const name of COMPONENT_TYPES){
    world.components[name] = new Map((data.components && data.components[name]) || []);
  }
  world.entities = new Map(data.entityIds.map(id => [id, makeEntityHandle(id)]));
}
