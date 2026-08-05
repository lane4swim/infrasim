// ---------------------------------------------------------------------
// ROAD NETWORK + PATHFINDING (§6.2, §10 — BFS since edges are uniform cost)
// ---------------------------------------------------------------------
// Roads (and, in later phases, rail/pipe/etc.) connect on individual tile
// edges, not "any two adjacent same-type cells are automatically linked."
// Each road cell stores which of its 4 sides actually has an established
// connection. This is what a new road tile updates when it's built next to
// an existing one — connectivity is real per-edge state, not something
// recomputed from scratch by checking neighbor type at query time. That
// distinction is what will let later transport modes model things like a
// one-way edge or an elevated crossing that doesn't connect to what's
// directly below it, without changing how pathfinding itself works.
const ROAD_DIRS = [
  {dir:'N', dx:0,  dy:-1, opp:'S'},
  {dir:'S', dx:0,  dy:1,  opp:'N'},
  {dir:'E', dx:1,  dy:0,  opp:'W'},
  {dir:'W', dx:-1, dy:0,  opp:'E'},
];
function neighbors4(x,y){
  return [[x+1,y],[x-1,y],[x,y+1],[x,y-1]].filter(([nx,ny])=>inBounds(nx,ny));
}
function isRoad(x,y,layer){ return getCell(x,y).layers[layer||'ground'].track; }

// Every cell a building occupies, derived from its anchor (x,y) + footprint.
function footprintCells(building){
  const cells = [];
  for(let dx=0; dx<building.footprint.w; dx++){
    for(let dy=0; dy<building.footprint.h; dy++){
      cells.push({x:building.x+dx, y:building.y+dy});
    }
  }
  return cells;
}

// A building's road dock. If it has a `facing` (Stations do — chosen by the
// player at build time), it connects through that single side only, even if
// a road happens to touch another side too. Buildings without a facing fall
// back to scanning every side (kept for generality; nothing currently uses
// this path since only Stations touch roads).
function buildingRoadAccessCell(building){
  if(building.facing){
    const d = ROAD_DIRS.find(r=>r.dir===building.facing);
    const nx = building.x+d.dx, ny = building.y+d.dy;
    return isRoad(nx,ny,'ground') ? {x:nx,y:ny,layer:'ground'} : null;
  }
  const own = new Set(footprintCells(building).map(c=>c.x+','+c.y));
  for(const cell of footprintCells(building)){
    for(const [nx,ny] of neighbors4(cell.x,cell.y)){
      if(own.has(nx+','+ny)) continue; // don't count a neighbor that's part of the same building
      if(isRoad(nx,ny,'ground')) return {x:nx,y:ny,layer:'ground'};
    }
  }
  return null;
}

// A Rail Depot's rail side, in contrast, is full-perimeter — any touching
// rail tile counts, no facing to choose at build time (§2.1's simpler of
// the two options: the depot's identity as a transfer node is already the
// new thing here, so this deliberately doesn't ALSO introduce a rail-facing
// UI). Structurally the same "scan every side" fallback buildingRoadAccessCell
// already has for a building with no `facing`, just against the rail layer.
function buildingRailAccessCell(building){
  const own = new Set(footprintCells(building).map(c=>c.x+','+c.y));
  for(const cell of footprintCells(building)){
    for(const [nx,ny] of neighbors4(cell.x,cell.y)){
      if(own.has(nx+','+ny)) continue;
      if(getCell(nx,ny).layers.rail.track) return {x:nx,y:ny};
    }
  }
  return null;
}

// BFS over {x,y,layer} nodes: lateral moves follow only established,
// direction-allowed edges within a layer (respecting one-way blocks); a
// vertical move between ground and elevated is only possible at a Ramp
// cell. Returns an array of nodes from start to end (inclusive), or null.
function findRoadPath(start, end){
  const nodeKey = n => n.x+','+n.y+','+n.layer;
  if(start.x===end.x && start.y===end.y && start.layer===end.layer) return [start];
  const visited = new Set([nodeKey(start)]);
  const queue = [start];
  const cameFrom = new Map();
  function tryVisit(node, cur){
    const k = nodeKey(node);
    if(visited.has(k)) return null;
    visited.add(k);
    cameFrom.set(k, cur);
    if(node.x===end.x && node.y===end.y && node.layer===end.layer){
      let path = [node]; let c = cur;
      while(c){ path.unshift(c); c = cameFrom.get(nodeKey(c)); }
      return path;
    }
    queue.push(node);
    return undefined; // not found yet, but queued
  }
  while(queue.length){
    const cur = queue.shift();
    const cell = getCell(cur.x, cur.y);
    const track = cell.layers[cur.layer];
    for(const {dir,dx,dy} of ROAD_DIRS){
      if(!track.edges[dir]) continue;          // no connection this way
      if(track.oneWayBlocked[dir]) continue;   // one-way: can't depart via this side
      const found = tryVisit({x:cur.x+dx, y:cur.y+dy, layer:cur.layer}, cur);
      if(found) return found;
    }
    if(cell.ramp){
      const otherLayer = cur.layer==='ground' ? 'elevated' : 'ground';
      const found = tryVisit({x:cur.x, y:cur.y, layer:otherLayer}, cur);
      if(found) return found;
    }
  }
  return null;
}

