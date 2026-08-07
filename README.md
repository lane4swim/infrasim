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

## Addendum — Road and rail cross only at a right angle

Ground road and rail were originally fully independent layers: nothing
stopped both from occupying the same cell in the same direction, so a road
and a track could silently run parallel through the exact same point —
not how any real level crossing works, and not a distinction the game
enforced at all.

Ground road and rail now share the same physical grade: a single
direction (N/S/E/W) at a given cell can carry a through-connected
ground-road edge *or* a through-connected rail edge, never both.
`directionClaimedByOtherNetwork` (`commands.js`) checks this whenever an
edge is about to form — in `connectNewTileEdges` (auto-connect on
placing a new tile) and in `cmdToggleConnection` (the manual Connect
tool, which now rejects the same overlap with a warning instead of
silently fusing the two networks). Perpendicular directions at the same
cell are unaffected, so a clean crossing (road claims E/W, rail claims
N/S) forms automatically through ordinary auto-connect — no special
"crossing" mode needed. A tile can still be *placed* on a cell the other
network already occupies; only the specific direction that would overlap
fails to connect, leaving that side an isolated stub instead. Elevated
road keeps its existing, unchanged non-interaction with rail (a bridge
passes physically above it, same as it already does over ground road
absent a Ramp) — this rule is strictly between `ground` and `rail`.

A crossing cell (both networks physically present) gets a small white X
marker in `render.js`, the same spirit as the Ramp's diamond — purely
informational, since pathfinding, occupancy, and block signaling all
still only ever look at their own layer's edges and never needed to
change.

Covered by `test-rail.js`'s Test 8: a road and a track crossing at a
right angle both stay fully connected end to end (truck and train paths
both intact); a second rail tile placed parallel to the road at the same
cell is placed but fails to connect through it, via both auto-connect
and a manual Connect attempt.

## Addendum — a train physically blocks the crossing while it's there

A crossing being geometrically valid (perpendicular only, see above)
said nothing about right-of-way — trucks and trains still ran through the
same cell without ever noticing each other, unlike a real level crossing
where a train always has priority and road traffic simply waits.

`markTrainCrossingsOccupied` (`systems.js`) now seeds a truck's own
occupancy map — the same one `gapAheadFor`/`advanceAlongPath` already
check for other trucks — with every crossing cell a train's current
footprint covers. This is deliberately not a new reservation/acquire-
release table like rail's own block signaling: the map is rebuilt from
scratch every tick anyway, so a crossing simply stops appearing in it the
instant the train's footprint no longer covers that cell — "release" is
just "didn't get marked this tick," nothing to leak or forget. Because
it's the *same* occupancy map trucks already treat another vehicle's
position as, a train at a crossing gets both smooth braking on approach
and a hard stop at the boundary for free — no new physics. The rule is
one-directional, matching a real crossing's right-of-way: trains never
check truck occupancy at all, only the reverse.

Covered by `test-rail.js`'s Test 9: a train placed directly onto a
crossing cell holds a truck back from ever advancing past it for the
whole time it sits there, then the truck proceeds on its own, unprompted,
the moment the train is moved off — proving both the block and its
automatic release, deterministically rather than hoping the two vehicles'
organic timing happens to coincide.

## Addendum — a train reserves a crossing before it physically arrives

Blocking a crossing only once a train's footprint already covered it
(the addendum above) left a real gap: a truck could still end up sitting
on the crossing cell itself the instant before the train got there —
nothing warned it to stay clear in advance, unlike a real crossing whose
gates come down *before* the train arrives, precisely so nothing is
still on the tracks when it does.

`markTrainCrossingsOccupied` (`systems.js`) now also scans a train's
`path`/`pathIndex` up to `LOOKAHEAD` tiles ahead (the same constant
`gapAheadFor` already uses for a truck's own collision lookahead — not a
new number to invent, since a truck's own lookahead never sees further
than that anyway regardless of how early the reservation actually
started) and reserves any crossing cell found there, exactly like the
cells the train's current footprint already covers. A truck approaching
gets the reservation well before the train is anywhere near the cell —
same smooth braking and hard stop as before, just triggered earlier —
so by the time the train actually needs the crossing, nothing is on it.
Nothing changed about *how* a crossing is blocked, only *when* it starts
counting as occupied.

Covered by `test-rail.js`'s Test 10: a train sitting 4 tiles from a
crossing, entirely idle and not moving that tick, still holds a truck
back from ever reaching the crossing — proving the reservation comes from
the train's upcoming path, not merely its current position — and the
truck proceeds on its own once that path no longer runs through the
crossing at all.

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

---

# Addendum — connected edges render as a straight line, not a right-angle elbow

A pure rendering change, applying equally to all three track layers
(ground, elevated, rail) since they all share the same
`{track, edges, oneWayBlocked}` shape and the one `drawRoadLayer` function
that draws them (`render.js`). Nothing about world state, pathfinding, or
any other system changed.

Previously, a tile's connections were drawn as a filled core square plus
one rectangular stub per connected side, all meeting in the tile's
center — fine for a straight through-route (two stubs opposite each
other already look like one continuous line), but a turn (e.g. connected
only to the North and West) rendered as a blocky right-angle elbow bent
through the middle of the tile, not how an actual road or rail bend looks.

`drawTrackCell` now draws connections based on how many sides a tile
connects to:
- **Exactly 2** — the only case with one unambiguous line to draw — gets
  a single straight line directly between the two sides' port midpoints
  (`trackPort`), with no detour through the center. An opposite pair
  (N-S or E-W) is still a straight line, same as before; an adjacent pair
  (e.g. N-W) is now a genuine 45° diagonal cutting the corner.
- **0, 1, or 3+** connected sides (an isolated tile, a dead end, or a
  T-/4-way junction) still meet at the tile's center, unchanged from
  before — there's no single pair to straighten out when multiple lines
  genuinely converge at one point, or when there's at most one line at
  all.

