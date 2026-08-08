// ---------------------------------------------------------------------
// UI WIRING (tools, selection, order editor)
// ---------------------------------------------------------------------
let currentTool = 'select';
let selected = null;       // selected building or vehicle
let pickingStopFor = null; // {vehicle, action} awaiting a click on a building to add that stop
let oneWayFirst = null;    // first tile picked for the One-Way tool, awaiting a second click
let connectFirst = null;   // first tile picked for the Connect/Disconnect tool, awaiting a second click
let undergroundRampFirst = null; // first tile picked for the Tunnel Ramp tool, awaiting a second click
let hoverCell = null;

// Underground level dropdown options (§ Multi-level tunnels) — generated
// from UNDERGROUND_LEVELS (loader.js) rather than hand-written in
// index.html, inserted right before Deep Underground so the list keeps
// reading top-to-bottom as the vertical stack it represents. Runs before
// any of the cost-label wiring below, which reads currentLayer() and
// needs these options to already exist.
(function injectUndergroundLayerOptions(){
  const select = document.getElementById('layerSelect');
  const deepOption = select.querySelector('option[value="deepUnderground"]');
  for(let level=1; level<=UNDERGROUND_LEVELS; level++){
    const opt = document.createElement('option');
    opt.value = undergroundGradeName(level);
    const label = UNDERGROUND_LEVELS>1 ? `Underground level ${level} layer` : 'Underground layer';
    opt.textContent = `${label} (tunnel, x${costMultiplierForUndergroundLevel(level)} cost)`;
    select.insertBefore(opt, deepOption);
  }
})();

// Same generated-from-UNDERGROUND_LEVELS pattern as the layer options
// above, for the View selector (§ Underground visibility toggle) —
// "all" (the default 'option' already in index.html) plus one option per
// underground level, plus Deep Underground. A rendering-only control:
// render.js reads it fresh every frame via currentUndergroundView(), so
// no change/redraw wiring is needed here beyond populating the list.
(function injectUndergroundViewOptions(){
  const select = document.getElementById('undergroundViewSelect');
  for(let level=1; level<=UNDERGROUND_LEVELS; level++){
    const opt = document.createElement('option');
    opt.value = undergroundGradeName(level);
    opt.textContent = `View: Underground level ${level} only`;
    select.appendChild(opt);
  }
  const deepOpt = document.createElement('option');
  deepOpt.value = 'deepUnderground';
  deepOpt.textContent = 'View: Deep Underground only';
  select.appendChild(deepOpt);
})();
function currentUndergroundView(){ return document.getElementById('undergroundViewSelect').value; }

// ---------------------------------------------------------------------
// DYNAMIC TOOLBAR (§ Content-pack layering's own addon proved this gap:
// Colliery/Coal Hauler/Coal Hopper were fully valid, live content with no
// way to actually reach them through the UI, since every button/option
// below used to be hand-written HTML naming specific type ids). Runs
// before the click-wiring loop right below, which needs every button —
// generated or hand-written — to already exist in the DOM.
// ---------------------------------------------------------------------

// Hand-drawn icons for the types that have one; anything else (a
// content-pack addon's own new building/vehicle type) falls back to a
// plain generic icon rather than being unable to render at all.
const BUILDING_ICON = {mine:'icon-mine', mill:'icon-mill'};
const VEHICLE_ICON = {bulk:'icon-bulktruck', flatbed:'icon-flatbedtruck'};

function toolButtonHtml(color, icon, label, costText){
  return `<span class="tool-swatch" style="background:${color}"><span class="badge"></span><svg class="tool-icon" viewBox="0 0 24 24"><use href="#${icon}"/></svg></span>${label}${costText ? `<span class="cost">${costText}</span>` : ''}`;
}

// One tool button per BUILDING_DEFS entry with a `recipe` — the same
// `def.recipe` test entities.js's createBuilding already uses to decide
// which buildings get Producer/Storage wiring at all (§ Content-pack
// layering), so a building is a "production building" reachable here if
// and only if it actually behaves like one — no separate, driftable list
// of type names to keep in sync. Town/Station/Depot/Train Yard have no
// recipe and are excluded automatically; they stay hand-written in
// index.html since each needs its own extra UI (resource dropdown,
// facing, orientation) that isn't purely data-driven yet.
(function generateProductionButtons(){
  const container = document.getElementById('productionButtons');
  for(const [type, def] of Object.entries(BUILDING_DEFS)){
    if(!def.recipe) continue;
    const btn = document.createElement('button');
    btn.className = 'tool-btn';
    btn.dataset.tool = type;
    btn.innerHTML = toolButtonHtml(def.color, BUILDING_ICON[type] || 'icon-generic-building', `Build ${def.label}`, `$${def.buildCost}`);
    container.appendChild(btn);
  }
})();

