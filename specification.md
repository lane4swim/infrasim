# Real-Time Logistics Game — Architecture Design

A single-player, browser-only HTML5 game where the player builds multi-modal
transport networks (road, rail, water, air, pipeline, powerline) connecting
extraction sites, factories, and demand centers, across multiple height levels.

---

## 1. Design Goals & Constraints

- **Single player, fully client-side.** No backend required; runs entirely in
  the browser. Save/load via local storage or exported file.
- **Real-time simulation** with a deterministic, fixed-timestep core so the
  game stays consistent regardless of frame rate.
- **Multi-layer / multi-height world.** Surface, elevated (bridges/viaducts/
  pylons), underground (tunnels/pipelines/mining shafts), and airspace.
- **Extensible by data, not by code forks.** New resources, recipes, vehicles,
  and even entirely new transport modes should be addable primarily through
  data files and small plugin modules, not by rewriting core systems.
- **Performance at scale.** Hundreds of vehicles, thousands of grid cells,
  running smoothly in a browser tab.
- **Player-directed logistics, not autopilot.** The simulation never invents
  a route or a storage buffer on the player's behalf. The player explicitly
  assigns each vehicle's stops/orders, and explicitly builds (and sizes)
  storage at every station, depot, and port. Insufficient planning on either
  front — no route, or too little buffer — is a real, visible bottleneck the
  player must design around, not something the game quietly solves for them.
- **A real economy, not just a physical simulation.** Every construction
  action (track/road/pipe/wire segments, stations, buildings) costs money;
  every vehicle has a purchase price and an ongoing running cost while it
  operates; income is earned only when cargo is actually delivered. See §16.

---

## 2. High-Level Layered Architecture

```
┌───────────────────────────────────────────────────────────┐
│  Presentation Layer                                        │
│  - Renderer (WebGL/PixiJS)                                 │
│  - UI (React/Preact overlay, DOM)                          │
│  - Input & Camera controller                                │
├───────────────────────────────────────────────────────────┤
│  Application / Game Layer                                   │
│  - Build mode, tools, selection, orders                     │
│  - Save/Load, scenario/campaign loader                      │
├───────────────────────────────────────────────────────────┤
│  Simulation Core (deterministic, headless, testable)         │
│  - ECS world (entities, components, systems)                │
│  - Fixed-timestep tick loop                                  │
│  - Network graphs (road/rail/water/air/pipe/power)           │
│  - Production/logistics simulation (resources, recipes)      │
│  - Pathfinding & routing                                     │
├───────────────────────────────────────────────────────────┤
│  Data / Content Layer (JSON + schemas, hot-loadable)          │
│  - Resource defs, recipe defs, building defs, vehicle defs    │
│  - Transport-mode plugin registry                             │
├───────────────────────────────────────────────────────────┤
│  Platform Layer                                              │
│  - Web Workers (simulation, pathfinding)                      │
│  - Storage (IndexedDB/localStorage), file import/export        │
└───────────────────────────────────────────────────────────┘
```

The key architectural principle: **the simulation core knows nothing about
rendering or the DOM.** It is a pure, tick-based state machine that could in
principle run headless (useful for testing, and for offloading to a Web
Worker so the UI thread stays smooth). The renderer only reads simulation
state and never mutates it directly — all mutation happens through **commands**
(see §7).

---

## 3. Tech Stack Recommendation

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript | Type safety for a large data-driven simulation |
| Rendering | PixiJS (WebGL2) or a thin custom WebGL layer | 2.5D isometric/ortho rendering with sprite batching handles thousands of tiles/vehicles well; avoid a heavy 3D engine unless true 3D visuals are wanted |
| UI overlay | Preact or vanilla DOM + a small reactive store | Build menus, HUD, dialogs sit above the canvas as normal DOM |
| Simulation threading | Web Worker running the ECS + pathfinding | Keeps 60fps rendering independent of simulation tick cost |
| State transfer | SharedArrayBuffer / transferable typed arrays where possible, else structured-clone messages | Avoid GC churn from posting large JS objects every frame |
| Persistence | IndexedDB (large saves) with localStorage for settings | Synchronous localStorage is too small/slow for full-world saves |
| Data format | JSON + JSON Schema validation at load time | Human-editable, easy to extend, versionable |
| Build tooling | Vite | Fast dev loop, native ES modules, easy worker bundling |

A pure 3D engine (Three.js/Babylon) is optional — only justified if you want
true 3D camera rotation. An isometric 2.5D approach (sprites + a height offset
per layer) delivers the "multiple height levels" feel at far lower complexity
and cost, and is the recommended default.

---

## 4. World Representation

### 4.1 The grid and height layers

The world is a 2D grid of **cells** `(x, y)`. Each cell has a **stack of
vertical layers**:

```
Layer index   Meaning                         Example occupants
   +2         High airspace                   plane routes
   +1         Elevated / bridge level          elevated rail, pylons, viaducts
    0         Ground level                     roads, factories, rail, mines
   -1         Shallow underground               pipelines, cut-and-cover tunnels
   -2         Deep underground                  mine shafts, deep tunnels
```

