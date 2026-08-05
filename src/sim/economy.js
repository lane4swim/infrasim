// ---------------------------------------------------------------------
// EVENTS / LOG  (stand-in for the Event stream in §7/§16)
// ---------------------------------------------------------------------
const logEl = document.getElementById('log');
function logEvent(msg, cls){
  const d = document.createElement('div');
  if(cls) d.className = cls;
  d.textContent = msg;
  logEl.appendChild(d);
  while(logEl.children.length > 40) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
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
