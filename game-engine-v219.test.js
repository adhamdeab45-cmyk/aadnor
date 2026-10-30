'use strict';

const assert = require('node:assert/strict');
const {
  settleRound,
  holdRound,
  accountTreasury,
  deterministicPick,
  rebalanceForTargetRtp
} = require('../src/game-engine-v219');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function parts(path) {
  return String(path || '').split('/').filter(Boolean);
}

function getAt(root, path) {
  let node = root;
  for (const key of parts(path)) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

function setAt(root, path, value) {
  const keys = parts(path);
  if (!keys.length) {
    Object.keys(root).forEach((key) => delete root[key]);
    if (value && typeof value === 'object') Object.assign(root, clone(value));
    return;
  }
  let node = root;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (!node[keys[i]] || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
    node = node[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (value === null || value === undefined) delete node[last];
  else node[last] = clone(value);
}

class Snapshot {
  constructor(value) { this.value = clone(value); }
  val() { return clone(this.value); }
  exists() { return this.value !== undefined && this.value !== null; }
}

class MockRef {
  constructor(db, path) { this.db = db; this.path = path; }
  child(childPath) { return new MockRef(this.db, [this.path, childPath].filter(Boolean).join('/')); }
  async once() { return new Snapshot(getAt(this.db.data, this.path)); }
  async set(value) { setAt(this.db.data, this.path, value); }
  async update(updates) {
    for (const [path, value] of Object.entries(updates || {})) {
      const full = this.path ? `${this.path}/${path}` : path;
      setAt(this.db.data, full, value);
    }
  }
  async transaction(callback) {
    const count = (this.db.txCounts[this.path] || 0) + 1;
    this.db.txCounts[this.path] = count;
    const failures = this.db.failures[this.path] || new Set();
    if (failures.has(count)) throw new Error(`MOCK_TRANSACTION_FAILURE:${this.path}:${count}`);
    const current = clone(getAt(this.db.data, this.path));
    const next = callback(current);
    if (next === undefined) return { committed: false, snapshot: new Snapshot(current) };
    setAt(this.db.data, this.path, next);
    return { committed: true, snapshot: new Snapshot(next) };
  }
}

class MockDb {
  constructor(data = {}) {
    this.data = clone(data);
    this.txCounts = {};
    this.failures = {};
  }
  ref(path = '') { return new MockRef(this, path); }
  fail(path, counts) { this.failures[path] = new Set(counts); }
}

function baseUser(overrides = {}) {
  return {
    realBalance: 100,
    bonusBalance: 0,
    freeSpins: 0,
    ...overrides
  };
}

function baseInput(db, overrides = {}) {
  return {
    db,
    uid: 'u1',
    requestId: 'req_12345678',
    operationId: 'op_12345678',
    gameId: 'golden_squirrel',
    gameName: 'السنجاب الذهبي',
    bet: 1,
    allowReal: true,
    allowBonus: false,
    outcomes: [
      { type: 'win', multiplier: 2, weight: 100, label: 'x2', segmentIndex: 1 }
    ],
    settings: { platformCutPercent: 5, defaultOpeningReserve: 5000 },
    randomSeed: 0,
    now: 1_700_000_000_000,
    ...overrides
  };
}

async function testPaidRoundAndIdempotency() {
  const db = new MockDb({ users: { u1: baseUser() } });
  const input = baseInput(db);
  const first = await settleRound(input);
  assert.equal(first.receipt.status, 'complete');
  assert.equal(first.receipt.payout, 2);
  assert.equal(db.data.users.u1.realBalance, 101);
  assert.equal(db.data.game_treasury.by_game.golden_squirrel.playerPool, 4998.95);
  assert.equal(db.data.game_treasury.by_game.golden_squirrel.platformProfit, 0.05);
  assert.equal(db.data.game_treasury.by_game.golden_squirrel.roundsCount, 1);
  const second = await settleRound(input);
  assert.equal(second.duplicate, true);
  assert.equal(db.data.users.u1.realBalance, 101);
  assert.equal(db.data.game_treasury.by_game.golden_squirrel.roundsCount, 1);
}

async function testInsufficientBalanceNoTreasuryChange() {
  const db = new MockDb({ users: { u1: baseUser({ realBalance: 0.25 }) } });
  await assert.rejects(settleRound(baseInput(db)), (error) => error.message === 'INSUFFICIENT_PLAYABLE_BALANCE');
  assert.equal(db.data.users.u1.realBalance, 0.25);
  assert.equal(getAt(db.data, 'game_treasury/by_game/golden_squirrel'), undefined);
}

async function testHighMultiplierFilteredButRoundRuns() {
  const db = new MockDb({ users: { u1: baseUser() } });
  const result = await settleRound(baseInput(db, {
    gameId: 'wheel',
    gameName: 'عجلة الحظ الملكية',
    operationId: 'wheel_op_1',
    requestId: 'wheel_req_1',
    outcomes: [
      { type: 'win', multiplier: 10000, weight: 100, label: '10000x', segmentIndex: 6 },
      { type: 'win', multiplier: 2, weight: 100, label: '2x', segmentIndex: 2 },
      { type: 'loss', multiplier: 0, weight: 1, label: '0x', segmentIndex: 0 }
    ],
    rebalanceTargetRtp: false,
    randomSeed: 0
  }));
  assert.equal(result.receipt.multiplier, 2);
  assert.equal(result.receipt.segmentIndex, 2);
  assert.equal(db.data.users.u1.realBalance, 101);
}

async function testExhaustedPoolStillAllowsSafeLoss() {
  const db = new MockDb({
    users: { u1: baseUser() },
    game_treasury: { by_game: { wheel: { gameId: 'wheel', playerPool: 0, roundsCount: 1, totalBetsReal: 1 } } }
  });
  const result = await settleRound(baseInput(db, {
    gameId: 'wheel', gameName: 'عجلة الحظ الملكية', operationId: 'wheel_op_2', requestId: 'wheel_req_2',
    outcomes: [{ type: 'win', multiplier: 20, weight: 100, label: '20x', segmentIndex: 1 }],
    randomSeed: 0
  }));
  assert.equal(result.receipt.payout, 0);
  assert.equal(db.data.users.u1.realBalance, 99);
  assert.equal(db.data.game_treasury.by_game.wheel.playerPool, 0.95);
}

async function testFreeSpin() {
  const db = new MockDb({ users: { u1: baseUser({ realBalance: 0, freeSpins: 1 }) } });
  const result = await settleRound(baseInput(db, {
    gameId: 'wheel', gameName: 'عجلة الحظ الملكية', operationId: 'wheel_op_3', requestId: 'wheel_req_3',
    allowFreeSpin: true, promoMaxMultiplier: 2,
    outcomes: [{ type: 'win', multiplier: 2, weight: 100, label: '2x', segmentIndex: 2 }],
    randomSeed: 0
  }));
  assert.equal(result.receipt.freeSpin, true);
  assert.equal(result.receipt.payout, 2);
  assert.equal(db.data.users.u1.realBalance, 2);
  assert.equal(db.data.users.u1.freeSpins, 0);
}

async function testTreasuryFailureRefundsUser() {
  const db = new MockDb({ users: { u1: baseUser() } });
  db.fail('game_treasury/by_game/golden_squirrel', [1, 2, 3]);
  await assert.rejects(settleRound(baseInput(db)), (error) => error.message === 'GAME_TREASURY_ACCOUNTING_FAILED');
  assert.equal(db.data.users.u1.realBalance, 100);
  const receipt = db.data.users.u1.serverReceipts.gameV219_golden_squirrel.req_12345678;
  assert.equal(receipt.status, 'refunded');
}

async function testFinalizeFailureRollsBackAndRefunds() {
  const db = new MockDb({ users: { u1: baseUser() } });
  db.fail('users/u1', [2, 3, 4]);
  await assert.rejects(settleRound(baseInput(db)), (error) => error.message === 'GAME_SETTLEMENT_FAILED');
  assert.equal(db.data.users.u1.realBalance, 100);
  assert.equal(db.data.game_treasury.by_game.golden_squirrel.roundsCount, 0);
  assert.equal(db.data.game_treasury.by_game.golden_squirrel.playerPool, 5000);
  const receipt = db.data.users.u1.serverReceipts.gameV219_golden_squirrel.req_12345678;
  assert.equal(receipt.status, 'refunded');
}

async function testRealBonusSplit() {
  const db = new MockDb({ users: { u1: baseUser({ realBalance: 0.4, bonusBalance: 2 }) } });
  const result = await settleRound(baseInput(db, {
    allowBonus: true,
    outcomes: [{ type: 'loss', multiplier: 0, weight: 100, label: '0x' }]
  }));
  assert.equal(result.receipt.paidFromReal, 0.4);
  assert.equal(result.receipt.paidFromBonus, 0.6);
  assert.equal(db.data.users.u1.realBalance, 0);
  assert.equal(db.data.users.u1.bonusBalance, 1.4);
}



async function testTransientTreasuryFailureRetriesSuccessfully() {
  const db = new MockDb({ users: { u1: baseUser() } });
  db.fail('game_treasury/by_game/golden_squirrel', [1, 2]);
  const result = await settleRound(baseInput(db, {
    requestId: 'retry_treasury_req_1',
    operationId: 'retry_treasury_op_1'
  }));
  assert.equal(result.receipt.status, 'complete');
  assert.equal(db.txCounts['game_treasury/by_game/golden_squirrel'], 3);
  assert.equal(db.data.users.u1.realBalance, 101);
}

async function testTransientUserHoldFailureRetriesSuccessfully() {
  const db = new MockDb({ users: { u1: baseUser() } });
  db.fail('users/u1', [1]);
  const result = await settleRound(baseInput(db, {
    requestId: 'retry_hold_req_1',
    operationId: 'retry_hold_op_1'
  }));
  assert.equal(result.receipt.status, 'complete');
  assert.equal(db.data.users.u1.realBalance, 101);
}

async function testRecoveryAfterTreasuryAccountingBeforeFinalize() {
  const db = new MockDb({ users: { u1: baseUser() } });
  const input = baseInput(db, {
    operationId: 'recover_op_1',
    requestId: 'recover_req_1',
    randomSeed: 0
  });
  const held = await holdRound(db, {
    uid: input.uid,
    requestId: input.requestId,
    operationId: input.operationId,
    gameId: input.gameId,
    gameName: input.gameName,
    bet: input.bet,
    allowReal: true,
    allowBonus: false,
    allowFreeSpin: false,
    randomSeed: input.randomSeed,
    now: input.now
  });
  await accountTreasury(db, {
    uid: input.uid,
    requestId: input.requestId,
    operationId: input.operationId,
    gameId: input.gameId,
    gameName: input.gameName,
    bet: input.bet,
    paidFromReal: held.paidFromReal,
    paidFromBonus: held.paidFromBonus,
    promoRound: false,
    randomSeed: input.randomSeed,
    outcomes: input.outcomes,
    promoMaxMultiplier: 0,
    rebalanceTargetRtp: false,
    settings: input.settings,
    now: input.now
  });
  assert.equal(db.data.users.u1.realBalance, 99);
  assert.equal(db.data.game_treasury.by_game.golden_squirrel.roundsCount, 1);
  const recovered = await settleRound(input);
  assert.equal(recovered.receipt.status, 'complete');
  assert.equal(recovered.receipt.payout, 2);
  assert.equal(db.data.users.u1.realBalance, 101);
  assert.equal(db.data.game_treasury.by_game.golden_squirrel.roundsCount, 1);
}

async function testRequestIdCannotChangeBet() {
  const db = new MockDb({ users: { u1: baseUser() } });
  const first = baseInput(db, { operationId: 'reuse_op_1', requestId: 'reuse_req_1' });
  await settleRound(first);
  await assert.rejects(
    settleRound({ ...first, bet: 2 }),
    (error) => error.message === 'REQUEST_ID_REUSED'
  );
  assert.equal(db.data.users.u1.realBalance, 101);
  assert.equal(db.data.game_treasury.by_game.golden_squirrel.roundsCount, 1);
}

async function testStressNeverMakesPoolNegative() {
  const db = new MockDb({ users: { u1: baseUser({ realBalance: 100000 }) } });
  const outcomes = [
    { type: 'loss', multiplier: 0, weight: 25, label: '0x', segmentIndex: 0 },
    { type: 'win', multiplier: 1, weight: 30, label: '1x', segmentIndex: 1 },
    { type: 'win', multiplier: 2, weight: 20, label: '2x', segmentIndex: 2 },
    { type: 'win', multiplier: 10, weight: 10, label: '10x', segmentIndex: 3 },
    { type: 'win', multiplier: 10000, weight: 15, label: '10000x', segmentIndex: 4 }
  ];
  for (let i = 0; i < 750; i += 1) {
    const result = await settleRound(baseInput(db, {
      gameId: 'wheel',
      gameName: 'عجلة الحظ الملكية',
      requestId: `stress_req_${String(i).padStart(5, '0')}`,
      operationId: `stress_op_${String(i).padStart(5, '0')}`,
      outcomes,
      randomSeed: i * 7919,
      rebalanceTargetRtp: true
    }));
    assert.equal(result.receipt.status, 'complete');
    assert.ok(db.data.game_treasury.by_game.wheel.playerPool >= 0);
    assert.ok(result.receipt.payout <= result.receipt.playerPoolAfter + result.receipt.payout);
  }
  assert.equal(db.data.game_treasury.by_game.wheel.roundsCount, 750);
  assert.ok(db.data.users.u1.realBalance >= 0);
}

function testDeterministicSelectionAndRtp() {
  const outcomes = rebalanceForTargetRtp([
    { type: 'loss', multiplier: 0, weight: 30, label: '0x' },
    { type: 'win', multiplier: 1, weight: 20, label: '1x' },
    { type: 'win', multiplier: 2, weight: 10, label: '2x' }
  ], 0.95);
  assert.deepEqual(deterministicPick(outcomes, 12345), deterministicPick(outcomes, 12345));
  assert.ok(outcomes.every((outcome) => Number.isFinite(outcome.weight) && outcome.weight > 0));
}

(async () => {
  await testPaidRoundAndIdempotency();
  await testInsufficientBalanceNoTreasuryChange();
  await testHighMultiplierFilteredButRoundRuns();
  await testExhaustedPoolStillAllowsSafeLoss();
  await testFreeSpin();
  await testTreasuryFailureRefundsUser();
  await testFinalizeFailureRollsBackAndRefunds();
  await testRealBonusSplit();
  await testTransientTreasuryFailureRetriesSuccessfully();
  await testTransientUserHoldFailureRetriesSuccessfully();
  await testRecoveryAfterTreasuryAccountingBeforeFinalize();
  await testRequestIdCannotChangeBet();
  await testStressNeverMakesPoolNegative();
  testDeterministicSelectionAndRtp();
  console.log('GAME_ENGINE_V219_ALL_TESTS_OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
