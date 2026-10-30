'use strict';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function text(value, max = 220) {
  return String(value ?? '').trim().slice(0, max);
}

function lowerEmail(value) {
  return text(value, 220).toLowerCase();
}

function cleanPhone(value) {
  return text(value, 60).replace(/[^+\d]/g, '');
}

function snapshotEntries(snapshot) {
  const value = snapshot && typeof snapshot.val === 'function' ? snapshot.val() : null;
  return value && typeof value === 'object' ? Object.entries(value) : [];
}

async function directUser(db, uid) {
  if (!uid) return null;
  const snapshot = await db.ref(`users/${uid}`).once('value');
  if (!snapshot.exists()) return null;
  return { uid, profile: snapshot.val() || {}, source: 'direct' };
}

async function linkedUser(db, authUid) {
  const snapshot = await db.ref(`auth_user_links/${authUid}`).once('value');
  if (!snapshot.exists()) return null;
  const raw = snapshot.val();
  const linkedUid = text(raw && typeof raw === 'object' ? raw.uid : raw, 128);
  if (!linkedUid) return null;
  const found = await directUser(db, linkedUid);
  return found ? { ...found, source: 'link' } : null;
}

async function queryUsers(db, field, value, candidates) {
  if (!value) return;
  const snapshot = await db.ref('users')
    .orderByChild(field)
    .equalTo(value)
    .limitToFirst(8)
    .once('value');
  for (const [uid, profile] of snapshotEntries(snapshot)) {
    if (!uid || !profile || typeof profile !== 'object') continue;
    candidates.set(uid, { uid, profile, source: `query:${field}` });
  }
}

function identityScore(candidate, identity) {
  const profile = candidate.profile || {};
  const email = lowerEmail(profile.email || profile.emailLower);
  const phone = cleanPhone(profile.phoneNumber || profile.phone || profile.mobile);
  const authFields = [profile.authUid, profile.firebaseAuthUid, profile.firebaseUid, profile.uid]
    .map((value) => text(value, 128));
  let score = 0;
  if (authFields.includes(identity.authUid)) score += 1000;
  if (identity.email && email === identity.email) score += 500;
  if (identity.phone && phone === identity.phone) score += 450;
  if (Number(profile.realBalance || 0) !== 0 || Number(profile.bonusBalance || 0) !== 0) score += 80;
  if (profile.publicId || profile.userId || profile.accountNumber) score += 30;
  if (Number(profile.lastActivityAt || profile.lastLoginAt || profile.updatedAt || 0) > 0) score += 10;
  return score;
}

async function scanUsersFallback(db, identity, candidates) {
  const snapshot = await db.ref('users').once('value');
  for (const [uid, profile] of snapshotEntries(snapshot)) {
    if (!profile || typeof profile !== 'object') continue;
    const email = lowerEmail(profile.email || profile.emailLower);
    const phone = cleanPhone(profile.phoneNumber || profile.phone || profile.mobile);
    const authFields = [profile.authUid, profile.firebaseAuthUid, profile.firebaseUid, profile.uid]
      .map((value) => text(value, 128));
    if (
      authFields.includes(identity.authUid) ||
      (identity.email && email === identity.email) ||
      (identity.phone && phone === identity.phone)
    ) {
      candidates.set(uid, { uid, profile, source: 'scan' });
    }
  }
}