// One tool button per VEHICLE_DEFS entry — every truck type follows the
// exact same cmdPurchaseVehicle(x,y,type) pattern (§ Content-pack
// layering), so unlike buildings there's no special-case exclusion here:
// all of VEHICLE_DEFS is generated.
(function generateVehicleButtons(){
  const container = document.getElementById('vehicleButtons');
  for(const [type, def] of Object.entries(VEHICLE_DEFS)){
    const btn = document.createElement('button');
    btn.className = 'tool-btn';
    btn.dataset.tool = type;
    btn.innerHTML = toolButtonHtml(def.color, VEHICLE_ICON[type] || 'icon-generic-vehicle', `Buy ${def.label}`, `$${def.purchaseCost}`);
    container.appendChild(btn);
  }
})();

(function injectEngineOptions(){
  const select = document.getElementById('engineSelect');
  for(const [type, def] of Object.entries(ENGINE_DEFS)){
    const opt = document.createElement('option');
    opt.value = type;
    opt.textContent = `Engine: ${def.label}`;
    select.appendChild(opt);
  }
})();
(function injectWagonOptions(){
  const select = document.getElementById('wagonSelect');
  for(const [type, def] of Object.entries(WAGON_DEFS)){
    const opt = document.createElement('option');
    opt.value = type;
    opt.textContent = `Wagon: ${RESOURCES[def.resource].name}`;
    select.appendChild(opt);
  }
})();

// townResourceSelect/stationResourceSelect/depotResourceSelect all list
// every RESOURCES entry the same way — generated once here rather than
// three times, since a content-pack addon's own new resource (e.g. Coal)
// needs to be selectable in all three or nothing could ever be built to
// produce/consume/buffer it end-to-end, even with a production building
// and a vehicle for it already reachable via the two generators above.
// `defaultResource`, if it names a real RESOURCES id, is preselected —
// preserving each select's original default (Town: Steel; Station/Depot:
// Ore) exactly, rather than always falling back to insertion order.
function injectResourceOptions(selectId, labelPrefix, defaultResource){
  const select = document.getElementById(selectId);
  for(const [id, def] of Object.entries(RESOURCES)){
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `${labelPrefix}: ${def.name}`;
    if(id===defaultResource) opt.selected = true;
    select.appendChild(opt);
  }
}
injectResourceOptions('townResourceSelect', 'Town accepts', 'steel');
injectResourceOptions('stationResourceSelect', 'Station handles', 'ore');
injectResourceOptions('depotResourceSelect', 'Depot handles', 'ore');

document.querySelectorAll('.tool-btn[data-tool]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.tool-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    currentTool = btn.dataset.tool;
    pickingStopFor = null;
    oneWayFirst = null;
    connectFirst = null;
    undergroundRampFirst = null;
    document.getElementById('hint').textContent = toolHint(currentTool);
  });
});
// Same def.recipe/VEHICLE_DEFS tests generateProductionButtons/
// generateVehicleButtons use above — a production building's hint is one
// formula (footprint + what the recipe turns into what), so Mine/Mill/an
// addon's own Colliery all get a correct hint with no per-type entry
// needed here, same as their button/click-handling.
function productionBuildingHint(type){
  const def = BUILDING_DEFS[type];
  const recipe = RECIPES[def.recipe];
  const outputNames = recipe.outputs.map(o=>RESOURCES[o.resource].name).join(' + ') || 'nothing';
  const inputDesc = recipe.inputs.length===0
    ? `Always produces ${outputNames}.`
    : `Turns ${recipe.inputs.map(i=>RESOURCES[i.resource].name).join(' + ')} into ${outputNames} — it needs a Station (or chain of Stations) handling each input and the output.`;
  return `Click the top-left cell for a ${def.label} (${def.footprint.w}x${def.footprint.h}). ${inputDesc} It doesn't need to touch a road itself — build a Station touching it for trucks to use.`;
}
function vehicleHint(type){
  const def = VEHICLE_DEFS[type];
  return `Click a ground road tile to buy a ${def.label} ($${def.purchaseCost}) there. Carries ${RESOURCES[def.resource].name} only.`;
}
function toolHint(t){
  if(BUILDING_DEFS[t] && BUILDING_DEFS[t].recipe) return productionBuildingHint(t);
  if(VEHICLE_DEFS[t]) return vehicleHint(t);
  return {
    select:'Click a building or truck to inspect it.',
    road:'Click or drag to build road on the selected layer ($10/tile, x2 elevated). Uncheck auto-connect to place tiles without joining them. On the ground layer, crosses rail track at a right angle only — it won\'t connect through track running the same direction.',
    ramp:'Click a cell that already has both a ground and an elevated road tile to link them ($40).',
    railramp:'Click a cell that already has both a rail and an elevated rail tile to link them ($40) — rail\'s own Ramp, entirely independent of the road one.',
    tunnelramp:(()=>{ const level = currentUndergroundLevel(); const upper = level===1 ? 'ground' : `underground level ${level-1}`; return `Click a ${upper} road tile, then click an adjacent underground level ${level} road tile ($${rampCostForUndergroundLevel(level)}) — a sloped link, not a same-cell one. Select the deeper of the two levels above to build a ramp further down the stack. Only works along a straight stretch: neither tile may have any other connection besides the straight-through continuation.`; })(),
    railtunnelramp:(()=>{ const level = currentUndergroundLevel(); const upper = level===1 ? 'ground' : `underground level ${level-1}`; return `Click a ${upper} rail tile, then click an adjacent underground level ${level} rail tile ($${rampCostForUndergroundLevel(level)}) — rail's own Tunnel Ramp, entirely independent of the road one. Same straight-through-only rule.`; })(),
    raiseterrain:`Click a cell to raise its terrain by one level ($${TERRAFORM_COST}). Requires the cell be clear of all track and buildings first.`,
    lowerterrain:`Click a cell to lower its terrain by one level ($${TERRAFORM_COST}). Requires the cell be clear of all track and buildings first.`,
    connect:'Click a road tile, then click an adjacent road tile on the same layer — connects them if not joined, disconnects them if they are.',
    oneway:'Click a road tile, then click an adjacent connected tile — traffic will only be allowed from the first to the second.',
    town:`Click the top-left cell for a Town (${BUILDING_DEFS.town.footprint.w}x${BUILDING_DEFS.town.footprint.h}). Accepts whichever resource is chosen in the dropdown. It doesn't need to touch a road itself — build a Station touching it for trucks to use.`,
    station:`Click a cell touching an industry or another Station (${BUILDING_DEFS.station.footprint.w}x${BUILDING_DEFS.station.footprint.h}). Choose which resource it handles — it will only ever connect to a road on its chosen facing side.`,
    demolish:'Click a road or track tile (on the selected layer, whichever of road or rail is actually there) or a building to remove it.',
    track:`Click or drag to build rail track on the selected layer ($${RAIL_DEFS.track.costPerTile}/tile, x2 elevated). Uncheck auto-connect to place tiles without joining them. Crosses the same-grade road layer at a right angle only — it won't connect through road running the same direction.`,
    trackconnect:'Click a track tile, then click an adjacent track tile on the same layer — connects them if not joined, disconnects them if they are.',
    signal:'Click a track tile, then click an adjacent connected tile on the same layer — trains will only be allowed to travel from the first to the second. A signal also marks a hard block boundary.',
    depot:(()=>{ const fp = effectiveFootprint('depot', BUILDING_DEFS.depot, currentDepotOrientation(), currentDepotLength()); return `Click the top-left cell for a Rail Depot (${fp.w}x${fp.h}). It must run alongside a straight, unbroken length of track on one of its long sides — no track there yet, and the build is rejected. Choose which resource it buffers and build a Station touching it for road access.`; })(),
    trainyard:`Click the top-left cell for a Train Yard (${BUILDING_DEFS.trainyard.footprint.w}x${BUILDING_DEFS.trainyard.footprint.h}). This is where trains get assembled — it doesn't move cargo itself. Any touching track tile gives it rail access.`,
    assembletrain:'Pick an engine, a wagon type, and a wagon count, then click a rail track tile touching a Train Yard to assemble and pay for the train there.',
  }[t] || '';
}

