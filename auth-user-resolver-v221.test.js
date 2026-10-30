'use strict';

const assert = require('node:assert/strict');
const {
  resolveAuthenticatedUser,
  clearResolverCache
} = require('../src/auth-user-resolver-v221');
const { settleRound } = require('../src/game-engine-v219');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function parts(path) { return String(path || '').split('/').filter(Boolean); }
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
    for (const key of Object.keys(root)) delete root[key];
    if (value && typeof value === 'object') Object.assign(root, clone(value));
    return;
  }
  let node = root;
  for (let index = 0; index < keys.length - 1; index += 1) {
    if (!node[keys[index]] || typeof node[keys[index]] !== 'object') node[keys[index]] = {};
    node = node[keys[index]];
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
  constructor(db, path, query = {}) { this.db = db; this.path = path; this.query = query; }
  orderByChild(field) { return new MockRef(this.db, this.path, { ...this.query, field }); }
  equalTo(value) { return new MockRef(this.db, this.path, { ...this.query, equal: value }); }
  limitToFirst(limit) { return new MockRef(this.db, this.path, { ...this.query, limit }); }
  async once() {
    let value = getAt(this.db.data, this.path);
    if (this.query.field && value && typeof value === 'object') {
      const output = {};
      for (const [key, item] of Object.entries(value)) {
        if (item && typeof item === 'object' && item[this.query.field] === this.query.equal) {
          output[key] = item;
          if (Object.keys(output).length >= Number(this.query.limit || Infinity)) break;
        }
      }
      value = output;
    }
    return new Snapshot(value);
  }
  async update(updates) {
    for (const [path, value] of Object.entries(updates || {})) {
      setAt(this.db.data, this.path ? `${this.path}/${path}` : path, value);
    }
  }
  async transaction(callback) {
    const current = clone(getAt(this.db.data, this.path));
    const next = callback(current);
    if (next === undefined) return { committed: false, snapshot: new Snapshot(current) };
    setAt(this.db.data, this.path, next);
    return { committed: true, snapshot: new Snapshot(next) };
  }
}

class MockDb {
  constructor(data = {}) { this.data = clone(data); }
  ref(path = '') { return new MockRef(this, path); }
}

async function testDirectUser() {
  clearResolverCache();
  const db = new MockDb({ users: { auth1: { email: 'a@test.com', realBalance: 10 } } });
  const result = await resolveAuthenticatedUser(db, { uid: 'auth1', email: 'a@test.com' });
  assert.equal(result.uid, 'auth1');
  assert.equal(result.profile.realBalance, 10);
}

async function testLegacyUserResolvedByEmailAndLinked() {
  clearResolverCache();
  const db = new MockDb({
    users: {
      old_financial_uid: {
        uid: 'old_financial_uid',
        email: 'adhamdeab45@gmail.com',
        realBalance: 299886.11,
        bonusBalance: 0,
        publicId: '100321',
        lastActivityAt: 100
      }
    }
  });
  const result = await resolveAuthenticatedUser(db, {
    uid: 'new_firebase_auth_uid',
    email: 'adhamdeab45@gmail.com'
  });
  assert.equal(result.uid, 'old_financial_uid');
  assert.equal(result.profile.realBalance, 299886.11);
  assert.equal(db.data.auth_user_links.new_firebase_auth_uid.uid, 'old_financial_uid');
  assert.equal(db.data.users.old_financial_uid.firebaseAuthUid, 'new_firebase_auth_uid');
  assert.equal(db.data.users.new_firebase_auth_uid.financialAccountUid, 'old_financial_uid');
  assert.equal(db.data.users.new_firebase_auth_uid.realBalance, undefined);
}

async function testSavedLinkWinsWithoutEmailQuery() {
  clearResolverCache();
  const db = new MockDb({
    users: { financial1: { realBalance: 77 } },
    auth_user_links: { auth2: { uid: 'financial1' } }
  });
  const result = await resolveAuthenticatedUser(db, { uid: 'auth2' });
  assert.equal(result.uid, 'financial1');
  assert.equal(result.profile.realBalance, 77);
}