This is not a full voxel engine — it's a small, fixed number of semantic
layers (extensible via data, see §4.3), which keeps pathfinding and rendering
tractable while still giving the player meaningful "build up / build down"
decisions (e.g., a bridge over a river, a tunnel under a mountain, pylons
crossing a rail yard).

```ts
interface Cell {
  x: number; y: number;
  terrainHeight: number;     // visual ground elevation (hills/valleys)
  layers: Map<LayerId, CellOccupant | null>;
}

interface CellOccupant {
  entityId: EntityId;        // the building/track/pipe segment occupying it
  networkId?: NetworkId;     // which transport network this belongs to
}
```

### 4.2 Chunking

The grid is divided into fixed-size **chunks** (e.g. 32×32 cells) for:
- Spatial partitioning (only simulate/render chunks near the camera or with
  activity, "sleep" idle far-away chunks at reduced tick rate).
- Efficient serialization (save/load per chunk, stream large maps).
- Collision/occupancy queries scoped to a chunk plus neighbors.

### 4.3 Layers are data, not hardcoded

`LayerId` is not a hardcoded enum baked into logic — it's declared in data
(`layers.json`) with properties like `zOrder`, `allowedNetworkTypes`,
`buildRequirements` (e.g. "requires foundation/pylon on layer below"). This
lets content packs add e.g. a "orbital layer" or a second underground tier
without touching simulation code.

> **Validated in Phase 1.** Only two of the five conceptual layers are
> implemented so far — ground and elevated, for roads only — but the core
> principle held up under real implementation: **two layers occupying the
> same cell never connect to each other implicitly, even when both have a
> road tile right there.** An elevated road can cross directly over a
> ground road without joining it, which is exactly the "bridge over a
> junction" case this section was meant to support. The one addition the
> real build needed that this section didn't originally call out: a
> **`Ramp`** — a distinct, purchasable, single-cell entity that explicitly
> links the two layers at that one location, modeled as a same-cell
> vertical move in the pathfinding graph. Without an explicit ramp
> mechanic, "layers don't auto-connect" has no counterpart action for
> "now deliberately connect them here" — worth generalizing to every future
> layer pair (elevated↔ground, ground↔underground), not just this one.

---

## 5. Entity-Component-System (ECS)

An ECS keeps the simulation extensible: new behavior = new component +
system, without editing a monolithic class hierarchy.

**Core components** (illustrative, not exhaustive):

- `Transform` — cell position, layer, orientation
- `NetworkNode` — this entity is a node in a transport graph (station, depot,
  substation, pumping station...)
- `NetworkEdge` — this entity is a track/road/pipe/wire segment connecting
  two nodes, with capacity/speed/throughput
- `Producer` — converts input resources to output resources per a `Recipe`
  (factories, mines, power plants)
- `Storage` — a **finite, player-sized** stockpile buffer. Capacity is fixed
  at build time (and only changed by an explicit player upgrade action) —
  the simulation never auto-expands it. See §6.6 for the consequences of
  under-building it.
- `Vehicle` — moves along a network edge, carries cargo, and follows an
  **`Orders` list**: an ordered sequence of stops the player assigned, each
  with load/unload instructions (see §6.6)
- `Consumer` — demand center; consumes resources, generates score/income
- `PowerNode` / `FluidNode` — for continuous-flow networks (see §6.4)
- `UpkeepCost` — attached to any entity with an ongoing operating expense
  (vehicles' fuel/maintenance, some stations' staffing) — a per-tick amount
  `EconomySystem` deducts from the `Treasury` while the entity is active
- **`Treasury`** — not a per-entity component but a single world-level
  resource holding the player's cash balance; every economic transaction
  (construction cost, vehicle purchase, upkeep, delivery income) is a
  mutation of this one value, made only by `EconomySystem` (§16)

**Core systems**, run each simulation tick in a fixed order:

1. `ProductionSystem` — advance recipes, produce/consume from `Storage`
   (halts if inputs are empty or output storage is full — see §6.6)
2. `RoutingSystem` — does **not** invent or reassign destinations. It only
   (a) validates that a vehicle's player-assigned `Orders` are still
   traversable given current network topology, and (b) computes/caches the
   low-level path *between* consecutive player-chosen stops. It re-runs only
   when topology changes invalidate a cached path (event-driven, see §8) —
   never in response to demand or storage state.
3. `MovementSystem` — advance vehicles along their edges
4. `LoadUnloadSystem` — handle cargo transfer at stations/depots per the
   vehicle's current order and the station's available storage; blocks
   (vehicle waits) if the source is empty or the destination buffer is full
5. `FlowSystem` — resolve continuous networks (power, pipelines) as a
   graph-flow problem rather than discrete units
6. `EconomySystem` — the only system allowed to mutate the player's
   `Treasury`. Deducts per-tick running costs from active vehicles/stations
   (`UpkeepCost` component), credits income when a delivery completes at a
   `Consumer` (triggered by `LoadUnloadSystem`), and validates/settles
   construction and purchase costs when `BUILD_EDGE`/`BUILD_NODE`/
   `PURCHASE_VEHICLE` commands are applied. See §16 for the full model.
7. `EventSystem` — breakdowns, disasters, contracts (extensible hook point)