function currentTier(){ return document.getElementById('tierSelect').value; }
function currentLayer(){ return document.getElementById('layerSelect').value; }
// The same Ground/Elevated/Underground dropdown road tools already read,
// translated to rail's own layer names — one shared "Network" layer
// selector governs every track-laying tool (Road AND Track), rather than
// rail needing a second dropdown of its own. Underground levels go through
// undergroundRailLayerName (world.js) rather than a hardcoded name, so a
// new level added via UNDERGROUND_LEVELS needs no change here.
function currentRailLayer(){
  const layer = currentLayer();
  const level = undergroundLevelOfGrade(layer);
  if(level) return undergroundRailLayerName(level);
  return layer==='elevated' ? 'railElevated'
    : layer==='deepUnderground' ? 'railDeepUnderground'
    : layer==='airspace' ? 'railAirspace'
    : 'rail';
}
// Which Tunnel Ramp level the currently-selected layer implies (§
// Multi-level tunnels) — level 1 (ground<->underground) whenever the
// dropdown isn't actually on an underground level, so picking the Tunnel
// Ramp tool with "Ground layer" selected (the default) still behaves
// exactly like it always did before multi-level tunnels existed.
function currentUndergroundLevel(){
  return undergroundLevelOfGrade(currentLayer()) || 1;
}
function currentFacing(){ return document.getElementById('facingSelect').value; }
function currentAutoConnect(){ return document.getElementById('autoConnect').checked; }
function currentTownResource(){ return document.getElementById('townResourceSelect').value; }
function currentStationResource(){ return document.getElementById('stationResourceSelect').value; }
function currentDepotResource(){ return document.getElementById('depotResourceSelect').value; }
function currentDepotOrientation(){ return document.getElementById('depotOrientationSelect').value; }
function currentDepotLength(){ return parseInt(document.getElementById('depotLengthSelect').value, 10); }
function currentEngine(){ return document.getElementById('engineSelect').value; }
function currentWagon(){ return document.getElementById('wagonSelect').value; }
function currentWagonCount(){ return parseInt(document.getElementById('wagonCountSelect').value, 10); }


function cellFromEvent(evt){
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((evt.clientX-rect.left)/CELL);
  const y = Math.floor((evt.clientY-rect.top)/CELL);
  if(!inBounds(x,y)) return null;
  return {x,y};
}

