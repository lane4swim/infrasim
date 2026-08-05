# Phase 1 — Playable Prototype

*(See [Phase 2 — Rail](#phase-2--rail) below for what's built on top of
this since.)*

This started as Phase 1 of the build order from the architecture spec:
**ground-level roads + trucks, a single resource, a single recipe, a basic
tick loop** — plus the two interaction models the whole spec depends on
getting right early: **player-authored orders** and **player-sized
storage**. It's since grown well past that: a first taste of the
height-layer system (elevated road crossings), directional network edges
(one-way roads, single-sided Station access), and now multiple resources
with a real processing chain (Mine → Mill → Town) and resource-restricted
vehicle types.

## Running it

Open `index.html` directly in a browser (Chrome/Edge/Firefox). No build
step, no server, no npm install — the code is organized into files under
`src/` (see [Phase 2 — Project Structure](#phase-2--project-structure)
below), but loading it is still just double-clicking `index.html`; nothing
to install, no network connection needed.

## How to play

1. Pick **Build Road** and drag out a road. The **Ground/Elevated** dropdown
   above it picks which layer you're building on — elevated costs 2x and
   never connects to a ground tile at the same cell, so it's how you cross
   one road over another without them joining. Where you want the two layers
   to actually link up, use **Build Ramp** on a cell that already has both a
   ground and an elevated tile.
2. Try **Toggle One-Way**: click a road tile, then click an adjacent
   connected tile — traffic will only flow from the first tile to the
   second from then on (click the same pair again to revert to two-way). An
   amber arrow marks the allowed direction.
3. For parallel one-way streets, uncheck **Auto-connect new road tiles**
   first, then lay two lanes side by side — they won't join across the
   middle. Switch to **Connect / Disconnect** and click along each lane
   (tile, then the next tile in that lane) to wire it lengthwise, then use
   Toggle One-Way to send each lane in an opposite direction. The same
   Connect / Disconnect tool also works the other way: click two *already
   connected* tiles to sever that link, e.g. to split up a road you built
   with auto-connect on.
4. Pick **Build Mine** and click anywhere with room for its footprint — it
   always produces Ore, and it no longer needs to touch the road itself.
5. Pick **Build Steel Mill** and place one too — a Mill turns Ore into
   Steel. It needs *two* Stations touching it: one handling Ore (for
   delivery) and one handling Steel (for pickup) — the Station's resource
   is chosen in the **Station handles** dropdown when you place it.
6. Pick **Build Town**, choose what it **accepts** (Ore or Steel) in the
   dropdown, and place it. For the Mine→Mill→Town chain, set it to accept
   Steel.
7. Pick **Build Station**, choose a **Facing** (N/E/S/W) — the *only* side
   that will ever connect to a road — and the **resource it handles**, then
   click a cell touching the relevant building. You'll need four Stations
   total: Ore at the Mine, Ore at the Mill (delivery), Steel at the Mill
   (pickup), Steel at the Town.
8. Buy a **Bulk Truck** (carries Ore only) and give it two stops: the Ore
   Station at the Mine (loads), then the Ore Station at the Mill (unloads).
   Buy a **Flatbed Truck** (carries Steel only) and give it two stops: the
   Steel Station at the Mill (loads), then the Steel Station at the Town
   (unloads, for income). The order editor rejects a stop whose resource
   doesn't match the truck's — a Bulk Truck simply can't be given a Steel
   stop.
9. Watch the Mill's *two* fill-bars (Ore in on the bottom, Steel out above
   it) — it halts (red outline) if it runs out of Ore *or* if its Steel
   buffer is full, same as the Mine halts if its own output fills up. Watch
   the small dot on each Station too — teal means it's connected to an
   industry, red means it isn't (yet); the amber dot on a Station's edge
   shows its facing side. Nothing routes, resupplies, or resizes itself —
   that's on you, per the spec's §6.6.

## What's implemented (maps to the architecture spec)

- **Multiple resources, a real recipe chain, and resource-restricted vehicle
  types.** `RESOURCES` now holds Ore and Steel (each with its own
  `baseValue` and `unitWeight`); `RECIPES` defines `extract_ore` (Mine: no
  inputs, produces Ore) and `smelt_steel` (Mill: consumes Ore, produces
  Steel). A building's `Storage` component is a pair of resource-typed slots
  — `out` (what it offers for pickup) and `in` (what it accepts for
  drop-off) — rather than one flat stock/cap: a Mine has only `out`, a Town
  has only `in` (its accepted resource is chosen at build time), and a Mill
  has both, which is what makes it a real intermediate processing step
  rather than just another source or sink. `tickProduction` is generic over
  any recipe (0-or-1 input, 1 output — a deliberate Phase 1 simplification)
  rather than hardcoding extraction. A Station's `resource` (chosen at build
  time, alongside its `facing`) determines which of an industry's two slots
  it talks to — a Station handling Ore at a Mill drives its `in` slot
  (delivery), one handling Steel drives its `out` slot (pickup) — and the
  order editor rejects a stop whose resource doesn't match. Vehicles are
  now typed: a Bulk Truck's cargo resource is fixed to Ore, a Flatbed
  Truck's to Steel, for its entire life — enforced the same way, at the
  point a stop is added, not just by convention. Verified end-to-end with a
  full Mine → Bulk Truck → Mill → Flatbed Truck → Town chain, including
  that the Mill halts correctly when it runs out of Ore and resumes once
  resupplied, and that vehicle mass/accel/decel correctly use whichever
  resource that specific vehicle is actually carrying.
