// ---------------------------------------------------------------------
// UI WIRING (tools, selection, order editor)
// ---------------------------------------------------------------------
let currentTool = 'select';
let selected = null;       // selected building or vehicle
let pickingStopFor = null; // {vehicle, action} awaiting a click on a building to add that stop
let oneWayFirst = null;    // first tile picked for the One-Way tool, awaiting a second click
let connectFirst = null;   // first tile picked for the Connect/Disconnect tool, awaiting a second click
let hoverCell = null;

document.querySelectorAll('.tool-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.tool-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    currentTool = btn.dataset.tool;
    pickingStopFor = null;
    oneWayFirst = null;
    connectFirst = null;
    document.getElementById('hint').textContent = toolHint(currentTool);
  });
});
function toolHint(t){
  return {
    select:'Click a building or truck to inspect it.',
    road:'Click or drag to build road on the selected layer ($10/tile, x2 elevated). Uncheck auto-connect to place tiles without joining them.',
    ramp:'Click a cell that already has both a ground and an elevated road tile to link them ($40).',
    connect:'Click a road tile, then click an adjacent road tile on the same layer — connects them if not joined, disconnects them if they are.',
    oneway:'Click a road tile, then click an adjacent connected tile — traffic will only be allowed from the first to the second.',
    mine:`Click the top-left cell for a Mine (${BUILDING_DEFS.mine.footprint.w}x${BUILDING_DEFS.mine.footprint.h}). Always produces Ore. It doesn't need to touch a road itself — build a Station touching it for trucks to use.`,
    mill:`Click the top-left cell for a Steel Mill (${BUILDING_DEFS.mill.footprint.w}x${BUILDING_DEFS.mill.footprint.h}). Turns Ore into Steel — it needs one Station handling Ore (delivery) and one handling Steel (pickup), both touching it.`,
    town:`Click the top-left cell for a Town (${BUILDING_DEFS.town.footprint.w}x${BUILDING_DEFS.town.footprint.h}). Accepts whichever resource is chosen in the dropdown. It doesn't need to touch a road itself — build a Station touching it for trucks to use.`,
    station:`Click a cell touching a Mine, Mill, Town, or another Station (${BUILDING_DEFS.station.footprint.w}x${BUILDING_DEFS.station.footprint.h}). Choose which resource it handles — it will only ever connect to a road on its chosen facing side.`,
    demolish:'Click a road or track tile (on the selected layer — rail is checked automatically) or a building to remove it.',
    bulktruck:'Click a ground road tile to buy a Bulk Truck ($200) there. Carries Ore only.',
    flatbedtruck:'Click a ground road tile to buy a Flatbed Truck ($260) there. Carries Steel only.',
    track:`Click or drag to build rail track ($${RAIL_DEFS.track.costPerTile}/tile). Uncheck auto-connect to place tiles without joining them.`,
    signal:'Click a track tile, then click an adjacent connected tile — trains will only be allowed to travel from the first to the second. A signal also marks a hard block boundary.',
    depot:`Click the top-left cell for a Rail Depot (${BUILDING_DEFS.depot.footprint.w}x${BUILDING_DEFS.depot.footprint.h}). Choose which resource it buffers. Build a Station touching it for road access; any touching track tile gives it rail access.`,
    trainyard:`Click the top-left cell for a Train Yard (${BUILDING_DEFS.trainyard.footprint.w}x${BUILDING_DEFS.trainyard.footprint.h}). This is where trains get assembled — it doesn't move cargo itself. Any touching track tile gives it rail access.`,
    assembletrain:'Pick an engine, a wagon type, and a wagon count, then click a rail track tile touching a Train Yard to assemble and pay for the train there.',
  }[t] || '';
}