Systems only read/write components through the ECS world API — no direct
references to rendering or UI.

> **Validated in Phase 1.** A real component-table ECS is implemented and
> working: components live in `Map<entityId, data>` tables (`Transform`,
> `Footprint`, `Storage`, `Producer`, `Consumer`, `Movement`, `Orders`,
> `Cargo`, etc.), and systems select entities via `queryEntities(...names)`
> rather than switching on a type field — e.g. the production system runs on
> "anything with `Producer`+`Storage`" and doesn't care whether that's an
> extraction site or a processing plant. One refinement worth carrying
> forward: each entity is exposed to the rest of the codebase through a thin
> `Proxy` handle that reads/writes the right component field under a plain
> property name (`building.stock`, `vehicle.speed`). This turned out to be
> the difference between "a real ECS" and "a painful ECS to build UI/tools
> against" — call sites stay ergonomic while the data is still genuinely
> decomposed and queryable. `destroyEntity(id)` removing an entity from
> *every* table at once (not just a single map) turned out to matter in
> practice — wiring it into demolish/sell caught a real bug where a
> destroyed building kept being processed by production because only its
> grid reference had been cleared, not its component data.
> `Storage` also turned out to need two independently-sized slots rather
> than one (`out`: what a building offers for pickup; `in`: what it accepts
> for drop-off) — a pure extractor has only `out`, a pure demand center has
> only `in`, and a processing building (a mill converting ore to steel) has
> both, which is what makes it a real intermediate step in a chain rather
> than just another source or sink. See §9 and §17.

---

## 6. Transport Networks

### 6.1 A common abstraction

Every transport mode — truck, train, ship, plane, pipeline, powerline —
implements the same interface, so the simulation core (and pathfinding) treat
them uniformly, while each mode supplies its own rules:

```ts
interface TransportMode {
  id: string;                       // "truck", "rail", "pipeline", ...
  networkKind: "discrete" | "continuous"; // vehicles vs. flow
  allowedLayers: LayerId[];
  buildableOn(cell: Cell): boolean;
  connectionRules: ConnectionRules;  // e.g. rail needs rail, road needs road
  vehicleTypes?: VehicleTypeDef[];   // absent for pipelines/powerlines
  pathCostFn(edge: NetworkEdge, cargo: CargoSpec): number;
  capacityModel: CapacityModel;      // per-edge or per-node throughput limits
}
```

Each mode is registered in a `TransportModeRegistry` at startup, populated
from data files (`modes/truck.json`, `modes/rail.json`, ...). Adding a new
mode — say, drones, or a monorail — means adding a data file plus a small
TypeScript module implementing edge-cost and rendering hooks; the simulation
loop, save system, and UI build-menu all pick it up automatically because
they iterate the registry rather than switching on a hardcoded mode list.

### 6.2 Discrete networks (truck, train, ship, plane)

Modeled as a **graph**: nodes = stations/depots/ports/airports, edges =
road/track/lane/route segments. Vehicles are entities that traverse edges
with mode-specific speed/capacity/turning rules, following the **ordered
stop list the player assigned** (§6.6) — the network graph is only used to
compute *how* a vehicle gets from one player-chosen stop to the next, never
to decide *where* it should go.

- **Trucks**: the player picks the stop sequence; pathfinding fills in the
  turn-by-turn route on the road graph between stops, using any road node
  as a waypoint; supports intersections.
- **Trains**: graph with **directionality and block/signal constraints**
  (single track = mutual exclusion per block) to create meaningful capacity
  planning.
- **Ships**: graph restricted to water cells (+ canals/locks as special
  edges); large turning radius/speed modeled as edge cost.
- **Planes**: a *simplified* graph — airports as nodes, direct flight edges
  computed from node pairs rather than a dense tile grid, since air travel
  isn't tile-constrained. Airspace layer mainly matters for rendering and
  for "no other layer-+2 construction here" collision rules.

> **Validated in Phase 1, for roads.** Two things this section left
> implicit turned out to need to be explicit, and generalize well beyond
> roads: (1) **connectivity between two adjacent tiles/edges is its own
> piece of state, not inferred from adjacency** — building a road tile next
> to another one auto-connects them by default, but that default is a
> per-build toggle, and a separate "Connect/Disconnect" action can wire up
> or sever one specific edge by hand regardless of physical adjacency. This
> is what makes two parallel one-way streets (or, later, parallel rail
> tracks) representable at all — without it, anything touching anything
> else of the same type joins the same graph whether the player wanted that
> or not. (2) **edges carry directionality**, off by default (two-way), settable
> per edge independent of the connection itself — a real, working
> requirement for one-way streets and eventually rail signaling block
> direction. Both are cheap to add to the edge data model (a couple of
> booleans per side) and expensive to retrofit once pathfinding assumes
> "connected = bidirectional," so worth having from the start for every
> discrete network mode, not just trucks.

### 6.3 Continuous networks (pipeline, powerline)

Modeled as a **flow graph**, not discrete vehicles: each tick, `FlowSystem`
solves a max-flow/least-cost-flow style distribution from sources (wells,
power plants) through edges (pipes/wires with capacity and loss) to sinks
(factories, cities). This is cheaper computationally than simulating
individual "packets" and matches how players intuitively think about these
networks (pressure/throughput rather than individual trucks).