- **A real component-table ECS.** Entities are just ids; each component type
  (`Transform`, `Footprint`, `Facing`, `StationResource`, `Storage`,
  `Producer`, `Consumer`, `Identity`, `Movement`, `Status`, `Orders`,
  `Cargo`) lives in its own `Map<entityId, data>` under `world.components`,
  and systems select which entities to process with `queryEntities(...names)`
  — e.g. `tickProduction` runs on `queryEntities('Producer','Storage')`
  rather than scanning every entity and checking a `.type` field. A Station
  genuinely has no `Storage` component at all (not just a zero-valued one),
  a Mine has no `Movement` component, and so on — `hasComponent`/
  `getComponent` query this directly. Each entity handle is a thin `Proxy`
  that reads/writes the right component field under a plain property name
  (`building.stock`, `vehicle.speed`), so the rest of the codebase (and
  every existing test) didn't need to change to benefit from this — but the
  data now genuinely lives in independent, queryable tables rather than one
  flat object per entity. `destroyEntity` removes an entity from every
  table at once; fixing the commands that demolish a building or sell a
  vehicle to call it (instead of only forgetting the id from a single map)
  caught a real pre-existing bug where a demolished Mine kept silently
  producing ore forever, since nothing had actually removed it from the
  entity/component data — only its grid-cell reference was cleared.
- Road graph + BFS pathfinding between a vehicle's current position and its
  ordered stops (§6.2, §10)
- Fixed 300ms simulation tick, decoupled from the render loop via an
  accumulator (§8)
- Player-authored `Orders`: the only way a truck gets a destination (§6.6)
- Player-chosen storage tier (small/large) at build time; halted production
  and waiting vehicles when storage/backpressure limits are hit (§6.6)
- Configurable building footprints: each building def carries a `footprint`
  (`{w,h}` in cells) — Mines are 2x2, Towns are 3x2, Stations are 1x1 in this
  build — and construction, demolition, rendering, and pathfinding all work
  off that footprint rather than assuming one cell per building
- **Stations as the only load/unload point.** Mines and Towns hold resources
  but are never touched by a vehicle directly. A Station is a separate,
  storage-less building that must touch a Mine, Town, or another Station;
  vehicle orders can only target Stations. When a truck loads/unloads at a
  Station, the game walks the chain of touching Stations to find the
  industry it's ultimately connected to (`findLinkedIndustry`) and transfers
  against *that* building's stock — so a Station chain can carry access out
  from an industry that isn't itself next to a road.
- **A Station's road access is single-sided and chosen at build time.**
  Every cell stores its road network per layer as `{road, edges, oneWayBlocked}`
  per side; a generic building would dock through *any* side touching a
  road, but a Station instead records a `facing` (N/E/S/W) picked when it's
  placed, and `buildingRoadAccessCell` only ever checks that one side. A road
  on another side of the same Station simply doesn't count.
- **Acceleration and deceleration are physics-based (F=ma), not fixed
  constants — and load genuinely matters.** Each vehicle instance has its
  own `maxSpeed` (tiles/tick), `massEmpty`, `engineForce`, `brakeForce`, and
  `length` (tile-units) — all derived from the truck type's base values with
  individual per-vehicle variance, not shared constants. Actual acceleration
  and deceleration aren't stored on the vehicle at all; they're computed
  fresh every tick as `engineForce / mass` and `brakeForce / mass`, where
  `mass = massEmpty + cargoAmount × resource.unitWeight`. A loaded truck is
  heavier, so the same engine force yields less acceleration and the same
  brake force yields less deceleration — a full truck measurably starts
  braking at a bigger gap and accelerates more slowly than an empty one,
  which was verified directly. `brakeForce` is always built to be greater
  than `engineForce`, which guarantees decel > accel at *any* mass (both
  divide by the same current mass in a given tick, so it's the force ratio
  that matters, not the mass itself) — verified across a range of cargo
  loads, not just at rest. A vehicle starts at rest and accumulates
  `frac += speed` each tick, crossing into the next cell once that reaches 1
  or more (looping to cross more than one cell in a single tick at higher
  speeds).
- **Speed is regulated every tick by a real stopping-distance check, which
  is what makes the following gap velocity- (and load-) dependent.** Before
  moving, each vehicle looks ahead along its own path for the nearest
  obstruction (a reservation held by another vehicle, or its own path's
  end) and computes the gap to it. If that gap is less than what the
  vehicle would need to stop from its current speed at its *current*
  deceleration (`speed² / (2·decel)`, the same physics as a real braking
  distance, plus a small safety cushion when the obstruction is another
  vehicle), it decelerates; otherwise it accelerates toward its own
  `maxSpeed`. Since required stopping distance grows with the *square* of
  speed, a faster vehicle needs a disproportionately bigger gap and starts
  braking earlier than a slower one — this was verified directly (a
  higher-maxSpeed vehicle measurably starts braking at a bigger gap than a
  lower-maxSpeed one under identical force, and a loaded vehicle starts
  braking at a bigger gap than an empty one under identical force and top
  speed). Approaching its own destination uses a zero safety cushion (fully
  closing that gap to arrive is correct and safe), which matters — an
  earlier version of this reused the same small cushion for both cases and
  vehicles would stall permanently just short of arriving, since a fixed
  minimum gap can never fully close to zero.