One-way arrows are unaffected — `drawOneWayArrow` didn't change, and is
still called once per one-way edge exactly as before.

---

# Addendum — a rail-specific Connect / Disconnect Track tool

`cmdToggleConnection` was always layer-agnostic — it happily accepts
`'rail'` and has since the Rail milestone (Test 8 already exercises it
directly). But the UI never exposed a way to reach it for rail: the
toolbar's "Connect / Disconnect" tool always used `currentLayer()`, and
that dropdown only ever offers Ground or Elevated. Rail track built with
auto-connect off, or that had a connection manually severed, had no way
back to being joined again — the command worked, there was just no
button that would ever call it with `layer:'rail'`.

Fixed the same way rail's one-way toggle ("Toggle Signal Direction")
already handled the identical problem: a new toolbar button,
`data-tool="trackconnect"`, that reuses `handleConnectClick` entirely but
hardcodes `layer = 'rail'` instead of reading `currentLayer()` — mirroring
`handleOneWayClick`'s existing `currentTool==='signal' ? 'rail' : ...`
split exactly. No command changed at all; this was purely a missing UI
entry point.

Verified in a real browser: two rail tiles built with auto-connect off
start genuinely disconnected (`findRailPath` between them returns `null`),
the new tool connects them (`findRailPath` then finds the direct path)
and disconnects them again, and the original ground/elevated "Connect /
Disconnect" tool still correctly rejects a rail-only cell rather than
silently doing the wrong thing.

---

# Addendum — rail also runs on ground and elevated layers, linked by its own Rail Ramp

