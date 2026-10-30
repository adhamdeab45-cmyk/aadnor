'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/server.js'), 'utf8');
function extract(startText, endText) {
  const start = source.indexOf(startText); const end = source.indexOf(endText, start);
  if (start < 0 || end < 0) throw new Error(`Missing draw function: ${startText}`);
  return source.slice(start, end);
}
const candidates = extract('function collectLegacyScheduledCandidates(type, roots) {', 'let legacyDrawMigrationPromise = null;');
const migration = extract('let legacyDrawMigrationPromise = null;', 'async function adminSaveLotteryResult(admin, body) {');
const reads = new Map(); const updates = {};
const values = {
  'lottery_settings/v91_last_results/scheduled': { daily: { id: 'old_daily', status: 'scheduled', drawType: 'daily', ticketNumber: '1234567', publishAt: Date.now() + 3600000, winnerUid: 'u1' } },
  'lottery_settings/v91_last_results/current': { daily: { status: 'scheduled' } },
  'lottery_settings/last_results/current': {},
  'system_settings/latest_draw_results/current': {},
  'system_settings/v108_official_draw_results/scheduled': {},
  'system_settings/v108_official_draw_results/upcoming': {},
  'system_settings/v108_official_draw_results/current': {},
  'admin_draw_schedule': {}
};
const firebaseDb = { ref(path = '') { return {
  async once() { reads.set(path, (reads.get(path) || 0) + 1); const value = values[path]; return { val: () => value ?? null }; },
  async update(value) { Object.assign(updates, value); }
}; } };
const context = {
  firebaseDb,
  PRIVATE_DRAW_SCHEDULE_PATH: 'admin_draw_schedule',
  PUBLIC_OFFICIAL_RESULTS_PATH: 'system_settings/v108_official_draw_results',
  normalizeDrawType: value => value,
  normalizePublishAt: (value, fallback = Date.now()) => Number(value || fallback),
  safeText: (value, maximum = 220) => String(value ?? '').slice(0, maximum),
  requestKey: (...parts) => parts.join('_'),
  resolveDrawWinner: async item => ({ ...item, winnerUid: 'u1', ticketNumber: String(item.ticketNumber) }),
  console, Date, Object, String
};
vm.createContext(context);
vm.runInContext(`${candidates}\n${migration}\nglobalThis.migrate=migrateLegacyScheduledDrawResults;`, context);
(async () => {
  await context.migrate();
  assert.equal(reads.size, 8);
  assert.equal([...reads.keys()].some(key => key.includes('/history')), false, 'migration must not read full legacy result history');
  assert.equal(updates['admin_draw_schedule/daily'].status, 'scheduled');
  assert.equal(updates['lottery_settings/v91_last_results/scheduled/daily'], null);
  const readsAfterFirstRun = [...reads.values()].reduce((sum, count) => sum + count, 0);
  await context.migrate();
  const readsAfterSecondRun = [...reads.values()].reduce((sum, count) => sum + count, 0);
  assert.equal(readsAfterSecondRun, readsAfterFirstRun, 'successful migration runs once per server process');
  console.log('DRAW_MIGRATION_V233_OK: migrates scheduled legacy results without history scans or repeated reads.');
})().catch(error => { console.error(error); process.exit(1); });