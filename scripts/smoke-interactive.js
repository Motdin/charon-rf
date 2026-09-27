import './_testdb.js';
/**
 * Smoke: interactive pending-edit flow (tap â†’ type value â†’ hot-save).
 * Usage: node scripts/smoke-interactive.js
 */
import { initDb } from '../src/db/connection.js';
import { strategyById, updateStrategyConfig } from '../src/db/settings.js';
import {
  setPendingEdit,
  getPendingEdit,
  hasPendingEdit,
  applyPendingEdit,
  clearPendingEdit,
  toggleBoolField,
  promptForPendingEdit,
  parseValue,
  STRATEGY_FIELDS,
} from '../src/telegram/menu.js';

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  âœ“ ${msg}`);
}

initDb();
const CHAT = '999';

console.log('â€” parseValue guards â€”');
assert(parseValue('tp_percent', '75').ok === true, 'tp_percent 75 ok');
assert(parseValue('tp_percent', 'abc').ok === false, 'reject non-numeric');
assert(parseValue('sl_percent', '10').ok === false, 'sl_percent max is 0, reject +10');
assert(parseValue('require_volume_spike', 'on').value === true, 'bool on â†’ true');
assert(parseValue('require_volume_spike', 'off').value === false, 'bool off â†’ false');
assert(parseValue('entry_mode', 'wait_for_dip').ok === true, 'enum ok');
assert(parseValue('entry_mode', 'yolo').ok === false, 'enum reject unknown');
assert(parseValue('nope_field', '1').ok === false, 'unknown field rejected');

console.log('â€” pending edit lifecycle â€”');
clearPendingEdit(CHAT);
assert(hasPendingEdit(CHAT) === false, 'no pending initially');

const state = setPendingEdit(CHAT, 'sniper', 'tp_percent');
assert(state != null, 'setPendingEdit returns state');
assert(state.current === 50, `current tp captured (${state.current})`);
assert(hasPendingEdit(CHAT) === true, 'hasPendingEdit true');
const prompt = promptForPendingEdit(state);
assert(prompt.includes('Take profit'), 'prompt shows label');

const applied = applyPendingEdit(CHAT, '80');
assert(applied.ok === true, 'applyPendingEdit ok');
assert(applied.value === 80, `value applied = ${applied.value}`);
assert(applied.previous === 50, `previous recorded = ${applied.previous}`);
assert(hasPendingEdit(CHAT) === false, 'pending cleared after apply');
assert(strategyById('sniper').tp_percent === 80, 'sniper tp_percent now 80');

// restore
const s = { ...strategyById('sniper') };
delete s.id;
delete s.name;
s.tp_percent = 50;
updateStrategyConfig('sniper', s);
assert(strategyById('sniper').tp_percent === 50, 'restored to 50');

console.log('â€” invalid value keeps pending â€”');
setPendingEdit(CHAT, 'sniper', 'tp_percent');
const bad = applyPendingEdit(CHAT, 'not-a-number');
assert(bad.ok === false, 'invalid value rejected');
assert(hasPendingEdit(CHAT) === true, 'pending kept so user can retry');
clearPendingEdit(CHAT);

console.log('â€” bool toggle instant â€”');
const before = strategyById('sniper').trailing_enabled;
const toggled = toggleBoolField('sniper', 'trailing_enabled');
assert(toggled.value === !before, `trailing_enabled toggled ${before} â†’ ${toggled.value}`);
toggleBoolField('sniper', 'trailing_enabled'); // restore

console.log('â€” expires after TTL â€”');
setPendingEdit(CHAT, 'sniper', 'max_open_positions');
// force expire
const st = getPendingEdit(CHAT);
st.expiresAt = Date.now() - 1;
assert(getPendingEdit(CHAT) === null, 'expired pending returns null');

console.log('\nINTERACTIVE EDIT SMOKE PASSED');
process.exit(0);