### 6.4 Unifying discrete and continuous under one Network abstraction

Both are represented as a `NetworkGraph<NodeData, EdgeData>` with a
`resolve(tick)` method — `DiscreteNetworkResolver` runs pathfinding +
movement, `ContinuousNetworkResolver` runs flow distribution. This lets the
UI (route highlighting, capacity overlays, "connected/disconnected" warnings)
work identically across all six network types.

### 6.5 Intersections between networks: transfer stations

Cross-mode logistics (truck → train → ship) happen at **transfer nodes**: a
building that is simultaneously a `NetworkNode` in two+ networks and has
`Storage` + transfer logic. The `RoutingSystem`'s multi-modal pathfinder
treats a transfer node as a graph edge between networks with a cost (loading
time, handling fee) — this is what lets the player build genuinely
interesting multi-modal supply chains. Because arrivals from each mode
rarely stay in lockstep (a train may deliver 500 units at once while trucks
draw it down 20 units at a time), the `Storage` buffer the player builds at
a transfer node is what absorbs that mismatch — see §6.6.

> **Validated in Phase 1, with one deliberate deviation.** The real
> "Station" entity that trucks load/unload at ended up **not** having its
> own `Storage` at all — it's a pure access point that forwards to whichever
> industry building it (or a chain of touching Stations) is physically
> connected to, and that industry's own `Storage` is what actually absorbs
> the mismatch described above. This reads more honestly for a single-mode
> network where the "transfer" is really "give a vehicle physical access to
> a building's buffer" rather than a genuine mode-to-mode handoff — the
> transfer-node-with-its-own-storage model in this section is still right
> for true cross-mode handoffs (truck↔train), which Phase 1 hasn't built
> yet. A Station also has (a) a single configured resource it handles, and
> (b) exactly one side (`facing`, chosen at build time) that can ever touch
> a road, even if a road is physically adjacent on another side — both
> real, working constraints worth keeping for the eventual multi-mode
> version, since a real transfer node choosing "which mode reaches me from
> which direction, carrying which resource" is exactly this same idea, generalized.

### 6.6 Player-authored routing & storage as a design constraint

Two things the simulation deliberately does **not** do for the player:

