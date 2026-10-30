'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/server.js'), 'utf8');
function extract(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  if (start < 0 || end < 0) throw new Error(`Missing server function: ${startText}`);
  return source.slice(start, end);
}
const financeHelpers = extract('async function adminFinanceList() {', 'async function resolveDepositFinancialAccount(deposit) {');
const depositFunctions = extract('async function createDepositRequest(decodedToken, body) {', 'async function reserveUniqueUsdtAmount(uid, intentId, baseCents, expiresAt) {');
const adminFunctions = extract('async function resolveDepositFinancialAccount(deposit) {', 'async function adminProcessWithdrawal(admin, body) {');
const root = {
  users: {
    'auth-old': { uid: 'auth-old', email: 'user@example.test', realBalance: 0, bonusBalance: 0 },
    'wallet-old': { uid: 'wallet-old', authUid: 'auth-old', email: 'user@example.test', realBalance: 8, bonusBalance: 1 }
  },
  system_settings: { referral: {} }, finance: { deposits: {}, withdrawals: {}, deposit_receipts: {} },
  transactions: {}, user_finance: {}, admin_notifications: {}, user_notifications: {},
  finance_audit: {}, referral_account_refresh: {}, auth_user_links: {}
};
let failNextRootUpdate = false;
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function getPath(path) { return !path ? root : path.split('/').reduce((value, key) => value == null ? undefined : value[key], root); }
function setPath(path, value) {
  const parts = path.split('/'); let node = root;
  for (const key of parts.slice(0, -1)) { if (!node[key] || typeof node[key] !== 'object') node[key] = {}; node = node[key]; }
  if (value === null) delete node[parts.at(-1)]; else node[parts.at(-1)] = clone(value);
}
const firebaseDb = { ref(path = '') {
  return {
    orderByChild() { return this; }, equalTo() { return this; }, limitToLast() { return this; },
    async once() { const value = getPath(path); return { val: () => clone(value) ?? null, exists: () => value !== undefined && value !== null }; },
    async transaction(updater) {
      const current = clone(getPath(path)); const next = updater(current);
      if (next === undefined) return { committed: false, snapshot: { val: () => current ?? null } };
      setPath(path, next); return { committed: true, snapshot: { val: () => clone(next) } };
    },
    async set(value) { setPath(path, value); },
    async update(updates) {
      if (!path && failNextRootUpdate) { failNextRootUpdate = false; throw Object.assign(new Error('simulated root update failure'), { code: 'SIMULATED_WRITE_FAILURE' }); }
      if (path) throw new Error('unexpected child update');
      for (const [key, value] of Object.entries(updates)) setPath(key, value);
    }
  };
} };
const context = {
  firebaseDb, Buffer, console, Date, Set, structuredClone,
  MANUAL_DEPOSITS_ENABLED: true,
  numberValue: value => Number.isFinite(Number(value)) ? Number(value) : 0,
  safeText: (value, maximum = 1000) => String(value ?? '').slice(0, maximum),
  isValidFirebaseKey: value => typeof value === 'string' && value.length > 0 && !/[.#$\[\]\/]/.test(value),
  userFrozen: () => false,
  readSystemControls: async () => ({ depositEnabled: true, maintenanceMode: false }),
  getPaymentMethod: async () => ({ id: 'manual', name: 'USDT TRC20', minDeposit: 5 }),
  requestKey: (prefix, uid, requestId) => `${prefix}_${uid}_${requestId}`,
  resolveWithdrawalFinancialAccount: async token => ({ authUid: token.uid, uid: 'wallet-old', profile: clone(root.users['wallet-old']), linked: true }),
  withdrawalMethodMetadata: () => ({ category: 'crypto', currency: 'USDT', network: 'TRC20', destinationLabel: 'محفظة', destinationAddress: '', destinationDetails: '' }),
  timestampOf: item => Number(item.createdAt || 0)
};
vm.createContext(context);
vm.runInContext(`${financeHelpers}\n${depositFunctions}\n${adminFunctions}\nglobalThis.createDepositRequest=createDepositRequest;globalThis.adminProcessDeposit=adminProcessDeposit;globalThis.adminFinanceList=adminFinanceList;globalThis.adminDepositReceipt=adminDepositReceipt;`, context);
(async () => {
  const token = { uid: 'auth-old', email: 'user@example.test', phone_number: '555' };
  const image = 'data:image/png;base64,AAAA';

  failNextRootUpdate = true;
  await assert.rejects(context.createDepositRequest(token, { amount: 20, methodId: 'manual', requestId: 'retry-create', receiptDataUrl: image }));
  const repairedCreate = await context.createDepositRequest(token, { amount: 20, methodId: 'manual', requestId: 'retry-create', receiptDataUrl: image });
  assert.equal(repairedCreate.duplicate, true);
  const repairedId = repairedCreate.request.id;
  assert.equal(root.finance.deposits[repairedId].status, 'pending');
  assert.equal(root.finance.deposits[repairedId].receiptDataUrl, undefined);
  assert.equal(root.finance.deposit_receipts[repairedId].dataUrl, image);
  assert.equal(root.user_finance['wallet-old'].deposits[repairedId].status, 'pending');
  assert.equal('receiptDataUrl' in root.user_finance['wallet-old'].deposits[repairedId], false);
  assert.equal(root.admin_notifications[`deposit_${repairedId}`].status, 'new');

  const created = await context.createDepositRequest(token, { amount: 50, methodId: 'manual', requestId: 'approve', receiptDataUrl: image });
  const approvedId = created.request.id;
  const approval = await context.adminProcessDeposit({ email: 'admin@example.test' }, { id: approvedId, action: 'approve', creditedAmount: 10 });
  assert.equal(approval.status, 'approved');
  assert.equal(approval.requestedAmount, 50);
  assert.equal(approval.creditedAmount, 10);
  assert.equal(root.users['wallet-old'].realBalance, 18);
  assert.equal(root.users['auth-old'].realBalance, 0);
  assert.equal(root.user_finance['auth-old'].deposits[approvedId].status, 'approved');
  assert.equal(root.user_finance['wallet-old'].deposits[approvedId].creditedAmount, 10);
  assert.equal(root.transactions['auth-old'][`deposit_request_${approvedId}`].status, 'approved');
  assert.equal(root.transactions['auth-old'][`deposit_request_${approvedId}`].amount, 50);
  assert.equal(root.transactions['auth-old'][`deposit_request_${approvedId}`].creditedAmount, 10);
  assert.equal(root.transactions['wallet-old'][`deposit_${approvedId}`].amount, 10);
  assert.equal(root.admin_notifications[`deposit_${approvedId}`].status, 'done');
  await context.adminProcessDeposit({ email: 'admin@example.test' }, { id: approvedId, action: 'approve', creditedAmount: 10 });
  assert.equal(root.users['wallet-old'].realBalance, 18, 'repeat approval must not credit twice');
  assert.equal(root.transactions['wallet-old'][`deposit_request_${approvedId}`].status, 'approved');

  const rejected = await context.createDepositRequest(token, { amount: 25, methodId: 'manual', requestId: 'reject' });
  const rejectedId = rejected.request.id;
  const rejection = await context.adminProcessDeposit({ email: 'admin@example.test' }, { id: rejectedId, action: 'reject', reason: 'الإيصال غير واضح' });
  assert.equal(rejection.status, 'rejected');
  assert.equal(root.finance.deposits[rejectedId].status, 'rejected');
  assert.equal(root.user_finance['auth-old'].deposits[rejectedId].status, 'rejected');
  assert.equal(root.transactions['auth-old'][`deposit_request_${rejectedId}`].status, 'rejected');
  assert.equal(root.transactions['wallet-old'][`deposit_request_${rejectedId}`].status, 'rejected');
  assert.equal(root.admin_notifications[`deposit_${rejectedId}`].status, 'done');
  assert.equal(root.users['wallet-old'].realBalance, 18, 'rejection must not change balance');

  root.finance.deposits.legacy = { id: 'legacy', uid: 'wallet-old', financialUid: 'wallet-old', authUid: 'auth-old', amount: 7, status: 'pending', createdAt: Date.now() - 1, receiptDataUrl: image };
  root.user_finance['wallet-old'].deposits.legacy = { receiptDataUrl: image };
  root.user_finance['auth-old'].deposits.legacy = { receiptDataUrl: image };
  const listed = await context.adminFinanceList();
  const listedApproved = listed.deposits.find(row => row.id === approvedId);
  assert.equal(listedApproved.hasReceipt, true);
  assert.equal('receiptDataUrl' in listedApproved, false);
  assert.equal(root.finance.deposits.legacy.receiptDataUrl, undefined);
  assert.equal(root.user_finance['wallet-old'].deposits.legacy.receiptDataUrl, undefined);
  assert.equal(root.user_finance['auth-old'].deposits.legacy.receiptDataUrl, undefined);
  assert.equal(root.finance.deposit_receipts.legacy.dataUrl, image);
  assert.ok(JSON.stringify(listed).length < 10000, 'finance list must not include encoded receipt bytes');
  const receipt = await context.adminDepositReceipt(approvedId);
  assert.equal(receipt.mimeType, 'image/png');
  assert.equal(receipt.image.length, 3);
  const migratedReceipt = await context.adminDepositReceipt('legacy');
  assert.equal(migratedReceipt.image.length, 3);
  console.log('DEPOSIT_FINANCE_V233_OK: retry repair, actual amount credit, terminal mirrors, cleared admin badge, lazy receipt, idempotent approval.');
})().catch(error => { console.error(error); process.exit(1); });