Rail was a single flat layer — a bridge over an obstacle (another rail
line, a river the tile grid doesn't model, whatever) had no way to exist,
even though road already had exactly that via its own ground/elevated
split. Since rail bridges are a real, common thing, rail now gets the
same split: a new `railElevated` layer, structurally identical to `rail`,
linked to it only at a **Rail Ramp** (`cell.railRamp`) — entirely
independent of the road Ramp (`cell.ramp`); a cell can have either, both,
or neither.

## What changed

- **`world.js`**: `getCell`'s `layers` object gains a fourth key,
  `railElevated` (alongside `ground`/`elevated`/`rail`), and cells gain a
  `railRamp` flag next to the existing `ramp`. Four independent flat
  layers, not a 2x2 nested structure — every existing piece of code that
  already treated "a layer" as a string key into this object needed no
  restructuring, just one more key to iterate.
- **`pathfinding.js`**: `findRailPath` now takes the same
  `{x,y,layer}` node shape `findRoadPath` always has, and gained the same
  vertical-move-via-ramp logic — a `railRamp` cell lets a train's path
  switch between `rail` and `railElevated`, exactly like a Ramp switches
  a truck's path between `ground` and `elevated`. `RAIL_ROAD_COUNTERPART`
  (`{ground:'rail', rail:'ground', elevated:'railElevated',
  railElevated:'elevated'}`) replaces the old ground-only mapping the
  perpendicular-crossing rule used, so that rule and the crossing-blocking
  mechanic both now apply at the elevated grade too, symmetrically.
  `buildingRailAccessCell` stays ground-only (`rail`) deliberately — a
  Depot or Train Yard is a ground building, and `railElevated` is a
  through-only bridge layer that must come back down via a Rail Ramp
  before reaching one, exactly like an elevated road must return to
  ground via a Ramp before reaching a Station.
- **`commands.js`**: `cmdBuildTrack` gained a `layer` parameter (default
  `'rail'`), matching `cmdBuildRoad`'s existing signature — elevated track
  costs the same x2 multiplier elevated road does. A new
  `cmdBuildRailRamp(x,y)` mirrors `cmdBuildRamp` exactly, for the
  `rail`/`railElevated` pair. `cmdToggleConnection`/`cmdToggleOneWay`/
  `cmdDemolish` all now recompute rail blocks for either rail layer, and
  `cmdDemolish` clears only the ramp type whose own layer pair was
  actually affected (a latent bug fixed as a natural side effect of
  writing this correctly for two ramp types instead of one).
- **`rail-blocks.js`**: `computeRailBlocks` now computes both rail
  layers' blocks into the same `world.railBlocks` map with one continuous
  id sequence, via a new `computeRailBlocksForLayer(layer, counter)` — a
  `railRamp` cell counts as a hub (like a signal or Depot), so a train
  transitioning layers always crosses a block boundary there; the vertical
  move itself has no edge/block of its own and is always allowed (see
  `tickTrainMovement`'s `canEnter`/`onEnter` callbacks, now guarded on
  `cur.layer !== next.layer`).
- **`render.js`**: `railElevated` draws in a lighter tint of rail's purple
  (mirroring elevated road's relationship to ground road); a Rail Ramp
  gets its own diamond marker in that same color, distinguishable from the
  road Ramp's; the crossing-marker and crossing-blocking logic both check
  the elevated pair in addition to the ground pair.
- **`ui.js`/`index.html`**: Build Track, Connect / Disconnect Track, and
  Toggle Signal Direction all now read the same Ground/Elevated dropdown
  road tools already use (via a new `currentRailLayer()` helper) instead
  of being hardcoded to ground-level rail. A new "Build Rail Ramp" tool
  and cost label round out the toolbar; Demolish's per-layer fallback
  logic extends naturally to try each grade's rail layer, not just ground.

## Testing

Covered by `test-rail.js`'s Test 11: an elevated road crossing elevated
rail stays perpendicular-only and fully connected on both, exactly like
the ground-grade version; a signal on the elevated rail layer splits
blocks there independently of any ground-rail blocks; and — driven
entirely by `simTick()`, not just a pathfinding check — a real assembled
train climbs from a ground-level Depot onto an elevated rail bridge via
one Rail Ramp, crosses it, comes back down via a second Rail Ramp, and
delivers cargo to a second ground-level Depot on the far side.

Also verified in a real browser: every new tool (elevated Build Track,
Build Rail Ramp, layer-aware Connect / Disconnect Track and Toggle Signal
Direction) works via actual clicks, the elevated track cost label updates
correctly (x2 multiplier), and the elevated crossing renders exactly like
its ground counterpart — with no console errors.

---

# Addendum — road and rail merge into one grade-layer structure

The previous two addenda gave rail its own ground/elevated split and its
own perpendicular-crossing rule, but road and rail were still four
entirely separate top-level grid layers (`ground`, `elevated`, `rail`,
`railElevated`) under the hood, each pairing (ground↔rail, elevated↔
railElevated) hand-named in a lookup table. That doesn't scale: a third
infrastructure kind (a pipeline, a power line — §15's later transport
modes) would have meant two MORE top-level layers, plus teaching every
pairwise rule about the new combinations. Merged the grid itself so a new
kind is genuinely one line of code, not a growing compatibility matrix.

## What changed

- **`world.js`**: a grade (`ground` or `elevated`) is now a bag of
  *kinds* — `newGradeLayer()` returns `{road: newTrack(), rail:
  newTrack()}` — instead of road and rail being independent top-level
  layers. Adding a third kind later is exactly one more key in that
  object; it automatically participates in every rule below with no
  further code. `cell.ramp`/`cell.railRamp` similarly merged into
  `cell.ramps = {road: false, rail: false}` — a Ramp of any kind links
  that kind's own ground and elevated tiles, entirely independent of any
  other kind's ramp.

  The flat vehicle/command/render-facing vocabulary — `'ground'`,
  `'elevated'`, `'rail'`, `'railElevated'` — didn't need to change at all;
  renaming it everywhere would have been pure churn for no behavioral
  gain. `LAYER_GRADE_KIND` (and its inverse, `GRADE_KIND_LAYER`) is the
  one place that translates a flat layer name to the `(grade, kind)` pair
  it's actually stored under, and `trackAt(x,y,layer)` is the one
  function every piece of grid-reading/writing code goes through instead
  of indexing `world.grid` by a flat name directly.

- **`pathfinding.js`**: `findRoadPath` and `findRailPath` — which had
  become near-identical once rail gained ground/elevated and a ramp
  concept of its own (the last addendum) — are now thin wrappers over one
  shared `findLayerPath`, since the only remaining difference (which
  layer names, which ramp flag) is exactly what `trackAt`/
  `GRADE_KIND_LAYER` already abstract.

- **`commands.js`**: `directionClaimedByOtherNetwork` (the
  perpendicular-crossing rule) now iterates every OTHER kind at a
  layer's own grade, instead of naming one fixed counterpart — this is
  the actual payoff: a future kind gets crossing protection against road
  and rail (and they against it) automatically. `cmdBuildRoad` and
  `cmdBuildTrack` share one `buildTrackTile` implementation (cost,
  building-collision, auto-connect); `cmdBuildRamp` and
  `cmdBuildRailRamp` share one `buildRamp`. `cmdBuildBuilding`'s overlap
  check now asks "is ANY kind at ground grade occupying this cell"
  (`Object.values(cell.layers.ground).some(t => t.track)`) instead of
  naming road and rail specifically, for the same reason.

- **`rail-blocks.js`**, **`systems.js`**, **`render.js`**, **`ui.js`**:
  updated to read/write the grid through `trackAt`/`cell.ramps` instead
  of the old flat `cell.layers.rail` / `cell.ramp` / `cell.railRamp`
  shape. No behavior changed in any of these beyond the storage
  indirection — block computation, train movement, rendering, and tool
  wiring all work exactly as the previous two addenda described.

## Testing

No new tests — this was a pure internal restructuring, not a behavior
change, so the existing 11 sections in `test-rail.js` (updated to read
the grid through the new nested shape where they inspect it directly)
passing unmodified *is* the regression check, the same principle the
content-pack refactor and the Worker split both used. Also re-verified in
a real browser: ground and elevated crossings, both ramp types, and the
generalized "a building can't sit on any kind of ground-grade
infrastructure" check (tried building a Mine on top of rail track — the
same rejection message a road conflict already gave) all work via actual
clicks, with no console errors.

---

# Phase 2 — Persistence

The last of the four Phase 2 workstreams (content-pack refactor, Worker
split, rail, persistence — §12). Save exports the whole world to a JSON
file; Load replaces the whole world with a previously saved one. No
autosave/IndexedDB layer yet — just the explicit export/import §12
already called the baseline.

## Design

Both directions round-trip through the Worker, not the main thread, for
the same reason every mutation already does: the Worker holds the real
`world`, the main thread only ever has a shadow copy rebuilt from
snapshots. Two new message types, symmetric with the existing
`'init'`/`'command'`/`'snapshot'` protocol:

- `-> {type:'save'}` — the Worker serializes its own `world` and replies
  `<- {type:'saveData', data}`; the main thread turns that into a file
  download.
- `-> {type:'load', data}` — the Worker replaces `world` wholesale from
  `data`, then sends a normal `'snapshot'` so the main thread's shadow
  copy (and the canvas) catch up immediately, exactly like after any
  command.

**`sim/persistence.js`** is a new file, Worker-only — loaded via
`importScripts` (and by the test harness) exactly like `commands.js`,
never added to `index.html`'s own `<script>` list, since serializing/
deserializing `world` only ever needs to happen where `world` actually
lives. It's two functions:

- `serializeWorld()` walks every Map on `world` (`grid`, `railBlocks`,
  each `components[name]`) and turns it into a plain `[key,value][]`
  array via `.entries()` — Maps aren't JSON-safe, so this is a stricter
  requirement than the snapshot protocol's structured-clone safety
  (structured clone preserves Maps natively; a save file has to survive
  an actual `JSON.stringify`/`JSON.parse` round trip, since it's written
  to and read back from disk). `world.entities` isn't saved directly
  either, for the same reason snapshots don't ship it — just the id list,
  same as `entityIds` in a snapshot. Rail block state doesn't need
  recomputing on load: each rail edge's `blockId` (in `world.grid`) and
  `world.railBlocks`'s `occupiedBy` state are saved and restored
  together, so they stay mutually consistent as of save time, with no
  extra work.
- `deserializeWorld(data)` is the exact inverse — rebuilds every Map with
  `new Map(...)`, restores `treasury`/`tick`/`nextId` directly, and
  rebuilds `world.entities` with `makeEntityHandle` from the saved id
  list, same as a snapshot does on the main thread.

The content pack gained an optional `"version"` field (currently `"1"`).
A save records `contentPackVersion` alongside its own
`saveFormatVersion`; loading a save made under a different content-pack
version doesn't refuse to load (a modder's pack is still just data — see
the content-pack refactor addendum — refusing outright would undercut
that), but the UI logs a warning naming both versions, since a real
mismatch (a resource/building/vehicle id the save references but the
current pack lacks) will otherwise surface as a much more confusing
failure somewhere else instead.