let dragging = false;
canvas.addEventListener('mousedown', evt=>{
  const cell = cellFromEvent(evt); if(!cell) return;
  dragging = true;
  handleClick(cell);
});
canvas.addEventListener('mousemove', evt=>{
  hoverCell = cellFromEvent(evt);
  if(!dragging || !hoverCell) return;
  if(currentTool==='road') postCommand('cmdBuildRoad', [hoverCell.x, hoverCell.y, currentLayer(), currentAutoConnect()]);
  if(currentTool==='track') postCommand('cmdBuildTrack', [hoverCell.x, hoverCell.y, currentRailLayer(), currentAutoConnect()]);
});
window.addEventListener('mouseup', ()=>{ dragging=false; });

function buildingAt(x,y){
  const cell = getCell(x,y);
  return cell.buildingId ? world.entities.get(cell.buildingId) : null;
}
function vehicleAt(x,y){
  for(const id of queryEntities('Movement')){
    const v = world.entities.get(id);
    if(v.x===x && v.y===y) return v;
  }
  return null;
}

// Resolves what clicking `clickedBuilding` while adding a stop for `vehicle`
// with the player's chosen `action` ('load_full'|'unload_all') actually
// means — the single place that validates a stop, for both trucks (via a
// Station, walking its chain to whatever Storage-having building it's
// linked to) and trains (at a Rail Depot, which now does exactly the same
// chain walk a Station does — see findLinkedIndustry in tickTrainMovement's
// counterpart below — falling back to the Depot's own buffer only when
// nothing's linked). Returns {nodeId, resource} on success or {error} on
// failure. Resolving by the player's explicit chosen action (rather than
// inferring it from which resource the target's out/in slot happens to
// match) is what makes a Rail Depot addressable at all here — its own
// out and in slots share the same resource by design (§2.1), so there'd be
// no way to tell "pick up" from "drop off" apart from the player saying
// which one they meant.
function resolveStopTarget(vehicle, clickedBuilding, action){
  const actionNoun = action==='load_full' ? 'output' : 'input';
  if(isTrain(vehicle.id)){
    if(clickedBuilding.type !== 'depot'){
      return {error:'Trains load/unload at Rail Depots only.'};
    }
    if(clickedBuilding.outResource !== vehicle.cargoResource){
      return {error:`This train only carries ${RESOURCES[vehicle.cargoResource].name}, but Rail Depot #${clickedBuilding.id} handles ${RESOURCES[clickedBuilding.outResource].name}.`};
    }
    // A Depot forwards to whatever it (or its chain of touching Stations)
    // connects to, exactly like a Station forwards for a truck — unlike a
    // Station, an unlinked Depot isn't an error: it still has its own real
    // Storage to fall back on (§ Rail milestone), so the stop is valid
    // either way. If it IS linked, its own declared resource must still
    // match what the linked industry actually offers/accepts, same check
    // a Station's chain gets.
    const industry = findLinkedIndustry(clickedBuilding);
    if(industry){
      const resource = action==='load_full' ? industry.outResource : industry.inResource;
      if(resource !== clickedBuilding.outResource){
        return {error:`Rail Depot #${clickedBuilding.id} handles ${RESOURCES[clickedBuilding.outResource].name}, which doesn't match the linked industry's ${actionNoun}.`};
      }
    }
    return {nodeId: clickedBuilding.id, resource: clickedBuilding.outResource};
  }
  if(clickedBuilding.type !== 'station'){
    return {error:'Trucks load/unload at Stations, not at the industry itself.'};
  }
  if(clickedBuilding.resource !== vehicle.cargoResource){
    return {error:`This truck only carries ${RESOURCES[vehicle.cargoResource].name}, but Station #${clickedBuilding.id} handles ${RESOURCES[clickedBuilding.resource].name}.`};
  }
  const industry = findLinkedIndustry(clickedBuilding);
  if(!industry) return {error:`Station #${clickedBuilding.id} isn't connected to any industry yet.`};
  const resource = action==='load_full' ? industry.outResource : industry.inResource;
  if(resource !== clickedBuilding.resource){
    return {error:`Station #${clickedBuilding.id} handles ${RESOURCES[clickedBuilding.resource].name}, which doesn't match the linked industry's ${actionNoun}.`};
  }
  return {nodeId: clickedBuilding.id, resource};
}

