// ---------------------------------------------------------------------
// ECS CORE  (§5 — an entity is just an id; components are per-type data
// tables keyed by that id; systems iterate whichever entities have a given
// set of components, rather than switching on a hardcoded "kind"/"type").
// ---------------------------------------------------------------------
const COMPONENT_TYPES = [
  'Transform',  // {x,y,layer} — every entity, building or vehicle
  'Footprint',  // {w,h} — buildings only
  'Facing',     // 'N'|'E'|'S'|'W' — Stations only, the single road-facing side
  'StationResource', // resource id — Stations only, which single resource this Station handles
  'Storage',    // {out:{resource,stock,cap}|null, in:{resource,stock,cap}|null} — Mines/Mills/Towns
  'Producer',   // {recipeId,ticksRemaining} — Mines and Mills
  'Consumer',   // {population,consumptionPerTick,priceMultiplier} — Towns only
  'Identity',   // {kind:'building'|'vehicle', type} — every entity
  'Movement',   // {speed,maxSpeed,massEmpty,engineForce,brakeForce,length,path,pathIndex,frac,trail,blockTrail,heldBlocks} — vehicles only; blockTrail/heldBlocks are rail-only (see tickTrainMovement)
  'Status',     // {state} — vehicles only (idle|moving|loading|unloading|blocked)
  'Orders',     // {list,index} — vehicles only, player-authored (§6.6)
  'Cargo',      // {amount,capacity,resource} — vehicles only; capacity/resource are fixed at creation (a truck's own def, or a train's wagons — see Consist)
  'RailNode',   // {} — marks a building (Rail Depot) as a valid rail-network endpoint, full-perimeter access
  'TrainYard',  // {} — marks a building (Train Yard) as a train-assembly/spawn point, full-perimeter rail access, no road side
  'Consist',    // {engineType,wagonType,wagonCount} — trains only; what getTrainStats derives a train's Movement/Cargo stats from
];
for(const name of COMPONENT_TYPES) world.components[name] = new Map();

function addComponent(id, name, data){ world.components[name].set(id, data); }
function removeComponent(id, name){ world.components[name].delete(id); }
function getComponent(id, name){ return world.components[name].get(id); }
function hasComponent(id, name){ return world.components[name].has(id); }

// Entities that currently have every one of the given components (and are
// still alive). Systems use this instead of checking a `.kind`/`.type`
// field, so e.g. tickProduction() finds "anything with Producer+Storage"
// rather than hardcoding "buildings of type mine".
function queryEntities(...names){
  if(names.length===0) return [...world.entities.keys()];
  // scan the smallest table first — cheap win, and correct regardless of order
  let smallest = names[0];
  for(const n of names) if(world.components[n].size < world.components[smallest].size) smallest = n;
  const others = names.filter(n=>n!==smallest);
  const result = [];
  for(const id of world.components[smallest].keys()){
    if(!world.entities.has(id)) continue;
    if(others.every(n => world.components[n].has(id))) result.push(id);
  }
  return result;
}

function destroyEntity(id){
  if(hasComponent(id,'Movement')) releaseBlock(world.entities.get(id)); // don't leave a rail block held by a sold/removed train
  world.entities.delete(id);
  for(const name of COMPONENT_TYPES) world.components[name].delete(id);
}

// property name -> [componentName, fieldInComponent] (null field = the
// component's value itself, for components that aren't multi-field records)
const FIELD_MAP = {
  x:['Transform','x'], y:['Transform','y'], layer:['Transform','layer'],
  footprint:['Footprint', null],
  facing:['Facing', null],
  resource:['StationResource', null],
  ticksRemaining:['Producer','ticksRemaining'], recipeId:['Producer','recipeId'],
  population:['Consumer','population'], consumptionPerTick:['Consumer','consumptionPerTick'], priceMultiplier:['Consumer','priceMultiplier'],
  kind:['Identity','kind'], type:['Identity','type'],
  speed:['Movement','speed'], maxSpeed:['Movement','maxSpeed'], massEmpty:['Movement','massEmpty'],
  engineForce:['Movement','engineForce'], brakeForce:['Movement','brakeForce'], length:['Movement','length'],
  path:['Movement','path'], pathIndex:['Movement','pathIndex'], frac:['Movement','frac'], trail:['Movement','trail'],
  blockTrail:['Movement','blockTrail'], // rail-only: block id of the edge crossed i steps ago, mirroring `trail`
  heldBlocks:['Movement','heldBlocks'], // rail-only: every Block id (see world.railBlocks) this train currently holds
  state:['Status','state'],
  orders:['Orders','list'], ordersIndex:['Orders','index'],
  cargoAmount:['Cargo','amount'], capacity:['Cargo','capacity'], cargoResource:['Cargo','resource'],
  transferRate:['Cargo','transferRate'], // this vehicle's own load/unload rate — see effectiveTransferRate in systems.js
  consist:['Consist', null], // {engineType,wagonType,wagonCount} — trains only, see getTrainStats
};
// Storage is a resource-typed pair of slots — {out, in} — rather than one
// flat stock/cap: `out` is what a building offers for pickup (a Mine's ore,
// a Mill's steel), `in` is what it accepts for drop-off (a Mill's ore
// input, a Town's demand). A building only has whichever slot(s) it
// actually needs — a Mine has no `in`, a Town has no `out`, a Mill has both.
const STORAGE_SLOT_FIELDS = {
  outStock:['out','stock'], outCap:['out','cap'], outResource:['out','resource'],
  inStock:['in','stock'], inCap:['in','cap'], inResource:['in','resource'],
};

