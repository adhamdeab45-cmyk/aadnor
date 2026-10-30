'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const start = source.indexOf('function referralOwn(source, key) {');
const end = source.indexOf('\nasync function adminReferralBundle()', start);
assert(start >= 0 && end > start, 'V227 referral source block not found');
const referralSource = source.slice(start, end);
const clone = (value) => JSON.parse(JSON.stringify(value));
const getAt = (root, p) => p ? p.split('/').filter(Boolean).reduce((cur, key) => cur && cur[key], root) : root;
const setAt = (root, p, value, merge = false) => {
  const parts = p.split('/').filter(Boolean);
  let cur = root;
  for (let i = 0; i < parts.length - 1; i += 1) cur = cur[parts[i]] = cur[parts[i]] || {};
  const key = parts[parts.length - 1];
  if (!parts.length) throw new Error('root set not supported');
  cur[key] = merge && cur[key] && typeof cur[key] === 'object' ? { ...cur[key], ...value } : clone(value);
};
const snapshot = (value) => ({ val: () => clone(value), exists: () => value !== undefined && value !== null });

function makeHarness({ incomplete = false } = {}) {
  let database = {
    system_settings: { referral: {
      enabled: true,
      newUserRewardType: 'bonus', newUserRewardAmount: 1,
      referrerRewardType: 'bonus', referrerRewardAmount: 1,
      dailyReferralLimit: 25
    } },
    users: {
      newFinancial: {
        uid: 'newFinancial', email: 'new@example.com', name: 'New', bonusBalance: 0, realBalance: 0,
        ...(incomplete ? { referredBy: 'ADNTEST', referredByUid: 'ownerFinancial' } : {})
      },
      newAuth: { uid: 'newAuth', email: 'new@example.com', name: 'New Auth Shell', bonusBalance: 0 },
      ownerFinancial: { uid: 'ownerFinancial', email: 'owner@example.com', name: 'Owner', bonusBalance: 4, realBalance: 0 },
      ownerAuth: { uid: 'ownerAuth', email: 'owner@example.com', name: 'Owner Auth Shell', bonusBalance: 0 }
    },
    auth_user_links: { newAuth: 'newFinancial', ownerAuth: 'ownerFinancial' },
    referral_codes: {
      ADNTEST: { code: 'ADNTEST', ownerUid: 'ownerFinancial', ownerAuthUid: 'ownerAuth', ownerEmail: 'owner@example.com', ownerName: 'Owner', active: true }
    }
  };

  const firebaseDb = {
    ref(p = '') {
      return {
        async once() { return snapshot(getAt(database, p)); },
        async update(value) {
          if (!p) {
            for (const [key, val] of Object.entries(value || {})) setAt(database, key, val, false);
          } else setAt(database, p, value, true);
        },
        async transaction(updater) {
          assert.strictEqual(p, '', 'Referral transaction must be on root');
          // Reproduce the Firebase provisional-null callback that broke V226.
          const next = updater(null);
          if (next === undefined) return { committed: false, snapshot: snapshot(database) };
          database = clone(next);
          return { committed: true, snapshot: snapshot(database) };
        }
      };
    }
  };

  const context = {
    console,
    Date,
    JSON,
    Math,
    Number,
    Object,
    String,
    crypto,
    firebaseDb,
    PUBLIC_SITE_URL: 'https://example.test/app.html',
    safeText: (v, max = 1000) => String(v == null ? '' : v).trim().slice(0, max),
    numberValue: (v) => Number.isFinite(Number(v)) ? Math.round(Number(v) * 100000000) / 100000000 : 0,
    isValidFirebaseKey: (v) => !!v && !/[.#$\[\]/]/.test(String(v)),
    requestKey: (...parts) => parts.join('_'),
    dayKey: () => '2026-07-20',
    maskEmail: (email) => String(email).replace(/^(.).+(@.+)$/, '$1***$2'),
    objectValues: (v) => Object.values(v || {}),
    resolveGameAccount: async () => ({
      uid: 'newFinancial', authUid: 'newAuth', linked: true,
      profile: clone(database.users.newFinancial)
    })
  };
  vm.createContext(context);
  vm.runInContext(referralSource, context, { filename: 'referral-v227-extracted.js' });
  return { context, db: () => database };
}

(async () => {
  const defaults = makeHarness().context;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(defaults.normalizeReferralReward({}, 'newUser'))), { type: 'bonus', amount: 1 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(defaults.normalizeReferralReward({}, 'referrer'))), { type: 'bonus', amount: 1 });
  assert.strictEqual(defaults.normalizeReferralReward({ referrerRewardAmount: 0 }, 'referrer').amount, 0, 'explicit zero must remain zero');

  const token = { uid: 'newAuth', email: 'new@example.com', name: 'New' };
  const fresh = makeHarness();
  const first = await fresh.context.applyReferralServer(token, { code: 'ADNTEST', publicId: '123456', requestId: 'first' });
  const freshDb = fresh.db();
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(first.repairedIncomplete, false);
  assert.strictEqual(freshDb.users.newFinancial.bonusBalance, 1, 'new user must receive 1 bonus');
  assert.strictEqual(freshDb.users.ownerFinancial.bonusBalance, 5, 'owner must receive 1 bonus');
  assert.strictEqual(freshDb.users.newAuth.bonusBalance, 0, 'auth shell must not duplicate financial reward');
  assert.strictEqual(freshDb.users.ownerAuth.bonusBalance, 0, 'owner auth shell must not duplicate financial reward');
  assert.strictEqual(freshDb.users.newAuth.referredBy, 'ADNTEST', 'auth shell must remember referral use');
  assert.strictEqual(freshDb.referral_account_refresh.newAuth.financialUid, 'newFinancial');
  assert.strictEqual(freshDb.referral_account_refresh.ownerAuth.financialUid, 'ownerFinancial');
  assert(freshDb.user_referrals.ownerAuth[first.referral.id], 'owner auth mirror must exist');
  assert(freshDb.user_referrals_received.newAuth[first.referral.id], 'new auth mirror must exist');
  assert.strictEqual(first.referral.newUserRewardText, '$1 بونص');
  assert.strictEqual(first.referral.referrerRewardText, '$1 بونص');

  const second = await fresh.context.applyReferralServer(token, { code: 'ADNTEST', publicId: '123456', requestId: 'retry' });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.duplicate, true, 'same user+code retry must be idempotent');
  assert.strictEqual(fresh.db().users.newFinancial.bonusBalance, 1, 'retry must not pay new user twice');
  assert.strictEqual(fresh.db().users.ownerFinancial.bonusBalance, 5, 'retry must not pay owner twice');

  const incomplete = makeHarness({ incomplete: true });
  const repaired = await incomplete.context.applyReferralServer(token, { code: 'ADNTEST', publicId: '123456' });
  assert.strictEqual(repaired.ok, true);
  assert.strictEqual(repaired.repairedIncomplete, true, 'legacy referredBy-without-reward state must be repaired');
  assert.strictEqual(incomplete.db().users.newFinancial.bonusBalance, 1);
  assert.strictEqual(incomplete.db().users.ownerFinancial.bonusBalance, 5);

  console.log('V227 referral tests passed: fresh referral, null fallback, legacy incomplete repair, 1+1 bonus, linked UIDs, live refresh markers, idempotent retry.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
