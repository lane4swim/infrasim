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
function isRoad(x,y,layer){ return trackAt(x,y,layer||'ground').track; }
// A cell where road and rail — the two kinds sharing a grade (see
// newGradeLayer in world.js) — physically coexist at the SAME grade:
// necessarily a perpendicular crossing. Used both for the crossing
// marker (render.js) and for trains blocking road traffic through it
// while they're physically there (see markTrainCrossingsOccupied in
// systems.js). `railLayer` is 'rail' (ground, the default) or
// 'railElevated'; its grade is where both kinds are checked.
function isRoadRailCrossing(x,y,railLayer){
  railLayer = railLayer || 'rail';
  const [grade] = LAYER_GRADE_KIND[railLayer];
  const gradeLayer = getCell(x,y).layers[grade];
  return gradeLayer.road.track && gradeLayer.rail.track;
}

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

// A Rail Depot's platform: a real loading platform runs alongside the
// track it serves, not just touching it at one corner, so a Depot's
// footprint has a long axis (whichever of w/h is bigger) and only the PAIR
// of sides parallel to that axis are eligible to be its rail side — the
// two short end caps never are, the same way a real platform's end doesn't
// serve trains passing alongside it. Returns the ordered list of the
// track cells alongside whichever of those two long sides has a full,
// unbroken run of ground rail track for the platform's entire length (the
// literal "runs parallel to the track" requirement), or null if neither
// long side qualifies. Takes raw x/y/w/h (not a building handle) so it
// works both for build-time validation, before the building exists, and
// for runtime dock resolution against an already-built Depot.
function depotPlatformCells(x,y,w,h){
  const tall = h >= w; // long axis is N-S (or a square fallback, arbitrarily treated as tall)
  const sides = tall
    ? [ Array.from({length:h}, (_,dy)=>({x:x-1, y:y+dy})),   // west
        Array.from({length:h}, (_,dy)=>({x:x+w, y:y+dy})) ]  // east
    : [ Array.from({length:w}, (_,dx)=>({x:x+dx, y:y-1})),   // north
        Array.from({length:w}, (_,dx)=>({x:x+dx, y:y+h})) ]; // south
  for(const cells of sides){
    if(cells.every(c => inBounds(c.x,c.y) && trackAt(c.x,c.y,'rail').track)) return cells;
  }
  return null;
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

// A Train Yard's rail side is full-perimeter — any touching rail tile
// counts, no facing/platform to choose at build time, since a Yard is
// purely an assembly point (a train departs from wherever it's built, it
// doesn't load/unload there — see createBuilding). A Rail Depot, in
// contrast, only ever docks along its platform (see depotPlatformCells)
// — this returns the platform's first cell as a single representative
// dock cell for callers that just need "is this reachable at all" (the
// UI's connectivity check); resolveTrainDock in systems.js does the real,
// train-length-aware endpoint choice for an actual arriving train.
// Ground-level ('rail') only, deliberately, same as buildingRoadAccessCell
// only ever checks 'ground' road — a Depot or Train Yard is a ground
// building; 'railElevated' is a through-only bridge layer that must come
// back down via a railRamp before it can reach one, exactly like an
// elevated road must return to ground via a Ramp before reaching a Station.
function buildingRailAccessCell(building){
  if(building.type === 'depot'){
    const platform = depotPlatformCells(building.x, building.y, building.footprint.w, building.footprint.h);
    return platform ? {x:platform[0].x, y:platform[0].y, layer:'rail'} : null;
  }
  const own = new Set(footprintCells(building).map(c=>c.x+','+c.y));
  for(const cell of footprintCells(building)){
    for(const [nx,ny] of neighbors4(cell.x,cell.y)){
      if(own.has(nx+','+ny)) continue;
      if(trackAt(nx,ny,'rail').track) return {x:nx,y:ny,layer:'rail'};
    }
  }
  return null;
}

// A rail cell with all 4 lateral directions connected has no possible
// interpretation other than two independent straight lines crossing at
// grade — this game has no switch/points equipment, so a genuine junction
// that lets a train CHANGE from one line onto the other needs a player to
// leave one direction disconnected, exactly like a T/3-way junction already
// works (and stays fully any-to-any, unrestricted — a real switch DOES let
// a train divert). Only rail gets this: a real road intersection lets
// traffic turn in any direction, so a 4-way road cell keeps its ordinary
// any-to-any behavior. See findLayerPath below for where this is enforced,
// and drawTrackCell (render.js) for the matching "two crossing lines, not a
// hub" visual.
function isRailCrossing(track, kind){
  return kind==='rail' && track.edges.N && track.edges.S && track.edges.E && track.edges.W;
}
// A crossing's 2 straight pairs (N-S, E-W) are always connected by default
// — the case above. The 4 "corner" pairs (N-E, N-W, S-E, S-W) are OFF by
// default (a plain crossing has no switch) but individually selectable via
// cmdToggleDiagonalConnection (commands.js) and track.diagonalPairs (world.js)
// — a player-modeled points/switch at that one crossing. Looks up which
// diagonalPairs key (if any) connects two given directions; returns
// undefined for a straight pair (N-S/E-W) or two equal directions, neither
// of which is ever a "diagonal" pair.
const DIAGONAL_PAIR_KEY = {
  N: {E:'NE', W:'NW'},
  S: {E:'SE', W:'SW'},
  E: {N:'NE', S:'SE'},
  W: {N:'NW', S:'SW'},
};

// BFS over {x,y,layer} nodes: lateral moves follow only established,
// direction-allowed edges within a layer (respecting one-way blocks). A
// grade change happens one of two ways, both restricted to the SAME kind
// (a road Ramp for road, a Rail Ramp for rail — see GRADE_KIND_LAYER in
// world.js): a same-cell vertical step at a (road/rail) Ramp between
// ground and elevated, or a lateral step at a ramp edge (§ Underground
// layer) between a ground cell and its underground neighbor one direction
// over — the two are structurally different (one stays at the same x,y,
// the other moves to an adjacent cell) but both just add another
// candidate {x,y,layer} node to the same BFS. Returns an array of nodes
// from start to end (inclusive), or null. findRoadPath and findRailPath
// used to be near-identical separate functions (one difference: which of
// the two flat layer names and which ramp flag); now that both are really
// just "a kind, and its two grades," they're thin wrappers over this one body.
function findLayerPath(start, end){
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
    const track = trackAt(cur.x, cur.y, cur.layer);
    const [grade, kind] = LAYER_GRADE_KIND[cur.layer];
    // At a rail crossing (isRailCrossing above), continuing is restricted to
    // straight through on whichever line was actually arrived on, PLUS
    // whichever corner pairs (if any) the player has switched on for this
    // exact entry direction (track.diagonalPairs — see DIAGONAL_PAIR_KEY
    // above) — dirBetween(prev,cur) is the direction of TRAVEL that reached
    // `cur` (the exit side `prev` used), and straight-through means
    // departing `cur` the same compass direction, not its opposite
    // (arriving while heading east means continuing east on the far side of
    // the crossing, not reversing west). The very first node (no cameFrom
    // entry — cur === start) has no established direction to be consistent
    // with, so it's left unrestricted; that's a narrow, harmless gap in
    // practice, since a fresh path is only ever computed while a vehicle is
    // fully at rest (startMovingTo/startMovingToRail, systems.js), and a
    // bare crossing is never itself a rest point (nothing docks at a
    // crossing) in any built layout.
    let straightOnly = null;
    let entryPort = null; // the physical side `cur` was entered through — the OPPOSITE compass direction from the direction of travel (straightOnly): arriving while traveling south means the connection actually used is cur's NORTH side.
    if(isRailCrossing(track, kind)){
      const prev = cameFrom.get(nodeKey(cur));
      const entryDir = prev && dirBetween(prev, cur);
      if(entryDir){ straightOnly = entryDir.dir; entryPort = entryDir.opp; }
    }
    for(const {dir,dx,dy} of ROAD_DIRS){
      if(!track.edges[dir]) continue;          // no connection this way
      if(track.oneWayBlocked[dir]) continue;   // one-way: can't depart via this side
      if(straightOnly && dir !== straightOnly){
        // A diagonal pair names the two PHYSICAL SIDES it links (e.g. "NE"
        // = the north side and the east side), so the lookup keys off
        // entryPort (the side actually used to arrive), not straightOnly
        // (the direction of travel, its opposite).
        const diagonalKey = DIAGONAL_PAIR_KEY[entryPort] && DIAGONAL_PAIR_KEY[entryPort][dir];
        if(!diagonalKey || !track.diagonalPairs[diagonalKey]) continue; // rail crossing: no turning unless that corner's switch is on
      }
      const found = tryVisit({x:cur.x+dx, y:cur.y+dy, layer:cur.layer}, cur);
      if(found) return found;
    }
    // Same-cell vertical ramps (§ Terrain elevation) — any RAMP_PAIRS entry
    // touching this grade (world.js) — currently just ground<->elevated.
    // A cell can have more than one at once (independently, per kind), so
    // this doesn't stop at the first match — each is its own candidate BFS
    // move.
    const ramps = getCell(cur.x,cur.y).ramps[kind];
    for(const pair of RAMP_PAIRS){
      if(grade !== pair.lo && grade !== pair.hi) continue;
      if(!ramps[pair.key]) continue;
      const otherGrade = grade===pair.lo ? pair.hi : pair.lo;
      const found = tryVisit({x:cur.x, y:cur.y, layer:GRADE_KIND_LAYER[otherGrade][kind]}, cur);
      if(found) return found;
    }
    // Lateral ramp edge (§ Underground layer; § Multi-level tunnels) — one
    // step over at whichever direction(s) this cell's track has rampEdge
    // set (never set on elevated/airspace/deepUnderground track, so this
    // is a harmless no-op there). Unlike the same-cell ramps above,
    // rampEdge[dir] stores the target GRADE directly rather than a
    // boolean, since a cell partway down the underground stack can have a
    // ramp edge going up a level in one direction and a different one
    // going down a level in another — there's no fixed "the other grade"
    // to swap to the way ground<->underground alone could assume.
    for(const {dir,dx,dy} of ROAD_DIRS){
      const targetGrade = track.rampEdge[dir];
      if(!targetGrade) continue;
      const found = tryVisit({x:cur.x+dx, y:cur.y+dy, layer:GRADE_KIND_LAYER[targetGrade][kind]}, cur);
      if(found) return found;
    }
  }
  return null;
}
function findRoadPath(start, end){ return findLayerPath(start, end); }
function findRailPath(start, end){ return findLayerPath(start, end); }

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