- **It does not compute where a vehicle should go.** A vehicle only owns an
  `Orders` list — an ordered sequence of station/port stops with per-stop
  load/unload rules (e.g. "load up to 50 steel", "unload all", "wait until
  full") — that the player assembles explicitly for every vehicle or vehicle
  group. There is no global demand-solver assigning vehicles to shortages.
  If a factory has no vehicle with an order to visit it, its output simply
  accumulates (or its production stalls once storage is full) until the
  player fixes the route.
- **It does not size storage for the player.** Every `NetworkNode` that can
  hold cargo (factory output/input buffers, station platforms, port
  warehouses, depot yards) has a capacity chosen by the player at build
  time via a `BUILD_NODE`/`UPGRADE_STORAGE` command, using building tiers or
  add-on storage modules defined in data (`data/buildings/*.json`). The
  simulation enforces that capacity as a hard limit.

**Consequences the systems must handle explicitly, since they're core to the
gameplay rather than edge cases:**

| Situation | Behavior |
|---|---|
| Producer's output storage is full | `ProductionSystem` halts that recipe until space frees up (visible "backed up" state) |
| Vehicle arrives to load but source storage is empty | Vehicle waits at the stop (idle timer visible to the player) rather than skipping the order |
| Vehicle arrives to unload but destination storage is full | Vehicle waits; if configured, an order can allow partial unload instead |
| A station has no storage buffer at all (0 capacity) | Legal to build, but throughput is capped at whatever a vehicle can transfer in a single instantaneous exchange — effectively forcing perfectly synchronized schedules; the UI should flag this as a fragile setup |
| Continuous network (pipeline/power) source exceeds sink+storage capacity | `FlowSystem` throttles/curtails supply at the source rather than losing resources silently, and surfaces a capacity warning |

This is the intended source of mid-late-game complexity: the player must
reason about buffer sizing and schedule/order design the same way they
reason about track/road layout. The UI layer should surface storage
fill-level and "vehicle idle/waiting" states prominently (e.g. a fill-bar on
every station icon, a queue indicator for waiting vehicles) so the
consequences of under-building are legible rather than hidden simulation
state.

---

## 7. Command / Event Architecture (UI ↔ Simulation boundary)

To keep simulation deterministic and to support undo, replay, and the
worker-thread split, all player actions become **commands** rather than
direct mutations:

```ts
type Command =
  | { type: "BUILD_EDGE"; mode: string; layer: LayerId; path: CellCoord[] }
  | { type: "BUILD_NODE"; mode: string; layer: LayerId; cell: CellCoord; buildingType: string; storageCapacity?: number }
  | { type: "UPGRADE_STORAGE"; nodeId: EntityId; newCapacity: number }
  | { type: "PURCHASE_VEHICLE"; vehicleType: string; homeNodeId: EntityId }
  | { type: "SELL_VEHICLE"; vehicleId: EntityId }
  | { type: "DEMOLISH"; entityId: EntityId }
  | { type: "SET_ORDERS"; vehicleId: EntityId; orders: OrderStop[] }  // player-authored stop list; see §6.6
  | { type: "SET_RECIPE"; producerId: EntityId; recipeId: string };

interface OrderStop {
  nodeId: EntityId;
  action: "load" | "unload" | "load_full" | "unload_all";
  resource?: string;   // omit to mean "whatever the vehicle is carrying / station accepts"
  amount?: number;
  waitCondition?: "until_full" | "until_available" | "none";
}
```

`SET_ORDERS` (renamed from an earlier `SET_ROUTE`) is deliberately the
*only* way a vehicle's destinations are ever set — there is no command or
system pathway that assigns orders automatically. `BUILD_NODE` takes an
explicit `storageCapacity` chosen by the player (bounded by the building
type's min/max in its data definition); `UPGRADE_STORAGE` is the only way to
grow it later.

`BUILD_EDGE`, `BUILD_NODE`, `UPGRADE_STORAGE`, and `PURCHASE_VEHICLE` all
carry an implicit cost looked up from data (§16) rather than a cost field on
the command itself — this keeps costs authoritative in one place (the
content layer) instead of trusting whatever the client sends. `EconomySystem`
computes the cost, checks it against `Treasury`, and **rejects the command
entirely** (emitting an `InsufficientFunds` event, no partial construction)
if funds are insufficient. `SELL_VEHICLE` refunds a data-defined fraction of
the original purchase price.

Flow: `UI → CommandQueue → Simulation (validates + applies) → emits
Events → Renderer/UI subscribe to Events for feedback (sound, particles,
notifications)`.

This also gives a natural extensibility seam: new build tools just add a new
`Command` variant and a handler, without the UI needing to know simulation
internals.

---

## 8. The Simulation Loop

- **Fixed timestep** (e.g. 100–200ms "logistics tick") decoupled from render
  frame rate via an accumulator pattern, so vehicle movement and production
  are consistent regardless of device performance.
- **Event-driven path recompute, not per-tick and never demand-driven**:
  a vehicle's destinations come only from its player-assigned `Orders`
  (§6.6); the engine recomputes the low-level path *between* two
  already-chosen stops only when a build/demolish edit invalidates the
  cached path — never in response to storage levels or shortages. Cache
  paths per (network, source, destination) and invalidate on relevant edits.
- **Storage backpressure is resolved synchronously within the tick**: a full
  destination buffer or an empty source buffer simply blocks the relevant
  `ProductionSystem`/`LoadUnloadSystem` action for that tick (vehicle/recipe
  waits) rather than being queued or silently dropped — this is what makes
  under-sized storage a visible, diagnosable bottleneck.
- **Chunk activity levels**: chunks with no vehicles/production and no
  visible presence on screen tick at a reduced rate ("far simulation") to
  save CPU on large maps — a common strategy in city-builders/factory games.
- Runs inside a **Web Worker**; the main thread only holds a render-ready
  snapshot (double-buffered) so pathfinding spikes never drop frames.

---

## 9. Resource & Recipe System (data-driven extensibility)

```json
// data/resources/iron-ore.json
{ "id": "iron_ore", "category": "raw", "unitVolume": 1, "unitWeight": 2, "baseValue": 5 }

// data/recipes/steel-mill.json
{
  "id": "smelt_steel",
  "building": "steel_mill",
  "inputs": [{ "resource": "iron_ore", "amount": 4 }, { "resource": "coal", "amount": 2 }],
  "outputs": [{ "resource": "steel", "amount": 2 }],
  "durationTicks": 20
}
```

`baseValue` is what `EconomySystem` uses to price delivery income at a
`Consumer` (§16) — another example of gameplay numbers living in data rather
than code, so a new resource is automatically economically meaningful the
moment it's added.

New supply chains are added purely by dropping in new resource/recipe/
building JSON files (validated against a JSON Schema at load time) — no code
changes required for the common case of "new material + new factory type."
A `ContentPack` loader merges base-game data with any additional packs,
which is also the seam a modding UI could hook into later.

> **Validated in Phase 1.** A real two-step chain is implemented and
> working end to end: a Mine extracts Ore (a recipe with no inputs), a
> Steel Mill consumes Ore and produces Steel (a recipe with one input and
> one output), and a Town consumes whatever resource it's configured to
> accept (Steel, in this chain) for income. `ProductionSystem`'s recipe
> handling only needed to support **0-or-1 input resource types and exactly
> 1 output type** to make this work — genuinely multi-input recipes (e.g.
> "ore + coal → steel") are the natural next step but weren't needed yet
> and would mean iterating `recipe.inputs` instead of reading a single
> entry. The other real addition: **vehicles are typed by the single
> resource they carry**, fixed for the vehicle's whole life (a bulk truck
> only ever carries ore; a flatbed only ever carries steel) — enforced at
> the moment a stop is added to a vehicle's `Orders`, not just by
> convention. This is what actually makes "different vehicles transport
> different resources" a rule the game holds the player to, rather than
> just a naming/flavor choice, and it composes cleanly with a Station's own
> single configured resource (§6.5): a stop is only ever valid when
> vehicle-resource, station-resource, and industry-slot-resource all agree.

---

## 10. Pathfinding

- **Discrete networks**: A* per mode over the network graph (not the raw
  tile grid) — nodes are stations/junctions, edges precomputed with
  cost = f(distance, speed limit, elevation change, tolls). Rail additionally
  checks block occupancy before committing a path. Pathfinding only ever
  solves "get from stop A to stop B," where A and B are two consecutive
  entries the player put in a vehicle's `Orders` — it never chooses A or B.
- **Multi-modal**: when the player's own order list spans networks (e.g. a
  truck's orders end at a rail depot, and a separately-ordered train picks
  up from there), each vehicle still only pathfinds within its own network
  between its own player-chosen stops. A higher-level "meta-graph" view
  (single-mode subgraphs joined at transfer nodes) is exposed to the player
  as a *planning aid* — e.g. highlighting reachable transfer nodes or
  estimating end-to-end transit time in the UI — but it never auto-assigns
  orders on the player's behalf.