## What changed

- **`sim/persistence.js`** (new): `serializeWorld()`/`deserializeWorld()`
  as described above.
- **`content-pack` JSON block** (`index.html`): gained `"version": "1"`.
  `validateContentPack` deliberately does *not* require it, so the
  modder-pack test fixture (which has no version field) still validates —
  a save simply records `null` for `contentPackVersion` if the pack
  it was made against never had one.
- **`worker-client.js`**: `WORKER_SIM_URLS` gained `persistence.js`; the
  Worker's `self.onmessage` gained the `'save'`/`'load'` branches above;
  the main thread gained `postSave()`/`postLoad(data)` (mirroring
  `postCommand`) and `downloadSave(data)`, which triggers a real browser
  file download via a throwaway `<a download>` element and a Blob URL —
  no server involved, works the same under `file://` since nothing about
  it is a network request.
- **`index.html`**: a new "Game" toolbar section with Save Game / Load
  Game buttons and a hidden `<input type="file">` for Load. These use the
  existing `.tool-btn` visual style but deliberately aren't map tools —
  `ui.js`'s tool-selecting click listener now targets
  `.tool-btn[data-tool]` specifically (Save/Load buttons have no
  `data-tool`), so clicking either one doesn't fight over `currentTool`
  or the "active" tool highlight the way an actual tool button does.
- **`ui.js`**: Save just calls `postSave()`. Load click opens the hidden
  file input; its `change` handler reads the file via `FileReader`,
  `JSON.parse`s it (rejecting non-JSON and non-save-shaped files with a
  clear log message before ever handing them to the Worker), warns on a
  content-pack version mismatch, clears `selected` (it may hold a handle
  to an entity the loaded world doesn't have — the same reason a sold
  vehicle already clears it), and calls `postLoad(data)`.
- **`test/harness.js`**: `SIM_SCRIPT_FILES` gained `persistence.js`, same
  position/reasoning as `commands.js`.

## Testing

New `test/test-persistence.js` (2 sections, 19 checks): builds a
genuinely nontrivial world (road+rail networks, every building kind, a
truck and a train each with real orders, 60 real `simTick()`s so
treasury/cargo/stock/rail-block state are all nonzero) and verifies —

