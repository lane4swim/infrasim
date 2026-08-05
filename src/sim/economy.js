// ---------------------------------------------------------------------
// EVENTS / LOG  (stand-in for the Event stream in §7/§16)
// ---------------------------------------------------------------------
// This runs inside the Worker (see src/worker/worker-client.js), which has
// no DOM — so logEvent can't write to #log directly the way it used to
// pre-Worker-split. It queues instead; each snapshot message ships
// pendingLogs to the main thread, which is the only place that still
// touches #log (see worker-client.js's onmessage handler), then clears it.
let pendingLogs = [];
function logEvent(msg, cls){
  pendingLogs.push({msg, cls});
}

// ---------------------------------------------------------------------
// ECONOMY  (§16 — EconomySystem: the only thing that touches Treasury)
// ---------------------------------------------------------------------
function canAfford(cost){ return world.treasury >= cost; }
function charge(cost, reason){
  world.treasury -= cost;
  logEvent(`-$${cost} ${reason}`, 'money');
}
function credit(amount, reason){
  world.treasury += amount;
  logEvent(`+$${amount} ${reason}`, 'money');
}