- **Vehicles queue instead of overlapping, and length affects the gap.**
  Each tick, `tickVehicles` builds a reservation map from every vehicle's
  footprint — its current cell plus enough of its own recent trail (`trail`,
  a short history of cells it's actually occupied) to cover its `length` —
  before any of them move. A vehicle only commits a step into the next cell
  if that cell isn't reserved by a different vehicle's footprint, so a
  longer vehicle forces a bigger following gap than a shorter one, on top of
  the speed-dependent gap above. Two vehicles converging head-on on a
  single-width lane settle into a stable standoff rather than colliding or
  deadlocking the tick loop — resolving that (passing lanes, one-way routing
  around it) is on the player, the same way storage sizing and orders are.
- **Per-edge road connectivity**, now layered: each cell has an independent
  `ground` and `elevated` track, each storing which of its 4 sides has an
  established connection — never inferred from "two adjacent cells are both
  road." Building a tile only connects the specific sides that border an
  existing tile *on the same layer* at that moment; demolishing severs those
  edges rather than leaving stale state.
- **Auto-connect is a toggle, not a given — plus a manual Connect /
  Disconnect tool.** The Road tool has an "Auto-connect new road tiles"
  checkbox (on by default, matching the original behavior); switch it off
  and a newly placed tile is isolated even if it's sitting right next to an
  existing one. The **Connect / Disconnect** tool then lets you wire up (or
  sever) one specific edge at a time — click a road tile, then an adjacent
  one, and it toggles that single connection, independent of what's
  physically touching. Disconnecting also clears any one-way state on that
  edge, so a later reconnect doesn't resurrect a stale block. Together these
  are what make parallel one-way streets possible: lay two lanes side by
  side with auto-connect off (so they never join across the middle), wire
  each lane lengthwise with Connect, then set opposite one-way directions on
  each — verified directly, including that there's genuinely no path from
  one lane to the other.
- **Elevated crossings.** An elevated road tile can occupy the same cell as
  a ground road tile (or sit above open ground) without ever connecting to
  it — they're entirely separate tracks. A **Ramp**, built where both layers
  already have a tile at the same cell, is the only thing that links them,
  represented as a same-cell vertical move in the pathfinding BFS. Vehicles
  track their own `layer` and can use an elevated shortcut between two Ramps
  if one exists.
- **One-way edges.** Each cell/direction has a `oneWayBlocked` flag (default
  false, i.e. two-way). Making an edge one-way sets that flag only on the
  *receiving* side for the reverse direction, leaving the forward direction
  open — pathfinding checks this flag before departing a cell in a given
  direction, and rendering draws a small arrow on a one-way edge instead of
  a plain stub.
- Town resource consumption: each Town has a population (set by its storage
  tier) that drains its own Ore stock every tick, independent of deliveries —
  a Town with no truck service will run dry even though nothing loaded or
  unloaded there
- Treasury, road/building construction costs (elevated roads cost 2x per
  tile, a §16.2-style layer multiplier), vehicle purchase + per-tick running
  cost, and delivery income priced from `resource.baseValue` (§16). Ore also
  carries a `unitWeight`, which feeds directly into vehicle mass while loaded
  (see the acceleration/deceleration bullet above).

## Deliberately deferred to later phases

- **Web Worker split.** The spec calls for the simulation to run off the
  main thread (§2, §8). This prototype runs it inline in the render loop
  instead, specifically so it works when opened straight from disk
  (`file://`) without hitting worker/module CORS restrictions in some
  browsers. The simulation code here is already isolated from rendering
  (look at `simTick()` vs `render()`) — moving it into a worker later is a
  refactor, not a redesign.
- Ship/plane/pipeline/powerline modes. (Rail — the first additional
  transport mode, plus a true multi-modal transfer node — is no longer
  deferred; see [Phase 2 — Rail](#phase-2--rail-a-second-transport-mode).)
- The full multi-layer height system (§3–4) — this build only has two
  layers (ground/elevated) and only for roads; underground layers, and
  elevated/underground for buildings or other transport modes, aren't here.
- IndexedDB persistence / save-load. Not wired up yet.
- Any content-pack / JSON-file data loading — the resource, recipe,
  building, and vehicle definitions are inline JS objects for now instead of
  `data/*.json`, to keep this one file. Splitting them out is the natural
  first step of the "Content/extensibility pass" milestone (§15).
- Multi-input or multi-output recipes (each recipe here has at most one
  input resource and exactly one output) and multi-slot vehicle cargo (a
  vehicle still carries one resource at a time, matching its fixed type).
- Multi-cell Stations. `buildingRoadAccessCell`'s facing logic maps directly
  to one neighbor cell, which only works because Stations are 1x1; a larger
  Station would need "facing" to mean an entire side of the footprint.

## Known rough edges

- A vehicle that's `blocked` (waiting on an empty source or a full
  destination) flickers between `blocked` and `loading`/`unloading` in its
  displayed state every other tick. It's still correctly waiting either way
  — this is just a cosmetic quirk in the state machine, not a logic bug.
- Deleting a road segment mid-transit doesn't invalidate a vehicle's current
  path; it'll just recompute cleanly the next time it starts a new order. Full
  path invalidation-on-edit is worth adding once rail block signals (Phase 2)
  make stale paths a bigger deal.
- A stop's load/unload action is decided once, when you add it — from
  whichever industry the Station is linked to *at that moment*. If you later
  rewire a Station's chain to a different kind of industry (Mine vs Town),
  an existing order pointing at it keeps its original action, which may no
  longer match. Re-adding the stop fixes it; this isn't handled automatically
  yet.
- A vehicle's length-based reservation is only as good as its `trail` — the
  short history of cells it's actually driven through. A freshly-spawned
  vehicle (or one that's never moved yet) has an empty trail, so for its
  first `ceil(length)` cell-crossings it only reserves its current cell,
  not its full body. It self-corrects within a few ticks of actually
  driving; it just doesn't have a "pre-loaded" trail the instant it's
  bought.
- Demolishing one layer's road tile at a cell (say, elevated) automatically
  removes a Ramp there too, since a Ramp needs both layers present — you'll
  need to rebuild the Ramp (and pay for it again) if you want the link back.

---

# Phase 2 — Rail

The first milestone of Phase 2 (per the architecture spec's build order,
§15): **Rail as a genuinely different transport mode, plus a true
cross-mode transfer node** — the Rail Depot — that Phase 1's Station
deliberately wasn't. Still one self-contained `index.html`, no build step.

## Running the tests

Unlike Phase 1, this milestone ships with a headless regression suite:

```
node test/test-rail.js
```

`test/harness.js` runs the *actual* `<script>` contents of `index.html`
inside a Node `vm` context, stubbed with just enough of a DOM (`document`,
`requestAnimationFrame`, …) that the file loads without ever starting its
render loop — real shipped code, not a reimplementation. `test-rail.js`
covers block mutual exclusion, block-boundary computation (including
recompute-on-demolish), a full Mine → truck → Depot → train → Depot →
truck → Town chain, and confirms the F=ma physics model generalizes to
trains unmodified. It also re-runs Phase 1's own Mine → Mill → Town chain
headlessly as a stand-in for "no regressions," since this repo doesn't have
Phase 1's original suites checked in to literally re-run.

## What's implemented (maps to the Rail milestone plan)

- **A third grid layer, reusing the road pattern deliberately.** `rail`
  sits alongside `ground`/`elevated` with the exact same
  `{track, edges, oneWayBlocked}` shape (the `road` boolean was renamed to
  the generic `track`, since none of `getCell`/`findRoadPath`/connectivity
  bookkeeping was ever actually road-specific). Track is grid data, not
  ECS entities — same reasoning as roads in Phase 1: uniform,
  position-indexed, and numerous, which was already the reason roads
  weren't entities either.
- **Block signaling — a genuinely new state category.** A `Block`
  (`{occupiedBy: entityId|null}`) covers a maximal run of rail edges
  between "hubs": a junction or dead end (degree ≠ 2), a signal, or a cell
  touching a Rail Depot. Recomputed wholesale on track build/demolish
  (`computeRailBlocks`), never per tick. Two trains can never hold the same
  block at once — a hard rule layered on top of the same soft
  velocity-gap/footprint spacing trucks already use, not a replacement for
  it. Blocks live in `world.railBlocks` (keyed by block id) rather than as
  an ECS component, for the same reason track itself isn't ECS — there's
  no entity to attach a component to.
- **Rail Depot — a true cross-mode transfer node.** Unlike a Station (a
  storage-less access point), a Depot has real `Storage`, sized so it can
  absorb the rate mismatch between a train dropping off dozens of units at
  once and trucks drawing it down a few at a time. Its `out` and `in`
  slots are *the same object* (not two separate counters that happen to
  share a resource id) — a Depot doesn't convert anything, so there's only
  one physical pile of whatever resource it buffers, and a truck's
  drop-off and a train's pickup need to read/write that one number
  regardless of direction. Road access works exactly like a Mine/Mill/Town
  (a Station built touching it does the docking — `findLinkedIndustry` now
  recognizes any Storage-having building, not just Producer/Consumer
  ones); rail access is full-perimeter (any touching track tile), no
  facing UI needed.
- **`tickTrainMovement`, sharing the road vehicles' physics wholesale.**
  `applySpeedStep`/`advanceAlongPath`/the occupancy-map machinery were
  factored out of `tickVehicles` into functions both trucks and trains
  call — trains get individual `maxSpeed`/`massEmpty`/`engineForce`/
  `brakeForce` exactly like trucks, just with much larger base values, and
  `brakeForce > engineForce` still guarantees decel > accel at any mass.
  The only genuinely new piece is layered on top: before crossing into the
  next block, a train must acquire it (and release whichever block it's
  leaving); if the next block is already held, it decelerates to a full
  stop *at the boundary*.
- **`findRailPath`**, a near-copy of `findRoadPath`'s BFS for the rail
  layer (uniform edge cost, so still BFS, no A*) — one flat layer, no
  ramp/vertical-move concept the way ground/elevated roads have.
- **Trains are assembled at a Train Yard from an Engine and N Wagons, not
  bought off a fixed def.** *(This superseded an earlier, simpler
  single-vehicle "Freight Train" design — see the Content-Pack Refactor
  and Train Yard sections below for the reasoning and what replaced it.)*
- **Explicit Load/Unload stop buttons**, replacing the single "+ Add stop"
  button. A Depot's `out` and `in` sharing one resource made the old
  resource-match inference (which slot has this resource?) ambiguous for
  the first time — Mill's two differently-resourced Stations never hit
  this. The player now says which action they mean; `resolveStopTarget`
  validates it (via a Station's chain for trucks, or directly for trains
  at a Depot) and rejects a stop that doesn't support it. This also
  quietly fixed a latent bug: a Station touching a building whose
  `out`/`in` happened to match on resource could only ever resolve to one
  action before, never the other.
- **Rail tool group**: Build Track, Toggle Signal Direction (mechanically
  identical to Toggle One-Way — a signal *is* a one-way restriction, and
  additionally a block boundary), Build Rail Depot. (Train purchase moved
  to the Train Yard tool group — see below.) Depot inspector shows both
  links ("Road side: Station #N" / "Rail side: connected/not") instead of
  a Station's single line.

## Deliberately deferred

- Ship/plane/pipeline/powerline modes and the later performance pass stay
  future milestones (§15) — this is Rail only.
- Block computation cost at scale. Recomputing all blocks from scratch on
  every track edit is fine at this grid size; flagged for the later
  performance pass, not solved here.
- The Worker split and persistence workstreams that the implementation
  plan schedules after Rail — not part of this milestone. (The
  content-pack refactor, also scheduled after Rail, is no longer deferred
  — see [Phase 2 — Content-Pack Refactor](#phase-2--content-pack-refactor)
  below.)

## Known rough edges

- Demolishing rail track out from under a train mid-journey isn't handled
  specially — same accepted rough edge as Phase 1's "deleting a road
  segment mid-transit doesn't invalidate a path." The stale block
  reference is guarded against crashing, but a train in that situation
  won't recover cleanly.
- A stationary train that hasn't crossed a block edge yet (freshly
  purchased, or idle with no orders) doesn't hold any block — only the
  soft cell-footprint reservation still prevents another train from
  physically overlapping it. Real block signaling would reserve the whole
  block for a parked train too; this is a simplification, same spirit as
  Phase 1's vehicle-`trail` rough edge.

## Addendum — Depot forwards to a linked industry, like a Station

A Rail Depot originally only ever moved cargo into/out of its own real
`Storage` — a train's pickup/drop-off always hit that buffer directly,
regardless of what (if anything) the Depot happened to be touching. That
meant a Depot could never draw straight from an adjacent Mine, or push
straight into an adjacent Town, the way a Station already did for trucks
— every rail delivery needed a truck leg on at least one end to physically
carry cargo into or out of the Depot's own bucket first (see Test 4
above).

A Depot now does the exact same `findLinkedIndustry` chain-walk a
Station already used — touching an industry directly, or reaching one
through a chain of other Stations — and when linked, a train's
pickup/drop-off happens against *that* industry's real `Storage`
directly, not the Depot's own. The Depot's own buffer is still there and
still used exactly as before, but only as a fallback for when nothing's
linked — so a standalone Depot mid-line, filled/drained by a truck+Station
leg elsewhere on the map, keeps working unchanged (this is genuinely just
a fallback, not a special case: `findLinkedIndustry(depot)` returning
`null` and falling back to the Depot itself is indistinguishable, in
every way that matters, from a Depot that was never linked to begin
with).

`resolveStopTarget` (`ui.js`) validates a Depot's own declared resource
against both the vehicle's cargo and, when linked, the linked industry's
actual resource — the same two checks a Station's chain already got, now
applied symmetrically. The Depot inspector and its on-map fill bar both
show the linked industry (if any) and its real stock instead of the
Depot's own, since that's the number actually moving once a link exists.

Covered by `test-rail.js`'s Test 7: a Mine touching a Depot directly (no
Station, no truck at all), forwarding into a Train Yard-assembled train,
delivering through a second Depot chained to a Town via one ordinary
Station — end to end, with zero trucks anywhere in the test.

---

# Phase 2 — Content-Pack Refactor

The second workstream of Phase 2 (§3): move `RESOURCES`, `RECIPES`,
`BUILDING_DEFS`, `VEHICLE_DEFS`, `RAIL_DEFS`, and `TRAIN_DEFS` out of
inline JS objects into genuine external-ish data, closing the gap between
§9/§13's "new resource = new JSON file, no code change" claim and what was
actually true before this (the defs were data-*shaped*, but still JS
literals baked into the file, requiring an edit of the whole game to add
anything).

## Running the tests

```
node test/test-content-pack.js
```

Covers: the real content pack still loads and validates cleanly; each of
several deliberately-broken fixtures (missing `baseValue`, a recipe
referencing an undefined resource, a vehicle with `brakeForce <=
engineForce`, …) is rejected with a specific, correctly-worded error, not
a generic failure or a silent pass; and a small modder-authored pack (one
new resource, one new recipe reusing the existing Mine building, one new
vehicle type) works end-to-end — including actually producing and
transporting the new resource through a live simulation — with zero
changes to `index.html`'s script beyond the JSON block itself.
`test/test-rail.js` still passes unmodified too, confirming this refactor
didn't change any behavior, only where the data lives.

## What's implemented (maps to the Content-Pack Refactor plan)

- **The content is now one `<script type="application/json"
  id="content-pack">` block**, sitting above the main `<script>` in
  `index.html`, containing a single JSON object keyed by category
  (`resources`, `recipes`, `buildings`, `vehicles`, `rail`, `engines`,
  `wagons` — the last two added by the Train Yard redesign, see below). A
  modder edits one clearly-delineated JSON block, not JS source — and the
  game still opens by double-clicking the file, since this sidesteps the
  `fetch()`-under-`file://` CORS problem a real `data/*.json` directory
  would hit without a local server (the same reason this project is one
  self-contained HTML file in the first place).
- **Parsed once at startup** into the exact same `RESOURCES`/`RECIPES`/
  `BUILDING_DEFS`/`VEHICLE_DEFS`/`RAIL_DEFS`/`ENGINE_DEFS`/`WAGON_DEFS`
  bindings every system, command, and render function already referenced
  — genuinely zero changes anywhere else in the script, since none of that
  code ever cared whether the object it was handed came from a literal or
  a parse.
- **`validateContentPack`**, a lightweight schema check (not real JSON
  Schema — cheap to write, and enough to catch the actual failure mode: a
  hand-edited content block with a typo or a dangling reference) that runs
  immediately after parsing and throws a clear error naming the exact
  missing/malformed field, rather than an obscure crash three systems away
  the first time something reads the bad value. Checks structural
  requirements (required fields, correct types) and cross-references
  (a recipe's resource ids exist, a building's `recipe` id exists, a
  vehicle/wagon's `resource` exists) plus the physics invariant Phase 1
  established (`brakeForce > engineForce`, checked for both vehicles and
  engines, which is what guarantees decel > accel at any mass).
- **`test/harness.js`** now stubs `document.getElementById('content-pack')`
  with the real extracted JSON text by default, and accepts a
  `contentPackJson` override — which is what lets `test-content-pack.js`
  prove the extensibility claim by actually swapping in different content,
  not just asserting the mechanism should work.

## Deliberately deferred

- A real `data/` directory with a build step remains a later, purely
  additive step if/when a bundler is adopted for other reasons (most
  likely the Worker split wanting real `import`s) — migrating from "one
  JSON blob" to "a `data/` directory" is mechanical at that point, not a
  redesign of the validation or loading logic.
- Real JSON Schema validation, or a validation library — `validateContentPack`
  stays a small hand-written function; revisit only if the schema outgrows
  what a dozen `need(...)` checks can cover clearly.

---

# Phase 2 — Train Yard

A redesign of how trains come into being, landing on top of the Rail
milestone and Content-Pack Refactor above: instead of buying a single
fixed "Freight Train" vehicle def, a train is **assembled at a Train Yard
from one Engine (physics) plus N identical Wagons (cargo)** — much closer
to how real trains work, and closer to trucks' resource-fixed model than
the earlier "any resource per trip" design was.

## Running the tests

Both existing suites cover this — no new test file, since this changed how
trains are *created*, not the rail mechanics or content-pack loading that
`test-rail.js` and `test-content-pack.js` already exercise:

```
node test/test-rail.js
node test/test-content-pack.js
```

`test-rail.js`'s "Test 3 — Train Yard assembly" is the dedicated coverage:
confirms assembling away from a Yard is rejected (no train, no charge),
assembling on track touching a Yard works and charges exactly
`engine.purchaseCost + wagonCount * wagon.purchaseCost`, capacity is
`wagonCount * wagon.capacity`, the cargo resource is the wagon's (fixed,
like a truck's), the `Consist` component records exactly what was
assembled, and an unknown engine or a zero wagon count is rejected rather
than silently accepted. The other rail tests (block exclusion, physics
reuse, the cross-mode chain) were updated to create trains via
`createTrain`/`cmdAssembleTrain` instead of the retired
`cmdPurchaseVehicle(x, y, 'freight')`. `test-content-pack.js`'s modder-pack
test now also adds a new Wagon type end-to-end, alongside the existing new
resource/recipe/vehicle.

## What's implemented

- **`ENGINE_DEFS`/`WAGON_DEFS`** replace `TRAIN_DEFS` in the content pack.
  An engine def is physics-only (`maxSpeedTilesPerTick`, `massEmpty`,
  `engineForce`, `brakeForce`, `lengthTiles` — no capacity, no resource,
  it carries nothing itself). A wagon def is cargo-only (`capacity`, a
  fixed `resource` — like a truck's, not settable per-trip anymore — plus
  `massEmpty`/`lengthTiles` — no propulsion of its own).
- **`Consist`**, a new component (`{engineType, wagonType, wagonCount}`)
  replacing a train's old fixed `Identity.type` lookup. `getTrainStats`
  combines one engine with N identical wagons into the same shape
  `getVehicleDef` returns for a truck (label, cost, capacity, resource,
  physics), so every call site that reads a vehicle's stats (rendering,
  upkeep, sell, inspector) stays one dispatcher — `getVehicleStats(v)` —
  instead of branching between trucks and trains everywhere. `isTrain(id)`
  (checks `hasComponent(id, 'Consist')`) replaced the old
  `isTrainType(type)` string-table check as the one place that
  distinction is made.
- **Train Yard**, a new building (`TrainYard` component) that's purely a
  rail-side assembly/spawn point — no `Storage`, no road side, no Station
  requirement to touch anything. Full-perimeter rail access, same as a
  Depot's rail side, and it's a block hub for the same reason a Depot is
  (a train's approach to either is always its own segment) —
  `railCellTouchesDepot` was generalized to `railCellTouchesRailEndpoint`
  (checks for a Depot's `RailNode` *or* a Yard's `TrainYard`) for block
  computation, while `railCellTouchesYard` stays Yard-specific for
  assembly validation, since "does this segment end at a hub" and "can I
  assemble a train here" are different questions that happen to often
  overlap.
- **`cmdAssembleTrain(x, y, engineType, wagonType, wagonCount)`** — the
  replacement for the old `cmdPurchaseVehicle(x, y, 'freight')`. Requires
  the target rail tile to actually touch a Yard (not just any track),
  charges the combined cost, and calls `createTrain`, which is to
  `cmdAssembleTrain` what `createVehicle`(now `createTruck`) already was
  to `cmdPurchaseVehicle` — a plain entity factory, no validation, matching
  the existing Command/factory split (§7).
- **A wagon's resource is fixed at assembly, like a truck's** — this
  retires the earlier "a train's cargo resource is set per-trip, at the
  point of loading" design (§2.5 of the Rail plan). A single train can
  still serve "several parts of the network" the way that design intended
  — just by carrying more of one resource per trip (`wagonCount *
  wagon.capacity` can be much larger than any truck) rather than switching
  resources between trips.
- **UI**: "Buy Freight Train" replaced by "Build Train Yard" + "Assemble
  Train" (engine/wagon/count selects, then click track touching a Yard).
  Depot's inspector and rendering are unchanged; Yard gets its own
  inspector (rail-side link status only, since it has no Storage) and
  falls through the generic building bars code as an empty-bars building,
  same as a Station.

## Deliberately deferred

- **Mixed-resource consists.** A train's wagons must all be the same
  type/resource for now — `Cargo` stays the single `{amount, capacity,
  resource}` shape every other vehicle already uses, rather than becoming
  a per-wagon list. A train wanting to carry both Ore and Steel
  simultaneously would need Cargo (and the load/unload state machine, and
  Orders) to become wagon-aware; cheap to add later since it's additive to
  the Consist model, not a redesign of it — just isn't needed to satisfy
  "assembled from engines and wagons" on its own.
- **Multiple engine types, more than two wagon types.** The content pack
  ships one engine (Diesel) and two wagons (Ore, Steel) — enough to prove
  the mechanic; more of each is a pure data addition, no code change (see
  the Content-Pack Refactor section's own extensibility test, now
  extended to cover a modded wagon too).
- **Multi-segment train rendering.** A train still draws as one rectangle
  sized loosely by its total `length` (now genuinely variable — 1 wagon
  vs. 6 reads differently) rather than one segment per car.
- **Reconfiguring an existing train** (swap wagons, add/remove cars) at a
  Yard after assembly. Currently a train's consist is fixed for its life,
  same as a truck's type; you sell it and assemble a new one instead.

---

# Phase 2 — Project Structure

`index.html`'s inline `<script>` had grown to ~2,000 lines across four
milestones (Rail, content-pack refactor, Train Yard, plus Phase 1 itself).
This splits it into files matching §14 of `specification.md`'s suggested
module structure, adapted for what this project actually is right now: no
TypeScript, no bundler, no Pixi/Preact/Worker — those are real future
milestones (§15), not retrofitted here just to match the folder names.

## Why classic `<script src>`, not ES modules

§14's structure assumes a build step; this project still doesn't have one,
for the same reason the content-pack refactor kept its data inline instead
of moving to real `data/*.json` files (see that section above): **ES
module scripts (`<script type="module" src="...">`) are blocked by CORS
under `file://` in every major browser** — the exact failure mode that
made Phase 1 a single file and made the content-pack refactor stop short
of external JSON. **Classic scripts (`<script src="...">`, no `type` or a
JS MIME type) have no such restriction** and load local sibling files fine
under `file://`, which is the mechanism this split actually uses. All
classic `<script>` elements on one page share a single global scope
(top-level `const`/`function` in one file is visible to every
*later*-loaded `<script>` on the same page, exactly as if they'd been
concatenated) — so this is a pure reorganization: identical runtime
behavior, just organized into files that match what each piece is, instead
of one file with comment-delimited sections. Verified directly: every
split file loads with a real 200 response under a `file://` URL in a
headless browser, and the game runs identically (ticks advance, treasury
updates, UI responds) — see Testing below.

The content-pack JSON itself stays inline in `index.html` (not moved to
`src/data/`, unlike §14's suggested layout) — moving *that* to an external
file raises a genuinely different question (whether a non-executable
`<script type="application/json" src="...">` even fetches its content the
same way a classic JS script does) that wasn't worth gambling on when the
inline version is already verified working; a later, purely additive step
if it turns out to work cleanly.

## Project layout

```
index.html              markup, CSS, the content-pack JSON block, and the
                         ordered <script src> tags that load everything below
src/
  content/
    loader.js            content-pack parsing + validateContentPack + config constants
  sim/
    world.js              grid + world state (§14's "World")
    ecs.js                 component tables, entity handles, queries (§14's "Component, System, Query")
    economy.js             treasury + the event log
    pathfinding.js         road/rail BFS, dock-cell resolution, Station/industry chain-walking
    rail-blocks.js         rail mutual-exclusion segment computation
    entities.js            entity factories (buildings, trucks, trains) + vehicle-stat lookups
    commands.js            the only functions allowed to mutate world state (§7)
    systems.js             the per-tick systems, run from simTick()
  worker/
    worker-client.js       builds the simulation Worker and bridges it to the main thread (see Phase 2 — Worker Split below)
  render/
    render.js              the render loop + canvas rendering
  ui/
    ui.js                  tool wiring, click handling, inspector, and the loop's initial kickoff
test/
  harness.js               runs loader.js + every sim/*.js file (fixed order, same as the Worker's own) in a Node vm
  test-rail.js
  test-content-pack.js
```

*(As of Phase 2 — Worker Split below, `sim/commands.js` and `simTick()`
only ever run inside the Worker, loaded there via `importScripts` — see
that section for why `index.html`'s own `<script src>` list no longer
includes `commands.js` even though every other `sim/*.js` file is still
loaded on the main thread too.)*

Load order in `index.html` matters only for the small amount of top-level
(not-inside-a-function) code — the content-pack parsing in `loader.js`, and
`ui.js`'s final `requestAnimationFrame(frame)` call that starts the game —
since that runs immediately as each script loads. Function bodies calling
into a later-loaded file are fine regardless of order: nothing actually
*calls* them until the game loop starts, by which point every file has
already loaded.

## Testing

No behavior changed, so no new tests — `test/test-rail.js` and
`test/test-content-pack.js` both pass unmodified, which is itself the
regression check (§ "Extract current inline defs verbatim… confirm
byte-for-byte equivalent" — the same principle the content-pack refactor
used, applied here to code instead of data). `test/harness.js` was updated
to read index.html's `<script src>` tags and concatenate the referenced
files in order, instead of extracting one inline `<script>` block — that
change is exactly the harness's job (running the real shipped code) staying
honest about what "the real shipped code" now consists of.

Also re-verified in a real headless browser (Playwright): every one of the
11 `<script src>` requests resolves with a real HTTP-style `200` under a
`file://` URL (no CORS failures, no 404s), and the game genuinely runs —
ticks advance, the UI responds, a full build/assemble/inspect flow works
through actual clicks — not just "the files parse."

## Deliberately deferred

- **Moving the content-pack JSON to `src/data/`** — see the CORS
  discussion above; revisit once/if it's confirmed that an external
  non-executable `<script type="application/json" src="...">` fetches
  cleanly under `file://`, or once a real bundler is adopted for other
  reasons (most likely the Worker split), at which point this becomes
  moot.
- **Real ES modules, a bundler, TypeScript, Pixi, Preact, a Worker** — the
  rest of §14's target structure. All later milestones (§15) in their own
  right, not something this reorganization tries to simulate with plain
  files.
- **Splitting `ui.js` or `systems.js` further.** Both are still the
  largest files (~385 and ~384 lines) — reasonable for now given how much
  of the game's interactive surface (tool wiring, inspector, click
  handling) and per-tick logic (production, vehicles, trains) they each
  own; revisit only if either grows enough on its own to justify another
  cut.

# Phase 2 — Worker Split

The simulation itself (`sim/*.js` plus `content/loader.js`) now runs inside
a Web Worker instead of the main thread — the fast-follow the Project
Structure section above and the architecture spec's §8 both flagged. This
was purely a plumbing change: no system, command, or content-pack code
needed to change at all, since the whole point of the earlier `src/`
split was that each file is already just plain functions operating on a
`world` object, with no dependency on the DOM except the one spot the
event log used to write to it (see below).

## Why a Worker

Before this, one JS-thread was doing production/movement/pathfinding
*and* handling every click *and* drawing every frame — fine at the current
scale, but a real bottleneck the moment a busy world (dozens of trucks and
trains all pathfinding at once) needs a heavier tick: that work would
directly stall input and rendering. Moving the tick loop to a Worker means
a slow tick makes ticks arrive slower, not the page stop responding.

## How it works

`src/worker/worker-client.js` (loaded right after `sim/systems.js`, before
`render.js`/`ui.js`) is the entire bridge, and is the only genuinely new
file this milestone added:

- **Building the Worker.** `new Worker('src/worker/....js')` is rejected
  under `file://` — every page there has origin `"null"`, and browsers
  refuse to load a worker script "from" a null origin even off the same
  local file tree (verified directly; this is the same family of
  restriction that ruled out ES modules in the Project Structure section
  above). The fix is a **Blob-constructed Worker**: its initial script is
  a small in-memory bootstrap string, not a `file://` fetch, so the
  null-origin check never applies. That bootstrap then pulls in the real
  simulation code unmodified via `importScripts()`, using each `sim/*.js`
  file's own **absolute** `file://` URL (`new URL(path, document.baseURI)`)
  — a *relative* `importScripts()` path throws ("the URL … is invalid")
  from inside a `blob:` worker, since a blob URL has no base path to
  resolve one against; this only works with an absolute URL, resolved on
  the main thread first. Net effect: `sim/*.js` stays the single source of
  truth, loaded twice (once as a `<script src>` on the page, once via
  `importScripts` in the Worker) but never duplicated in content.
- **Two-phase `importScripts`.** The Worker's bootstrap loads
  `content/loader.js` alone first and stops. `loader.js`'s own top-level
  bootstrap is guarded on `typeof document !== 'undefined'`, so this
  leaves `initContentPack`/`validateContentPack` defined but not yet
  called — there's no DOM inside a Worker to parse the content-pack block
  from directly. Only once the page's own `'init'` message actually
  arrives (carrying the content pack the page already parsed) does the
  Worker call `initContentPack(pack)` itself, **then** `importScripts()`
  the remaining `sim/*.js` files. This has to be two phases, not one:
  `world.js`'s very first statement reads `INITIAL_TREASURY`, which
  doesn't exist until `initContentPack()` has run, and `postMessage`
  delivery is asynchronous while `importScripts` is synchronous — there's
  no way to block a single import batch on the pack's arrival.
- **Message protocol.** The page sends `{type:'init', contentPack}` once,
  then one `{type:'command', name, args}` per player action (this
  replaced every direct `cmdXxx(...)` call in `ui.js` with
  `postCommand('cmdXxx', [...])`). The Worker ticks on its own
  `setInterval(TICK_MS)`, independent of the page's framerate, and sends a
  `{type:'snapshot', treasury, tick, grid, components, railBlocks,
  entityIds, logs}` message back after `'init'`, after every command, and
  after every tick.
- **The shadow `world`.** The page still has its own `world` (from
  `world.js`, loaded there same as always) — `render.js`/`ui.js` read it
  exactly as before, they just never mutate it directly anymore. Each
  snapshot overwrites `world`'s mutable properties in place (`world`'s own
  `const` binding never changes) with what the Worker actually computed.
  `world.entities` can't be shipped verbatim — its values are `Proxy`
  handles (see `makeEntityHandle` in `ecs.js`), and a `Proxy` isn't
  structured-clone-able — so the Worker instead sends a plain `entityIds`
  array, and `worker-client.js` rebuilds `world.entities` as a fresh `Map`
  of freshly made handles. This is safe even for a handle other code is
  still holding onto (`ui.js`'s `selected`, across snapshots): every
  property access on a handle re-reads `world.components` live rather than
  caching, so an "old" handle instance keeps working correctly once
  `world.components` itself has been swapped to the latest snapshot.
- **The two commands that take a handle.** `cmdSellVehicle(vehicle)` and
  `cmdSetOrders(vehicle, orders)` are the only commands whose signature
  takes an entity handle rather than plain values — also not
  structured-clone-able. Callers now send the vehicle's plain `.id`
  instead; the Worker's command dispatcher resolves that id back to a
  handle (via its own `world.entities`, not the page's) before invoking
  the real function.
- **The event log.** `economy.js`'s `logEvent` used to write to `#log`
  directly — impossible inside a Worker (no DOM). It's now a plain queue
  (`pendingLogs`), flushed into each snapshot's `logs` array and cleared.
  `worker-client.js` then *redefines* the page's own top-level `logEvent`
  (classic `<script>` tags share one global scope, so a later
  `function logEvent` simply replaces the earlier one) to write straight
  to `#log` — both for flushing a snapshot's queued lines, and for the
  handful of direct `logEvent(...)` calls left in `ui.js` (pure
  click-handler feedback, like "click a building to add it as a stop",
  that never goes through the Worker at all and shows up with no added
  latency either way).

## Running the tests

`test/test-rail.js` and `test/test-content-pack.js` both pass unmodified.
`test/harness.js` no longer derives "the simulation core" from
`index.html`'s `<script src>` tags (that list now excludes
`sim/commands.js`, which is Worker-only) — it instead concatenates
`content/loader.js` + every `sim/*.js` file in a fixed order matching what
the Worker itself loads, since that's the environment this code actually
runs in now. This is exactly the case the Worker split's own design
intends to stay easy: the simulation core is still plain functions on a
`world` object, runnable synchronously with no Worker, no `postMessage`,
and no browser at all.

Also re-verified in a real headless browser (Playwright), end to end
through actual UI clicks and `postCommand()` calls (not just direct
function calls): the Worker starts and ticks on its own independent of
render framerate; building roads/track, buying trucks, assembling and
selling a train, and adding load/unload stops via the order editor all
correctly reach the Worker and show up in the next snapshot; a truck given
real orders actually drives its route and loads/unloads cargo over time;
log messages (both Worker-originated and pure-UI ones) appear in `#log`;
and no console errors or worker errors occur across any of it.

## Deliberately deferred

- **Snapshot diffing / typed-array transport.** Every snapshot currently
  ships the whole `grid`/`components`/`railBlocks` structure via
  structured clone, wholesale, every tick. That's the simplest correct
  thing, and at this project's current scale (a 22×14 grid, a handful of
  vehicles) there's no measured cost to justify anything cleverer —
  revisit only if profiling on a much bigger world actually shows
  `postMessage` overhead mattering.
- **Transferable objects / `SharedArrayBuffer`.** Same reasoning — real
  options if snapshot size ever becomes the bottleneck, not before.
- **Moving `render.js`/`ui.js` into the Worker too (OffscreenCanvas).**
  Deliberately not attempted: input handling and DOM updates belong on the
  main thread regardless, and `OffscreenCanvas` support/ergonomics is a
  separate, genuinely bigger milestone on its own, not a natural extension
  of this one.