async function testPhoneResolution() {
  clearResolverCache();
  const db = new MockDb({ users: { phone_user: { phoneNumber: '+905551112233', realBalance: 12 } } });
  const result = await resolveAuthenticatedUser(db, { uid: 'phone_auth', phone_number: '+905551112233' });
  assert.equal(result.uid, 'phone_user');
}

async function testFundedDuplicatePreferredOverEmptyDuplicate() {
  clearResolverCache();
  const db = new MockDb({
    users: {
      empty_new: { email: 'same@test.com', realBalance: 0, createdAt: 200 },
      funded_old: { email: 'same@test.com', realBalance: 500, publicId: '100999', createdAt: 100 }
    }
  });
  const result = await resolveAuthenticatedUser(db, { uid: 'auth_same', email: 'same@test.com' });
  assert.equal(result.uid, 'funded_old');
  assert.equal(result.profile.realBalance, 500);
}


async function testResolvedLegacyAccountCanSettleRound() {
  clearResolverCache();
  const db = new MockDb({
    users: {
      legacy_wallet: {
        email: 'player@test.com',
        realBalance: 100,
        bonusBalance: 0,
        publicId: '100555'
      }
    }
  });
  const identity = await resolveAuthenticatedUser(db, {
    uid: 'new_auth_player', email: 'player@test.com'
  });
  const settled = await settleRound({
    db,
    uid: identity.uid,
    requestId: 'resolver_game_req_123',
    operationId: 'resolver_game_op_123',
    gameId: 'golden_squirrel',
    gameName: 'السنجاب الذهبي',
    bet: 1,
    allowReal: true,
    allowBonus: false,
    outcomes: [{ type: 'win', multiplier: 2, weight: 100, label: 'x2', segmentIndex: 1 }],
    settings: { platformCutPercent: 5, defaultOpeningReserve: 5000 },
    randomSeed: 0,
    now: 1700000000000
  });
  assert.equal(settled.receipt.status, 'complete');
  assert.equal(db.data.users.legacy_wallet.realBalance, 101);
  assert.equal(db.data.users.new_auth_player.financialAccountUid, 'legacy_wallet');
  assert.equal(db.data.users.new_auth_player.realBalance, undefined);
  const refreshed = await resolveAuthenticatedUser(db, {
    uid: 'new_auth_player', email: 'player@test.com'
  });
  assert.equal(refreshed.profile.realBalance, 101);
}


async function testDirectIdentityShellDoesNotHideFundedLegacyAccount() {
  clearResolverCache();
  const authUid = 'new_auth_shell';
  const db = new MockDb({
    users: {
      [authUid]: {
        uid: authUid,
        email: 'shell@test.com',
        emailLower: 'shell@test.com',
        realBalance: 0,
        bonusBalance: 0,
        publicId: '100001',
        createdAt: 200,
        lastLoginAt: 300
      },
      funded_legacy: {
        uid: 'funded_legacy',
        email: 'shell@test.com',
        emailLower: 'shell@test.com',
        realBalance: 299886.11,
        bonusBalance: 0,
        publicId: '100999',
        createdAt: 100,
        lastActivityAt: 250
      }
    },
    auth_user_links: { [authUid]: { uid: authUid, source: 'server_v220_created' } }
  });
  const result = await resolveAuthenticatedUser(db, { uid: authUid, email: 'shell@test.com', email_verified: true }, { createIfMissing: true });
  assert.equal(result.uid, 'funded_legacy');
  assert.equal(result.profile.realBalance, 299886.11);
  assert.equal(db.data.auth_user_links[authUid].uid, 'funded_legacy');
  assert.equal(db.data.users[authUid].financialAccountUid, 'funded_legacy');
}