function currentTier(){ return document.getElementById('tierSelect').value; }
function currentLayer(){ return document.getElementById('layerSelect').value; }
function currentFacing(){ return document.getElementById('facingSelect').value; }
function currentAutoConnect(){ return document.getElementById('autoConnect').checked; }
function currentTownResource(){ return document.getElementById('townResourceSelect').value; }
function currentStationResource(){ return document.getElementById('stationResourceSelect').value; }
function currentDepotResource(){ return document.getElementById('depotResourceSelect').value; }
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
  if(currentTool==='track') postCommand('cmdBuildTrack', [hoverCell.x, hoverCell.y, currentAutoConnect()]);
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
  if(currentTool==='connect'){ handleConnectClick(x,y); return; }
  if(currentTool==='oneway'){ handleOneWayClick(x,y); return; }
  if(currentTool==='mine'){ postCommand('cmdBuildBuilding', ['mine', x, y, currentTier()]); return; }
  if(currentTool==='mill'){ postCommand('cmdBuildBuilding', ['mill', x, y, currentTier()]); return; }
  if(currentTool==='town'){ postCommand('cmdBuildBuilding', ['town', x, y, currentTier(), null, currentTownResource()]); return; }
  if(currentTool==='station'){ postCommand('cmdBuildBuilding', ['station', x, y, 'small', currentFacing(), currentStationResource()]); return; }
  if(currentTool==='demolish'){
    // Rail isn't reachable through the ground/elevated layer dropdown, so
    // fall back to it automatically when the selected layer has nothing
    // to remove at this cell but rail track does.
    const layer = getCell(x,y).layers[currentLayer()].track ? currentLayer() : 'rail';
    postCommand('cmdDemolish', [x,y,layer]);
    return;
  }
  if(currentTool==='bulktruck'){ postCommand('cmdPurchaseVehicle', [x,y,'bulk']); return; }
  if(currentTool==='flatbedtruck'){ postCommand('cmdPurchaseVehicle', [x,y,'flatbed']); return; }
  if(currentTool==='track'){ postCommand('cmdBuildTrack', [x,y,currentAutoConnect()]); return; }
  if(currentTool==='signal'){ handleOneWayClick(x,y); return; }
  if(currentTool==='depot'){ postCommand('cmdBuildBuilding', ['depot', x, y, currentTier(), null, currentDepotResource()]); return; }
  if(currentTool==='trainyard'){ postCommand('cmdBuildBuilding', ['trainyard', x, y, 'small']); return; }
  if(currentTool==='assembletrain'){ postCommand('cmdAssembleTrain', [x, y, currentEngine(), currentWagon(), currentWagonCount()]); return; }
}

function handleConnectClick(x,y){
  const layer = currentLayer();
  if(!getCell(x,y).layers[layer].track){
    logEvent(`No ${layer} road tile there.`, 'warn');
    connectFirst = null;
    document.getElementById('hint').textContent = toolHint('connect');
    return;
  }
  if(!connectFirst){
    connectFirst = {x,y};
    document.getElementById('hint').textContent = 'Now click an adjacent road tile to connect or disconnect it.';
    return;
  }
  postCommand('cmdToggleConnection', [connectFirst.x, connectFirst.y, x, y, layer]);
  connectFirst = null;
  document.getElementById('hint').textContent = toolHint('connect');
}

function handleOneWayClick(x,y){
  // Doubles as rail's "Toggle Signal Direction" (currentTool==='signal') —
  // same command, same two-click interaction, just always on the rail
  // layer rather than whichever ground/elevated layer is currently selected.
  const layer = currentTool==='signal' ? 'rail' : currentLayer();
  if(!getCell(x,y).layers[layer].track){
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
    const railDock = buildingRailAccessCell(selected);
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
      <div>Rail side: ${railDock
        ? 'connected'
        : '<span style="color:var(--danger)">not connected</span>'}</div>
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

document.getElementById('mineCost').textContent = '$' + BUILDING_DEFS.mine.buildCost;
document.getElementById('millCost').textContent = '$' + BUILDING_DEFS.mill.buildCost;
document.getElementById('townCost').textContent = '$' + BUILDING_DEFS.town.buildCost;
document.getElementById('stationCost').textContent = '$' + BUILDING_DEFS.station.buildCost;
document.getElementById('rampCost').textContent = '$' + RAMP_COST;
document.getElementById('trackCost').textContent = '$' + RAIL_DEFS.track.costPerTile + '/tile';
document.getElementById('depotCost').textContent = '$' + BUILDING_DEFS.depot.buildCost;
document.getElementById('trainyardCost').textContent = '$' + BUILDING_DEFS.trainyard.buildCost;
function updateRoadCostLabel(){
  const elevated = currentLayer()==='elevated';
  document.getElementById('roadCost').textContent =
    '$' + (ROAD_COST_PER_TILE * (elevated ? ELEVATED_COST_MULTIPLIER : 1)) + '/tile';
}
document.getElementById('layerSelect').addEventListener('change', updateRoadCostLabel);
updateRoadCostLabel();

requestAnimationFrame(frame);