- Run in the same Worker as the simulation, using pooled/reused typed arrays
  for open/closed sets to avoid per-call allocation.

---

## 11. Rendering Pipeline

- **Isometric or ortho tile renderer** (PixiJS) with sprite batching;
  layers drawn back-to-front, each height layer offset visually (screen-Y
  shift) so elevated/underground construction reads clearly, with a
  "layer visibility" toggle (à la floor-by-floor view in sim games) so the
  player can inspect underground pipes without ground-level clutter.
  A short vertical connector sprite (pylon, tunnel mouth, shaft) is drawn
  wherever an edge changes layer.
- Renderer subscribes to a **read-only snapshot** of ECS state produced each
  simulation tick (or interpolates between two snapshots for smooth motion
  between ticks) — never touches simulation state directly.
- Camera/culling: only chunks in the viewport (+margin) are drawn;
  off-screen chunks are skipped by the renderer regardless of their
  simulation activity level.
- **Storage/queue legibility**: every station/port/depot renders a small
  fill-bar for its `Storage` buffer, and idle/waiting vehicles get a visible
  "waiting" indicator — since under-building storage or mis-ordering
  vehicles is a core player mistake to make discoverable (§6.6), not
  something buried in a stats panel.
- **Economy legibility**: current `Treasury` balance is always visible in
  the HUD; construction tools show a live cost estimate on the build ghost
  before the player commits; completed deliveries show a small floating
  income popup at the consumer (§16), so cost and income are as legible as
  storage state, not just numbers in a menu.

---

## 12. Persistence

- Serialize world as: header (version, mode registry versions) + chunk data
  (occupancy, entities) + ECS component tables, all as compact JSON or
  binary-packed typed arrays for large maps. This includes the `Treasury`
  balance and any active loans/contracts (§16); a short recent-transaction
  log can be saved too for the player's ledger UI, though it isn't required
  for correctness — only the balance itself is authoritative.
- Store in IndexedDB (auto-save) with an explicit "export to file" (download
  a `.json`/`.sav`) and "import from file" for manual backups/sharing saves.
- Version the save format and the content-pack set together, so a save made
  with an older recipe/resource set can be migrated or flagged incompatible
  gracefully rather than crashing.

---

## 13. Extensibility Summary

| Want to add... | How |
|---|---|
| New resource | New JSON file in `data/resources/` |
| New recipe/factory | New JSON file in `data/recipes/` + `data/buildings/` |
| New vehicle within an existing mode | New JSON in `data/vehicles/` |
| New transport mode (e.g. drones, monorail) | New `TransportMode` module + data file registered in `TransportModeRegistry`; simulation, UI build menu, save system pick it up automatically since they iterate the registry |
| New height layer | New entry in `data/layers.json` with build rules |
| New game mechanic (disasters, contracts, seasons) | New ECS component(s) + system, hooked into `EventSystem` |
| New cost/income rule (e.g. dynamic market prices, seasonal demand, subsidies) | New pricing rule plugged into `EconomySystem`'s pricing hook (§16), reading `baseValue`/cost fields from data rather than a hardcoded formula |

The guiding rule throughout: **core systems iterate registries/graphs
generically; they never hardcode a specific resource, mode, or layer by
name.**

---

## 14. Suggested Module/Folder Structure

```
src/
  sim/                     # pure TS, no DOM/rendering deps, unit-testable
    ecs/                   # World, Component, System, Query
    networks/              # NetworkGraph, DiscreteResolver, ContinuousResolver
    modes/                 # truck.ts, rail.ts, ship.ts, plane.ts, pipe.ts, power.ts
    pathfinding/
    production/
    commands/
    events/
    save/
  content/
    schemas/               # JSON Schema for each data type
    loader.ts               # ContentPack loading + validation
  render/
    pixi/                   # renderer, layer compositor, sprite atlases
    camera.ts
  ui/
    build-menu/, hud/, dialogs/ (Preact components)
  worker/
    sim.worker.ts           # hosts the sim loop, message protocol to main thread
  data/                      # the actual JSON content (base game)
    resources/ recipes/ buildings/ vehicles/ modes/ layers/
```