async function testProfileFinancialLinkRecoversWhenAuthLinkIsMissing() {
  clearResolverCache();
  const db = new MockDb({ users: {
    auth_profile_link: { uid:'auth_profile_link', email:'plink@test.com', realBalance:0, financialAccountUid:'old_plink' },
    old_plink: { uid:'old_plink', email:'plink@test.com', realBalance:88, publicId:'333333' }
  }});
  const result = await resolveAuthenticatedUser(db, { uid:'auth_profile_link', email:'plink@test.com', email_verified:true });
  assert.equal(result.uid,'old_plink');
  assert.equal(result.profile.realBalance,88);
}

async function testFundedDirectAccountStillWins() {
  clearResolverCache();
  const db = new MockDb({ users: {
    auth_funded: { uid:'auth_funded', email:'funded@test.com', realBalance:50, publicId:'101010' },
    legacy_empty: { uid:'legacy_empty', email:'funded@test.com', realBalance:0, publicId:'202020' }
  }});
  const result = await resolveAuthenticatedUser(db, { uid:'auth_funded', email:'funded@test.com', email_verified:true });
  assert.equal(result.uid,'auth_funded');
  assert.equal(result.profile.realBalance,50);
}

async function testPlaceholderResolutionCanSettleWheelAndSquirrel() {
  clearResolverCache();
  const authUid='auth_both_games';
  const db=new MockDb({users:{
    [authUid]:{uid:authUid,email:'games@test.com',realBalance:0,bonusBalance:0,publicId:'111111'},
    wallet:{uid:'wallet',email:'games@test.com',realBalance:100,bonusBalance:0,publicId:'222222'}
  }});
  const identity=await resolveAuthenticatedUser(db,{uid:authUid,email:'games@test.com',email_verified:true},{createIfMissing:true});
  assert.equal(identity.uid,'wallet');
  const squirrel=await settleRound({db,uid:identity.uid,requestId:'sq_req_123456',operationId:'sq_op_123456',gameId:'golden_squirrel',gameName:'السنجاب',bet:1,allowReal:true,allowBonus:false,outcomes:[{type:'win',multiplier:2,weight:100,label:'x2',segmentIndex:1}],settings:{platformCutPercent:5,defaultOpeningReserve:5000},randomSeed:0,now:1700000000000});
  assert.equal(squirrel.receipt.status,'complete');
  assert.equal(db.data.users.wallet.realBalance,101);
  const wheel=await settleRound({db,uid:identity.uid,requestId:'wh_req_123456',operationId:'wh_op_123456',gameId:'wheel',gameName:'العجلة',bet:1,allowReal:true,allowBonus:false,outcomes:[{type:'win',multiplier:2,weight:100,label:'2x',segmentIndex:1}],settings:{platformCutPercent:5,defaultOpeningReserve:5000},randomSeed:0,now:1700000001000});
  assert.equal(wheel.receipt.status,'complete');
  assert.equal(db.data.users.wallet.realBalance,102);
  assert.equal(db.data.users[authUid].realBalance,0);
}

async function testCreateMissingUser() {
  clearResolverCache();
  const db = new MockDb({ users: {} });
  const result = await resolveAuthenticatedUser(db, {
    uid: 'brand_new', email: 'new@test.com', name: 'New User'
  }, { createIfMissing: true });
  assert.equal(result.uid, 'brand_new');
  assert.equal(db.data.users.brand_new.realBalance, 0);
  assert.equal(db.data.auth_user_links.brand_new.uid, 'brand_new');
}

(async () => {
  await testDirectUser();
  await testLegacyUserResolvedByEmailAndLinked();
  await testSavedLinkWinsWithoutEmailQuery();
  await testPhoneResolution();
  await testFundedDuplicatePreferredOverEmptyDuplicate();
  await testResolvedLegacyAccountCanSettleRound();
  await testDirectIdentityShellDoesNotHideFundedLegacyAccount();
  await testProfileFinancialLinkRecoversWhenAuthLinkIsMissing();
  await testFundedDirectAccountStillWins();
  await testPlaceholderResolutionCanSettleWheelAndSquirrel();
  await testCreateMissingUser();
  console.log('AUTH_USER_RESOLVER_V221_TESTS_OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
