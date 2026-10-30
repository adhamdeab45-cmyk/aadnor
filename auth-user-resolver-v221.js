'use strict';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function text(value, max = 220) {
  return String(value ?? '').trim().slice(0, max);
}
function lowerEmail(value) { return text(value, 220).toLowerCase(); }
function cleanPhone(value) { return text(value, 60).replace(/[^+\d]/g, ''); }
function number(value) { const n = Number(value || 0); return Number.isFinite(n) ? n : 0; }
function snapshotEntries(snapshot) {
  const value = snapshot && typeof snapshot.val === 'function' ? snapshot.val() : null;
  return value && typeof value === 'object' ? Object.entries(value) : [];
}
function financialTotal(profile = {}) {
  return Math.max(0, number(profile.realBalance))
    + Math.max(0, number(profile.bonusBalance))
    + Math.max(0, number(profile.reservedWithdrawalBalance));
}
function hasFinancialEvidence(profile = {}) {
  if (financialTotal(profile) > 0) return true;
  if (number(profile.freeSpins) > 0 || number(profile.freeTickets) > 0 || number(profile.freeLotteryTickets) > 0) return true;
  if (number(profile.adnBalance) > 0 || number(profile.referralBonusEarned) > 0) return true;
  if (profile.serverReceipts && typeof profile.serverReceipts === 'object' && Object.keys(profile.serverReceipts).length) return true;
  if (profile.accountStatus || profile.vipUntil || profile.isVIP === true) return true;
  return false;
}
function isIdentityShell(candidate, identity) {
  const profile = candidate && candidate.profile || {};
  if (candidate.uid !== identity.authUid) return false;
  if (hasFinancialEvidence(profile)) return false;
  const emailMatches = identity.email && lowerEmail(profile.email || profile.emailLower) === identity.email;
  const phoneMatches = identity.phone && cleanPhone(profile.phoneNumber || profile.phone || profile.mobile) === identity.phone;
  return Boolean(emailMatches || phoneMatches || text(profile.uid, 128) === identity.authUid);
}
async function directUser(db, uid, source = 'direct') {
  if (!uid) return null;
  const snapshot = await db.ref(`users/${uid}`).once('value');
  if (!snapshot.exists()) return null;
  return { uid, profile: snapshot.val() || {}, source };
}
async function linkedUser(db, authUid) {
  const snapshot = await db.ref(`auth_user_links/${authUid}`).once('value');
  if (!snapshot.exists()) return null;
  const raw = snapshot.val();
  const linkedUid = text(raw && typeof raw === 'object' ? raw.uid : raw, 128);
  if (!linkedUid) return null;
  const found = await directUser(db, linkedUid, linkedUid === authUid ? 'self-link' : 'saved-link');
  return found;
}
async function queryUsers(db, field, value, candidates) {
  if (!value) return;
  const snapshot = await db.ref('users').orderByChild(field).equalTo(value).limitToFirst(12).once('value');
  for (const [uid, profile] of snapshotEntries(snapshot)) {
    if (!uid || !profile || typeof profile !== 'object') continue;
    if (!candidates.has(uid)) candidates.set(uid, { uid, profile, source: `query:${field}` });
  }
}
async function scanUsersFallback(db, identity, candidates) {
  const snapshot = await db.ref('users').once('value');
  for (const [uid, profile] of snapshotEntries(snapshot)) {
    if (!profile || typeof profile !== 'object') continue;
    const email = lowerEmail(profile.email || profile.emailLower);
    const phone = cleanPhone(profile.phoneNumber || profile.phone || profile.mobile);
    const authFields = [profile.authUid, profile.firebaseAuthUid, profile.firebaseUid]
      .map((value) => text(value, 128));
    if (
      authFields.includes(identity.authUid) ||
      (identity.email && email === identity.email) ||
      (identity.phone && phone === identity.phone)
    ) {
      if (!candidates.has(uid)) candidates.set(uid, { uid, profile, source: 'scan' });
    }
  }
}
function explicitAuthMatch(candidate, identity) {
  const profile = candidate.profile || {};
  return [profile.authUid, profile.firebaseAuthUid, profile.firebaseUid]
    .map((value) => text(value, 128)).includes(identity.authUid);
}
function identityMatch(candidate, identity) {
  const profile = candidate.profile || {};
  return {
    explicitAuth: explicitAuthMatch(candidate, identity),
    email: Boolean(identity.email && lowerEmail(profile.email || profile.emailLower) === identity.email),
    phone: Boolean(identity.phone && cleanPhone(profile.phoneNumber || profile.phone || profile.mobile) === identity.phone)
  };
}
function candidateScore(candidate, identity) {
  const profile = candidate.profile || {};
  const match = identityMatch(candidate, identity);
  let score = 0;
  if (candidate.source === 'saved-link' || candidate.source === 'profile-link') score += 5000;
  if (match.explicitAuth) score += 3000;
  if (match.phone) score += 1200;
  if (match.email) score += identity.emailVerified ? 1100 : 750;
  if (candidate.uid === identity.authUid) score += 300;
  if (hasFinancialEvidence(profile)) score += 900;
  const total = financialTotal(profile);
  if (total > 0) score += Math.min(900, 250 + Math.log10(total + 1) * 120);
  if (profile.publicId || profile.userId || profile.accountNumber) score += 90;
  if (number(profile.lastActivityAt || profile.lastLoginAt || profile.updatedAt) > 0) score += 20;
  if (isIdentityShell(candidate, identity)) score -= 650;
  return score;
}
function chooseCandidate(candidates, identity) {
  const list = [...candidates.values()].filter((candidate) => {
    const m = identityMatch(candidate, identity);
    return candidate.uid === identity.authUid || m.explicitAuth || m.email || m.phone || candidate.source === 'saved-link';
  });
  const saved = list.find((candidate) => candidate.source === 'saved-link' || candidate.source === 'profile-link');
  if (saved) return saved;
  const direct = list.find((candidate) => candidate.uid === identity.authUid);
  const alternates = list.filter((candidate) => candidate.uid !== identity.authUid);
  if (direct && alternates.length) {
    const directFinancial = hasFinancialEvidence(direct.profile);
    const fundedAlternates = alternates.filter((candidate) => hasFinancialEvidence(candidate.profile));
    if (!directFinancial && fundedAlternates.length) {
      return fundedAlternates.sort((a, b) => candidateScore(b, identity) - candidateScore(a, identity))[0];
    }
    if (directFinancial && fundedAlternates.length) {
      const explicitlyLinked = fundedAlternates.find((candidate) => explicitAuthMatch(candidate, identity));
      if (explicitlyLinked) return explicitlyLinked;
      const directTotal = financialTotal(direct.profile);
      const strongest = fundedAlternates.sort((a, b) => candidateScore(b, identity) - candidateScore(a, identity))[0];
      const altTotal = financialTotal(strongest.profile);
      if (altTotal > directTotal * 20 && directTotal < 1) return strongest;
      const error = new Error('ACCOUNT_LINK_CONFLICT');
      error.statusCode = 409;
      error.details = { authUid: identity.authUid, directUid: direct.uid, alternateUid: strongest.uid };
      throw error;
    }
  }
  return list.sort((a, b) => candidateScore(b, identity) - candidateScore(a, identity))[0] || null;
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
      source: 'server_v221'
    },
    [`users/${candidate.uid}/firebaseAuthUid`]: identity.authUid,
    [`users/${candidate.uid}/authLinkedAt`]: now,
    [`users/${candidate.uid}/authLinkSource`]: 'server_v221'
  };
  if (identity.email) updates[`users/${candidate.uid}/emailLower`] = identity.email;
  if (candidate.uid !== identity.authUid) {
    updates[`users/${identity.authUid}/financialAccountUid`] = candidate.uid;
    updates[`users/${identity.authUid}/accountAliasOnly`] = true;
    updates[`users/${identity.authUid}/updatedAt`] = now;
  }
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
    authLinkSource: 'server_v221_created'
  };
  await db.ref().update({
    [`users/${identity.authUid}`]: profile,
    [`auth_user_links/${identity.authUid}`]: {
      uid: identity.authUid, email: identity.email, phoneNumber: identity.phone,
      linkedAt: now, source: 'server_v221_created'
    }
  });
  return { uid: identity.authUid, profile, source: 'created' };
}
async function resolveAuthenticatedUser(db, decodedToken, options = {}) {
  const authUid = text(decodedToken && decodedToken.uid, 128);
  if (!authUid) { const error = new Error('AUTH_UID_MISSING'); error.statusCode = 401; throw error; }
  const cached = cache.get(authUid);
  if (cached && cached.expiresAt > Date.now()) {
    const fresh = await directUser(db, cached.value.uid, cached.value.source);
    if (fresh) return { ...cached.value, profile: fresh.profile };
    cache.delete(authUid);
  }
  const identity = {
    authUid,
    email: lowerEmail(decodedToken && decodedToken.email),
    emailVerified: decodedToken && decodedToken.email_verified === true,
    phone: cleanPhone(decodedToken && decodedToken.phone_number)
  };
  const candidates = new Map();
  const saved = await linkedUser(db, authUid);
  if (saved) candidates.set(saved.uid, saved);
  const direct = await directUser(db, authUid, 'direct');
  if (direct) {
    candidates.set(direct.uid, direct);
    const profileLinkedUid = text(direct.profile && direct.profile.financialAccountUid, 128);
    if (profileLinkedUid && profileLinkedUid !== authUid) {
      const profileLinked = await directUser(db, profileLinkedUid, 'profile-link');
      if (profileLinked) candidates.set(profileLinked.uid, profileLinked);
    }
  }
  for (const field of ['authUid', 'firebaseAuthUid', 'firebaseUid']) await queryUsers(db, field, authUid, candidates);
  if (identity.email) {
    await queryUsers(db, 'emailLower', identity.email, candidates);
    await queryUsers(db, 'email', text(decodedToken.email, 220), candidates);
    if (text(decodedToken.email, 220) !== identity.email) await queryUsers(db, 'email', identity.email, candidates);
  }
  if (identity.phone) {
    await queryUsers(db, 'phoneNumber', text(decodedToken.phone_number, 60), candidates);
    await queryUsers(db, 'phone', identity.phone, candidates);
    await queryUsers(db, 'mobile', identity.phone, candidates);
  }
  if (options.allowFullScan !== false) await scanUsersFallback(db, identity, candidates);
  let found = chooseCandidate(candidates, identity);
  if (!found && options.createIfMissing === true) found = await createUser(db, identity, decodedToken || {});
  if (!found) { const error = new Error('USER_NOT_FOUND'); error.statusCode = 404; throw error; }
  if (found.uid !== authUid || found.source !== 'direct') {
    try { await linkIdentity(db, identity, found); }
    catch (error) { console.error('AUTH_USER_LINK_V221', authUid, found.uid, error.code || error.message); }
  }
  const value = { uid: found.uid, authUid, profile: found.profile || {}, source: found.source || 'resolved' };
  if (found.uid !== authUid || found.source !== 'direct') {
    console.log('AUTH_USER_RESOLVED_V221', { authUid, databaseUid: found.uid, source: value.source });
  }
  cache.set(authUid, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return { ...value };
}
function clearResolverCache() { cache.clear(); }
module.exports = { resolveAuthenticatedUser, clearResolverCache, lowerEmail, cleanPhone, hasFinancialEvidence, financialTotal };