---

## 15. Suggested Build Order (phased)

1. ✅ **Grid + one layer + one mode**: ground-level roads + trucks, single
   resource, single recipe, basic ECS and fixed-tick loop. Prove the
   command/event boundary and worker split early — including the
   player-facing order-list editor and station storage sizing (§6.6), since
   getting the "no autopilot" interaction model right early avoids having to
   retrofit it once more modes exist. **Built and playable — see §17.** It
   grew past its original single-resource/single-recipe scope (real
   multi-resource chain, vehicle physics, partial multi-layer roads) before
   moving to milestone 2, which turned out fine: none of that extra scope
   needed the Worker split or a second transport mode to be meaningful.
2. **Second discrete mode + transfer nodes** (e.g. rail) to validate the
   multi-modal graph abstraction before adding more modes. Not started —
   this is the next real test of §6.5's transfer-node model, since Phase 1's
   Station (§6.5) deliberately isn't a true cross-mode handoff yet.
3. **Continuous network** (pipeline or power) to validate the flow-resolver
   split from the discrete resolver.
4. **Multi-layer construction** (bridges/tunnels/pylons): partially proven
   early — ground/elevated road crossings and an explicit Ramp mechanic
   (§4.1) work now, ahead of schedule, because it turned out to be a small
   addition on top of per-edge road connectivity rather than needing the
   rest of the game to exist first. Underground layers and non-road modes
   using layers are still open.
5. **Remaining modes** (ship, plane) — should mostly be data + a thin
   mode-module given the abstraction is proven.
6. **Content/extensibility pass**: JSON Schema validation, content-pack
   loader, and a couple of "test" third-party-style content packs to prove
   the extensibility claims actually hold. Not started — Phase 1's data defs
   (resources, recipes, buildings, vehicles) are still inline JS objects in
   one file, not `data/*.json` yet; splitting them out is the natural first
   step here.
7. **Performance pass**: chunk sleeping, worker profiling, save/load for
   large maps.

---

## 16. Economy Model

### 16.1 The Treasury