// A thin, ergonomic handle over an entity's components. The rest of the
// codebase reads/writes plain properties (`building.stock`, `vehicle.speed`)
// exactly as it would on a plain object — but every read/write actually
// goes through the component tables above, so the data is genuinely
// queryable/iterable independently per component, not just renamed fields
// on a monolithic object. `producer`/`consumer` are derived booleans (does
// this entity have a Producer/Consumer component at all?) rather than
// separate stored flags, since the component's presence already means that.
// `stock`/`storageCap` remain as a convenience for buildings with exactly
// ONE storage slot (Mine: out only; Town: in only) — ambiguous for a
// dual-slot building like a Mill, which must use outStock/inStock etc.
function makeEntityHandle(id){
  return new Proxy({id}, {
    get(target, prop){
      if(prop==='id') return target.id;
      if(prop==='producer') return world.components.Producer.has(target.id);
      if(prop==='consumer') return world.components.Consumer.has(target.id);
      if(prop==='stock' || prop==='storageCap'){
        const storage = world.components.Storage.get(target.id);
        if(!storage) return undefined;
        const slot = storage.out && !storage.in ? storage.out : (storage.in && !storage.out ? storage.in : null);
        if(!slot) return undefined; // ambiguous (has both) — use outStock/inStock explicitly
        return prop==='stock' ? slot.stock : slot.cap;
      }
      if(STORAGE_SLOT_FIELDS[prop]){
        const [slotName, field] = STORAGE_SLOT_FIELDS[prop];
        const storage = world.components.Storage.get(target.id);
        const slot = storage && storage[slotName];
        return slot ? slot[field] : undefined;
      }
      const mapping = FIELD_MAP[prop];
      if(!mapping) return undefined;
      const [compName, field] = mapping;
      const comp = world.components[compName].get(target.id);
      if(comp===undefined) return undefined;
      return field===null ? comp : comp[field];
    },
    set(target, prop, value){
      if(prop==='id' || prop==='producer' || prop==='consumer') return false; // derived/immutable
      if(prop==='stock' || prop==='storageCap'){
        const storage = world.components.Storage.get(target.id);
        if(!storage) return false;
        const slot = storage.out && !storage.in ? storage.out : (storage.in && !storage.out ? storage.in : null);
        if(!slot) return false;
        if(prop==='stock') slot.stock = value; else slot.cap = value;
        return true;
      }
      if(STORAGE_SLOT_FIELDS[prop]){
        const [slotName, field] = STORAGE_SLOT_FIELDS[prop];
        const storage = world.components.Storage.get(target.id);
        if(!storage || !storage[slotName]) return false;
        storage[slotName][field] = value;
        return true;
      }
      const mapping = FIELD_MAP[prop];
      if(!mapping) return false;
      const [compName, field] = mapping;
      if(field===null){
        world.components[compName].set(target.id, value);
      } else {
        let comp = world.components[compName].get(target.id);
        if(!comp){ comp = {}; world.components[compName].set(target.id, comp); }
        comp[field] = value;
      }
      return true;
    },
    has(target, prop){
      if(prop==='id' || prop==='producer' || prop==='consumer') return true;
      if(prop==='stock' || prop==='storageCap' || STORAGE_SLOT_FIELDS[prop]) return true;
      const mapping = FIELD_MAP[prop];
      return !!mapping && world.components[mapping[0]].has(target.id);
    },
  });
}

