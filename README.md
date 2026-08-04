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
step, no server, no npm install — it's a single self-contained file, which
was a deliberate choice so it runs anywhere without a network connection or
tooling. There's nothing to install.

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
- **A train's cargo resource isn't fixed at creation, unlike a truck's.**
  `TRAIN_DEFS.freight.resource` is `null`; `Cargo.resource` is set at the
  point of loading, from whichever `load` order is executing
  (`v.cargoResource = order.resource` in `tickTrainMovement`'s loading
  branch) — a small, type-gated exception rather than a redesign of
  `Cargo`. Rationale: a 40-capacity freight train is a much bigger
  commitment than a $200 truck, and "one expensive asset serving several
  parts of the network" is part of rail's identity versus roads.
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
  additionally a block boundary), Build Rail Depot, Buy Freight Train.
  Depot inspector shows both links ("Road side: Station #N" / "Rail side:
  connected/not") instead of a Station's single line. Train inspector
  shows the same physics readout trucks have, plus "Currently carrying: —"
  until its first load.

## Deliberately deferred

- Ship/plane/pipeline/powerline modes and the later performance pass stay
  future milestones (§15) — this is Rail only.
- Block computation cost at scale. Recomputing all blocks from scratch on
  every track edit is fine at this grid size; flagged for the later
  performance pass, not solved here.
- The content-pack refactor, Worker split, and persistence workstreams
  that the implementation plan schedules after Rail — not part of this
  milestone.

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