function handleClick(cell){
  const {x,y} = cell;

  // Order-editor "pick a stop" mode takes priority over the active tool.
  if(pickingStopFor){
    const b = buildingAt(x,y);
    if(!b){
      logEvent('Click a building to add it as a stop.', 'warn');
    } else {
      const result = resolveStopTarget(pickingStopFor.vehicle, b, pickingStopFor.action);
      if(result.error){
        logEvent(result.error, 'warn');
      } else {
        const orders = pickingStopFor.vehicle.orders.slice();
        orders.push({nodeId:result.nodeId, action:pickingStopFor.action, resource:result.resource});
        postCommand('cmdSetOrders', [pickingStopFor.vehicle.id, orders]);
        renderOrderEditor(pickingStopFor.vehicle);
      }
    }
    pickingStopFor = null;
    document.getElementById('hint').textContent = toolHint(currentTool);
    return;
  }

  if(currentTool==='select'){
    const v = vehicleAt(x,y);
    const b = buildingAt(x,y);
    selected = v || b || null;
    renderSelection();
    return;
  }
  if(currentTool==='road'){ postCommand('cmdBuildRoad', [x,y,currentLayer(),currentAutoConnect()]); return; }
  if(currentTool==='ramp'){ postCommand('cmdBuildRamp', [x,y]); return; }
  if(currentTool==='railramp'){ postCommand('cmdBuildRailRamp', [x,y]); return; }
  if(currentTool==='raiseterrain'){ postCommand('cmdRaiseTerrain', [x,y]); return; }
  if(currentTool==='lowerterrain'){ postCommand('cmdLowerTerrain', [x,y]); return; }
  if(currentTool==='tunnelramp' || currentTool==='railtunnelramp'){ handleUndergroundRampClick(x,y); return; }
  if(currentTool==='connect'){ handleConnectClick(x,y); return; }
  if(currentTool==='oneway'){ handleOneWayClick(x,y); return; }
  if(BUILDING_DEFS[currentTool] && BUILDING_DEFS[currentTool].recipe){ postCommand('cmdBuildBuilding', [currentTool, x, y, currentTier()]); return; }
  if(currentTool==='town'){ postCommand('cmdBuildBuilding', ['town', x, y, currentTier(), null, currentTownResource()]); return; }
  if(currentTool==='station'){ postCommand('cmdBuildBuilding', ['station', x, y, 'small', currentFacing(), currentStationResource()]); return; }
  if(currentTool==='demolish'){
    // The selected Ground/Elevated layer picks which of that grade's ROAD
    // layer to try first; if there's nothing to remove there, fall back
    // to that same grade's RAIL layer (ground->rail, elevated->railElevated).
    const roadLayer = currentLayer();
    const railLayer = currentRailLayer();
    const layer = trackAt(x,y,roadLayer).track ? roadLayer : railLayer;
    postCommand('cmdDemolish', [x,y,layer]);
    return;
  }
  if(VEHICLE_DEFS[currentTool]){ postCommand('cmdPurchaseVehicle', [x,y,currentTool]); return; }
  if(currentTool==='track'){ postCommand('cmdBuildTrack', [x,y,currentRailLayer(),currentAutoConnect()]); return; }
  if(currentTool==='trackconnect'){ handleConnectClick(x,y); return; }
  if(currentTool==='signal'){ handleOneWayClick(x,y); return; }
  if(currentTool==='depot'){ postCommand('cmdBuildBuilding', ['depot', x, y, currentTier(), currentDepotOrientation(), currentDepotResource(), currentDepotLength()]); return; }
  if(currentTool==='trainyard'){ postCommand('cmdBuildBuilding', ['trainyard', x, y, 'small']); return; }
  if(currentTool==='assembletrain'){ postCommand('cmdAssembleTrain', [x, y, currentEngine(), currentWagon(), currentWagonCount()]); return; }
}

function handleConnectClick(x,y){
  // Doubles as rail's "Connect / Disconnect Track" (currentTool==='trackconnect')
  // — same command, same two-click interaction, just on whichever rail
  // layer the shared Ground/Elevated dropdown maps to (currentRailLayer())
  // rather than the road layer names currentLayer() itself returns,
  // mirroring handleOneWayClick's signal/oneway split below. Without this,
  // rail track built with auto-connect off (or that's had a connection
  // manually severed) had no way back to being joined again.
  const layer = currentTool==='trackconnect' ? currentRailLayer() : currentLayer();
  if(!trackAt(x,y,layer).track){
    logEvent(`No ${layer} track there.`, 'warn');
    connectFirst = null;
    document.getElementById('hint').textContent = toolHint(currentTool);
    return;
  }
  if(!connectFirst){
    connectFirst = {x,y};
    document.getElementById('hint').textContent = 'Now click an adjacent tile on the same network to connect or disconnect it.';
    return;
  }
  postCommand('cmdToggleConnection', [connectFirst.x, connectFirst.y, x, y, layer]);
  connectFirst = null;
  document.getElementById('hint').textContent = toolHint(currentTool);
}