// Near-copy of findRoadPath for the rail layer: same BFS (uniform edge
// cost, so no need for A* — §10), same one-way/signal respect, just a
// single layer with no ramp/vertical-move concept. Kept as a separate
// function rather than parameterizing findRoadPath because the two differ
// in exactly the ways road and rail differ structurally (ground/elevated +
// ramps vs. one flat layer) — forcing them through one function would mean
// more branching in the shared code than the two bodies actually share.
function findRailPath(start, end){
  const nodeKey = n => n.x+','+n.y;
  if(start.x===end.x && start.y===end.y) return [start];
  const visited = new Set([nodeKey(start)]);
  const queue = [start];
  const cameFrom = new Map();
  function tryVisit(node, cur){
    const k = nodeKey(node);
    if(visited.has(k)) return null;
    visited.add(k);
    cameFrom.set(k, cur);
    if(node.x===end.x && node.y===end.y){
      let path = [node]; let c = cur;
      while(c){ path.unshift(c); c = cameFrom.get(nodeKey(c)); }
      return path;
    }
    queue.push(node);
    return undefined;
  }
  while(queue.length){
    const cur = queue.shift();
    const track = getCell(cur.x, cur.y).layers.rail;
    for(const {dir,dx,dy} of ROAD_DIRS){
      if(!track.edges[dir]) continue;
      if(track.oneWayBlocked[dir]) continue; // a signal blocks departure this way
      const found = tryVisit({x:cur.x+dx, y:cur.y+dy}, cur);
      if(found) return found;
    }
  }
  return null;
}

// Direction (from ROAD_DIRS) from cell `a` to orthogonally-adjacent cell `b`.
function dirBetween(a,b){ return ROAD_DIRS.find(r => b.x===a.x+r.dx && b.y===a.y+r.dy); }


// Vehicles always live on road cells (they dock next to a building rather
// than entering its footprint), so a vehicle's own path is simply the road
// route from where it stands to the target building's dock cell.

// A Station has no storage of its own. It's only a physical access point:
// vehicles load/unload there, and the Station forwards that transfer to
// whichever industry it's touching — directly, or through a chain of other
// Stations that all touch each other. This walks that chain and returns the
// first Storage-having building it finds (Mine, Mill, Town, or a Rail
// Depot — anything with real Storage counts, not just Producer/Consumer
// buildings, which is what makes a Depot reachable through a Station chain
// exactly like a Mine or Town is today), or null if the station isn't
// connected to anything right now.
function findLinkedIndustry(station){
  const visited = new Set([station.id]);
  const queue = [station];
  while(queue.length){
    const s = queue.shift();
    for(const cell of footprintCells(s)){
      for(const [nx,ny] of neighbors4(cell.x,cell.y)){
        const nCell = getCell(nx,ny);
        if(!nCell.buildingId) continue;
        const nb = world.entities.get(nCell.buildingId);
        if(!nb || nb.id===s.id) continue;
        if(nb.type==='station'){
          if(!visited.has(nb.id)){ visited.add(nb.id); queue.push(nb); }
        } else if(hasComponent(nb.id,'Storage')){
          return nb;
        }
      }
    }
  }
  return null;
}

// Does this footprint (for a building about to be placed) touch at least
// one Storage-having building or Station? Used to require Stations to
// actually connect to something before they can be built (§6.6-style:
// don't let the player build something structurally useless without at
// least a warning).
function touchesIndustryOrStation(x, y, footprint){
  const own = new Set();
  for(let dx=0; dx<footprint.w; dx++) for(let dy=0; dy<footprint.h; dy++) own.add((x+dx)+','+(y+dy));
  for(let dx=0; dx<footprint.w; dx++){
    for(let dy=0; dy<footprint.h; dy++){
      for(const [nx,ny] of neighbors4(x+dx, y+dy)){
        if(own.has(nx+','+ny)) continue;
        const nb = getCell(nx,ny).buildingId ? world.entities.get(getCell(nx,ny).buildingId) : null;
        if(nb && (nb.type==='station' || hasComponent(nb.id,'Storage'))) return true;
      }
    }
  }
  return false;
}

// The Station immediately touching a building's footprint, if any — used
// by the Depot inspector to show its road-side link. Deliberately just the
// immediate neighbor (not a full chain walk like findLinkedIndustry) since
// it's describing "what's physically touching this building," not "what's
// it ultimately connected to."
function findTouchingStation(building){
  for(const cell of footprintCells(building)){
    for(const [nx,ny] of neighbors4(cell.x,cell.y)){
      const nb = getCell(nx,ny).buildingId ? world.entities.get(getCell(nx,ny).buildingId) : null;
      if(nb && nb.type==='station') return nb;
    }
  }
  return null;
}