A single world-level `Treasury` value (player's cash balance) is the sole
target of every economic transaction. `EconomySystem` is the only system
permitted to change it, and every change is emitted as an `Event`
(`ConstructionPaid`, `VehiclePurchased`, `UpkeepCharged`, `DeliveryIncome`,
`InsufficientFunds`) so the UI can render a ledger/history without the
renderer needing to inspect simulation internals directly.

### 16.2 Construction costs

- Every buildable thing has a cost defined in data: `data/buildings/*.json`
  carries a flat `buildCost` per station/factory/depot; `data/modes/*.json`
  carries a `costPerUnitLength` for track/road/pipe/wire edges, with a
  **layer multiplier** (e.g. tunnels and elevated/bridge construction cost
  more per tile than ground level — a natural lever for making height-level
  construction a real tradeoff, not just a visual option).
- `BUILD_EDGE`/`BUILD_NODE`/`UPGRADE_STORAGE` commands are costed by summing
  the relevant data-defined rates over the requested path/building/capacity
  delta, checked against `Treasury` **before** any world mutation happens —
  construction is all-or-nothing, never partially applied because money ran
  out partway through a long track.

### 16.3 Vehicle costs

- `data/vehicles/*.json` defines a `purchaseCost` (charged once, on
  `PURCHASE_VEHICLE`) and a `runningCostPerTick` (or optionally
  `runningCostPerDistance`, for modes where fuel-per-km reads more naturally
  than fuel-per-second — e.g. ships/planes).
- The `UpkeepCost` component caches the applicable rate for that vehicle
  instance; `EconomySystem` deducts it from `Treasury` every tick the
  vehicle is *active* (has orders and isn't parked/sold), regardless of
  whether it's currently loaded, moving, or waiting on a blocked order —
  a vehicle idling on a bad route still costs money, which is intentional
  pressure to fix broken logistics rather than let vehicles sit forever.
- `SELL_VEHICLE` credits back a data-defined fraction of `purchaseCost`
  (e.g. 40%), removing the entity and its `UpkeepCost`.

> **Validated in Phase 1, plus an addition worth generalizing.** Vehicles
> got real kinematics: each has its own `maxSpeed`, `massEmpty`,
> `engineForce`, and `brakeForce` (individually varied per vehicle instance,
> not shared constants), and actual acceleration/deceleration are computed
> every tick as `engineForce / mass` and `brakeForce / mass` — genuine
> F=ma, not a flat constant. `mass = massEmpty + cargoAmount × resource.unitWeight`,
> so a loaded vehicle measurably accelerates more slowly and needs more
> distance to stop than an empty one — this fell directly out of adding
> `unitWeight` to the resource data model (§9) and cost nothing extra in
> the content layer. `brakeForce` is kept greater than `engineForce` at the
> data level, which — because both divide by the same current mass in a
> given tick — guarantees braking is always stronger than accelerating
> regardless of load, without needing a separate rule for it. This also
> drives a genuinely **velocity- and load-dependent following gap** between
> vehicles: each vehicle checks the real stopping distance for its current
> speed and mass before deciding whether to accelerate or brake, so a
> faster or heavier vehicle needs (and gets) more room than a slower or
> lighter one. Worth carrying into every future vehicle-having mode (trains,
> ships) rather than treating Phase 1's trucks as a special case.

### 16.4 Delivery income

- Income is earned **only** when cargo is actually unloaded at a `Consumer`
  node — not on production, not on loading, not on "in transit." This is
  what makes the player's route/order design (§6.6) economically
  consequential: a perfectly built network that never completes a delivery
  earns nothing while still accruing upkeep.
- Base formula: `income = amountDelivered × resource.baseValue × consumer.priceMultiplier`,
  computed by `EconomySystem` when `LoadUnloadSystem` reports an `unload_all`/
  `unload` action completing at a node with a `Consumer` component.
  `consumer.priceMultiplier` is data-defined per demand center and is the
  hook for scenario design (a remote town pays more for the same goods than
  one next to the factory) without touching system code.
- This same hook point (`EconomySystem`'s pricing function) is where future
  extensions plug in — dynamic market prices that fall as a route floods a
  consumer with supply, seasonal demand, one-off contracts with bonus
  payouts — all as data/plugins rather than changes to `LoadUnloadSystem`
  or `EconomySystem`'s core loop.

### 16.5 Insufficient funds and running at a loss

- Construction and purchase commands are simply **rejected** if `Treasury`
  can't cover the cost (an `InsufficientFunds` event lets the UI show why).
- Running costs, by contrast, are allowed to take `Treasury` negative —
  the game doesn't auto-sell the player's vehicles or halt the simulation
  at zero. A negative balance is a visible warning state (HUD styling,
  optionally an escalating penalty or scenario-defined loss condition) that
  pushes the player to fix their network's profitability, consistent with
  the broader "make consequences visible, don't auto-resolve them"
  philosophy that also governs storage and routing (§6.6).

---

## 17. Phase 1 Status

Phase 1 (§15, milestone 1) is built and playable — a single self-contained
`index.html` with no build step, plus a battery of headless regression tests
run against the actual shipped simulation code (well over a hundred checks
across pathfinding, collision/queueing, vehicle physics, road connectivity,
the ECS core, and the multi-resource chain). It grew considerably past its
original single-resource/single-recipe scope. What's actually working:

- **World & network**: a single ground layer plus a second, independently-
  connected elevated layer for roads, linked only by explicit Ramps (§4.1);
  per-edge road connectivity that's never inferred from mere tile adjacency,
  including a manual Connect/Disconnect tool and an auto-connect toggle;
  one-way edges; BFS pathfinding (uniform edge cost, so A* wasn't needed
  yet) that resolves only between a vehicle's own player-chosen stops, never
  choosing a destination itself (§6.2, §6.6).
- **ECS**: a real component-table core with `queryEntities`, not simulated
  via a type switch — see the callout in §5.
- **Buildings**: Mine (extraction), Steel Mill (processing: ore → steel,
  the first real multi-step chain), Town (demand, configurable accepted
  resource), and Station (a storage-less access point with a configured
  facing side and a configured resource — see the callout in §6.5).
  Configurable multi-cell footprints throughout, not just 1x1.
  Construction/storage-tier costs, per §16.2.
- **Vehicles**: two resource-restricted types (bulk/ore, flatbed/steel);
  individual, fractional top speed/mass/engine-brake force/length per
  vehicle instance; real F=ma acceleration and braking with load-dependent
  mass (§16.3); a velocity- and length-aware following/queueing model so
  vehicles never overlap and longer or faster vehicles need more room.
- **Economy**: a single `Treasury`, construction/purchase costs (elevated
  roads cost more, per §16.2's layer-multiplier idea), per-tick vehicle
  upkeep, and delivery income paid only on completed unloads at a true
  Consumer (§16.4) — verified that an intermediate industrial delivery
  (trucking ore into the Mill) does *not* pay income, only the final Town
  delivery does.
- **Player-authored orders & storage** (§6.6): confirmed no autopilot
  anywhere — vehicles idle without orders, production halts on a full
  output or missing input, and every storage buffer's capacity is a
  player's build-time choice.

**Deliberately not yet built**, tracked against this document: the Worker
split (§2, §8 — the sim runs inline in the render loop today, specifically
so it works opened directly from disk without hitting module/CORS
restrictions; the simulation code is already isolated from rendering, so
this is a refactor rather than a redesign when it's needed), any second
transport mode (rail/ship/plane/pipeline/powerline) and true cross-mode
transfer nodes (§6.5's deviation callout), underground layers, JSON content
packs (§9, §13 — resource/recipe/building/vehicle defs are inline JS
objects in the one file today), IndexedDB persistence (§12), and multi-input
recipes (§9's callout — every recipe today has at most one input resource
type). None of these blocked what got built; they're the natural next
milestones per §15.

---

This gives you a system where the *simulation core* never needs to know how
many transport modes or height layers exist — it just resolves whatever is
registered — while the *content layer* is where nearly all game-content
growth (new resources, chains, vehicles, modes, layers, and now costs/prices)
happens.