function handleUndergroundRampClick(x,y){
  // Unlike Connect/OneWay, the two clicks aren't on the same layer — one is
  // the upper tile, the other its lower neighbor, in either order
  // (cmdBuildUndergroundRamp/cmdBuildRailUndergroundRamp auto-detect which
  // is which) — so there's no single "layer" to check for track against
  // here; the command itself validates grade/adjacency/straight-through
  // once both clicks are in. WHICH pair of grades (level 1 = ground<->
  // underground, level N>1 = one level deeper — § Multi-level tunnels) is
  // fixed by currentUndergroundLevel() at the moment the FIRST click
  // lands, so switching the layer dropdown mid-click can't retarget an
  // already-started ramp.
  const kind = currentTool==='railtunnelramp' ? 'rail' : 'road';
  if(!undergroundRampFirst){
    const level = currentUndergroundLevel();
    const upperGrade = level===1 ? 'ground' : undergroundGradeName(level-1);
    const lowerGrade = undergroundGradeName(level);
    if(!trackAt(x,y,GRADE_KIND_LAYER[upperGrade][kind]).track && !trackAt(x,y,GRADE_KIND_LAYER[lowerGrade][kind]).track){
      logEvent(`No ${upperGrade} or ${lowerGrade} ${kind} tile there.`, 'warn');
      document.getElementById('hint').textContent = toolHint(currentTool);
      return;
    }
    undergroundRampFirst = {x,y,level};
    document.getElementById('hint').textContent = `Now click the adjacent ${upperGrade} or ${lowerGrade} tile to link.`;
    return;
  }
  const cmd = currentTool==='railtunnelramp' ? 'cmdBuildRailUndergroundRamp' : 'cmdBuildUndergroundRamp';
  postCommand(cmd, [undergroundRampFirst.x, undergroundRampFirst.y, x, y, undergroundRampFirst.level]);
  undergroundRampFirst = null;
  document.getElementById('hint').textContent = toolHint(currentTool);
}

function handleOneWayClick(x,y){
  // Doubles as rail's "Toggle Signal Direction" (currentTool==='signal') —
  // same command, same two-click interaction, just on whichever rail layer
  // the shared Ground/Elevated dropdown maps to (currentRailLayer()).
  const layer = currentTool==='signal' ? currentRailLayer() : currentLayer();
  if(!trackAt(x,y,layer).track){
    logEvent(`No ${layer} track there.`, 'warn');
    oneWayFirst = null;
    document.getElementById('hint').textContent = toolHint(currentTool);
    return;
  }
  if(!oneWayFirst){
    oneWayFirst = {x,y};
    document.getElementById('hint').textContent = 'Now click the adjacent, connected tile traffic should be allowed to reach.';
    return;
  }
  postCommand('cmdToggleOneWay', [oneWayFirst.x, oneWayFirst.y, x, y, layer]);
  oneWayFirst = null;
  document.getElementById('hint').textContent = toolHint(currentTool);
}