- `serializeWorld()`'s output survives an actual `JSON.parse(JSON.
  stringify(...))` round trip with zero data loss (not just structured-
  clone safety, which every Map/Proxy in the codebase already had before
  this feature — genuine JSON-safety is the new requirement here).
- `deserializeWorld()` into a **fresh** context (deliberately not the
  same one that saved) restores treasury, tick, `nextId`, entity count,
  rail block count, truck cargo, and mine stock exactly.
- Post-load continuity: `simTick()` keeps running with no error, orders
  on both the restored truck and train survived, and pathfinding still
  works against the restored grid — proving every system operates
  correctly on the restored world, not just that the raw fields landed
  right.
- A newly created entity after load gets the exact restored `nextId`
  (not just a non-colliding one by luck), proving `world.nextId` itself
  round-tripped, not only the entity table.

All 3 test files (`test-content-pack.js`, `test-rail.js`,
`test-persistence.js`) pass. Also verified end-to-end in a real browser:
built a Mine, clicked Save Game (a real file download), built something
else, clicked Load Game and selected the saved file — the extra
post-save building disappeared and the Mine (with its accumulated stock)
came back exactly as saved, treasury included, with no console errors.

---

# Addendum — Rail Depots run parallel to the track

A Rail Depot used to be a plain 2x2 building with "full-perimeter" rail
access — any single touching track tile counted, the same way a Station's
non-facing side works. That's a fine model for a truck's Station, but not
for a real train platform: a platform runs *alongside* the track it
serves for its whole length, not just touches it at one corner. This
gives a Depot that real shape, and makes a longer train docked alongside
more of the platform load/unload proportionally faster.

## Design

- **Footprint**: the content pack's `depot` entry is now `{"w":2,"h":4}` —
  elongated, not square. `w`/`h` are canonical for the "platform runs
  North-South" orientation; a new toolbar dropdown (Platform runs
  North-South / East-West) lets the player rotate it, swapping `w`/`h` at
  build time. This repurposes the `facing` positional argument
  `cmdBuildBuilding`/`createBuilding` already had — Depots never used it
  (they have no single road-facing side; a Station touching them handles
  that, same as any other industry) — rather than adding a new parameter
  just for this. `effectiveFootprint(type, def, orientation)` (new, in
  `entities.js`) is the one place that does the swap; both
  `cmdBuildBuilding`'s pre-creation bounds/overlap check and
  `createBuilding`'s actual `Footprint` component go through it, so they
  can never disagree about what "this Depot's footprint" means.
- **Which sides count**: only the pair of sides *parallel* to the
  footprint's long axis are eligible to be the platform — the two short
  end caps never are, the same way a real platform's end doesn't serve
  trains passing alongside it. `depotPlatformCells(x,y,w,h)` (new, in
  `pathfinding.js`) returns the ordered list of track cells alongside
  whichever long side has a full, unbroken run of ground rail track for
  the platform's *entire* length, or `null` if neither long side
  qualifies — this is both the build-time validation
  (`cmdBuildBuilding` rejects the build without one) and the single
  source of truth every other Depot-facing function (dock resolution,
  transfer-rate scaling, the inspector, the render marker) reads from.
- **Dock resolution**: a train doesn't just aim for "the first platform
  cell it finds" — `resolveTrainDock(train, building)` (new, in
  `systems.js`) picks whichever *end* of the platform is farther from the
  train (more path hops, not straight-line distance), since reaching the
  far end necessarily means passing through the nearer platform cells
  first. By the time the train physically stops, its trailing body
  (`footprintKeysFor` — the same physical-length reservation collision
  already used) already covers as much of the platform as its own length
  allows, instead of stopping at the very first platform cell reached
  with nothing of the platform actually behind it. A Train Yard (or
  anything without a platform) has no such choice to make — this falls
  back to the plain `buildingRailAccessCell` for it, unchanged.
  - **Bug found and fixed while building this**: the first version of
    `resolveTrainDock` re-derived "farther endpoint" from the train's
    *current* position on every idle/blocked re-check — fine on first
    approach, but once a train is already sitting somewhere on the
    platform (e.g. re-evaluating the same repeating order right after
    finishing a load), the end it just arrived *from* now reads as
    "farther," sending it shuttling back and forth across the platform
    forever instead of just staying docked. Fixed by short-circuiting:
    if the train's current cell is already a member of the platform, stay
    exactly there. Test 4 in `test-depot-platform.js` is the regression
    test for this.
- **Multi-cell transfer**: a real platform loads/unloads its whole length
  at once, not through one bottleneck point. `dockedPlatformCellCount(train,
  building)` (new, in `systems.js`) counts how many of the train's own
  currently-occupied cells (again `footprintKeysFor`) are members of the
  platform's cell set right now, and `tickTrainMovement`'s loading/
  unloading branches multiply `TRANSFER_RATE` by that count instead of
  using it flat. A Train Yard (or any non-Depot target) is always
  exactly 1 — this only ever speeds up Depot transfers, nothing else.

## What changed

- **`index.html`**: `depot` footprint is now `{"w":2,"h":4}`; a new
  "Platform runs North-South / East-West" dropdown next to the Build Rail
  Depot button; updated hint text.
- **`entities.js`**: new `effectiveFootprint`; `createBuilding` uses it
  for Depot's `Footprint` component.
- **`commands.js`**: `cmdBuildBuilding` uses `effectiveFootprint` for its
  bounds/overlap check, and rejects a Depot build with no valid platform
  (`depotPlatformCells` returns `null`).
- **`pathfinding.js`**: new `depotPlatformCells`; `buildingRailAccessCell`
  special-cases Depot to use it (Train Yard unchanged, still
  full-perimeter — it's an assembly point, not a place trains load/unload,
  so the same real-world motivation a loading platform has doesn't apply
  to it).
- **`systems.js`**: new `resolveTrainDock` and `dockedPlatformCellCount`;
  `startMovingToRail` and `tickTrainMovement`'s idle/blocked branch use
  `resolveTrainDock` instead of the plain `buildingRailAccessCell`; the
  loading/unloading branches scale `TRANSFER_RATE` by
  `dockedPlatformCellCount`.
- **`render.js`**: a Depot's valid platform side is highlighted in amber,
  right against the footprint edge (reads like a Station's facing notch,
  just for the whole side rather than one corner); the build-tool ghost
  preview respects the chosen orientation.
- **`ui.js`**: `currentDepotOrientation()`; the tool-button click listener
  now targets `.tool-btn[data-tool]` specifically, since the toolbar's new
  orientation dropdown isn't itself a map tool; the Depot inspector panel
  shows platform length instead of a bare "connected"/"not connected".

## Testing

New `test/test-depot-platform.js` (4 sections, 13 checks): build-time
rejection for no track / a short-end touch / a partial-length long-side
run, acceptance on either long side and either orientation, the
multi-cell transfer-rate math itself (`dockedCellCount * TRANSFER_RATE`,
verified strictly greater than the old flat rate), and the
already-docked-train-doesn't-shuttle regression described above.

Every existing Depot placement across `test-rail.js` (8 of its 11
sections) and `test-persistence.js` needed new coordinates to satisfy the
new footprint/platform rule — each Depot now gets its own dedicated
siding (rather than sitting flush against a shared through-line)
specifically so touching it doesn't fragment that shared line's own
block identity, which `test-rail.js`'s Test 1/Test 2 examine directly; a
real platform siding is usually separate from the running line for
exactly this reason. All 4 test files pass. Also verified end-to-end in a
real browser: an out-of-bounds depot attempt is rejected with the
parallel-track message, a valid build against a real siding charges
correctly, the inspector shows the platform length, and an East-West
oriented Depot renders with the swapped 4x2 footprint and the amber
platform marker on the correct side, with no console errors.

---

# Addendum — Transfer rate is now a content-pack field, not a constant

Loading/unloading used to run at one hardcoded `TRANSFER_RATE = 4`
(`src/content/loader.js`) shared by every vehicle and every Station/Depot
in the game, with no way for a modder to make e.g. a fast pneumatic
unloader or a slow manual dock without editing the JS. It's now a
per-vehicle and per-Station/Depot content-pack field, with the effective
rate being whichever side is the real bottleneck.

## Design

- **Two independent numbers, not one.** `VEHICLE_DEFS`/`WAGON_DEFS` each
  get their own `transferRate` (how fast THIS vehicle's own doors/pumps
  can move cargo), and `BUILDING_DEFS.station`/`BUILDING_DEFS.depot` get
  their own `transferRate` (how fast THIS dock's own crane/conveyor can).
  `effectiveTransferRate(vehicle, building)` (new, in `systems.js`) is
  just `Math.min` of the two — a real bottleneck model: a vehicle can't
  unload faster than its own capability allows, and a dock can't load
  faster than its own equipment allows, so whichever is slower sets the
  pace, the same way a real supply chain's throughput is capped by its
  slowest stage.
- **Required vs. optional.** `transferRate` is a **required** numeric
  field on every vehicle and wagon (`validateContentPack`), alongside the
  other required physical stats (`capacity`, `engineForce`, ...) — the
  same category of "this vehicle's own numbers." It's **optional** on
  buildings: only Station and Depot ever actually get read this way (a
  vehicle only ever docks at one of those two — `findLinkedIndustry`
  forwards through them to whatever industry they're touching, but the
  RATE is the dock's own throughput, not the industry's), so forcing a
  meaningless `transferRate` onto Mine/Mill/Town/Train Yard would just be
  clutter. `DEFAULT_TRANSFER_RATE = 4` (loader.js) is what a Station or
  Depot that omits the field falls back to.
- **Depot's platform bonus stacks on top, unchanged**: `effectiveTransferRate(...)
  * dockedPlatformCellCount(...)` — the min-of-two bottleneck sets the
  rate per loading point, and the platform-cell multiplier (§ Depot
  parallel-track) still says how many of those points are active at once
  for a given train. Neither replaces the other.
- **Where it lives on an entity**: fixed at creation on the `Cargo`
  component (`transferRate`, alongside the already-fixed `capacity`/
  `resource`) — same reasoning as those: a vehicle's own numbers don't
  change over its life, so they're set once, not re-derived from
  `VEHICLE_DEFS`/`getTrainStats` every tick. For a train, `getTrainStats`
  reads the WAGON's `transferRate` (a per-coupling throughput), not
  multiplied by `wagonCount` — capacity scales with wagon count because
  more wagons genuinely hold more cargo, but transfer throughput scaling
  with train length is exactly what the Depot platform-cell multiplier
  already models separately; summing both would double-count the same effect.

## What changed

- **`index.html`**: `"transferRate": 4` added to `vehicles.bulk`,
  `vehicles.flatbed`, `wagons.ore_wagon`, `wagons.steel_wagon`,
  `buildings.station`, `buildings.depot` — chosen so `min(4,4)=4`
  everywhere, matching the old flat rate exactly; existing game balance
  is unchanged unless these values are edited.
- **`loader.js`**: `validateContentPack` requires `transferRate` on every
  vehicle/wagon; the old flat `TRANSFER_RATE` constant is gone, replaced
  by the `DEFAULT_TRANSFER_RATE` building fallback.
- **`ecs.js`**: `FIELD_MAP` gains `transferRate` -> `Cargo.transferRate`.
- **`entities.js`**: `createTruck` seeds `Cargo.transferRate` from
  `VEHICLE_DEFS`; `getTrainStats` returns the wagon's `transferRate`;
  `createTrain` seeds it from there.
- **`systems.js`**: new `effectiveTransferRate(vehicle, building)`; all
  four load/unload call sites (truck loading/unloading at a Station,
  train loading/unloading at a Depot) use it instead of the old flat
  constant.

## Testing

New Test 5 in `test/test-depot-platform.js` (4 checks): a slow
truck/fast Station is capped by the truck, a fast truck/slow Station is
capped by the Station, equal rates pass through unchanged, and a Depot
missing `transferRate` falls back to `DEFAULT_TRANSFER_RATE` — all
verified by reading `effectiveTransferRate` directly, not just inferring
it from simulated stock changes. `test-content-pack.js` gained two new
rejection-case checks (a vehicle or wagon missing `transferRate` is
rejected) and its modder-pack fixture (Test 3) now includes the field on
its new vehicle/wagon types. All 4 test files pass unchanged otherwise —
the chosen default values reproduce the old flat rate exactly, so no
existing test needed its expected numbers touched. Also verified
end-to-end in a real browser: the content pack's new fields load
correctly, and a full Mine → truck → Station → Town delivery still
completes through the new `effectiveTransferRate` path with no console
errors.

---

# Addendum — Configurable Depot platform length

The parallel-track Depot addendum above gave a Depot a fixed 2x4
footprint (or 4x2, rotated). A real platform isn't one fixed length,
though — some sidings are short, some are long enough for a whole train —
so the platform's length is now a build-time choice, validated against
however much parallel track is actually there.

## Design

- **`platformLengths`** (new, optional content-pack field on `depot`):
  `[2, 4, 6, 8]` in the shipped pack — the set of lengths a player can
  pick from a new "Platform length" dropdown. Optional, not required,
  same reasoning as `transferRate`'s building-side field: only Depot ever
  reads it, so `validateContentPack` only checks its *shape* when present
  (a non-empty array of positive integers), rather than forcing every
  building type to define one.
- **Threading the choice through**: `effectiveFootprint(type, def,
  orientation, length)` (extended, `entities.js`) now takes a `length` —
  when given, it replaces the content pack's own `footprint.h` as the
  platform's long-axis size, swapped into `w` instead for `'ew'`
  orientation exactly like before. Omitted (every pre-existing call site,
  and every non-Depot building), it falls back to `def.footprint.h` —
  the same 4 the game always used — so this is fully backward compatible:
  not one existing test needed touching.
- **Validation is still the command layer's job, not the UI's**: the
  dropdown only ever offers valid choices, but `cmdBuildBuilding` (the
  Worker-side authority — §7) independently checks the chosen `length`
  against `platformLengths` before building, rejecting anything else —
  the same posture `cmdAssembleTrain` already takes toward an invalid
  engine/wagon count. A valid length with too little actual track behind
  it is still rejected too, by the existing `depotPlatformCells` check,
  unchanged.

## What changed

- **`index.html`**: `depot`'s content-pack entry gains
  `"platformLengths": [2, 4, 6, 8]`; a new "Platform length" dropdown
  next to the orientation one; updated hint text.
- **`loader.js`**: `validateContentPack` shape-checks `platformLengths`
  when present.
- **`entities.js`**: `effectiveFootprint` and `createBuilding` gain a
  `length` parameter.
- **`commands.js`**: `cmdBuildBuilding` gains a `length` parameter,
  defaults it to the pack's own `footprint.h` when omitted, and rejects
  an explicit choice not present in `platformLengths`.
- **`render.js`**: the build-tool ghost preview reads the selected length
  too, so the hover outline matches what will actually get built.
- **`ui.js`**: `currentDepotLength()`; the Depot build command and the
  tool hint text both use it.

## Testing

New Test 6 in `test/test-depot-platform.js` (9 checks): each of the 4
allowed lengths builds with exactly that footprint/platform size; an
out-of-range length (3) is rejected, naming the bad value; a valid
length is still rejected against a real track run shorter than it;
omitting length entirely falls back to the canonical default (4); and
length combines correctly with `'ew'` orientation (the chosen length
becomes the swapped width, not the height). All 4 test files pass — the
other 3 needed zero changes, since every pre-existing Depot placement
omits `length` and gets the same default footprint it always did.
Verified end-to-end in a real browser: the tool hint updates live as the
length dropdown changes, an 8-tile Depot builds and renders correctly
against a real 8-cell siding with the amber platform marker on the right
side, and an invalid length sent directly via `postCommand` (bypassing
the dropdown, which only ever offers valid choices) is rejected by the
command layer with a clear log message, with no console errors.

---

# Addendum — Vehicle lengths are quantized to quarter tiles

Every truck, engine, and wagon's physical length (`lengthTiles`) — and
each individual vehicle instance's own randomized length, derived from it
— is now required to be a multiple of 0.25 tiles, not an arbitrary
number. Real rolling stock/trucks come in standard length classes, not
continuous sizes; this makes the game's numbers match that.

## Design

- **Content pack**: `validateContentPack` now requires `lengthTiles` on
  every `VEHICLE_DEFS`/`ENGINE_DEFS`/`WAGON_DEFS` entry to be a multiple
  of 0.25 (a new `isQuarterTile` helper, floating-point-safe — compares
  the rounded quarter-count back against the original rather than testing
  divisibility directly). This also closed a real pre-existing gap:
  `VEHICLE_DEFS.lengthTiles` wasn't validated as a required number at
  all before this (engines/wagons were; trucks, oddly, weren't) — now
  all three are consistent. The shipped pack's Bulk Truck was the only
  offender (`1.3` → `1.25`, the nearest valid value); everything else
  already happened to satisfy the constraint.
- **Per-instance randomization**: `randomizedMovement` (`entities.js`)
  already gave each vehicle instance its own slightly-varied length (§
  "real vehicles of the same model aren't perfectly identical") via a
  continuous `* (0.9 + Math.random()*0.2)` multiplier — that alone could
  land anywhere, so the result is now snapped to the nearest 0.25 (with a
  0.25 floor) before being stored. A real consequence worth noting, not a
  bug: for a short enough base length relative to that ±10% window (the
  Bulk Truck's 1.25, specifically), the whole randomized range collapses
  into a single quantized value — every Bulk Truck ends up exactly 1.25
  tiles. That's arguably more realistic, not less: a specific truck model
  really is one fixed length; it's the OTHER Movement stats (mass, speed,
  force) that still vary continuously per instance, unaffected by this.
- **Trains**: `getTrainStats` sums `engine.lengthTiles + wagon.lengthTiles
  * wagonCount` before randomization ever runs — since both operands are
  already quarter-tile multiples, so is their sum, and the same snapping
  in `randomizedMovement` handles the final randomized total exactly like
  a truck's.

## What changed

- **`loader.js`**: new `isQuarterTile` helper; `validateContentPack`
  requires it for `vehicles`/`engines`/`wagons` `lengthTiles`, and now
  also requires `vehicles[].lengthTiles` to exist at all (previously
  unvalidated).
- **`index.html`**: Bulk Truck's `lengthTiles` corrected to `1.25`.
- **`entities.js`**: `randomizedMovement`'s `length` field is now
  `Math.max(0.25, Math.round(raw / 0.25) * 0.25)` instead of the raw
  continuous value.

## Testing

New `test/test-vehicle-length.js` (3 sections, 9 checks): every def in
the shipped content pack satisfies the quarter-tile constraint; 50
randomized trucks (Flatbed — chosen because its wider absolute variance
window actually straddles more than one 0.25 bucket, unlike the Bulk
Truck's, so the test can also confirm genuine variety survives
quantization) all land on exact multiples of 0.25; 30 assembled trains
across varying wagon counts do too. `test-content-pack.js` gained three
new rejection-case checks (a non-quarter-tile `lengthTiles` on a vehicle,
engine, or wagon is rejected) and its modder-pack fixture's `lengthTiles`
was corrected to a valid value. All 5 test files pass — nothing outside
the two touched files needed changes. Verified end-to-end in a real
browser: 10 purchased trucks and an assembled 3-wagon train all report
quarter-tile lengths (with real variety among the trucks), with no
console errors.

---

# Phase 2 — Underground layer (initial implementation)

A third grade, alongside ground and elevated — the last piece of §15's
milestone 4 ("underground layers... still open"). Geometrically different
from the road Ramp / Rail Ramp that already link ground and elevated: a
Tunnel Ramp doesn't share a cell with both grades, it slopes between two
ADJACENT cells — a ground tile and its underground neighbor one step
over — and only ever along a straight stretch of track, never at a turn
or junction.

## Design

- **A third grade, not a fourth pair of top-level layers.** `world.js`'s
  `layers` object gains `underground: newGradeLayer()` alongside
  `ground`/`elevated` — the same grade×kind structure the road/rail merge
  (an earlier addendum) built specifically so a new grade or kind is a
  small, local addition, not a new compatibility matrix. Flat layer names
  follow the existing convention: `'underground'` (road) and
  `'railUnderground'` (rail), both registered in `LAYER_GRADE_KIND`/
  `GRADE_KIND_LAYER`.
- **Two genuinely different kinds of ramp, both real.** The existing
  (road) Ramp / Rail Ramp — one cell, both grades physically present,
  transition via a same-cell vertical step — stays exactly as it was,
  unchanged, for ground<->elevated. A new `rampEdge:{N,S,E,W}` field on
  `newTrack()` represents the second kind: a sloped, directional
  transition to the SAME kind's track one cell over, at the adjacent
  grade — set on ground-grade or underground-grade track only, never
  elevated (there is no direct elevated<->underground ramp; getting
  between them always passes through ground, one ramp at a time — the
  natural result of a ramp only ever reading "the other grade" as the
  literal neighboring entry in `LAYER_GRADE_KIND`'s ground/elevated/
  underground ordering, never skipping one). Deliberately kept out of the
  existing `edges` field (which stays "same-grade connectivity" exactly
  as it always meant, everywhere it's already read) rather than
  overloading it with a new meaning.
- **The straight-through constraint** ("ramps should be constrained to
  infrastructure along east-west, north-south edges; no other edges may
  be connected") is enforced two ways: at build time
  (`cmdBuildUndergroundRamp`/`cmdBuildRailUndergroundRamp` reject a ramp
  attempt unless BOTH cells' existing connections — `edges` and any other
  `rampEdge` — are limited to the ramp's own straight-through axis), and
  ongoing (`connectNewTileEdges`/`cmdToggleConnection` reject a NEW
  perpendicular connection at a cell that already has a ramp edge, so the
  constraint can't be violated retroactively by building around it). The
  two cells are auto-detected (whichever has ground track vs. underground
  track), so the player can click either one first.
- **Pathfinding, blocks, and movement needed surprisingly little.**
  `findLayerPath` gained one new candidate-move loop (a lateral step
  through a `rampEdge` direction, alongside the existing same-cell Ramp
  vertical step) — everything downstream (`tickTrainMovement`'s block
  canEnter/onEnter, `advanceAlongPath`'s footprint/trail bookkeeping)
  already keyed off `cur.layer !== next.layer` generically, which is
  equally true whether the layer change happens at the same cell (the old
  Ramp) or an adjacent one (the new ramp edge) — so those needed zero
  changes. `railCellIsHub` gained one more hub condition (any `rampEdge`
  present), and `computeRailBlocks` now runs a third independent block
  graph for `railUnderground`, exactly like `railElevated` already does.

## What changed

- **`world.js`**: `underground` grade; `rampEdge` field on `newTrack()`;
  `'underground'`/`'railUnderground'` in `LAYER_GRADE_KIND`/
  `GRADE_KIND_LAYER`.
- **`loader.js`**: `UNDERGROUND_COST_MULTIPLIER` (3x — tunneling costs
  more than bridging) and `UNDERGROUND_RAMP_COST` ($80, vs. a Ramp's $40).
- **`commands.js`**: new `directionBlockedByRamp` guard, used by
  `connectNewTileEdges`/`cmdToggleConnection`; new
  `buildUndergroundRamp`/`cmdBuildUndergroundRamp`/
  `cmdBuildRailUndergroundRamp`; `buildTrackTile`'s cost formula and
  `cmdDemolish`'s edge-severing both generalized for the third grade
  (demolishing either side of a ramp clears `rampEdge` on both sides
  symmetrically, the same way demolishing normal track already clears
  `edges` on its neighbor).
- **`pathfinding.js`**: `findLayerPath` gained the lateral ramp-edge move;
  the existing same-cell Ramp move is now explicitly guarded to
  ground/elevated only (it was implicitly safe before underground
  existed, since `cell.ramps` had no other meaning to collide with).
- **`rail-blocks.js`**: `railCellHasRampEdge`; `railCellIsHub` and
  `computeRailBlocks` both extended for the third grade.
- **`render.js`**: underground/`railUnderground` track render dashed and
  in a muted, earthy color, drawn FIRST so ground/elevated content
  naturally covers it wherever both exist at a cell — a deliberate
  first-pass simplification (an "X-ray hint" through empty ground, not a
  real per-layer visibility toggle; see Known limitation below). A small
  edge-positioned marker (distinct from the same-cell Ramp's center
  diamond) marks each ramp edge; a vehicle on either underground layer
  gets a dashed outline (the "in a tunnel" counterpart to the elevated
  layers' solid "on a bridge" outline).
- **`ui.js`/`index.html`**: the Network layer selector gained an
  Underground option; new Build Tunnel Ramp / Build Rail Tunnel Ramp
  tools using the same two-click interaction as Connect/Disconnect (click
  a ground tile, then the adjacent underground tile, or the reverse
  order); cost labels and hint text updated throughout.

## Known limitation

Rendering is a genuine first pass, not a solved problem: underground
track only shows through where the ground above it happens to be empty,
since there's no dedicated "which level am I looking at" view yet — a
busy ground-level map could visually bury an underground line entirely
even though it's still fully functional underneath. A real
layer-visibility toggle is natural follow-up work, not attempted here.

## Testing

New `test/test-underground.js` (8 sections, 22 checks): cost/adjacency/
both-grades validation, order-independence of the two clicks, the
straight-through constraint rejecting a perpendicular connection on
either side (and the valid straight-continuation case), the
after-the-fact guard against adding a new perpendicular connection once
a ramp exists (both auto-connect and manual Connect), pathfinding
actually crossing the ramp (and confirming no direct elevated<->
underground path exists), rail blocks treating a ramp cell as a hub on
both layers with distinct block ids, a real train's full
ground->underground->ground round trip delivering cargo end to end via
`simTick()`, and demolishing either side of a ramp correctly clearing it
on both sides. All 6 test files pass. Also verified end-to-end in a real
browser: the Underground layer selection updates the road cost label
live ($30/tile, 3x), the two-click Tunnel Ramp tool builds correctly with
live hint-text feedback, `findRoadPath` confirms a real crossable path,
and the dashed underground rendering with its edge-positioned ramp marker
renders correctly beneath the ground-level content, with no console
errors.