function chooseCandidate(candidates, identity) {
  const ranked = [...candidates.values()]
    .map((candidate) => ({ ...candidate, score: identityScore(candidate, identity) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const bTime = Number(b.profile.lastActivityAt || b.profile.lastLoginAt || b.profile.updatedAt || 0);
      const aTime = Number(a.profile.lastActivityAt || a.profile.lastLoginAt || a.profile.updatedAt || 0);
      return bTime - aTime;
    });
  return ranked[0] || null;
}

async function linkIdentity(db, identity, candidate) {
  const now = Date.now();
  const profile = candidate.profile || {};
  const updates = {
    [`auth_user_links/${identity.authUid}`]: {
      uid: candidate.uid,
      email: identity.email || lowerEmail(profile.email),
      phoneNumber: identity.phone || cleanPhone(profile.phoneNumber || profile.phone),
      linkedAt: now,
      source: 'server_v220'
    },
    [`users/${candidate.uid}/firebaseAuthUid`]: identity.authUid,
    [`users/${candidate.uid}/authLinkedAt`]: now,
    [`users/${candidate.uid}/authLinkSource`]: 'server_v220'
  };
  if (identity.email) updates[`users/${candidate.uid}/emailLower`] = identity.email;
  await db.ref().update(updates);
}

async function createUser(db, identity, decodedToken) {
  const now = Date.now();
  const profile = {
    uid: identity.authUid,
    firebaseAuthUid: identity.authUid,
    email: text(decodedToken.email, 220),
    emailLower: identity.email,
    phoneNumber: text(decodedToken.phone_number, 60),
    name: text(decodedToken.name || decodedToken.email || 'مستخدم ADNOR', 120),
    displayName: text(decodedToken.name || decodedToken.email || 'مستخدم ADNOR', 120),
    realBalance: 0,
    bonusBalance: 0,
    reservedWithdrawalBalance: 0,
    freeSpins: 0,
    freeTickets: 0,
    createdAt: now,
    updatedAt: now,
    authLinkedAt: now,
    authLinkSource: 'server_v220_created'
  };
  const updates = {
    [`users/${identity.authUid}`]: profile,
    [`auth_user_links/${identity.authUid}`]: {
      uid: identity.authUid,
      email: identity.email,
      phoneNumber: identity.phone,
      linkedAt: now,
      source: 'server_v220_created'
    }
  };
  await db.ref().update(updates);
  return { uid: identity.authUid, profile, source: 'created' };
}

async function resolveAuthenticatedUser(db, decodedToken, options = {}) {
  const authUid = text(decodedToken && decodedToken.uid, 128);
  if (!authUid) {
    const error = new Error('AUTH_UID_MISSING');
    error.statusCode = 401;
    throw error;
  }
  const cached = cache.get(authUid);
  if (cached && cached.expiresAt > Date.now()) {
    const fresh = await directUser(db, cached.value.uid);
    if (fresh) return { ...cached.value, profile: fresh.profile };
    cache.delete(authUid);
  }

  const identity = {
    authUid,
    email: lowerEmail(decodedToken && decodedToken.email),
    phone: cleanPhone(decodedToken && decodedToken.phone_number)
  };

  let found = await directUser(db, authUid);
  if (!found) found = await linkedUser(db, authUid);

  if (!found) {
    const candidates = new Map();
    for (const field of ['authUid', 'firebaseAuthUid', 'firebaseUid', 'uid']) {
      await queryUsers(db, field, authUid, candidates);
    }
    if (identity.email) {
      await queryUsers(db, 'emailLower', identity.email, candidates);
      await queryUsers(db, 'email', text(decodedToken.email, 220), candidates);
      if (text(decodedToken.email, 220) !== identity.email) {
        await queryUsers(db, 'email', identity.email, candidates);
      }
    }
    if (identity.phone) {
      await queryUsers(db, 'phoneNumber', text(decodedToken.phone_number, 60), candidates);
      await queryUsers(db, 'phone', identity.phone, candidates);
      await queryUsers(db, 'mobile', identity.phone, candidates);
    }
    found = chooseCandidate(candidates, identity);
    if (!found && options.allowFullScan !== false) {
      await scanUsersFallback(db, identity, candidates);
      found = chooseCandidate(candidates, identity);
    }
  }

  if (!found && options.createIfMissing === true) {
    found = await createUser(db, identity, decodedToken || {});
  }

  if (!found) {
    const error = new Error('USER_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }

  if (found.uid !== authUid || found.source !== 'direct') {
    try { await linkIdentity(db, identity, found); } catch (error) {
      console.error('AUTH_USER_LINK_V220', authUid, found.uid, error.code || error.message);
    }
  }

  const value = {
    uid: found.uid,
    authUid,
    profile: found.profile || {},
    source: found.source || 'resolved'
  };
  if (found.uid !== authUid || found.source !== 'direct') {
    console.log('AUTH_USER_RESOLVED_V220', { authUid, databaseUid: found.uid, source: value.source });
  }
  cache.set(authUid, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return { ...value };
}

function clearResolverCache() {
  cache.clear();
}

module.exports = {
  resolveAuthenticatedUser,
  clearResolverCache,
  lowerEmail,
  cleanPhone
};
