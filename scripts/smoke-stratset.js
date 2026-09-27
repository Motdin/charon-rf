import './_testdb.js';
/**
 * Smoke: Telegram strategy menu + /stratset hot-edit.
 * Usage: node scripts/smoke-stratset.js
 */
import { initDb } from '../src/db/connection.js';
import { strategyById, updateStrategyConfig, allStrategies, activeStrategy, setActiveStrategy } from '../src/db/settings.js';
import { STRATEGY_FIELDS, formatStrategyCard, formatFieldEditor } from '../src/telegram/menu.js';

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  âœ“ ${msg}`);
}

initDb();

console.log('â€” strategy fields schema â€”');
assert(Object.keys(STRATEGY_FIELDS).length >= 20, `${Object.keys(STRATEGY_FIELDS).length} editable fields`);

console.log('â€” format cards render â€”');
const card = formatStrategyCard(strategyById('sniper'));
assert(card.includes('sniper'), 'formatStrategyCard works');
const editor = formatFieldEditor('sniper', 'tp_percent');
assert(editor.includes('tp_percent'), 'formatFieldEditor works');

console.log('â€” hot-edit tp_percent via updateStrategyConfig â€”');
const before = strategyById('sniper');
const next = { ...before };
delete next.id;
delete next.name;
next.tp_percent = 75;
updateStrategyConfig('sniper', next);
const after = strategyById('sniper');
assert(after.tp_percent === 75, `tp_percent updated 50 â†’ ${after.tp_percent}`);
// cache is 5s â€” force by reading again after clear via another update
next.tp_percent = 50;
updateStrategyConfig('sniper', next);
// activeStrategy may still cache; strategyById always fresh
assert(strategyById('sniper').tp_percent === 50, 'tp_percent restored to 50');

console.log('â€” edit position_size_eth â€”');
const s2 = { ...strategyById('degen') };
delete s2.id;
delete s2.name;
s2.position_size_eth = 0.03;
updateStrategyConfig('degen', s2);
assert(strategyById('degen').position_size_eth === 0.03, 'degen size 0.02 â†’ 0.03');

console.log('â€” activate degen then back to sniper â€”');
setActiveStrategy('degen');
assert(activeStrategy().id === 'degen' || strategyById('degen').enabled === 1, 'degen enabled');
setActiveStrategy('sniper');

console.log('\nSTRATSET SMOKE PASSED');
process.exit(0);