function renderSelection(){
  const panel = document.getElementById('selectionInfo');
  if(!selected){ panel.innerHTML = 'Nothing selected. Click a building or a truck.'; return; }

  if(selected.kind==='building' && selected.type==='station'){
    const industry = findLinkedIndustry(selected);
    const dock = buildingRoadAccessCell(selected);
    panel.innerHTML = `
      <div><b>${BUILDING_DEFS.station.label} #${selected.id}</b></div>
      <div>Handles: ${RESOURCES[selected.resource].name}</div>
      <div>${industry
        ? `Linked to: ${BUILDING_DEFS[industry.type].label} #${industry.id}`
        : '<span style="color:var(--danger)">Not connected to any industry</span>'}</div>
      <div>Road-facing side: ${selected.facing}${dock ? '' : ' <span style="color:var(--danger)">(no road there)</span>'}</div>
    `;
    return;
  }

  if(selected.kind==='building' && selected.type==='depot'){
    // A Depot is simultaneously a node in two networks — show both links
    // rather than one, unlike a Station's single road-facing line. It also
    // now forwards to a linked industry exactly like a Station does (§
    // Rail Depot forwarding) — when linked, the stock shown is the linked
    // industry's own (whichever slot it actually has: a Mine only has
    // `out`, a Town only `in`), since that's the number trains actually
    // move now; the Depot's own buffer only matters, and is shown, when
    // nothing's linked.
    const roadStation = findTouchingStation(selected);
    const platform = depotPlatformCells(selected.x, selected.y, selected.footprint.w, selected.footprint.h);
    const industry = findLinkedIndustry(selected);
    const source = industry || selected;
    const stock = source.outStock!==undefined ? source.outStock : source.inStock;
    const cap = source.outStock!==undefined ? source.outCap : source.inCap;
    let html = `
      <div><b>${BUILDING_DEFS.depot.label} #${selected.id}</b></div>
      <div>Handles: ${RESOURCES[selected.outResource].name}</div>
      <div>${industry
        ? `Linked to: ${BUILDING_DEFS[industry.type].label} #${industry.id} — trains load/unload there directly`
        : 'Not linked to an industry — buffers its own stock (fill/drain via a Station touching it, or here directly by train)'}</div>
      <div>Road side: ${roadStation
        ? `Station #${roadStation.id}`
        : '<span style="color:var(--danger)">not connected</span>'}</div>
      <div>Platform: ${platform
        ? `${platform.length} tiles — a train docked alongside up to that many of its own cells loads/unloads that many times faster`
        : '<span style="color:var(--danger)">no parallel track — trains can\'t reach this Depot</span>'}</div>
      <div>${industry ? 'Linked stock' : 'Buffered'}: ${stock.toFixed(1)} / ${cap}</div>
      <div class="fill-bar"><div style="width:${(stock/cap*100).toFixed(0)}%"></div></div>
    `;
    panel.innerHTML = html;
    return;
  }

  if(selected.kind==='building' && selected.type==='trainyard'){
    const railDock = buildingRailAccessCell(selected);
    panel.innerHTML = `
      <div><b>${BUILDING_DEFS.trainyard.label} #${selected.id}</b></div>
      <div>Rail side: ${railDock
        ? 'connected'
        : '<span style="color:var(--danger)">not connected</span>'}</div>
      <div style="margin-top:6px;color:var(--text-dim);font-size:11px;">Pick an engine/wagon/count in the toolbar, then click a track tile touching this Yard with the Assemble Train tool.</div>
    `;
    return;
  }

  if(selected.kind==='building'){
    const def = BUILDING_DEFS[selected.type];
    const halted = producerHalted(selected);
    let html = `<div><b>${def.label} #${selected.id}</b></div>`;
    if(selected.outStock!==undefined){
      html += `
        <div>${RESOURCES[selected.outResource].name} (out): ${selected.outStock.toFixed(1)} / ${selected.outCap}</div>
        <div class="fill-bar"><div style="width:${(selected.outStock/selected.outCap*100).toFixed(0)}%"></div></div>
      `;
    }
    if(selected.inStock!==undefined){
      html += `
        <div>${RESOURCES[selected.inResource].name} (in): ${selected.inStock.toFixed(1)} / ${selected.inCap}</div>
        <div class="fill-bar"><div style="width:${(selected.inStock/selected.inCap*100).toFixed(0)}%"></div></div>
      `;
    }
    if(selected.producer){
      html += `<div>${halted ? '<span style="color:var(--danger)">Halted — missing input or output full</span>' : 'Producing…'}</div>`;
    }
    if(selected.consumer){
      html += `
        <div>Population: ${selected.population}</div>
        <div>Consuming: ${selected.consumptionPerTick.toFixed(2)}/tick</div>
        ${selected.inStock<=0 ? '<div style="color:var(--danger)">Out of stock — nothing to consume</div>' : ''}
        <div>Pays $${RESOURCES[selected.inResource].baseValue}/unit delivered</div>
      `;
    }
    html += `<div style="margin-top:6px;color:var(--text-dim);font-size:11px;">Trucks can't load/unload here directly — build a Station touching this building.</div>`;
    panel.innerHTML = html;
    return;
  }

  if(selected.kind==='vehicle'){
    const stats = getVehicleStats(selected);
    const isTrainVehicle = isTrain(selected.id);
    // A wagon's resource is fixed at assembly, exactly like a truck's —
    // cargoResource is never null here (§ Train Yard: this replaced the
    // earlier per-trip-resource design once wagons became resource-typed).
    const resourceName = RESOURCES[selected.cargoResource].name;
    const unitWeight = RESOURCES[selected.cargoResource].unitWeight;
    const mass = selected.massEmpty + selected.cargoAmount*unitWeight;
    let html = `
      <div><b>${stats.label} #${selected.id}</b></div>
      <div>Carries: ${resourceName} only</div>
      <div>Cargo: ${selected.cargoAmount.toFixed(1)} / ${selected.capacity}</div>
      <div>State: ${selected.state}${selected.state==='blocked' ? ' <span style="color:var(--danger)">(waiting)</span>' : ''}</div>
      <div>Speed: ${selected.speed.toFixed(2)} / ${selected.maxSpeed.toFixed(2)} tiles/tick</div>
      <div>Mass: ${mass.toFixed(1)} (empty ${selected.massEmpty.toFixed(1)} + cargo ${(selected.cargoAmount*unitWeight).toFixed(1)})</div>
      <div>Accel/Decel now: ${(selected.engineForce/mass).toFixed(2)} / ${(selected.brakeForce/mass).toFixed(2)} tiles/tick²</div>
      <div>Length: ${selected.length.toFixed(2)} tiles</div>
      <div class="section-label">Orders</div>
      <div id="ordersList"></div>
      <button class="btn" id="addLoadStopBtn">+ Add stop (Load)</button>
      <button class="btn" id="addUnloadStopBtn">+ Add stop (Unload)</button>
      <button class="btn secondary" id="sellBtn">Sell ($${Math.round(stats.purchaseCost*stats.sellFraction)} refund)</button>
    `;
    panel.innerHTML = html;
    const targetNoun = isTrainVehicle ? 'Rail Depot' : `Station handling ${resourceName}`;
    document.getElementById('addLoadStopBtn').addEventListener('click', ()=>{
      pickingStopFor = {vehicle:selected, action:'load_full'};
      document.getElementById('hint').textContent = `Click a ${targetNoun} to pick up from.`;
    });
    document.getElementById('addUnloadStopBtn').addEventListener('click', ()=>{
      pickingStopFor = {vehicle:selected, action:'unload_all'};
      document.getElementById('hint').textContent = `Click a ${targetNoun} to drop off at.`;
    });
    document.getElementById('sellBtn').addEventListener('click', ()=>{
      postCommand('cmdSellVehicle', [selected.id]);
      selected = null;
      renderSelection();
    });
    renderOrderEditor(selected);
  }
}

function renderOrderEditor(vehicle){
  const list = document.getElementById('ordersList');
  if(!list) return;
  list.innerHTML = '';
  vehicle.orders.forEach((o, i)=>{
    const b = world.entities.get(o.nodeId);
    const row = document.createElement('div');
    row.className = 'order-row';
    row.innerHTML = `<span class="idx">${i+1}</span><span>${b ? BUILDING_DEFS[b.type].label+' #'+b.id : '(removed)'}</span><span class="act">${o.action}</span><span class="rm">✕</span>`;
    row.querySelector('.rm').addEventListener('click', ()=>{
      const orders = vehicle.orders.slice();
      orders.splice(i,1);
      postCommand('cmdSetOrders', [vehicle.id, orders]);
      renderOrderEditor(vehicle);
    });
    list.appendChild(row);
  });
}

// keep the side panel numbers live even when nothing changed selection-wise
setInterval(()=>{ if(selected) renderSelection(); }, 500);

document.getElementById('townCost').textContent = '$' + BUILDING_DEFS.town.buildCost;
document.getElementById('stationCost').textContent = '$' + BUILDING_DEFS.station.buildCost;
document.getElementById('rampCost').textContent = '$' + RAMP_COST;
document.getElementById('railRampCost').textContent = '$' + RAMP_COST;
document.getElementById('raiseTerrainCost').textContent = '$' + TERRAFORM_COST;
document.getElementById('lowerTerrainCost').textContent = '$' + TERRAFORM_COST;
document.getElementById('depotCost').textContent = '$' + BUILDING_DEFS.depot.buildCost;
document.getElementById('trainyardCost').textContent = '$' + BUILDING_DEFS.trainyard.buildCost;
function costMultiplierFor(layer){
  const undergroundLevel = undergroundLevelOfGrade(layer);
  return layer==='elevated' ? ELEVATED_COST_MULTIPLIER
    : undergroundLevel ? costMultiplierForUndergroundLevel(undergroundLevel)
    : layer==='deepUnderground' ? DEEP_UNDERGROUND_COST_MULTIPLIER
    : layer==='airspace' ? AIRSPACE_COST_MULTIPLIER
    : 1;
}
function updateRoadCostLabel(){
  document.getElementById('roadCost').textContent =
    '$' + (ROAD_COST_PER_TILE * costMultiplierFor(currentLayer())) + '/tile';
}
function updateTrackCostLabel(){
  document.getElementById('trackCost').textContent =
    '$' + (RAIL_DEFS.track.costPerTile * costMultiplierFor(currentLayer())) + '/tile';
}
// The Tunnel Ramp cost depends on WHICH level is selected (§ Multi-level
// tunnels — deeper levels cost more per rampCostForUndergroundLevel in
// world.js), so unlike the other one-time-cost labels above, this one has
// to stay live on every layer change, the same way the per-tile labels do.
function updateTunnelRampCostLabel(){
  const cost = rampCostForUndergroundLevel(currentUndergroundLevel());
  document.getElementById('tunnelRampCost').textContent = '$' + cost;
  document.getElementById('railTunnelRampCost').textContent = '$' + cost;
}
document.getElementById('layerSelect').addEventListener('change', updateRoadCostLabel);
document.getElementById('layerSelect').addEventListener('change', updateTrackCostLabel);
document.getElementById('layerSelect').addEventListener('change', updateTunnelRampCostLabel);
updateRoadCostLabel();
updateTrackCostLabel();
updateTunnelRampCostLabel();

// Save/Load (§12) — Save just asks the Worker to serialize+download; Load
// reads the chosen file, does light shape validation (real corruption still
// gets caught by deserializeWorld/the Worker choking on it, but this catches
// "picked the wrong file" before it ever reaches there), clears `selected`
// since it may hold a handle to an entity the loaded world doesn't have, and
// hands the parsed data to the Worker to replace the whole world with.
document.getElementById('saveGameBtn').addEventListener('click', ()=>{
  postSave();
  logEvent('Save started — check your downloads.', null);
});
document.getElementById('loadGameBtn').addEventListener('click', ()=>{
  document.getElementById('loadFileInput').click();
});
document.getElementById('loadFileInput').addEventListener('change', evt=>{
  const file = evt.target.files[0];
  evt.target.value = '';
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    let data;
    try{
      data = JSON.parse(reader.result);
    } catch(e){
      logEvent('Load failed: not valid JSON.', 'warn');
      return;
    }
    if(!data || !Array.isArray(data.entityIds) || !data.components || !Array.isArray(data.grid)){
      logEvent('Load failed: not an infrasim save file.', 'warn');
      return;
    }
    if(data.contentPackVersion !== undefined && data.contentPackVersion !== null && CONTENT_PACK.version !== undefined && data.contentPackVersion !== CONTENT_PACK.version){
      logEvent(`Warning: save was made with content-pack version ${data.contentPackVersion}, current is ${CONTENT_PACK.version}. Loading anyway.`, 'warn');
    }
    selected = null;
    renderSelection();
    postLoad(data);
    logEvent('Game loaded.', null);
  };
  reader.readAsText(file);
});

requestAnimationFrame(frame);
