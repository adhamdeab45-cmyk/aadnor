'use strict';

const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const API_VERSION = '1.6.8';

const FIREBASE_KEY_PATH =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  '/etc/secrets/firebase-service-account.json';

const FIREBASE_DATABASE_URL =
  String(process.env.FIREBASE_DATABASE_URL || '').trim();

const ADN_ENERGY_ADS_LIVE =
  String(process.env.ADN_ENERGY_ADS_LIVE || '').trim().toLowerCase() === 'true';


const TRONGRID_API_BASE = 'https://api.trongrid.io';
const TRONGRID_API_KEY = String(process.env.TRONGRID_API_KEY || '').trim();
const TRON_DEPOSIT_ADDRESS = String(process.env.TRON_DEPOSIT_ADDRESS || '').trim();
const TRON_USDT_CONTRACT = String(
  process.env.TRON_USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
).trim();
const TRON_USDT_DECIMALS = 6;
const TRON_DEPOSIT_MIN_USD = Math.max(1, Number(process.env.TRON_DEPOSIT_MIN_USD || 5));
const TRON_DEPOSIT_MAX_USD = Math.max(
  TRON_DEPOSIT_MIN_USD,
  Number(process.env.TRON_DEPOSIT_MAX_USD || 100000)
);
const TRON_DEPOSIT_INTENT_TTL_MS = Math.max(
  10 * 60 * 1000,
  Number(process.env.TRON_DEPOSIT_INTENT_TTL_MS || 30 * 60 * 1000)
);
const MANUAL_DEPOSITS_ENABLED = true;

const DEFAULT_ALLOWED_ORIGINS = [
  'https://aadnor.onrender.com',
  'https://adnor.onrender.com'
];

const allowedOrigins = new Set(
  String(process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

let firebaseAuth;
let firebaseDb;

// ADNOR V219 — short-lived runtime caches. They reduce repeated Firebase reads
// without making financial balances authoritative in memory. Financial writes
// remain protected by Firebase transactions.
const gameAccountLinkCacheV219 = new Map();
const wheelRuntimeCacheV219 = { value: null, expiresAt: 0, promise: null };
const exchangeRootWarmCacheV219 = { value: null, updatedAt: 0, promise: null };
const exchangeMarketCacheV219 = new Map();
const exchangeAccountCacheV219 = new Map();

function cacheMapGetV219(map, key) {
  const item = map.get(key);
  if (!item || Number(item.expiresAt || 0) <= Date.now()) {
    if (item) map.delete(key);
    return null;
  }
  return item.value;
}

function cacheMapSetV219(map, key, value, ttlMs) {
  map.set(key, { value, expiresAt: Date.now() + Math.max(100, Number(ttlMs || 0)) });
  if (map.size > 500) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  return value;
}

function invalidateExchangeCachesV219(uid = '') {
  exchangeMarketCacheV219.clear();
  if (uid) exchangeAccountCacheV219.delete(String(uid));
  else exchangeAccountCacheV219.clear();
}

function initializeFirebase() {
  if (!fs.existsSync(FIREBASE_KEY_PATH)) {
    throw new Error('Firebase service account file was not found');
  }

  if (!FIREBASE_DATABASE_URL) {
    throw new Error('FIREBASE_DATABASE_URL is missing');
  }

  const serviceAccount = JSON.parse(
    fs.readFileSync(FIREBASE_KEY_PATH, 'utf8')
  );

  const firebaseApp =
    getApps().length > 0
      ? getApps()[0]
      : initializeApp({
          credential: cert(serviceAccount),
          databaseURL: FIREBASE_DATABASE_URL
        });

  firebaseAuth = getAuth(firebaseApp);
  firebaseDb = getDatabase(firebaseApp);

  console.log('FIREBASE_ADMIN_READY');
  console.log('FIREBASE_DATABASE_READY');
}

function isAllowedOrigin(origin) {
  if (!origin) return true;

  const normalizedOrigin = String(origin).trim().replace(/\/$/, '');
  if (allowedOrigins.has(normalizedOrigin)) return true;

  try {
    const parsed = new URL(normalizedOrigin);

    return (
      (parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1') &&
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    );
  } catch {
    return false;
  }
}

function applySecurityHeaders(req, res) {
  const origin = req.headers.origin;

  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, X-Request-ID, X-ADNOR-Public-ID'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  );
}

function sendJson(req, res, statusCode, payload) {
  if (res.writableEnded) return;

  const body = JSON.stringify(payload);

  applySecurityHeaders(req, res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function getBearerToken(req) {
  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() : null;
}

async function readJsonBody(req, maxBytes = 16 * 1024) {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;

      if (size > maxBytes) {
        const error = new Error('REQUEST_BODY_TOO_LARGE');
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (size === 0) {
        resolve({});
        return;
      }

      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(text);

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const error = new Error('INVALID_JSON_BODY');
          error.statusCode = 400;
          reject(error);
          return;
        }

        resolve(parsed);
      } catch {
        const error = new Error('INVALID_JSON_BODY');
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

async function verifyUser(req) {
  const idToken = getBearerToken(req);

  if (!idToken) {
    const error = new Error('AUTH_TOKEN_MISSING');
    error.statusCode = 401;
    throw error;
  }

  try {
    return await firebaseAuth.verifyIdToken(idToken, true);
  } catch (cause) {
    const error = new Error('AUTH_TOKEN_INVALID');
    error.statusCode = 401;
    error.cause = cause;
    throw error;
  }
}

function numberValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
}


function usdCents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100);
}

function formatTokenRaw(rawValue, decimals = TRON_USDT_DECIMALS) {
  const raw = BigInt(String(rawValue));
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = String(raw % scale).padStart(decimals, '0');
  return `${whole}.${fraction}`;
}

function tokenRawToUsdCents(rawValue, decimals = TRON_USDT_DECIMALS) {
  const raw = BigInt(String(rawValue));
  const scale = 10n ** BigInt(decimals);
  return Number((raw * 100n + scale / 2n) / scale);
}

function tronDepositConfigured() {
  return Boolean(
    TRONGRID_API_KEY &&
    /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(TRON_DEPOSIT_ADDRESS) &&
    /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(TRON_USDT_CONTRACT)
  );
}

function normalizeTronAddress(value) {
  return String(value || '').trim();
}

function sameTronAddress(first, second) {
  return normalizeTronAddress(first) === normalizeTronAddress(second);
}

async function tronGridJson(pathname, query = {}) {
  if (!tronDepositConfigured()) {
    const error = new Error('TRON_DEPOSIT_NOT_CONFIGURED');
    error.statusCode = 503;
    throw error;
  }

  const url = new URL(pathname, TRONGRID_API_BASE);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'TRON-PRO-API-KEY': TRONGRID_API_KEY
      },
      signal: controller.signal
    });

    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      const error = new Error('TRONGRID_INVALID_RESPONSE');
      error.statusCode = 502;
      throw error;
    }

    if (!response.ok || payload.success === false) {
      const error = new Error(
        response.status === 429 ? 'TRONGRID_RATE_LIMITED' : 'TRONGRID_REQUEST_FAILED'
      );
      error.statusCode = response.status === 429 ? 429 : 502;
      throw error;
    }

    return payload;
  } catch (cause) {
    if (cause && cause.name === 'AbortError') {
      const error = new Error('TRONGRID_TIMEOUT');
      error.statusCode = 504;
      throw error;
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
}

function agentBalanceFrom(agent) {
  if (!agent || typeof agent !== 'object') return 0;

  const candidates = [
    agent.agentBalance,
    agent.balance,
    agent.walletBalance,
    agent.credit,
    agent.amount,
    agent.agentWalletBalance,
    agent.walletAmount,
    agent.wallet && agent.wallet.balance,
    agent.wallet && agent.wallet.agentBalance
  ];

  let sawZero = false;

  for (const candidate of candidates) {
    const amount = numberValue(candidate);

    if (amount > 0) return amount;
    if (candidate === 0 || candidate === '0') sawZero = true;
  }

  return sawZero ? 0 : 0;
}

function isAgentProfile(agent, decodedToken) {
  if (!agent || typeof agent !== 'object') return false;

  const email = String(agent.email || decodedToken.email || '').toLowerCase();

  return (
    agent.role === 'agent' ||
    agent.isAgent === true ||
    agent.agent === true ||
    email.endsWith('@adnor-agent.com')
  );
}

async function requireAgent(decodedToken) {
  const uid = decodedToken.uid;
  const snapshot = await firebaseDb.ref(`agents/${uid}`).once('value');
  const agent = snapshot.val();

  if (!agent || !isAgentProfile(agent, decodedToken)) {
    const error = new Error('AGENT_ACCOUNT_NOT_FOUND');
    error.statusCode = 403;
    throw error;
  }

  if (agent.active === false || agent.agentActive === false) {
    const error = new Error('AGENT_ACCOUNT_DISABLED');
    error.statusCode = 403;
    throw error;
  }

  return {
    uid,
    email: decodedToken.email || agent.email || '',
    profile: agent
  };
}

function dayKey(timestamp = Date.now()) {
  return new Date(timestamp + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function monthKey(timestamp = Date.now()) {
  return dayKey(timestamp).slice(0, 7);
}

function maskEmail(email) {
  const value = String(email || '').trim();
  const parts = value.split('@');

  if (parts.length !== 2) return '';

  const name = parts[0];
  const domain = parts[1];
  const visible = name.slice(0, Math.min(2, name.length));

  return `${visible}${'*'.repeat(Math.max(3, name.length - visible.length))}@${domain}`;
}

function publicUser(uid, user) {
  const profile = user || {};
  const publicId =
    profile.publicId || profile.userId || profile.accountNumber || '';

  return {
    uid,
    publicId,
    userId: publicId,
    accountNumber: publicId,
    name: profile.name || profile.displayName || 'مستخدم ADNOR',
    displayName: profile.displayName || profile.name || 'مستخدم ADNOR',
    email: maskEmail(profile.email),
    realBalance: numberValue(profile.realBalance),
    bonusBalance: numberValue(profile.bonusBalance),
    frozen: profile.frozen === true || profile.isFrozen === true
  };
}

function isValidFirebaseKey(value) {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    !/[.#$\[\]\/]/.test(value)
  );
}

async function findFirstUserByChild(child, value) {
  const snapshot = await firebaseDb
    .ref('users')
    .orderByChild(child)
    .equalTo(value)
    .limitToFirst(1)
    .once('value');

  const result = snapshot.val() || {};
  const entry = Object.entries(result)[0];

  if (!entry) return null;

  return {
    uid: entry[0],
    user: entry[1] || {}
  };
}


async function findUsersByChild(child, value, limit = 12) {
  const normalizedValue = value === undefined || value === null ? '' : value;
  if (normalizedValue === '') return [];

  const snapshot = await firebaseDb
    .ref('users')
    .orderByChild(child)
    .equalTo(normalizedValue)
    .limitToFirst(Math.max(1, Math.min(25, Number(limit || 12))))
    .once('value');

  return Object.entries(snapshot.val() || {}).map(([uid, profile]) => ({
    uid,
    profile: profile && typeof profile === 'object' ? profile : {}
  }));
}

function gameAccountRecency(profile) {
  if (!profile || typeof profile !== 'object') return 0;
  return Math.max(
    Number(profile.updatedAt || 0),
    Number(profile.profileUpdatedAt || 0),
    Number(profile.lastActivityAt || 0),
    Number(profile.lastLoginAt || 0),
    Number(profile.createdAt || 0)
  );
}

function chooseGameAccountCandidate(candidates, authUid, emailLower) {
  const list = Array.from(candidates.values());
  if (!list.length) return null;

  const score = (entry) => {
    const profile = entry.profile || {};
    let total = gameAccountRecency(profile);
    if (entry.uid === authUid) total += 1_000_000_000_000_000;
    if ([profile.authUid, profile.firebaseAuthUid, profile.firebaseUid, profile.uid]
      .some((value) => String(value || '') === authUid)) total += 100_000_000_000_000;
    const profileEmail = String(profile.emailLower || profile.email || '').trim().toLowerCase();
    if (emailLower && profileEmail === emailLower) total += 10_000_000_000_000;
    total += Math.round((numberValue(profile.realBalance) + numberValue(profile.bonusBalance)) * 100);
    return total;
  };

  return list.sort((a, b) => score(b) - score(a))[0];
}

function normalizeGameAccountPhone(value) {
  return String(value || '').replace(/[^0-9+]/g, '').trim();
}

function gameAccountProfileLooksUsable(profile) {
  if (!profile || typeof profile !== 'object') return false;
  const profileKeys = Object.keys(profile);
  const hasProbe = profileKeys.some((key) => key.startsWith('__adnor'));
  if (hasProbe && profileKeys.every((key) => key === 'createdAt' || key.startsWith('__adnor'))) return false;
  const keys = [
    'uid', 'authUid', 'firebaseAuthUid', 'firebaseUid', 'email', 'emailLower',
    'phoneNumber', 'publicId', 'userId', 'accountNumber', 'name', 'displayName',
    'realBalance', 'bonusBalance', 'reservedWithdrawalBalance', 'createdAt'
  ];
  return keys.some((key) => profile[key] !== undefined && profile[key] !== null && profile[key] !== '');
}

function gameAccountHintsFromRequest(req, url, body = {}) {
  const headerValue = req && req.headers ? req.headers['x-adnor-public-id'] : '';
  const queryValue = url && url.searchParams ? url.searchParams.get('publicId') : '';
  return {
    publicId: String(body.publicId || body.userId || body.accountNumber || headerValue || queryValue || '').replace(/\D/g, '').slice(0, 18),
    allowBootstrap: body.allowBootstrap !== false,
    force: body.forceAccountRepair === true
  };
}

async function legacyScanGameAccount(authUid, emailLower, phoneNumber, publicId) {
  // This scan runs only when direct links and indexed lookups fail. Once a
  // legacy account is found, auth_user_links makes every next request fast.
  const snapshot = await firebaseDb.ref('users').once('value');
  const users = snapshot.val() || {};
  const candidates = new Map();
  const normalizedPhone = normalizeGameAccountPhone(phoneNumber);
  for (const [uid, rawProfile] of Object.entries(users)) {
    const profile = rawProfile && typeof rawProfile === 'object' ? rawProfile : {};
    if (!gameAccountProfileLooksUsable(profile)) continue;
    const profileEmail = String(profile.emailLower || profile.email || '').trim().toLowerCase();
    const profilePhone = normalizeGameAccountPhone(profile.phoneNumber || profile.phone || profile.mobile || '');
    const profilePublicId = String(profile.publicId || profile.userId || profile.accountNumber || '').replace(/\D/g, '');
    const uidMatch = uid === authUid || [profile.uid, profile.authUid, profile.firebaseAuthUid, profile.firebaseUid]
      .some((value) => String(value || '') === authUid);
    const emailMatch = !!emailLower && profileEmail === emailLower;
    const phoneMatch = !!normalizedPhone && profilePhone === normalizedPhone;
    const publicIdMatch = !!publicId && profilePublicId === publicId;
    if (uidMatch || emailMatch || phoneMatch || publicIdMatch) {
      candidates.set(uid, { uid, profile });
    }
  }
  return chooseGameAccountCandidate(candidates, authUid, emailLower);
}

async function bootstrapGameAccount(decodedToken) {
  const authUid = String(decodedToken && decodedToken.uid || '').trim();
  const email = String(decodedToken && decodedToken.email || '').trim();
  const emailLower = email.toLowerCase();
  const phoneNumber = String(decodedToken && decodedToken.phone_number || '').trim();
  let authRecord = null;
  try { authRecord = await firebaseAuth.getUser(authUid); } catch (error) {
    console.warn('GAME_ACCOUNT_AUTH_RECORD_SKIPPED', error.message);
  }
  const now = Date.now();
  const userRef = firebaseDb.ref(`users/${authUid}`);
  const tx = await userRef.transaction((rawCurrent) => {
    const current = rawCurrent && typeof rawCurrent === 'object' ? { ...rawCurrent } : {};
    delete current.__adnorWheelV219Probe;
    delete current.__adnorWheelV220Probe;
    delete current.__adnorSecureTicketProbe;
    const displayName = String(current.displayName || current.name || authRecord?.displayName || decodedToken?.name || 'مستخدم ADNOR').slice(0, 160);
    const resolvedEmail = String(current.email || authRecord?.email || email || '').trim();
    const resolvedPhone = String(current.phoneNumber || authRecord?.phoneNumber || phoneNumber || '').trim();
    return {
      ...current,
      uid: String(current.uid || authUid),
      authUid,
      firebaseAuthUid: authUid,
      firebaseUid: authUid,
      email: resolvedEmail,
      emailLower: String(current.emailLower || resolvedEmail).trim().toLowerCase(),
      phoneNumber: resolvedPhone,
      name: String(current.name || displayName),
      displayName,
      photoURL: String(current.photoURL || authRecord?.photoURL || decodedToken?.picture || ''),
      role: String(current.role || 'user'),
      isAdmin: current.isAdmin === true,
      isFrozen: current.isFrozen === true,
      isVIP: current.isVIP === true,
      realBalance: numberValue(current.realBalance),
      bonusBalance: numberValue(current.bonusBalance),
      reservedWithdrawalBalance: numberValue(current.reservedWithdrawalBalance),
      freeSpins: Math.max(0, Number(current.freeSpins || 0)),
      freeTickets: Math.max(0, Number(current.freeTickets || 0)),
      adnBalance: numberValue(current.adnBalance),
      adnReserved: numberValue(current.adnReserved),
      exchangeReservedUsd: numberValue(current.exchangeReservedUsd),
      createdAt: Number(current.createdAt || now),
      accountLinkUpdatedAt: now,
      updatedAt: now
    };
  }, undefined, false);
  const profile = tx.snapshot ? tx.snapshot.val() : null;
  if (!tx.committed || !gameAccountProfileLooksUsable(profile)) {
    const error = new Error('USER_ACCOUNT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  await firebaseDb.ref(`auth_user_links/${authUid}`).set(authUid);
  cacheMapSetV219(gameAccountLinkCacheV219, authUid, authUid, 30 * 60 * 1000);
  console.log('GAME_ACCOUNT_V220', { gameAccount: 'bootstrapped', authUid, financialUid: authUid, linked: false });
  return { authUid, uid: authUid, profile, linked: false, bootstrapped: true };
}

async function resolveGameAccount(decodedToken, hints = {}) {
  const authUid = String(decodedToken && decodedToken.uid || '').trim();
  const emailLower = String(decodedToken && decodedToken.email || '').trim().toLowerCase();
  const phoneNumber = String(decodedToken && decodedToken.phone_number || '').trim();
  const publicId = String(hints.publicId || '').replace(/\D/g, '').slice(0, 18);
  const force = hints.force === true;

  if (!authUid || !isValidFirebaseKey(authUid)) {
    const error = new Error('USER_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }

  if (!force) {
    const cachedFinancialUid = cacheMapGetV219(gameAccountLinkCacheV219, authUid);
    if (cachedFinancialUid && isValidFirebaseKey(String(cachedFinancialUid))) {
      const cachedSnapshot = await firebaseDb.ref(`users/${cachedFinancialUid}`).once('value');
      const cachedProfile = cachedSnapshot.val() || null;
      if (cachedSnapshot.exists() && gameAccountProfileLooksUsable(cachedProfile)) {
        return {
          authUid,
          uid: String(cachedFinancialUid),
          profile: cachedProfile,
          linked: String(cachedFinancialUid) !== authUid,
          cached: true
        };
      }
      gameAccountLinkCacheV219.delete(authUid);
    }
  } else {
    gameAccountLinkCacheV219.delete(authUid);
  }

  const directRef = firebaseDb.ref(`users/${authUid}`);
  const directSnapshot = await directRef.once('value');
  const directProfile = directSnapshot.val() || null;
  if (directSnapshot.exists() && !gameAccountProfileLooksUsable(directProfile)) {
    const directKeys = directProfile && typeof directProfile === 'object' ? Object.keys(directProfile) : [];
    if (directKeys.length && directKeys.every((key) => key === 'createdAt' || key.startsWith('__adnor'))) {
      try { await directRef.remove(); } catch (error) { console.warn('GAME_ACCOUNT_STALE_PROBE_CLEANUP_SKIPPED', error.message); }
    }
  }
  if (directSnapshot.exists() && gameAccountProfileLooksUsable(directProfile)) {
    const profile = directProfile || {};
    const updates = {};
    if (!profile.uid) updates[`users/${authUid}/uid`] = authUid;
    if (!profile.authUid) updates[`users/${authUid}/authUid`] = authUid;
    if (!profile.firebaseAuthUid) updates[`users/${authUid}/firebaseAuthUid`] = authUid;
    if (!profile.firebaseUid) updates[`users/${authUid}/firebaseUid`] = authUid;
    if (emailLower && !profile.emailLower) updates[`users/${authUid}/emailLower`] = emailLower;
    if (phoneNumber && !profile.phoneNumber) updates[`users/${authUid}/phoneNumber`] = phoneNumber;
    updates[`auth_user_links/${authUid}`] = authUid;
    try { await firebaseDb.ref().update(updates); } catch (error) {
      console.warn('GAME_ACCOUNT_LINK_UPDATE_SKIPPED', error.message);
    }
    cacheMapSetV219(gameAccountLinkCacheV219, authUid, authUid, 30 * 60 * 1000);
    console.log('GAME_ACCOUNT_V220', { gameAccount: 'direct', authUid, financialUid: authUid, linked: false });
    return { authUid, uid: authUid, profile: { ...profile, uid: profile.uid || authUid }, linked: false };
  }

  const candidates = new Map();
  const addCandidate = (entry) => {
    if (!entry || !entry.uid || !isValidFirebaseKey(entry.uid)) return;
    if (!gameAccountProfileLooksUsable(entry.profile)) return;
    if (!candidates.has(entry.uid)) candidates.set(entry.uid, entry);
  };

  const linkSnapshot = await firebaseDb.ref(`auth_user_links/${authUid}`).once('value');
  const linkedUid = String(linkSnapshot.val() || '').trim();
  if (isValidFirebaseKey(linkedUid)) {
    const linkedSnapshot = await firebaseDb.ref(`users/${linkedUid}`).once('value');
    if (linkedSnapshot.exists()) addCandidate({ uid: linkedUid, profile: linkedSnapshot.val() || {} });
  }

  if (publicId && /^\d{4,18}$/.test(publicId)) {
    const mappingSnapshot = await firebaseDb.ref(`public_user_ids/${publicId}`).once('value');
    const mappedUid = String(mappingSnapshot.val() || '').trim();
    if (isValidFirebaseKey(mappedUid)) {
      const mappedSnapshot = await firebaseDb.ref(`users/${mappedUid}`).once('value');
      if (mappedSnapshot.exists()) addCandidate({ uid: mappedUid, profile: mappedSnapshot.val() || {} });
    }
  }

  for (const field of ['authUid', 'firebaseAuthUid', 'firebaseUid', 'uid']) {
    try {
      for (const entry of await findUsersByChild(field, authUid)) addCandidate(entry);
    } catch (error) {
      console.warn('GAME_ACCOUNT_LOOKUP_SKIPPED', field, error.message);
    }
  }

  if (emailLower) {
    for (const [field, value] of [['emailLower', emailLower], ['email', decodedToken.email || emailLower]]) {
      try {
        for (const entry of await findUsersByChild(field, value)) addCandidate(entry);
      } catch (error) {
        console.warn('GAME_ACCOUNT_LOOKUP_SKIPPED', field, error.message);
      }
    }
  }

  if (phoneNumber) {
    for (const field of ['phoneNumber', 'phone', 'mobile']) {
      try {
        for (const entry of await findUsersByChild(field, phoneNumber)) addCandidate(entry);
      } catch (error) {
        console.warn('GAME_ACCOUNT_LOOKUP_SKIPPED', field, error.message);
      }
    }
  }

  let selected = chooseGameAccountCandidate(candidates, authUid, emailLower);
  if (!selected) {
    try {
      selected = await legacyScanGameAccount(authUid, emailLower, phoneNumber, publicId);
      if (selected) console.log('GAME_ACCOUNT_V220_LEGACY_SCAN_MATCH', { authUid, financialUid: selected.uid });
    } catch (error) {
      console.warn('GAME_ACCOUNT_V220_LEGACY_SCAN_SKIPPED', error.message);
    }
  }

  if (!selected) {
    if (hints.allowBootstrap !== false) return await bootstrapGameAccount(decodedToken);
    console.warn('GAME_ACCOUNT_V220_MISSING', { authUid, hasEmail: !!emailLower, hasPhone: !!phoneNumber, publicId: publicId || null });
    const error = new Error('USER_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }

  const financialUid = selected.uid;
  const freshSnapshot = await firebaseDb.ref(`users/${financialUid}`).once('value');
  if (!freshSnapshot.exists() || !gameAccountProfileLooksUsable(freshSnapshot.val())) {
    if (hints.allowBootstrap !== false) return await bootstrapGameAccount(decodedToken);
    const error = new Error('USER_ACCOUNT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  const profile = freshSnapshot.val() || {};
  const updates = { [`auth_user_links/${authUid}`]: financialUid };
  if (!profile.uid) updates[`users/${financialUid}/uid`] = financialUid;
  if (!profile.authUid) updates[`users/${financialUid}/authUid`] = authUid;
  if (!profile.firebaseAuthUid) updates[`users/${financialUid}/firebaseAuthUid`] = authUid;
  if (!profile.firebaseUid) updates[`users/${financialUid}/firebaseUid`] = authUid;
  if (emailLower && !profile.emailLower) updates[`users/${financialUid}/emailLower`] = emailLower;
  if (phoneNumber && !profile.phoneNumber) updates[`users/${financialUid}/phoneNumber`] = phoneNumber;
  updates[`users/${financialUid}/accountLinkUpdatedAt`] = Date.now();
  try { await firebaseDb.ref().update(updates); } catch (error) {
    console.warn('GAME_ACCOUNT_LINK_UPDATE_SKIPPED', error.message);
  }
  cacheMapSetV219(gameAccountLinkCacheV219, authUid, financialUid, 30 * 60 * 1000);

  console.log('GAME_ACCOUNT_V220', {
    gameAccount: 'resolved',
    authUid,
    financialUid,
    linked: financialUid !== authUid
  });

  return { authUid, uid: financialUid, profile, linked: financialUid !== authUid };
}

async function findUserByTargetId(targetId) {
  const query = String(targetId || '').trim();

  if (!query || query.length > 128) {
    const error = new Error('TARGET_ID_REQUIRED');
    error.statusCode = 400;
    throw error;
  }

  if (/^\d{4,14}$/.test(query)) {
    const mapping = await firebaseDb
      .ref(`public_user_ids/${query}`)
      .once('value');

    if (mapping.exists()) {
      const uid = String(mapping.val() || '');

      if (isValidFirebaseKey(uid)) {
        const userSnapshot = await firebaseDb
          .ref(`users/${uid}`)
          .once('value');

        if (userSnapshot.exists()) {
          return { uid, user: userSnapshot.val() || {} };
        }
      }
    }
  }

  if (isValidFirebaseKey(query)) {
    const direct = await firebaseDb.ref(`users/${query}`).once('value');

    if (direct.exists()) {
      return { uid: query, user: direct.val() || {} };
    }
  }

  const fields = ['publicId', 'userId', 'accountNumber'];

  for (const field of fields) {
    const found = await findFirstUserByChild(field, query);
    if (found) return found;
  }

  const error = new Error('TARGET_USER_NOT_FOUND');
  error.statusCode = 404;
  throw error;
}

function validateTargetUser(agentUid, targetUid, user) {
  if (String(agentUid) === String(targetUid)) {
    const error = new Error('AGENT_SELF_RECHARGE_BLOCKED');
    error.statusCode = 400;
    throw error;
  }

  if (
    String(user.role || '').toLowerCase() === 'admin' ||
    user.isAdmin === true
  ) {
    const error = new Error('ADMIN_RECHARGE_BLOCKED');
    error.statusCode = 400;
    throw error;
  }

  if (user.frozen === true || user.isFrozen === true) {
    const error = new Error('TARGET_USER_FROZEN');
    error.statusCode = 409;
    throw error;
  }
}

function sanitizeRequestId(value) {
  const requestId = String(value || '').trim();

  if (!/^[A-Za-z0-9_-]{12,100}$/.test(requestId)) {
    const error = new Error('INVALID_REQUEST_ID');
    error.statusCode = 400;
    throw error;
  }

  return requestId;
}

function operationIdFor(agentUid, requestId) {
  const hash = crypto
    .createHash('sha256')
    .update(`${agentUid}|${requestId}`)
    .digest('hex')
    .slice(0, 28);

  return `agent_recharge_${hash}`;
}

function errorResponse(error) {
  const code = String(error.message || 'INTERNAL_ERROR');

  const messages = {
    AUTH_TOKEN_MISSING: 'يجب تسجيل الدخول أولاً.',
    AUTH_TOKEN_INVALID: 'انتهت جلسة الدخول. سجّل الدخول من جديد.',
    AGENT_ACCOUNT_NOT_FOUND: 'هذا الحساب ليس وكيلاً معتمداً.',
    AGENT_ACCOUNT_DISABLED: 'تم إيقاف حساب الوكيل من الإدارة.',
    TARGET_ID_REQUIRED: 'اكتب رقم المستخدم بشكل صحيح.',
    TARGET_USER_NOT_FOUND: 'لم يتم العثور على المستخدم.',
    AGENT_SELF_RECHARGE_BLOCKED: 'لا يمكن للوكيل شحن حسابه بنفسه.',
    ADMIN_RECHARGE_BLOCKED: 'لا يمكن شحن حساب أدمن من بوابة الوكيل.',
    TARGET_USER_FROZEN: 'حساب المستخدم مجمّد ولا يمكن شحنه.',
    INVALID_AMOUNT: 'مبلغ الشحن غير صحيح.',
    AMOUNT_TOO_LARGE: 'مبلغ الشحن أكبر من الحد المسموح للعملية.',
    INVALID_REQUEST_ID: 'رقم العملية غير صحيح. أعد المحاولة.',
    REQUEST_ID_REUSED: 'رقم العملية مستخدم لطلب مختلف.',
    AGENT_BALANCE_INSUFFICIENT: 'رصيد الوكيل غير كافٍ.',
    AGENT_DAILY_LIMIT_EXCEEDED: 'تم تجاوز الحد اليومي للوكيل.',
    AGENT_MONTHLY_LIMIT_EXCEEDED: 'تم تجاوز الحد الشهري للوكيل.',
    RECHARGE_REQUEST_REFUNDED: 'تم إلغاء هذه العملية وإعادة رصيد الوكيل.',
    DATABASE_TRANSACTION_FAILED: 'تعذر تنفيذ العملية بأمان. أعد المحاولة.',
    REQUEST_BODY_TOO_LARGE: 'حجم الطلب أكبر من المسموح.',
    INVALID_JSON_BODY: 'بيانات الطلب غير صحيحة.',
    USER_ACCOUNT_NOT_FOUND: 'حساب المستخدم غير موجود.',
    USER_ACCOUNT_FROZEN: 'الحساب موقوف مؤقتًا.',
    INVALID_DRAW_TYPE: 'نوع السحب غير صحيح.',
    DRAW_DISABLED: 'هذا السحب متوقف مؤقتًا من الإدارة.',
    INVALID_TICKET_NUMBER: 'رقم التذكرة يجب أن يكون 7 أرقام.',
    INSUFFICIENT_PLAYABLE_BALANCE: 'الرصيد القابل للعب غير كافٍ.',
    BONUS_PAYMENT_DISABLED: 'الدفع من البونص غير متاح لهذه العملية.',
    WHEEL_DISABLED: 'العجلة متوقفة مؤقتًا من الإدارة.',
    INVALID_BET: 'قيمة اللعب غير صحيحة.',
    BET_BELOW_MINIMUM: 'قيمة اللعب أقل من الحد الأدنى.',
    BET_ABOVE_MAXIMUM: 'قيمة اللعب أعلى من الحد الأقصى.',
    GAME_CONFIGURATION_INVALID: 'إعدادات اللعبة غير صحيحة.',
    ENERGY_DISABLED: 'تم إيقاف ADN Energy مؤقتًا من الإدارة.',
    ADS_PROVIDER_NOT_CONFIGURED: 'لم يتم ربط Google Rewarded Ads بالسيرفر بعد.',
    ADS_SSV_NOT_IMPLEMENTED: 'التحقق الآمن من إعلان المكافأة لم يكتمل بعد.',
    ADMIN_ACCESS_DENIED: 'هذا الحساب لا يملك صلاحية دخول لوحة الإدارة.',
    INVALID_USER_ID: 'رقم المستخدم غير صحيح.',
    INVALID_ADMIN_ACTION: 'الإجراء الإداري غير صحيح.',
    ADMIN_REASON_REQUIRED: 'اكتب سبب العملية قبل التنفيذ.',
    BALANCE_ADJUSTMENT_FAILED: 'تعذر تعديل الرصيد بأمان.',
    NOTIFICATION_CONTENT_REQUIRED: 'اكتب عنوان الإشعار ونصه.',
    NOTIFICATION_TARGET_EMPTY: 'لا يوجد مستخدمون ضمن الفئة المختارة.',
    NOTIFICATION_TARGET_TOO_LARGE: 'عدد المستلمين أكبر من الحد الآمن.',
    FINANCE_REQUEST_NOT_PENDING: 'هذا الطلب لم يعد معلّقًا. تم تحديث القائمة تلقائيًا.',
    FINANCE_REQUEST_ALREADY_PROCESSED: 'تم تنفيذ هذا الطلب مسبقًا.',
    FINANCE_REQUEST_PROCESSING: 'الطلب قيد المعالجة الآن. انتظر لحظات ثم حدّث القائمة.',
    FINANCE_REQUEST_FINALIZED_OTHER: 'تم إنهاء الطلب مسبقًا بإجراء مختلف. تم تحديث القائمة.',
    INVALID_FINANCE_REQUEST: 'بيانات الطلب المالي غير صحيحة.',
    EXCHANGE_DISABLED: 'سوق ADN متوقف مؤقتًا من الإدارة.',
    EXCHANGE_MARKET_HALTED: 'تم إيقاف التداول مؤقتًا لحماية السوق من حركة سعر غير طبيعية.',
    EXCHANGE_BUY_DISABLED: 'شراء ADN متوقف مؤقتًا.',
    EXCHANGE_SELL_DISABLED: 'بيع ADN متوقف مؤقتًا.',
    EXCHANGE_TERMS_REQUIRED: 'اقرأ تحذير المخاطر ووافق على شروط سوق ADN قبل التداول.',
    EXCHANGE_INVALID_SIDE: 'اختر شراء أو بيع بشكل صحيح.',
    EXCHANGE_INVALID_ORDER_TYPE: 'نوع الأمر غير صحيح.',
    EXCHANGE_INVALID_PRICE: 'سعر الأمر غير صحيح.',
    EXCHANGE_INVALID_QUANTITY: 'كمية ADN غير صحيحة.',
    EXCHANGE_PRICE_OUT_OF_RANGE: 'السعر بعيد جدًا عن سعر السوق الحالي.',
    EXCHANGE_ORDER_BELOW_MINIMUM: 'قيمة الأمر أقل من الحد الأدنى.',
    EXCHANGE_ORDER_ABOVE_MAXIMUM: 'قيمة الأمر أكبر من الحد المسموح.',
    EXCHANGE_DAILY_LIMIT_EXCEEDED: 'تم تجاوز حد التداول اليومي للحساب.',
    EXCHANGE_OPEN_ORDER_LIMIT: 'لديك عدد كبير من الأوامر المفتوحة. ألغِ بعض الأوامر أولًا.',
    EXCHANGE_REAL_BALANCE_INSUFFICIENT: 'رصيدك الحقيقي غير كافٍ. رصيد البونص لا يُستخدم في سوق ADN.',
    EXCHANGE_ADN_BALANCE_INSUFFICIENT: 'رصيد ADN غير كافٍ لتنفيذ أمر البيع.',
    EXCHANGE_MARKET_LIQUIDITY_INSUFFICIENT: 'لا توجد كمية ADN أو USD كافية في دفتر السوق وخزينة السيولة لتنفيذ الأمر كاملًا.',
    EXCHANGE_AUTO_LIQUIDITY_DISABLED: 'السيولة التلقائية من خزينة السوق متوقفة من الإدارة.',
    EXCHANGE_ORDER_NOT_FOUND: 'أمر التداول غير موجود.',
    EXCHANGE_ORDER_NOT_OPEN: 'هذا الأمر منفذ أو ملغى ولا يمكن إلغاؤه.',
    EXCHANGE_ORDER_ACCESS_DENIED: 'لا تملك صلاحية تعديل هذا الأمر.',
    EXCHANGE_INVALID_ORDER_ID: 'رقم أمر التداول غير صحيح.',
    EXCHANGE_RESERVED_FUNDS_INVALID: 'حصل خطأ في الرصيد المحجوز للأمر.',
    EXCHANGE_RESERVED_ASSET_INVALID: 'حصل خطأ في كمية ADN المحجوزة.',
    EXCHANGE_DATABASE_NOT_READY: 'قاعدة بيانات السوق غير جاهزة. أعد المحاولة.',
    EXCHANGE_TRANSACTION_FAILED: 'تعذر تنفيذ عملية التداول بأمان. أعد المحاولة.',
    EXCHANGE_TREASURY_USD_INSUFFICIENT: 'احتياطي USD في خزينة السوق غير كافٍ.',
    EXCHANGE_TREASURY_ADN_INSUFFICIENT: 'رصيد ADN في خزينة السوق غير كافٍ.',
    EXCHANGE_SETTINGS_INVALID: 'إعدادات سوق ADN غير صحيحة.',
    EXCHANGE_SUPPLY_BELOW_ISSUED: 'لا يمكن جعل إجمالي المعروض أقل من الكمية المصدرة.',
    EXCHANGE_TOTAL_SUPPLY_EXCEEDED: 'التعديل يتجاوز إجمالي معروض ADN المحدد.',
    EXCHANGE_TREASURY_NEGATIVE: 'لا يمكن أن يصبح رصيد خزينة السوق سالبًا.',
    EXCHANGE_TREASURY_ADJUSTMENT_EMPTY: 'اكتب قيمة تعديل لخزينة ADN أو USD.',
    EXCHANGE_INVALID_ADMIN_ORDER: 'بيانات أمر خزينة السوق غير صحيحة.',
    DEPOSIT_DISABLED: 'الإيداع متوقف مؤقتًا من الإدارة.',
    MANUAL_DEPOSIT_DISABLED: 'الإيداع اليدوي متوقف من إعدادات السيرفر.',
    DEPOSIT_CREDIT_AMOUNT_LOCKED: 'تم تثبيت المبلغ الواصل لهذا الطلب؛ استكمل المعالجة بالمبلغ نفسه.',
    AUTOMATIC_DEPOSITS_DISABLED: 'الإيداع التلقائي متوقف. أنشئ طلب إيداع يدوي وانتظر موافقة الإدارة.',
    INVALID_DEPOSIT_AMOUNT: 'مبلغ الإيداع غير صحيح.',
    DEPOSIT_BELOW_MINIMUM: 'مبلغ الإيداع أقل من الحد الأدنى للطريقة المختارة.',
    TRON_DEPOSIT_NOT_CONFIGURED: 'الإيداع التلقائي عبر USDT TRC20 غير مربوط بالكامل بالسيرفر.',
    TRON_DEPOSIT_REQUEST_REQUIRED: 'أنشئ طلب إيداع جديد أولًا.',
    TRON_DEPOSIT_REQUEST_NOT_FOUND: 'طلب الإيداع غير موجود أو لا يخص هذا الحساب.',
    TRON_DEPOSIT_REQUEST_EXPIRED: 'انتهت مهلة طلب الإيداع. أنشئ طلبًا جديدًا.',
    TRON_DEPOSIT_AMOUNT_RESERVATION_FAILED: 'تعذر إنشاء مبلغ تحقق فريد. أعد المحاولة.',
    TRON_DEPOSIT_PENDING: 'لم يصل التحويل المؤكد بعد. انتظر قليلًا ثم أعد التحقق.',
    TRON_DEPOSIT_TXID_INVALID: 'رقم TXID غير صحيح. انسخه كاملًا من المحفظة.',
    TRON_DEPOSIT_TX_NOT_FOUND: 'لم نجد هذا التحويل المؤكد إلى محفظة ADNOR. تأكد من TXID وشبكة TRC20.',
    TRON_DEPOSIT_BELOW_MINIMUM: 'المبلغ الذي وصل أقل من الحد الأدنى للإيداع.',
    TRON_DEPOSIT_CLAIMED: 'تم استخدام هذا التحويل مسبقًا.',
    TRON_DEPOSIT_CREDIT_FAILED: 'وصل التحويل لكن تعذر إضافة الرصيد بأمان. أعد المحاولة.',
    TRONGRID_RATE_LIMITED: 'خدمة فحص شبكة TRON مشغولة مؤقتًا. أعد المحاولة بعد قليل.',
    TRONGRID_REQUEST_FAILED: 'تعذر الاتصال بخدمة فحص شبكة TRON.',
    TRONGRID_INVALID_RESPONSE: 'وصل رد غير صالح من خدمة فحص شبكة TRON.',
    TRONGRID_TIMEOUT: 'انتهت مهلة الاتصال بشبكة TRON. أعد المحاولة.',
    PAYMENT_METHOD_REQUIRED: 'اختر طريقة دفع صحيحة.',
    PAYMENT_METHOD_NOT_AVAILABLE: 'طريقة الدفع غير متاحة حاليًا.',
    RECEIPT_IMAGE_REQUIRED: 'صورة الإيصال مطلوبة.',
    RECEIPT_TOO_LARGE: 'حجم صورة الإيصال كبير جدًا.',
    WITHDRAW_DISABLED: 'السحب متوقف مؤقتًا من الإدارة.',
    INVALID_WITHDRAW_AMOUNT: 'مبلغ السحب غير صحيح.',
    WITHDRAW_BELOW_MINIMUM: 'مبلغ السحب أقل من الحد الأدنى للطريقة المختارة.',
    WITHDRAW_DETAILS_REQUIRED: 'اكتب بيانات الاستلام كاملة.',
    WITHDRAW_REQUEST_SAVE_FAILED: 'تعذر حفظ طلب السحب؛ تم إرجاع الحجز تلقائيًا.',
    INSUFFICIENT_REAL_BALANCE: 'الرصيد الحقيقي غير كافٍ.',
    ACCOUNT_FROZEN: 'الحساب مجمّد مؤقتًا.',
    USER_NOT_FOUND: 'حساب المستخدم غير موجود.',
    INVALID_REFERRAL_CODE: 'كود الدعوة غير صحيح.',
    REFERRAL_FAILED: 'تعذر تفعيل كود الدعوة.',
    REFERRAL_ALREADY_USED: 'هذا الحساب استفاد من دعوة سابقًا.',
    REFERRAL_CODE_NOT_FOUND: 'كود الدعوة غير موجود أو متوقف.',
    SELF_REFERRAL_NOT_ALLOWED: 'لا يمكنك استخدام كود دعوتك لنفسك.',
    REFERRER_NOT_FOUND: 'حساب صاحب الدعوة غير موجود.',
    REFERRAL_DISABLED: 'نظام الدعوات متوقف من الإدارة.',
    REFERRAL_DAILY_LIMIT: 'صاحب الدعوة وصل إلى الحد اليومي.',
    INVALID_PAYMENT_METHOD_ID: 'معرّف طريقة الدفع غير صحيح.',
    INVALID_PAYMENT_METHOD_TYPE: 'نوع طريقة الدفع غير صحيح.',
    INVALID_SUPPORT_REPLY: 'بيانات رد الدعم غير صحيحة.',
    INVALID_AGENT_ADJUSTMENT: 'بيانات تعديل رصيد الوكيل غير صحيحة.',
    WINNING_TICKET_NOT_FOUND: 'التذكرة الفائزة غير موجودة في السحب المحدد.',
    INVALID_DRAW_RESULT: 'بيانات نتيجة السحب غير صحيحة.',
    DRAW_PRIZE_CREDIT_FAILED: 'تعذر إضافة الجائزة للفائز بأمان.',
    DRAW_PRIZE_ACCOUNT_NOT_FOUND: 'تم نشر النتيجة، لكن حساب الفائز المالي يحتاج ربطًا تلقائيًا. سيعيد السيرفر المحاولة.',
    DRAW_SETTLEMENT_FAILED: 'تم نشر النتيجة، وتسوية الجائزة قيد إعادة المحاولة تلقائيًا.',
    AGENT_BALANCE_ADJUSTMENT_FAILED: 'تعذر تعديل رصيد الوكيل بأمان.',
    BACKUP_TOO_LARGE: 'حجم النسخة الاحتياطية أكبر من الحد المسموح.',
    DAILY_LOGIN_ALREADY_CLAIMED: 'تم استلام مكافأة الدخول اليومية مسبقًا.',
    DAILY_LOGIN_DISABLED: 'مكافأة الدخول اليومية متوقفة حاليًا.',
    GAMES_DISABLED: 'الألعاب متوقفة مؤقتًا من الإدارة.',
    GAME_BET_OUT_OF_RANGE: 'قيمة اللعب خارج الحدود المسموحة.',
    GAME_NOT_AVAILABLE: 'هذه اللعبة غير متاحة حاليًا.',
    GAME_TREASURY_LOW: 'صندوق اللعبة لا يغطي أعلى جائزة لهذا الرهان. خفّض قيمة اللعب أو موّل الصندوق من الإدارة.',
    GAME_TREASURY_NEGATIVE: 'لا يمكن أن يصبح صندوق اللعبة سالبًا.',
    GAME_TREASURY_ADJUSTMENT_REQUIRED: 'اكتب قيمة تمويل أو سحب صحيحة لصندوق اللعبة.',
    GAME_TREASURY_REASON_REQUIRED: 'اكتب سبب تعديل صندوق اللعبة.',
    GAME_REQUIRED: 'اختر اللعبة المطلوبة.',
    GAME_USER_HOLD_FAILED: 'تعذر حجز قيمة الجولة بأمان. أعد المحاولة.',
    GAME_TREASURY_ACCOUNTING_FAILED: 'تعذر تحديث صندوق اللعبة بأمان. لم يتم خصم الجولة.',
    GAME_SETTLEMENT_FAILED: 'تعذر إكمال تسوية الجولة؛ تمت حماية الرصيد تلقائيًا.',
    GAME_RECEIPT_NOT_FOUND: 'سجل الجولة غير موجود. أعد المحاولة.',
    INVALID_AI_KNOWLEDGE: 'بيانات قاعدة معرفة المساعد غير صحيحة.',
    INVALID_AI_KNOWLEDGE_ID: 'معرّف قاعدة المعرفة غير صحيح.',
    INVALID_GAME_BET_LIMITS: 'حدود الرهان الخاصة باللعبة غير صحيحة.',
    INVALID_GAME_ID: 'معرّف اللعبة غير صحيح.',
    INVALID_PROMO_CODE: 'اكتب كودًا دعائيًا صحيحًا.',
    INVALID_VIP_LIMITS: 'إعدادات VIP غير صحيحة.',
    LUCKY_BOX_ALREADY_OPENED: 'تم فتح صندوق الحظ اليوم بالفعل.',
    LUCKY_BOX_DISABLED: 'صندوق الحظ متوقف مؤقتًا.',
    PROMO_CODE_EXHAUSTED: 'انتهى العدد المسموح لاستخدام هذا الكود.',
    PROMO_CODE_NOT_FOUND: 'الكود الدعائي غير موجود أو غير فعال.',
    REFERRAL_REWARD_ALREADY_CLAIMED: 'تم استلام مكافأة الدعوة مسبقًا.',
    REFERRAL_REWARD_NOT_FOUND: 'لا توجد مكافأة دعوة معلقة.',
    REFERRAL_REWARD_REQUIRED: 'بيانات مكافأة الدعوة غير مكتملة.',
    SELF_EXCLUDED: 'الحساب موقوف ذاتيًا عن اللعب حتى انتهاء المدة.',
    TICKET_NUMBER_GENERATION_FAILED: 'تعذر إنشاء رقم تذكرة فريد. أعد المحاولة.',
    VIP_BOX_ALREADY_OPENED: 'تم فتح صندوق VIP اليوم بالفعل.',
    VIP_BOX_DISABLED: 'صندوق VIP متوقف مؤقتًا.',
    VIP_DISABLED: 'نظام VIP متوقف مؤقتًا.',
    VIP_TASK_ALREADY_CLAIMED: 'تم استلام مكافأة هذه المهمة مسبقًا.',
    VIP_TASK_DISABLED: 'هذه المهمة متوقفة حاليًا.',
    VIP_TASK_NOT_READY: 'لم تكتمل شروط المهمة بعد.',
    VIP_TASK_REQUIRED: 'اختر مهمة VIP صحيحة.'
  };

  return {
    statusCode: Number(error.statusCode || 500),
    payload: {
      ok: false,
      error: code,
      message: messages[code] || 'حدث خطأ داخلي في السيرفر.'
    }
  };
}


function secureOperationId(prefix, uid, requestId) {
  const hash = crypto
    .createHash('sha256')
    .update(`${prefix}|${uid}|${requestId}`)
    .digest('hex')
    .slice(0, 30);

  return `${prefix}_${hash}`;
}

function validateGameRequestId(value) {
  return sanitizeRequestId(value);
}

function normalizeDrawType(value) {
  const drawType = String(value || '').trim().toLowerCase();
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(drawType)) {
    const error = new Error('INVALID_DRAW_TYPE');
    error.statusCode = 400;
    throw error;
  }
  return drawType;
}

function drawLabelServer(drawType) {
  return {
    daily: 'السحب اليومي',
    weekly: 'السحب الأسبوعي',
    monthly: 'السحب الشهري',
    yearly: 'السحب السنوي'
  }[drawType] || drawType;
}

function isDrawEnabled(settings, drawType) {
  if (!settings || typeof settings !== 'object') return true;
  if (settings.enabled === false) return false;
  if (settings[`${drawType}Enabled`] === false) return false;
  if (settings.draws && settings.draws[drawType] && settings.draws[drawType].enabled === false) return false;
  return true;
}

function ticketPriceFor(settings, drawType) {
  const candidates = [
    settings && settings.draws && settings.draws[drawType] && settings.draws[drawType].ticketPrice,
    settings && settings[`${drawType}TicketPrice`],
    settings && settings.ticketPrice,
    1
  ];
  for (const candidate of candidates) {
    const value = numberValue(candidate);
    if (value > 0) return value;
  }
  return 1;
}

function userFrozen(profile) {
  return !!(profile && (profile.frozen === true || profile.isFrozen === true));
}

function playableSplit(profile, amount, allowBonus = true) {
  const real = numberValue(profile.realBalance);
  const bonus = numberValue(profile.bonusBalance);
  const useReal = Math.min(real, amount);
  const remaining = numberValue(amount - useReal);
  const useBonus = allowBonus ? Math.min(bonus, remaining) : 0;
  if (numberValue(useReal + useBonus) < amount) return null;
  return {
    realBefore: real,
    bonusBefore: bonus,
    useReal,
    useBonus,
    realAfter: numberValue(real - useReal),
    bonusAfter: numberValue(bonus - useBonus)
  };
}

async function secureTicketPurchase(decodedToken, body) {
  const account = await resolveGameAccount(decodedToken, { publicId: body.publicId, allowBootstrap: true });
  const uid = account.uid;
  const drawType = normalizeDrawType(body.drawType);
  const ticketNumber = String(body.ticketNumber || '').replace(/\D/g, '');
  const requestId = validateGameRequestId(body.requestId || body.idempotencyKey);

  if (!/^\d{7}$/.test(ticketNumber)) {
    const error = new Error('INVALID_TICKET_NUMBER');
    error.statusCode = 400;
    throw error;
  }

  const settingsSnapshot = await firebaseDb.ref('lottery_settings').once('value');
  const settings = settingsSnapshot.val() || {};
  if (!isDrawEnabled(settings, drawType)) {
    const error = new Error('DRAW_DISABLED');
    error.statusCode = 409;
    throw error;
  }

  const price = ticketPriceFor(settings, drawType);
  const allowBonus = settings.allowBonus !== false && settings.allowBonusForTickets !== false;
  const operationId = secureOperationId('ticket', uid, requestId);
  const userRef = firebaseDb.ref(`users/${uid}`);
  const now = Date.now();
  let abortCode = '';
  let receipt = null;
  const probe = { __adnorSecureTicketProbe: requestId, createdAt: now };

  const result = await userRef.transaction((profile) => {
    abortCode = '';
    receipt = null;

    if (profile == null) return probe;
    if (profile.__adnorSecureTicketProbe === requestId) {
      abortCode = 'USER_ACCOUNT_NOT_FOUND';
      return;
    }
    if (userFrozen(profile)) {
      abortCode = 'USER_ACCOUNT_FROZEN';
      return;
    }

    const receipts = profile.serverTicketPurchases && typeof profile.serverTicketPurchases === 'object'
      ? { ...profile.serverTicketPurchases }
      : {};
    const existing = receipts[requestId];
    if (existing) {
      if (existing.drawType !== drawType || existing.ticketNumber !== ticketNumber) {
        abortCode = 'REQUEST_ID_REUSED';
        return;
      }
      receipt = existing;
      return profile;
    }

    const split = playableSplit(profile, price, allowBonus);
    if (!split) {
      const total = numberValue(numberValue(profile.realBalance) + numberValue(profile.bonusBalance));
      abortCode = !allowBonus && numberValue(profile.realBalance) < price && total >= price
        ? 'BONUS_PAYMENT_DISABLED'
        : 'INSUFFICIENT_PLAYABLE_BALANCE';
      return;
    }

    receipt = {
      requestId,
      operationId,
      drawType,
      drawLabel: drawLabelServer(drawType),
      ticketNumber,
      price,
      paidFromReal: split.useReal,
      paidFromBonus: split.useBonus,
      realBefore: split.realBefore,
      bonusBefore: split.bonusBefore,
      realAfter: split.realAfter,
      bonusAfter: split.bonusAfter,
      createdAt: now,
      status: 'committed'
    };
    receipts[requestId] = receipt;

    return {
      ...profile,
      realBalance: split.realAfter,
      bonusBalance: split.bonusAfter,
      updatedAt: now,
      serverTicketPurchases: receipts
    };
  }, undefined, false);

  const committed = result.snapshot.val();
  if (result.committed && committed && committed.__adnorSecureTicketProbe === requestId) {
    await userRef.transaction((current) => current && current.__adnorSecureTicketProbe === requestId ? null : current, undefined, false);
    const error = new Error('USER_ACCOUNT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  if (!result.committed) {
    const error = new Error(abortCode || 'DATABASE_TRANSACTION_FAILED');
    error.statusCode = abortCode === 'USER_ACCOUNT_NOT_FOUND' ? 404 : 409;
    throw error;
  }
  if (!receipt) receipt = result.snapshot.val()?.serverTicketPurchases?.[requestId];
  if (!receipt) {
    const error = new Error('DATABASE_TRANSACTION_FAILED');
    error.statusCode = 500;
    throw error;
  }

  const profile = result.snapshot.val() || {};
  const ticket = {
    id: operationId,
    uid,
    userEmail: decodedToken.email || profile.email || '',
    userName: profile.name || profile.displayName || decodedToken.name || 'مستخدم ADNOR',
    number: ticketNumber,
    drawType,
    drawLabel: drawLabelServer(drawType),
    price,
    paidFromReal: receipt.paidFromReal,
    paidFromBonus: receipt.paidFromBonus,
    status: 'active',
    source: 'server_v108',
    createdAt: receipt.createdAt || now
  };
  const playableBefore = numberValue(receipt.realBefore + receipt.bonusBefore);
  const playableAfter = numberValue(receipt.realAfter + receipt.bonusAfter);
  const updates = {};
  updates[`tickets/${drawType}/${operationId}`] = ticket;
  updates[`user_tickets/${uid}/${operationId}`] = ticket;
  updates[`transactions/${uid}/${operationId}`] = {
    id: operationId,
    type: 'ticket_purchase',
    amount: -price,
    balanceBefore: playableBefore,
    balanceAfter: playableAfter,
    realBefore: receipt.realBefore,
    realAfter: receipt.realAfter,
    bonusBefore: receipt.bonusBefore,
    bonusAfter: receipt.bonusAfter,
    paidFromReal: receipt.paidFromReal,
    paidFromBonus: receipt.paidFromBonus,
    note: `شراء تذكرة ${ticketNumber} عبر السيرفر`,
    source: 'server_v108',
    createdAt: receipt.createdAt || now
  };
  updates[`admin_notifications/${operationId}`] = {
    type: 'ticket_purchase', uid, email: decodedToken.email || '',
    text: `شراء تذكرة ${ticketNumber} — ${drawLabelServer(drawType)} — عبر السيرفر`,
    status: 'new', source: 'server_v108', createdAt: receipt.createdAt || now
  };
  await firebaseDb.ref().update(updates);

  return {
    ok: true,
    secure: true,
    ticket,
    balances: {
      realBalance: receipt.realAfter,
      bonusBalance: receipt.bonusAfter,
      playableBalance: playableAfter
    }
  };
}

const DEFAULT_WHEEL_SEGMENTS_V217 = [
  { label: '0x', m: 0, w: 26, enabled: true },
  { label: '1x', m: 1, w: 22, enabled: true },
  { label: '2x', m: 2, w: 15, enabled: true },
  { label: '0x', m: 0, w: 24, enabled: true },
  { label: '100x', m: 100, w: 0.8, enabled: true },
  { label: '1000x', m: 1000, w: 0.08, enabled: false },
  { label: '5000x', m: 5000, w: 0.015, enabled: false },
  { label: '10000x', m: 10000, w: 0.005, enabled: false },
  { label: '0.5x', m: 0.5, w: 12, enabled: true },
  { label: '5x', m: 5, w: 5, enabled: true },
  { label: '10x', m: 10, w: 2, enabled: true },
  { label: '0x', m: 0, w: 24, enabled: true }
];

function wheelSegmentNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeWheelSegments(settings) {
  const raw = Array.isArray(settings && settings.segments) && settings.segments.length
    ? settings.segments
    : DEFAULT_WHEEL_SEGMENTS_V217;
  const normalized = raw.slice(0, 12).map((segment, index) => {
    const enabled = segment && segment.enabled !== false;
    const multiplier = Math.max(0, Math.min(10000, wheelSegmentNumber(segment && (segment.m ?? segment.multiplier), 0)));
    const configuredWeight = Math.max(0, Math.min(1000000, wheelSegmentNumber(segment && (segment.w ?? segment.weight), 0)));
    return {
      index,
      enabled,
      label: String((segment && segment.label) || `${multiplier}x`).slice(0, 50),
      multiplier,
      configuredWeight,
      weight: enabled ? configuredWeight : 0
    };
  }).filter((segment) => Number.isFinite(segment.multiplier) && segment.weight > 0);
  if (!normalized.length) {
    const error = new Error('GAME_CONFIGURATION_INVALID');
    error.statusCode = 500;
    throw error;
  }
  return normalized;
}

function normalizeAdminWheelSegments(inputSegments, currentSegments) {
  const hasInput = Array.isArray(inputSegments) && inputSegments.length;
  const hasCurrent = Array.isArray(currentSegments) && currentSegments.length;
  const source = hasInput ? inputSegments : (hasCurrent ? currentSegments : DEFAULT_WHEEL_SEGMENTS_V217);
  const normalized = source.slice(0, 12).map((segment, index) => {
    const fallback = DEFAULT_WHEEL_SEGMENTS_V217[index] || DEFAULT_WHEEL_SEGMENTS_V217[0];
    const multiplier = Math.max(0, Math.min(10000, wheelSegmentNumber(segment && (segment.m ?? segment.multiplier), fallback.m)));
    const weight = Math.max(0, Math.min(1000000, wheelSegmentNumber(segment && (segment.w ?? segment.weight), fallback.w)));
    const enabled = segment && Object.prototype.hasOwnProperty.call(segment, 'enabled')
      ? segment.enabled !== false
      : (hasInput || hasCurrent ? true : fallback.enabled !== false);
    return {
      label: safeText((segment && segment.label) || `${multiplier}x`, 50) || `${multiplier}x`,
      m: multiplier,
      w: weight,
      enabled
    };
  });
  while (normalized.length < 12) {
    const fallback = DEFAULT_WHEEL_SEGMENTS_V217[normalized.length];
    normalized.push({ ...fallback });
  }
  if (!normalized.some((segment) => segment.enabled && Number(segment.w || 0) > 0)) {
    const error = new Error('WHEEL_SEGMENTS_EMPTY');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function rebalanceWheelSegmentsForTargetRtp(segments, targetRtp) {
  const target = Math.max(0.70, Math.min(1, Number(targetRtp || 0.95)));
  const zeroWeight = segments.filter((segment) => Number(segment.multiplier || 0) === 0).reduce((sum, segment) => sum + Number(segment.weight || 0), 0);
  const positive = segments.filter((segment) => Number(segment.multiplier || 0) > 0);
  const positiveWeight = positive.reduce((sum, segment) => sum + Number(segment.weight || 0), 0);
  const weightedPayout = positive.reduce((sum, segment) => sum + Number(segment.weight || 0) * Number(segment.multiplier || 0), 0);
  const denominator = weightedPayout - target * positiveWeight;
  if (zeroWeight <= 0 || denominator <= 0) return segments;
  const scale = target * zeroWeight / denominator;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 25) return segments;
  return segments.map((segment) => Number(segment.multiplier || 0) > 0 ? { ...segment, weight: Number(segment.weight || 0) * scale } : { ...segment });
}

function wheelWeightedPickAtUnit(segments, unitValue) {
  const weighted = segments.map((segment) => ({
    ...segment,
    scaledWeight: Math.max(1, Math.round(Number(segment.weight || 0) * 1000))
  }));
  const total = weighted.reduce((sum, segment) => sum + segment.scaledWeight, 0);
  const safeUnit = Math.max(0, Math.min(0.999999999999, Number(unitValue || 0)));
  let point = Math.floor(safeUnit * total);
  for (const segment of weighted) {
    if (point < segment.scaledWeight) return segment;
    point -= segment.scaledWeight;
  }
  return weighted[weighted.length - 1];
}

async function getWheelRuntimeConfigV219(force = false) {
  const now = Date.now();
  if (!force && wheelRuntimeCacheV219.value && wheelRuntimeCacheV219.expiresAt > now) {
    return wheelRuntimeCacheV219.value;
  }
  if (!force && wheelRuntimeCacheV219.promise) return wheelRuntimeCacheV219.promise;
  wheelRuntimeCacheV219.promise = Promise.all([
    firebaseDb.ref('wheel_settings').once('value'),
    firebaseDb.ref('game_treasury/settings').once('value')
  ]).then(([settingsSnapshot, treasurySettingsSnapshot]) => {
    const value = {
      settings: settingsSnapshot.val() || {},
      sharedTreasurySettings: normalizeGameTreasurySettings(treasurySettingsSnapshot.val())
    };
    wheelRuntimeCacheV219.value = value;
    wheelRuntimeCacheV219.expiresAt = Date.now() + 4000;
    return value;
  }).finally(() => { wheelRuntimeCacheV219.promise = null; });
  return wheelRuntimeCacheV219.promise;
}

function invalidateWheelRuntimeCacheV219() {
  wheelRuntimeCacheV219.value = null;
  wheelRuntimeCacheV219.expiresAt = 0;
}


function findGameAccountInRootV221(root, decodedToken, publicId = '', preferredUid = '') {
  const users = root && root.users && typeof root.users === 'object' ? root.users : {};
  const authUid = String(decodedToken && decodedToken.uid || '').trim();
  const emailLower = String(decodedToken && decodedToken.email || '').trim().toLowerCase();
  const phoneNumber = normalizeGameAccountPhone(decodedToken && decodedToken.phone_number || '');
  const normalizedPublicId = String(publicId || '').replace(/\D/g, '').slice(0, 18);
  const candidates = new Map();
  const add = (uid) => {
    const key = String(uid || '').trim();
    const profile = users[key];
    if (!key || !isValidFirebaseKey(key) || !gameAccountProfileLooksUsable(profile)) return;
    candidates.set(key, { uid: key, profile });
  };

  add(preferredUid);
  add(authUid);
  add(root?.auth_user_links?.[authUid]);
  if (normalizedPublicId) add(root?.public_user_ids?.[normalizedPublicId]);

  for (const [uid, rawProfile] of Object.entries(users)) {
    const profile = rawProfile && typeof rawProfile === 'object' ? rawProfile : {};
    if (!gameAccountProfileLooksUsable(profile)) continue;
    const uidMatch = uid === authUid || [profile.uid, profile.authUid, profile.firebaseAuthUid, profile.firebaseUid]
      .some((value) => String(value || '') === authUid);
    const profileEmail = String(profile.emailLower || profile.email || '').trim().toLowerCase();
    const emailMatch = !!emailLower && profileEmail === emailLower;
    const profilePhone = normalizeGameAccountPhone(profile.phoneNumber || profile.phone || profile.mobile || '');
    const phoneMatch = !!phoneNumber && profilePhone === phoneNumber;
    const profilePublicId = String(profile.publicId || profile.userId || profile.accountNumber || '').replace(/\D/g, '');
    const publicIdMatch = !!normalizedPublicId && profilePublicId === normalizedPublicId;
    if (uidMatch || emailMatch || phoneMatch || publicIdMatch) add(uid);
  }
  return chooseGameAccountCandidate(candidates, authUid, emailLower);
}

async function wheelRootFallbackV221(decodedToken, body, preferredAccount = null) {
  const startedAt = Date.now();
  const authUid = String(decodedToken && decodedToken.uid || '').trim();
  const requestId = validateGameRequestId(body.requestId || body.idempotencyKey);
  const requestedBet = numberValue(body.bet);
  const publicId = String(body.publicId || '').replace(/\D/g, '').slice(0, 18);
  const [settingsSnapshot, treasurySettingsSnapshot, rootSnapshot] = await Promise.all([
    firebaseDb.ref('wheel_settings').once('value'),
    firebaseDb.ref('game_treasury/settings').once('value'),
    firebaseDb.ref().once('value')
  ]);
  const settings = settingsSnapshot.val() || {};
  const sharedTreasurySettings = normalizeGameTreasurySettings(treasurySettingsSnapshot.val());
  const preflightRoot = rootSnapshot.val();
  if (!preflightRoot || typeof preflightRoot !== 'object') {
    const error = new Error('USER_ACCOUNT_NOT_FOUND'); error.statusCode = 404; throw error;
  }
  if (settings.enabled === false) { const error = new Error('WHEEL_DISABLED'); error.statusCode = 409; throw error; }
  const minBet = Math.max(0.1, numberValue(settings.minBet || 1));
  const maxBet = Math.max(minBet, numberValue(settings.maxBet || 500));
  if (!(requestedBet > 0)) { const error = new Error('INVALID_BET'); error.statusCode = 400; throw error; }
  if (requestedBet < minBet) { const error = new Error('BET_BELOW_MINIMUM'); error.statusCode = 400; throw error; }
  if (requestedBet > maxBet) { const error = new Error('BET_ABOVE_MAXIMUM'); error.statusCode = 400; throw error; }

  let configuredSegments = normalizeWheelSegments(settings);
  configuredSegments = rebalanceWheelSegmentsForTargetRtp(
    configuredSegments,
    (100 - sharedTreasurySettings.platformCutPercent) / 100
  );
  const wheelRoll = secureUnitRandom();
  const now = Date.now();
  const rootRef = firebaseDb.ref();
  const probeId = crypto.randomUUID();
  let response = null;
  let abortCode = '';
  let abortStatus = 409;
  const tx = await rootRef.transaction((transactionRoot) => {
    abortCode = '';
    abortStatus = 409;
    response = null;
    let root = transactionRoot;
    if (root == null) root = { ...preflightRoot, __adnorWheelV221Probe: { id: probeId, createdAt: now } };
    if (root.__adnorWheelV221Probe?.id === probeId) delete root.__adnorWheelV221Probe;
    try {
      const selected = findGameAccountInRootV221(root, decodedToken, publicId, preferredAccount && preferredAccount.uid);
      if (!selected) {
        const error = new Error('USER_ACCOUNT_NOT_FOUND'); error.statusCode = 404; throw error;
      }
      const uid = selected.uid;
      const profile = selected.profile;
      if (userFrozen(profile)) { const error = new Error('ACCOUNT_FROZEN'); error.statusCode = 403; throw error; }
      if (!root.auth_user_links || typeof root.auth_user_links !== 'object') root.auth_user_links = {};
      root.auth_user_links[authUid] = uid;
      profile.uid = String(profile.uid || uid);
      profile.authUid = String(profile.authUid || authUid);
      profile.firebaseAuthUid = String(profile.firebaseAuthUid || authUid);
      profile.firebaseUid = String(profile.firebaseUid || authUid);
      profile.accountLinkUpdatedAt = now;

      const receiptStore = userReceipt(profile, 'wheelV221Root', requestId);
      if (receiptStore.existing) {
        response = { ok: true, secure: true, duplicate: true, fallbackV221: true, elapsedMs: Date.now() - startedAt, result: receiptStore.existing };
        return root;
      }

      const freeSpins = Math.max(0, Number(profile.freeSpins || 0));
      const freeSpin = freeSpins > 0;
      const allowBonus = settings.allowBonus !== false && settings.allowBonusForWheel !== false;
      const split = freeSpin ? {
        realBefore: numberValue(profile.realBalance), bonusBefore: numberValue(profile.bonusBalance),
        useReal: 0, useBonus: 0, realAfter: numberValue(profile.realBalance), bonusAfter: numberValue(profile.bonusBalance)
      } : playableSplit(profile, requestedBet, allowBonus);
      if (!split) {
        const total = numberValue(numberValue(profile.realBalance) + numberValue(profile.bonusBalance));
        const error = new Error(!allowBonus && numberValue(profile.realBalance) < requestedBet && total >= requestedBet
          ? 'BONUS_PAYMENT_DISABLED' : 'INSUFFICIENT_PLAYABLE_BALANCE');
        error.statusCode = 409; throw error;
      }

      const preview = ensureGameTreasuryState(root, 'wheel', 'عجلة الحظ الملكية');
      const edge = preview.settings.platformCutPercent;
      const previewPlatformCut = freeSpin ? 0 : numberValue(split.useReal * edge / 100);
      const previewPlayerPoolAdd = freeSpin ? 0 : numberValue(split.useReal - previewPlatformCut);
      const availableForPayout = numberValue(Number(preview.game.playerPool || 0) + previewPlayerPoolAdd);
      let eligibleSegments = configuredSegments.filter((segment) => {
        if (freeSpin && Number(segment.multiplier || 0) > 2) return false;
        return numberValue(requestedBet * Number(segment.multiplier || 0)) <= availableForPayout;
      });
      let coverageFallback = false;
      if (!eligibleSegments.length) {
        const zeroSegment = configuredSegments.find((segment) => Number(segment.multiplier || 0) === 0);
        eligibleSegments = [zeroSegment || { index: 0, label: '0x', multiplier: 0, weight: 1 }];
        coverageFallback = true;
      }
      const picked = wheelWeightedPickAtUnit(eligibleSegments, wheelRoll);
      const payout = numberValue(requestedBet * Number(picked.multiplier || 0));
      const maximumMultiplier = Math.max(0, ...eligibleSegments.map((segment) => Number(segment.multiplier || 0)));
      const treasury = applyGameTreasuryAccounting(root, {
        gameId: 'wheel', gameName: 'عجلة الحظ الملكية', bet: requestedBet,
        paidFromReal: split.useReal, paidFromBonus: split.useBonus,
        payout, maximumMultiplier, now, promoRound: freeSpin
      });
      const realAfter = numberValue(split.realAfter + payout);
      const bonusAfter = numberValue(split.bonusAfter);
      const operationId = secureOperationId('wheel', uid, requestId);
      const receipt = {
        operationId, requestId, status: 'complete', bet: requestedBet, freeSpin,
        segmentIndex: picked.index, label: picked.label, multiplier: picked.multiplier,
        win: payout, payout, balanceBefore: numberValue(split.realBefore + split.bonusBefore),
        balanceAfter: numberValue(realAfter + bonusAfter), realBefore: split.realBefore,
        bonusBefore: split.bonusBefore, realBalance: realAfter, bonusBalance: bonusAfter,
        paidFromReal: split.useReal, paidFromBonus: split.useBonus,
        platformCut: treasury.platformCut, playerPoolAdd: treasury.playerPoolAdd,
        playerPoolAfter: treasury.game.playerPool, availableForPayout,
        eligibleMultipliers: eligibleSegments.map((segment) => Number(segment.multiplier || 0)),
        coverageFallback, createdAt: now, completedAt: now, source: 'server_v221_root_fallback'
      };
      profile.realBalance = realAfter;
      profile.bonusBalance = bonusAfter;
      profile.freeSpins = freeSpin ? Math.max(0, freeSpins - 1) : freeSpins;
      profile.updatedAt = now;
      receiptStore.bucket[requestId] = receipt;
      const wheelLogs = ensureObjectNode(root, 'wheel_logs');
      if (!wheelLogs[uid] || typeof wheelLogs[uid] !== 'object') wheelLogs[uid] = {};
      wheelLogs[uid][operationId] = {
        id: operationId, uid, email: safeText(decodedToken.email, 220), bet: requestedBet,
        multiplier: picked.multiplier, label: picked.label, win: payout, payout,
        segmentIndex: picked.index, balanceBefore: receipt.balanceBefore, balanceAfter: receipt.balanceAfter,
        realBefore: split.realBefore, realAfter, bonusBefore: split.bonusBefore, bonusAfter,
        paidFromReal: split.useReal, paidFromBonus: split.useBonus,
        platformCut: treasury.platformCut, playerPoolAdd: treasury.playerPoolAdd,
        playerPoolAfter: treasury.game.playerPool, promoSpin: freeSpin,
        secureServer: true, source: 'server_v221_root_fallback', createdAt: now
      };
      storeUserTransaction(root, uid, operationId, {
        type: freeSpin ? 'promo_free_spin' : 'wheel_spin',
        amount: freeSpin ? payout : numberValue(payout - requestedBet),
        balanceBefore: receipt.balanceBefore, balanceAfter: receipt.balanceAfter,
        realBefore: split.realBefore, realAfter, bonusBefore: split.bonusBefore, bonusAfter,
        paidFromReal: split.useReal, paidFromBonus: split.useBonus,
        note: `عجلة الحظ عبر إصلاح V221: ${picked.label}`,
        source: 'server_v221_root_fallback', createdAt: now
      });
      storeAdminNotification(root, operationId, {
        type: 'wheel_spin', uid, email: safeText(decodedToken.email, 220),
        text: `عجلة V221: رهان $${requestedBet} / ${picked.label} / ربح $${payout}`,
        source: 'server_v221_root_fallback', createdAt: now
      });
      response = { ok: true, secure: true, duplicate: false, fallbackV221: true, financialUid: uid, elapsedMs: Date.now() - startedAt, result: receipt };
      return root;
    } catch (error) {
      abortCode = String(error.message || 'DATABASE_TRANSACTION_FAILED');
      abortStatus = Number(error.statusCode || 409);
      return;
    }
  }, undefined, false);

  if (!tx.committed) {
    const error = new Error(abortCode || 'DATABASE_TRANSACTION_FAILED');
    error.statusCode = abortStatus || 409;
    throw error;
  }
  if (!response) {
    const committedRoot = tx.snapshot ? tx.snapshot.val() : null;
    if (committedRoot?.__adnorWheelV221Probe?.id === probeId) {
      try { await rootRef.child('__adnorWheelV221Probe').remove(); } catch {}
      const error = new Error('USER_ACCOUNT_NOT_FOUND'); error.statusCode = 404; throw error;
    }
    const error = new Error('DATABASE_TRANSACTION_FAILED'); error.statusCode = 500; throw error;
  }
  cacheMapSetV219(gameAccountLinkCacheV219, authUid, String(response.financialUid || preferredAccount?.uid || authUid), 30 * 60 * 1000);
  return response;
}

async function secureWheelSpin(decodedToken, body) {
  const startedAt = Date.now();
  let account = await resolveGameAccount(decodedToken, { publicId: body.publicId, allowBootstrap: true });
  let uid = account.uid;
  const requestId = validateGameRequestId(body.requestId || body.idempotencyKey);
  const { settings, sharedTreasurySettings } = await getWheelRuntimeConfigV219(false);

  if (settings.enabled === false) { const error = new Error('WHEEL_DISABLED'); error.statusCode = 409; throw error; }
  const minBet = Math.max(0.1, numberValue(settings.minBet || 1));
  const maxBet = Math.max(minBet, numberValue(settings.maxBet || 500));
  const requestedBet = numberValue(body.bet);
  if (!(requestedBet > 0)) { const error = new Error('INVALID_BET'); error.statusCode = 400; throw error; }
  if (requestedBet < minBet) { const error = new Error('BET_BELOW_MINIMUM'); error.statusCode = 400; throw error; }
  if (requestedBet > maxBet) { const error = new Error('BET_ABOVE_MAXIMUM'); error.statusCode = 400; throw error; }

  let configuredSegments = normalizeWheelSegments(settings);
  configuredSegments = rebalanceWheelSegmentsForTargetRtp(
    configuredSegments,
    (100 - sharedTreasurySettings.platformCutPercent) / 100
  );

  let userRef = firebaseDb.ref(`users/${uid}`);
  let readySnapshot = await userRef.once('value');
  if (!readySnapshot.exists() || !gameAccountProfileLooksUsable(readySnapshot.val())) {
    gameAccountLinkCacheV219.delete(account.authUid);
    account = await resolveGameAccount(decodedToken, {
      publicId: body.publicId,
      allowBootstrap: true,
      force: true
    });
    uid = account.uid;
    userRef = firebaseDb.ref(`users/${uid}`);
    readySnapshot = await userRef.once('value');
    if (!readySnapshot.exists() || !gameAccountProfileLooksUsable(readySnapshot.val())) {
      console.warn('WHEEL_V221_READY_ACCOUNT_FALLBACK', { authUid: account.authUid, financialUid: uid });
      return await wheelRootFallbackV221(decodedToken, body, account);
    }
  }
  const readyProfileForDebit = readySnapshot.val() || account.profile || {};
  const operationId = secureOperationId('wheel', uid, requestId);
  const wheelRoll = secureUnitRandom();
  const now = Date.now();
  let abortCode = '';
  let pendingReceipt = null;
  let completedReceipt = null;

  // Step 1: debit only the requested user's wallet in a small transaction.
  const debitResult = await userRef.transaction((transactionProfile) => {
    abortCode = '';
    pendingReceipt = null;
    completedReceipt = null;
    const profile = transactionProfile && typeof transactionProfile === 'object'
      ? { ...transactionProfile }
      : (gameAccountProfileLooksUsable(readyProfileForDebit) ? { ...readyProfileForDebit } : null);
    if (!profile) { abortCode = 'USER_ACCOUNT_NOT_FOUND'; return; }
    delete profile.__adnorWheelV219Probe;
    delete profile.__adnorWheelV220Probe;
    if (userFrozen(profile)) { abortCode = 'ACCOUNT_FROZEN'; return; }

    const serverReceipts = profile.serverReceipts && typeof profile.serverReceipts === 'object'
      ? { ...profile.serverReceipts } : {};
    const bucket = serverReceipts.wheelV219 && typeof serverReceipts.wheelV219 === 'object'
      ? { ...serverReceipts.wheelV219 } : {};
    const existing = bucket[requestId];
    if (existing) {
      if (numberValue(existing.bet) !== requestedBet) { abortCode = 'REQUEST_ID_REUSED'; return; }
      if (existing.status === 'complete') completedReceipt = existing;
      else if (existing.status === 'pending') pendingReceipt = existing;
      else { abortCode = 'DATABASE_TRANSACTION_FAILED'; return; }
      return profile;
    }

    const freeSpins = Math.max(0, Number(profile.freeSpins || 0));
    const freeSpin = freeSpins > 0;
    const allowBonus = settings.allowBonus !== false && settings.allowBonusForWheel !== false;
    const split = freeSpin ? {
      realBefore: numberValue(profile.realBalance), bonusBefore: numberValue(profile.bonusBalance),
      useReal: 0, useBonus: 0, realAfter: numberValue(profile.realBalance), bonusAfter: numberValue(profile.bonusBalance)
    } : playableSplit(profile, requestedBet, allowBonus);
    if (!split) {
      const total = numberValue(numberValue(profile.realBalance) + numberValue(profile.bonusBalance));
      abortCode = !allowBonus && numberValue(profile.realBalance) < requestedBet && total >= requestedBet
        ? 'BONUS_PAYMENT_DISABLED' : 'INSUFFICIENT_PLAYABLE_BALANCE';
      return;
    }

    pendingReceipt = {
      operationId, requestId, status: 'pending', bet: requestedBet, freeSpin,
      wheelRoll, paidFromReal: split.useReal, paidFromBonus: split.useBonus,
      realBefore: split.realBefore, bonusBefore: split.bonusBefore,
      realAfterDebit: split.realAfter, bonusAfterDebit: split.bonusAfter,
      createdAt: now, updatedAt: now, source: 'server_v221_fast'
    };
    bucket[requestId] = pendingReceipt;
    serverReceipts.wheelV219 = bucket;
    return {
      ...profile,
      realBalance: split.realAfter,
      bonusBalance: split.bonusAfter,
      freeSpins: freeSpin ? Math.max(0, freeSpins - 1) : freeSpins,
      updatedAt: now,
      serverReceipts
    };
  }, undefined, false);

  const debitProfile = debitResult.snapshot ? debitResult.snapshot.val() : null;
  if (!debitResult.committed) {
    if (abortCode === 'USER_ACCOUNT_NOT_FOUND') {
      console.warn('WHEEL_V221_SCOPED_ACCOUNT_FALLBACK', { authUid: account.authUid, financialUid: uid });
      gameAccountLinkCacheV219.delete(account.authUid);
      return await wheelRootFallbackV221(decodedToken, body, account);
    }
    const error = new Error(abortCode || 'DATABASE_TRANSACTION_FAILED');
    error.statusCode = 409;
    throw error;
  }
  if (completedReceipt) {
    return { ok: true, secure: true, fastPath: true, duplicate: true, elapsedMs: Date.now() - startedAt, result: completedReceipt };
  }
  if (!pendingReceipt) pendingReceipt = debitProfile?.serverReceipts?.wheelV219?.[requestId] || null;
  if (!pendingReceipt) { const error = new Error('DATABASE_TRANSACTION_FAILED'); error.statusCode = 500; throw error; }

  let treasuryOutcome = null;
  let treasuryAbortCode = '';
  const treasuryRef = firebaseDb.ref('game_treasury');
  try {
    const treasuryResult = await treasuryRef.transaction((rawTreasury) => {
      treasuryAbortCode = '';
      treasuryOutcome = null;
      const treasuryRoot = rawTreasury && typeof rawTreasury === 'object' ? { ...rawTreasury } : {};
      const receipts = treasuryRoot.wheel_receipts_v219 && typeof treasuryRoot.wheel_receipts_v219 === 'object'
        ? { ...treasuryRoot.wheel_receipts_v219 } : {};
      if (receipts[operationId]) {
        treasuryOutcome = receipts[operationId];
        return treasuryRoot;
      }

      try {
        const wrapper = { game_treasury: treasuryRoot };
        const preview = ensureGameTreasuryState(wrapper, 'wheel', 'عجلة الحظ الملكية');
        const edge = preview.settings.platformCutPercent;
        const previewPlatformCut = pendingReceipt.freeSpin ? 0 : numberValue(pendingReceipt.paidFromReal * edge / 100);
        const previewPlayerPoolAdd = pendingReceipt.freeSpin ? 0 : numberValue(pendingReceipt.paidFromReal - previewPlatformCut);
        const availableForPayout = numberValue(Number(preview.game.playerPool || 0) + previewPlayerPoolAdd);

        let eligibleSegments = configuredSegments.filter((segment) => {
          if (pendingReceipt.freeSpin && Number(segment.multiplier || 0) > 2) return false;
          return numberValue(requestedBet * Number(segment.multiplier || 0)) <= availableForPayout;
        });
        let coverageFallback = false;
        if (!eligibleSegments.length) {
          const zeroSegment = configuredSegments.find((segment) => Number(segment.multiplier || 0) === 0);
          eligibleSegments = [zeroSegment || { index: 0, label: '0x', multiplier: 0, weight: 1 }];
          coverageFallback = true;
        }

        const picked = wheelWeightedPickAtUnit(eligibleSegments, Number(pendingReceipt.wheelRoll ?? wheelRoll));
        const payout = numberValue(requestedBet * Number(picked.multiplier || 0));
        const maximumMultiplier = Math.max(0, ...eligibleSegments.map((segment) => Number(segment.multiplier || 0)));
        const treasury = applyGameTreasuryAccounting(wrapper, {
          gameId: 'wheel', gameName: 'عجلة الحظ الملكية', bet: requestedBet,
          paidFromReal: pendingReceipt.paidFromReal, paidFromBonus: pendingReceipt.paidFromBonus,
          payout, maximumMultiplier, now, promoRound: pendingReceipt.freeSpin
        });
        treasuryOutcome = {
          operationId, requestId, segmentIndex: picked.index, label: picked.label,
          multiplier: picked.multiplier, win: payout, payout,
          platformCut: treasury.platformCut, playerPoolAdd: treasury.playerPoolAdd,
          playerPoolAfter: treasury.game.playerPool, availableForPayout,
          eligibleMultipliers: eligibleSegments.map((segment) => Number(segment.multiplier || 0)),
          coverageFallback, createdAt: now, source: 'server_v221_fast'
        };
        const updatedRoot = wrapper.game_treasury;
        updatedRoot.wheel_receipts_v219 = { ...(updatedRoot.wheel_receipts_v219 || {}), [operationId]: treasuryOutcome };
        return updatedRoot;
      } catch (error) {
        treasuryAbortCode = String(error.message || 'GAME_TREASURY_LOW');
        return;
      }
    }, undefined, false);

    if (!treasuryResult.committed) {
      const error = new Error(treasuryAbortCode || 'GAME_TREASURY_LOW'); error.statusCode = 409; throw error;
    }
    if (!treasuryOutcome) treasuryOutcome = treasuryResult.snapshot.val()?.wheel_receipts_v219?.[operationId] || null;
    if (!treasuryOutcome) { const error = new Error('DATABASE_TRANSACTION_FAILED'); error.statusCode = 500; throw error; }
  } catch (treasuryError) {
    // Refund a debit that could not be reserved in the game treasury.
    await userRef.transaction((profile) => {
      if (!profile || typeof profile !== 'object') return profile;
      const receipt = profile.serverReceipts?.wheelV219?.[requestId];
      if (!receipt || receipt.status !== 'pending') return profile;
      receipt.status = 'refunded';
      receipt.refundedAt = Date.now();
      receipt.refundReason = String(treasuryError.message || 'GAME_TREASURY_LOW');
      profile.realBalance = numberValue(Number(profile.realBalance || 0) + Number(receipt.paidFromReal || 0));
      profile.bonusBalance = numberValue(Number(profile.bonusBalance || 0) + Number(receipt.paidFromBonus || 0));
      if (receipt.freeSpin) profile.freeSpins = Math.max(0, Number(profile.freeSpins || 0) + 1);
      profile.updatedAt = Date.now();
      return profile;
    }, undefined, false);
    throw treasuryError;
  }

  let finalReceipt = null;
  let settleAbortCode = '';
  for (let attempt = 0; attempt < 3 && !finalReceipt; attempt += 1) {
    const settleResult = await userRef.transaction((transactionProfile) => {
      settleAbortCode = '';
      finalReceipt = null;
      const profile = transactionProfile && typeof transactionProfile === 'object'
        ? { ...transactionProfile }
        : (debitProfile && typeof debitProfile === 'object' ? { ...debitProfile } : null);
      if (!profile) { settleAbortCode = 'USER_ACCOUNT_NOT_FOUND'; return; }
      const receipt = profile.serverReceipts?.wheelV219?.[requestId];
      if (!receipt) { settleAbortCode = 'DATABASE_TRANSACTION_FAILED'; return; }
      if (receipt.status === 'complete') { finalReceipt = receipt; return profile; }
      if (receipt.status !== 'pending') { settleAbortCode = 'DATABASE_TRANSACTION_FAILED'; return; }

      const realAfter = numberValue(Number(profile.realBalance || 0) + Number(treasuryOutcome.payout || 0));
      const bonusAfter = numberValue(profile.bonusBalance || 0);
      const playableBefore = numberValue(Number(receipt.realBefore || 0) + Number(receipt.bonusBefore || 0));
      const playableAfter = numberValue(realAfter + bonusAfter);
      finalReceipt = {
        ...receipt,
        ...treasuryOutcome,
        status: 'complete',
        balanceBefore: playableBefore,
        balanceAfter: playableAfter,
        realBalance: realAfter,
        bonusBalance: bonusAfter,
        completedAt: Date.now(),
        updatedAt: Date.now()
      };
      profile.realBalance = realAfter;
      profile.bonusBalance = bonusAfter;
      profile.serverReceipts.wheelV219[requestId] = finalReceipt;
      profile.updatedAt = Date.now();
      return profile;
    }, undefined, false);
    if (!settleResult.committed && attempt === 2) {
      const error = new Error(settleAbortCode || 'DATABASE_TRANSACTION_FAILED'); error.statusCode = 500; throw error;
    }
    if (!finalReceipt) finalReceipt = settleResult.snapshot.val()?.serverReceipts?.wheelV219?.[requestId] || null;
  }
  if (!finalReceipt || finalReceipt.status !== 'complete') { const error = new Error('DATABASE_TRANSACTION_FAILED'); error.statusCode = 500; throw error; }

  // Non-critical audit/log writes are asynchronous so they never hold the wheel UI.
  const logRecord = {
    id: operationId, uid, email: safeText(decodedToken.email, 220), bet: requestedBet,
    multiplier: finalReceipt.multiplier, label: finalReceipt.label,
    win: finalReceipt.payout, payout: finalReceipt.payout,
    segmentIndex: finalReceipt.segmentIndex, balanceBefore: finalReceipt.balanceBefore,
    balanceAfter: finalReceipt.balanceAfter, realBefore: finalReceipt.realBefore,
    realAfter: finalReceipt.realBalance, bonusBefore: finalReceipt.bonusBefore,
    bonusAfter: finalReceipt.bonusBalance, paidFromReal: finalReceipt.paidFromReal,
    paidFromBonus: finalReceipt.paidFromBonus, platformCut: finalReceipt.platformCut,
    playerPoolAdd: finalReceipt.playerPoolAdd, playerPoolAfter: finalReceipt.playerPoolAfter,
    promoSpin: finalReceipt.freeSpin, availableForPayout: finalReceipt.availableForPayout,
    coverageFallback: finalReceipt.coverageFallback, secureServer: true,
    source: 'server_v221_fast', createdAt: finalReceipt.createdAt || now
  };
  const updates = {};
  updates[`wheel_logs/${uid}/${operationId}`] = logRecord;
  updates[`transactions/${uid}/${operationId}`] = {
    id: operationId, type: finalReceipt.freeSpin ? 'promo_free_spin' : 'wheel_spin',
    amount: finalReceipt.freeSpin ? finalReceipt.payout : numberValue(finalReceipt.payout - requestedBet),
    balanceBefore: finalReceipt.balanceBefore, balanceAfter: finalReceipt.balanceAfter,
    realBefore: finalReceipt.realBefore, realAfter: finalReceipt.realBalance,
    bonusBefore: finalReceipt.bonusBefore, bonusAfter: finalReceipt.bonusBalance,
    paidFromReal: finalReceipt.paidFromReal, paidFromBonus: finalReceipt.paidFromBonus,
    note: `عجلة الحظ عبر المسار السريع: ${finalReceipt.label}`,
    source: 'server_v221_fast', createdAt: finalReceipt.createdAt || now
  };
  updates[`admin_notifications/${operationId}`] = {
    id: operationId, status: 'new', type: 'wheel_spin', uid,
    email: safeText(decodedToken.email, 220),
    text: `عجلة سريعة: رهان $${requestedBet} / ${finalReceipt.label} / ربح $${finalReceipt.payout}`,
    source: 'server_v221_fast', createdAt: finalReceipt.createdAt || now
  };
  firebaseDb.ref().update(updates).catch((error) => console.error('WHEEL_V219_AUDIT_WRITE_ERROR', error.message));

  return {
    ok: true, secure: true, fastPath: true, duplicate: false,
    elapsedMs: Date.now() - startedAt, result: finalReceipt
  };
}

async function agentDashboard(decodedToken) {
  const agentAccount = await requireAgent(decodedToken);
  const now = Date.now();
  const currentDayKey = dayKey(now);
  const currentMonthKey = monthKey(now);

  const logsSnapshot = await firebaseDb
    .ref(`agent_recharges_by_agent/${agentAccount.uid}`)
    .limitToLast(60)
    .once('value');

  const agent = agentAccount.profile || {};
  const logs = Object.values(logsSnapshot.val() || {})
    .sort((a, b) => numberValue(b.createdAt) - numberValue(a.createdAt))
    .slice(0, 60);

  return {
    ok: true,
    agent: {
      uid: agentAccount.uid,
      name: agent.name || 'وكيل شحن',
      email: agent.email || agentAccount.email || '',
      loginId: agent.loginId || '',
      active: agent.active !== false,
      agentBalance: agentBalanceFrom(agent),
      totalCharged: numberValue(agent.totalCharged),
      totalOperations: Number(agent.totalOperations || 0),
      dailyLimit: numberValue(agent.dailyLimit),
      monthlyLimit: numberValue(agent.monthlyLimit)
    },
    todayCharged:
      agent.usageDayKey === currentDayKey
        ? numberValue(agent.todayCharged)
        : 0,
    monthCharged:
      agent.usageMonthKey === currentMonthKey
        ? numberValue(agent.monthCharged)
        : 0,
    logs
  };
}

async function reserveAgentBalance({
  agentUid,
  decodedToken,
  requestId,
  targetUid,
  targetId,
  amount,
  note,
  now
}) {
  const currentDayKey = dayKey(now);
  const currentMonthKey = monthKey(now);
  const agentRef = firebaseDb.ref(`agents/${agentUid}`);
  let abortCode = '';
  let reservation = null;
  let newlyDebited = false;

  const transactionProbe = {
    __adnorTransactionProbe: requestId,
    createdAt: now
  };

  const result = await agentRef.transaction(
    (agent) => {
      abortCode = '';
      reservation = null;
      newlyDebited = false;

      // Realtime Database may call a transaction first with null even when
      // remote data exists. Returning a probe allows Firebase to retry with
      // the real server value instead of aborting the operation immediately.
      if (agent == null) {
        return transactionProbe;
      }

      if (agent.__adnorTransactionProbe === requestId) {
        abortCode = 'AGENT_ACCOUNT_NOT_FOUND';
        return;
      }

      if (!isAgentProfile(agent, decodedToken)) {
        abortCode = 'AGENT_ACCOUNT_NOT_FOUND';
        return;
      }

      if (agent.active === false || agent.agentActive === false) {
        abortCode = 'AGENT_ACCOUNT_DISABLED';
        return;
      }

      const requests =
        agent.serverRechargeRequests &&
        typeof agent.serverRechargeRequests === 'object'
          ? { ...agent.serverRechargeRequests }
          : {};

      const existing = requests[requestId];

      if (existing) {
        if (
          String(existing.targetUid || '') !== String(targetUid) ||
          numberValue(existing.amount) !== amount
        ) {
          abortCode = 'REQUEST_ID_REUSED';
          return;
        }

        if (existing.status === 'refunded') {
          abortCode = 'RECHARGE_REQUEST_REFUNDED';
          return;
        }

        reservation = existing;
        newlyDebited = false;
        return agent;
      }

      const balanceBefore = agentBalanceFrom(agent);
      const dailyLimit = numberValue(agent.dailyLimit);
      const monthlyLimit = numberValue(agent.monthlyLimit);
      const todayBefore =
        agent.usageDayKey === currentDayKey
          ? numberValue(agent.todayCharged)
          : 0;
      const monthBefore =
        agent.usageMonthKey === currentMonthKey
          ? numberValue(agent.monthCharged)
          : 0;

      if (balanceBefore < amount) {
        abortCode = 'AGENT_BALANCE_INSUFFICIENT';
        return;
      }

      if (dailyLimit > 0 && todayBefore + amount > dailyLimit) {
        abortCode = 'AGENT_DAILY_LIMIT_EXCEEDED';
        return;
      }

      if (monthlyLimit > 0 && monthBefore + amount > monthlyLimit) {
        abortCode = 'AGENT_MONTHLY_LIMIT_EXCEEDED';
        return;
      }

      const balanceAfter = numberValue(balanceBefore - amount);
      const todayAfter = numberValue(todayBefore + amount);
      const monthAfter = numberValue(monthBefore + amount);

      reservation = {
        requestId,
        status: 'debited',
        targetUid,
        targetId: String(targetId || ''),
        amount,
        note,
        balanceBefore,
        balanceAfter,
        todayBefore,
        todayAfter,
        monthBefore,
        monthAfter,
        dayKey: currentDayKey,
        monthKey: currentMonthKey,
        createdAt: now,
        updatedAt: now
      };

      requests[requestId] = reservation;
      newlyDebited = true;

      return {
        ...agent,
        agentBalance: balanceAfter,
        totalCharged: numberValue(numberValue(agent.totalCharged) + amount),
        totalOperations: Number(agent.totalOperations || 0) + 1,
        usageDayKey: currentDayKey,
        usageMonthKey: currentMonthKey,
        todayCharged: todayAfter,
        monthCharged: monthAfter,
        lastRechargeAt: now,
        updatedAt: now,
        serverRechargeRequests: requests
      };
    },
    undefined,
    false
  );

  const committedAgent = result.snapshot.val();

  if (
    result.committed &&
    committedAgent &&
    committedAgent.__adnorTransactionProbe === requestId
  ) {
    await agentRef.transaction(
      (current) =>
        current && current.__adnorTransactionProbe === requestId
          ? null
          : current,
      undefined,
      false
    );

    const error = new Error('AGENT_ACCOUNT_NOT_FOUND');
    error.statusCode = 403;
    throw error;
  }

  if (!result.committed) {
    const error = new Error(abortCode || 'DATABASE_TRANSACTION_FAILED');
    error.statusCode =
      abortCode === 'AGENT_ACCOUNT_NOT_FOUND' ||
      abortCode === 'AGENT_ACCOUNT_DISABLED'
        ? 403
        : abortCode
          ? 409
          : 500;
    throw error;
  }

  if (!reservation) {
    const current = result.snapshot.val() || {};
    reservation =
      current.serverRechargeRequests &&
      current.serverRechargeRequests[requestId];
  }

  if (!reservation) {
    const error = new Error('DATABASE_TRANSACTION_FAILED');
    error.statusCode = 500;
    throw error;
  }

  return { reservation, newlyDebited };
}

async function creditTargetUser({
  requestId,
  operationId,
  agentUid,
  agentName,
  targetUid,
  amount,
  now
}) {
  const userRef = firebaseDb.ref(`users/${targetUid}`);
  let abortCode = '';
  let creditResult = null;

  const transactionProbe = {
    __adnorUserTransactionProbe: requestId,
    createdAt: now
  };

  const result = await userRef.transaction(
    (user) => {
      abortCode = '';
      creditResult = null;

      // The first transaction callback can receive null before the remote
      // user profile is loaded. Use a probe so Firebase retries safely.
      if (user == null) {
        return transactionProbe;
      }

      if (user.__adnorUserTransactionProbe === requestId) {
        abortCode = 'TARGET_USER_NOT_FOUND';
        return;
      }

      if (
        String(user.role || '').toLowerCase() === 'admin' ||
        user.isAdmin === true
      ) {
        abortCode = 'ADMIN_RECHARGE_BLOCKED';
        return;
      }

      if (user.frozen === true || user.isFrozen === true) {
        abortCode = 'TARGET_USER_FROZEN';
        return;
      }

      const receipts =
        user.serverAgentRechargeReceipts &&
        typeof user.serverAgentRechargeReceipts === 'object'
          ? { ...user.serverAgentRechargeReceipts }
          : {};

      const existing = receipts[requestId];

      if (existing) {
        if (
          String(existing.agentUid || '') !== String(agentUid) ||
          numberValue(existing.amount) !== amount
        ) {
          abortCode = 'REQUEST_ID_REUSED';
          return;
        }

        creditResult = existing;
        return user;
      }

      const balanceBefore = numberValue(user.realBalance);
      const balanceAfter = numberValue(balanceBefore + amount);

      creditResult = {
        requestId,
        operationId,
        agentUid,
        agentName,
        amount,
        balanceBefore,
        balanceAfter,
        createdAt: now
      };

      receipts[requestId] = creditResult;

      return {
        ...user,
        realBalance: balanceAfter,
        updatedAt: now,
        serverAgentRechargeReceipts: receipts
      };
    },
    undefined,
    false
  );

  const committedUser = result.snapshot.val();

  if (
    result.committed &&
    committedUser &&
    committedUser.__adnorUserTransactionProbe === requestId
  ) {
    await userRef.transaction(
      (current) =>
        current && current.__adnorUserTransactionProbe === requestId
          ? null
          : current,
      undefined,
      false
    );

    const error = new Error('TARGET_USER_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }

  if (!result.committed) {
    const error = new Error(abortCode || 'DATABASE_TRANSACTION_FAILED');
    error.statusCode =
      abortCode === 'TARGET_USER_NOT_FOUND'
        ? 404
        : abortCode === 'ADMIN_RECHARGE_BLOCKED' ||
            abortCode === 'TARGET_USER_FROZEN'
          ? 403
          : abortCode
            ? 409
            : 500;
    throw error;
  }

  if (!creditResult) {
    const current = result.snapshot.val() || {};
    creditResult =
      current.serverAgentRechargeReceipts &&
      current.serverAgentRechargeReceipts[requestId];
  }

  if (!creditResult) {
    const error = new Error('DATABASE_TRANSACTION_FAILED');
    error.statusCode = 500;
    throw error;
  }

  return creditResult;
}

async function refundAgentReservation({ agentUid, requestId, now }) {
  const agentRef = firebaseDb.ref(`agents/${agentUid}`);

  await agentRef.transaction(
    (agent) => {
      if (!agent || !agent.serverRechargeRequests) return agent;

      const request = agent.serverRechargeRequests[requestId];

      if (!request || request.status !== 'debited') return agent;

      const amount = numberValue(request.amount);
      const requests = { ...agent.serverRechargeRequests };

      requests[requestId] = {
        ...request,
        status: 'refunded',
        refundedAt: now,
        updatedAt: now
      };

      const currentBalance = agentBalanceFrom(agent);
      const currentToday = numberValue(agent.todayCharged);
      const currentMonth = numberValue(agent.monthCharged);

      return {
        ...agent,
        agentBalance: numberValue(currentBalance + amount),
        totalCharged: Math.max(
          0,
          numberValue(numberValue(agent.totalCharged) - amount)
        ),
        totalOperations: Math.max(0, Number(agent.totalOperations || 0) - 1),
        todayCharged:
          agent.usageDayKey === request.dayKey
            ? Math.max(0, numberValue(currentToday - amount))
            : currentToday,
        monthCharged:
          agent.usageMonthKey === request.monthKey
            ? Math.max(0, numberValue(currentMonth - amount))
            : currentMonth,
        updatedAt: now,
        serverRechargeRequests: requests
      };
    },
    undefined,
    false
  );
}

async function completeRechargeLogs({
  requestId,
  operationId,
  agentAccount,
  reservation,
  targetUid,
  targetUser,
  creditResult,
  amount,
  note,
  now
}) {
  const agentName =
    agentAccount.profile.name || agentAccount.email || 'وكيل شحن';
  const targetName =
    targetUser.name ||
    targetUser.displayName ||
    targetUser.email ||
    'مستخدم ADNOR';
  const targetPublicId = String(
    targetUser.publicId ||
      targetUser.userId ||
      targetUser.accountNumber ||
      ''
  );

  const row = {
    id: operationId,
    requestId,
    agentUid: agentAccount.uid,
    agentName,
    agentEmail: agentAccount.profile.email || agentAccount.email || '',
    targetUid,
    targetName,
    targetUserId: targetPublicId,
    targetPublicId,
    amount,
    note,
    status: 'completed',
    beforeAgentBalance: numberValue(reservation.balanceBefore),
    afterAgentBalance: numberValue(reservation.balanceAfter),
    beforeUserBalance: numberValue(creditResult.balanceBefore),
    afterUserBalance: numberValue(creditResult.balanceAfter),
    todayCharged: numberValue(reservation.todayAfter),
    monthCharged: numberValue(reservation.monthAfter),
    createdAt: Number(reservation.createdAt || now),
    completedAt: now,
    source: 'render_secure_server'
  };

  const updates = {};

  updates[
    `agents/${agentAccount.uid}/serverRechargeRequests/${requestId}/status`
  ] = 'completed';
  updates[
    `agents/${agentAccount.uid}/serverRechargeRequests/${requestId}/operationId`
  ] = operationId;
  updates[
    `agents/${agentAccount.uid}/serverRechargeRequests/${requestId}/completedAt`
  ] = now;
  updates[
    `agents/${agentAccount.uid}/serverRechargeRequests/${requestId}/updatedAt`
  ] = now;
  updates[`agent_recharges/${operationId}`] = row;
  updates[
    `agent_recharges_by_agent/${agentAccount.uid}/${operationId}`
  ] = row;
  updates[`agent_recharges_by_user/${targetUid}/${operationId}`] = row;
  updates[`transactions/${targetUid}/${operationId}_user`] = {
    id: `${operationId}_user`,
    type: 'agent_recharge_credit',
    amount,
    balanceBefore: numberValue(creditResult.balanceBefore),
    balanceAfter: numberValue(creditResult.balanceAfter),
    status: 'completed',
    note,
    agentUid: agentAccount.uid,
    agentName,
    createdAt: now,
    source: 'render_secure_server'
  };
  updates[`transactions/${agentAccount.uid}/${operationId}_agent`] = {
    id: `${operationId}_agent`,
    type: 'agent_wallet_debit',
    amount: -amount,
    balanceBefore: numberValue(reservation.balanceBefore),
    balanceAfter: numberValue(reservation.balanceAfter),
    status: 'completed',
    note: `شحن المستخدم ${targetName}`,
    targetUid,
    createdAt: now,
    source: 'render_secure_server'
  };
  updates[`finance_audit/${operationId}`] = {
    id: operationId,
    action: 'agent_recharge_secure_server',
    requestId,
    agentUid: agentAccount.uid,
    targetUid,
    amount,
    beforeAgentBalance: numberValue(reservation.balanceBefore),
    afterAgentBalance: numberValue(reservation.balanceAfter),
    beforeUserBalance: numberValue(creditResult.balanceBefore),
    afterUserBalance: numberValue(creditResult.balanceAfter),
    note,
    createdAt: now,
    source: 'render_secure_server'
  };
  updates[`user_notifications/${targetUid}/${operationId}`] = {
    id: operationId,
    type: 'agent_recharge',
    title: 'تم شحن رصيدك',
    text: `تم إضافة ${amount}$ إلى رصيدك عبر الوكيل.`,
    message: `تم إضافة ${amount}$ إلى رصيدك عبر الوكيل.`,
    read: false,
    amount,
    agentName,
    rechargeId: operationId,
    createdAt: now
  };
  updates[`admin_notifications/${operationId}`] = {
    id: operationId,
    type: 'agent_recharge_completed_secure',
    agentUid: agentAccount.uid,
    targetUid,
    text: `${agentName} شحن ${amount}$ للمستخدم ${targetName}`,
    status: 'done',
    createdAt: now,
    source: 'render_secure_server'
  };
  updates[
    `server_agent_recharge_operations/${agentAccount.uid}/${requestId}`
  ] = row;

  await firebaseDb.ref().update(updates);

  return row;
}

async function handleAgentRecharge(decodedToken, body) {
  const agentAccount = await requireAgent(decodedToken);
  const targetId = String(body.targetId || '').trim();
  const amount = numberValue(body.amount);
  const note = String(body.note || '').trim().slice(0, 300);
  const requestId = sanitizeRequestId(body.requestId);

  if (amount < 0.01) {
    const error = new Error('INVALID_AMOUNT');
    error.statusCode = 400;
    throw error;
  }

  if (amount > 100000) {
    const error = new Error('AMOUNT_TOO_LARGE');
    error.statusCode = 400;
    throw error;
  }

  const found = await findUserByTargetId(targetId);
  validateTargetUser(agentAccount.uid, found.uid, found.user);

  const now = Date.now();
  const operationId = operationIdFor(agentAccount.uid, requestId);
  const existingOperation = await firebaseDb
    .ref(`server_agent_recharge_operations/${agentAccount.uid}/${requestId}`)
    .once('value');

  if (existingOperation.exists()) {
    const existing = existingOperation.val() || {};

    if (
      String(existing.targetUid || '') !== String(found.uid) ||
      numberValue(existing.amount) !== amount
    ) {
      const error = new Error('REQUEST_ID_REUSED');
      error.statusCode = 409;
      throw error;
    }

    return {
      ok: true,
      id: existing.id || operationId,
      requestId,
      amount,
      targetName: existing.targetName || 'مستخدم ADNOR',
      agentAfter: numberValue(existing.afterAgentBalance),
      userAfter: numberValue(existing.afterUserBalance),
      todayCharged: numberValue(existing.todayCharged),
      monthCharged: numberValue(existing.monthCharged),
      duplicate: true,
      source: 'render_secure_server'
    };
  }

  const reservationResult = await reserveAgentBalance({
    agentUid: agentAccount.uid,
    decodedToken,
    requestId,
    targetUid: found.uid,
    targetId,
    amount,
    note,
    now
  });

  try {
    const agentName =
      agentAccount.profile.name || agentAccount.email || 'وكيل شحن';
    const creditResult = await creditTargetUser({
      requestId,
      operationId,
      agentUid: agentAccount.uid,
      agentName,
      targetUid: found.uid,
      amount,
      now
    });

    const row = await completeRechargeLogs({
      requestId,
      operationId,
      agentAccount,
      reservation: reservationResult.reservation,
      targetUid: found.uid,
      targetUser: found.user,
      creditResult,
      amount,
      note,
      now
    });

    return {
      ok: true,
      id: operationId,
      requestId,
      amount,
      targetName: row.targetName,
      agentAfter: row.afterAgentBalance,
      userAfter: row.afterUserBalance,
      todayCharged: row.todayCharged,
      monthCharged: row.monthCharged,
      duplicate: !reservationResult.newlyDebited,
      source: 'render_secure_server'
    };
  } catch (error) {
    let userWasCredited = false;

    try {
      const receiptSnapshot = await firebaseDb
        .ref(`users/${found.uid}/serverAgentRechargeReceipts/${requestId}`)
        .once('value');
      const receipt = receiptSnapshot.val();

      userWasCredited =
        !!receipt &&
        String(receipt.agentUid || '') === String(agentAccount.uid) &&
        numberValue(receipt.amount) === amount;
    } catch (receiptError) {
      console.error(
        'AGENT_RECEIPT_CHECK_ERROR:',
        receiptError.code || receiptError.message
      );
    }

    if (!userWasCredited) {
      await refundAgentReservation({
        agentUid: agentAccount.uid,
        requestId,
        now: Date.now()
      }).catch((refundError) => {
        console.error(
          'AGENT_REFUND_ERROR:',
          refundError.code || refundError.message
        );
      });
    }

    throw error;
  }
}


const DEFAULT_ADN_ENERGY_CONFIG = Object.freeze({
  enabled: true,
  showPublic: true,
  mode: 'preview',
  title: 'ADN Energy — محطة الطاقة اليومية',
  subtitle: 'جلسة تجميع ترفيهية داخل ADNOR عبر إعلانات مكافأة اختيارية.',
  sessionHours: 24,
  basePoints: 25,
  maxAdsPerSession: 3,
  multiplier1: 1,
  multiplier2: 1.5,
  multiplier3: 2,
  provider: 'google_rewarded',
  googleConnected: false,
  nonCash: true,
  nonTransferable: true,
  cashRedeemable: false,
  roadmap2026: 'إطلاق نظام النقاط والمستويات داخل ADNOR.',
  roadmap2027: 'توسيع استخدامات النقاط في المزايا الداخلية فقط.',
  roadmap2028: 'دراسة استخدامات رقمية جديدة وفق القوانين والتراخيص.'
});

function normalizeEnergyConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const mode = ['preview', 'disabled', 'live'].includes(String(input.mode))
    ? String(input.mode)
    : 'preview';

  return {
    ...DEFAULT_ADN_ENERGY_CONFIG,
    ...input,
    enabled: input.enabled !== false,
    showPublic: input.showPublic !== false,
    mode,
    sessionHours: Math.min(72, Math.max(1, Number(input.sessionHours || 24))),
    basePoints: Math.min(100000, Math.max(0, numberValue(input.basePoints || 25))),
    maxAdsPerSession: 3,
    multiplier1: 1,
    multiplier2: Math.min(2, Math.max(1, Number(input.multiplier2 || 1.5))),
    multiplier3: Math.min(3, Math.max(1, Number(input.multiplier3 || 2))),
    provider: 'google_rewarded',
    googleConnected: input.googleConnected === true && ADN_ENERGY_ADS_LIVE,
    nonCash: true,
    nonTransferable: true,
    cashRedeemable: false
  };
}

async function getEnergyConfig() {
  const snapshot = await firebaseDb
    .ref('system_settings/adn_energy_config')
    .once('value');

  return normalizeEnergyConfig(snapshot.val());
}

function publicEnergyConfig(config) {
  return {
    enabled: config.enabled,
    showPublic: config.showPublic,
    mode: config.mode,
    title: String(config.title || DEFAULT_ADN_ENERGY_CONFIG.title).slice(0, 120),
    subtitle: String(config.subtitle || DEFAULT_ADN_ENERGY_CONFIG.subtitle).slice(0, 500),
    sessionHours: config.sessionHours,
    basePoints: config.basePoints,
    maxAdsPerSession: 3,
    multiplier1: config.multiplier1,
    multiplier2: config.multiplier2,
    multiplier3: config.multiplier3,
    provider: 'google_rewarded',
    googleConnected: config.googleConnected === true,
    nonCash: true,
    nonTransferable: true,
    cashRedeemable: false,
    roadmap2026: String(config.roadmap2026 || DEFAULT_ADN_ENERGY_CONFIG.roadmap2026).slice(0, 300),
    roadmap2027: String(config.roadmap2027 || DEFAULT_ADN_ENERGY_CONFIG.roadmap2027).slice(0, 300),
    roadmap2028: String(config.roadmap2028 || DEFAULT_ADN_ENERGY_CONFIG.roadmap2028).slice(0, 300)
  };
}

async function getEnergyStatus(decodedToken) {
  const config = await getEnergyConfig();
  const snapshot = await firebaseDb
    .ref(`adn_energy/users/${decodedToken.uid}`)
    .once('value');
  const raw = snapshot.val() || {};
  const now = Date.now();
  const sessionEndsAt = Number(raw.sessionEndsAt || 0);
  const active = sessionEndsAt > now;

  return {
    ok: true,
    feature: 'ADN Energy',
    rewardedAds: config.googleConnected ? 'connected' : 'not-connected',
    config: publicEnergyConfig(config),
    user: {
      uid: decodedToken.uid,
      balance: Math.max(0, numberValue(raw.balance || 0)),
      active,
      sessionStartedAt: active ? Number(raw.sessionStartedAt || 0) : 0,
      sessionEndsAt: active ? sessionEndsAt : 0,
      multiplier: active ? Number(raw.multiplier || 1) : 0,
      adsWatched: active ? Math.min(3, Math.max(0, Number(raw.adsWatched || 0))) : 0,
      lastUpdatedAt: Number(raw.updatedAt || 0)
    }
  };
}

async function blockedEnergyAction(decodedToken) {
  const config = await getEnergyConfig();

  if (!config.enabled || config.mode === 'disabled') {
    const error = new Error('ENERGY_DISABLED');
    error.statusCode = 403;
    throw error;
  }

  if (
    config.mode !== 'live' ||
    config.googleConnected !== true ||
    ADN_ENERGY_ADS_LIVE !== true
  ) {
    const error = new Error('ADS_PROVIDER_NOT_CONFIGURED');
    error.statusCode = 503;
    throw error;
  }

  // Deliberately blocked until Google SSV signature verification is added.
  // Never grant points from a browser callback alone.
  const error = new Error('ADS_SSV_NOT_IMPLEMENTED');
  error.statusCode = 501;
  throw error;
}


/* ADNOR V198 — ADMIN COMMAND CENTER + REAL ADN EXCHANGE */
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || 'adhamdeab2@gmail.com,adhamdeab45@gmail.com')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

async function requireAdmin(decodedToken) {
  const email = String(decodedToken.email || '').trim().toLowerCase();
  if (email && ADMIN_EMAILS.has(email)) {
    return { uid: decodedToken.uid, email, role: 'owner' };
  }

  const [adminSnapshot, profileSnapshot] = await Promise.all([
    firebaseDb.ref(`admins/${decodedToken.uid}`).once('value'),
    firebaseDb.ref(`users/${decodedToken.uid}`).once('value')
  ]);
  const profile = profileSnapshot.val() || {};
  const allowed =
    adminSnapshot.val() === true ||
    profile.isAdmin === true ||
    String(profile.role || '').toLowerCase() === 'admin';

  if (!allowed) {
    const error = new Error('ADMIN_ACCESS_DENIED');
    error.statusCode = 403;
    throw error;
  }

  return {
    uid: decodedToken.uid,
    email: email || String(profile.email || '').toLowerCase(),
    role: String(profile.adminRole || profile.role || 'admin')
  };
}

function objectValues(value) {
  return value && typeof value === 'object' ? Object.values(value) : [];
}

function flattenOneLevel(value) {
  const output = [];
  if (!value || typeof value !== 'object') return output;
  for (const [groupKey, groupValue] of Object.entries(value)) {
    if (!groupValue || typeof groupValue !== 'object') continue;
    for (const [id, item] of Object.entries(groupValue)) {
      if (item && typeof item === 'object') output.push({ ...item, id: item.id || id, groupKey });
    }
  }
  return output;
}

function timestampOf(item) {
  if (!item || typeof item !== 'object') return 0;
  return Number(
    item.createdAt || item.updatedAt || item.at || item.lastActivityAt ||
    item.lastSeen || item.lastLoginAt || item.lastLogin || item.publishedAt || 0
  ) || 0;
}

function adminRangeMs(value) {
  const key = String(value || 'today').toLowerCase();
  if (key === '24h' || key === 'today') return 24 * 60 * 60 * 1000;
  if (key === '7d') return 7 * 24 * 60 * 60 * 1000;
  if (key === '30d') return 30 * 24 * 60 * 60 * 1000;
  if (key === '90d') return 90 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function safeUserForAdmin(uid, user) {
  const profile = user || {};
  return {
    uid,
    publicId: String(profile.publicId || profile.userId || profile.accountNumber || ''),
    name: String(profile.name || profile.displayName || 'مستخدم ADNOR'),
    email: String(profile.email || ''),
    phoneNumber: String(profile.phoneNumber || profile.phone || ''),
    country: String(profile.country || ''),
    role: String(profile.role || 'user'),
    isAdmin: profile.isAdmin === true,
    isFrozen: profile.isFrozen === true || profile.frozen === true,
    isVIP: profile.isVIP === true,
    vipUntil: Number(profile.vipUntil || 0),
    realBalance: numberValue(profile.realBalance),
    bonusBalance: numberValue(profile.bonusBalance),
    reservedWithdrawalBalance: numberValue(profile.reservedWithdrawalBalance),
    freeSpins: Math.max(0, Number(profile.freeSpins || 0)),
    freeTickets: Math.max(0, Number(profile.freeTickets || 0)),
    adnEnergyBalance: numberValue(profile.adnEnergyBalance || profile.adnBalance),
    createdAt: Number(profile.createdAt || 0),
    lastLoginAt: Number(profile.lastLoginAt || profile.lastLogin || 0),
    lastActivityAt: Number(profile.lastActivityAt || profile.updatedAt || 0)
  };
}

async function adminOverview(rangeKey) {
  const now = Date.now();
  const from = now - adminRangeMs(rangeKey);
  const paths = [
    'users', 'presence', 'tickets', 'wheel_logs', 'finance/deposits',
    'finance/withdrawals', 'agents', 'admin_support_tickets',
    'admin_notifications', 'agent_recharges', 'draw_history',
    'adn_energy/users', 'system_settings', 'lottery_settings', 'wheel_settings'
  ];
  const snapshots = await Promise.all(paths.map((path) => firebaseDb.ref(path).once('value')));
  const data = Object.fromEntries(paths.map((path, index) => [path, snapshots[index].val() || {}]));

  const usersMap = data.users || {};
  const users = Object.entries(usersMap).map(([uid, user]) => safeUserForAdmin(uid, user));
  const presence = data.presence || {};
  const tickets = flattenOneLevel(data.tickets).filter((item) => timestampOf(item) >= from);
  const wheel = flattenOneLevel(data.wheel_logs).filter((item) => timestampOf(item) >= from);
  const deposits = objectValues(data['finance/deposits']).map((item) => ({ ...item })).filter((item) => timestampOf(item) >= from);
  const withdrawals = objectValues(data['finance/withdrawals']).map((item) => ({ ...item })).filter((item) => timestampOf(item) >= from);
  const agents = objectValues(data.agents);
  const support = objectValues(data.admin_support_tickets);
  const energy = objectValues(data['adn_energy/users']);

  const onlineWindow = 5 * 60 * 1000;
  const activeNow = users.filter((user) => {
    const p = presence[user.uid] || {};
    const presenceTime = Number(p.lastSeen || p.updatedAt || 0);
    return (p.online === true && now - presenceTime <= onlineWindow) || now - user.lastActivityAt <= 15 * 60 * 1000;
  }).length;

  const approvedDeposits = deposits.filter((item) => String(item.status || '').toLowerCase() === 'approved');
  const depositAmountForReport = (item) => String(item.status || '').toLowerCase() === 'approved'
    ? numberValue(item.creditedAmount ?? item.receivedAmount ?? item.approvedAmount ?? item.amount)
    : numberValue(item.amount);
  const approvedWithdrawals = withdrawals.filter((item) => String(item.status || '').toLowerCase() === 'approved');
  const pendingDeposits = objectValues(data['finance/deposits']).filter((item) => String(item.status || 'pending').toLowerCase() === 'pending');
  const pendingWithdrawals = objectValues(data['finance/withdrawals']).filter((item) => String(item.status || 'pending').toLowerCase() === 'pending');
  const ticketRevenue = tickets.reduce((sum, item) => sum + numberValue(item.price || item.amount || 1), 0);
  const wheelBets = wheel.reduce((sum, item) => sum + numberValue(item.bet), 0);
  const wheelPayouts = wheel.reduce((sum, item) => sum + numberValue(item.payout || item.win), 0);
  const balances = users.reduce((sum, user) => ({
    real: numberValue(sum.real + user.realBalance),
    bonus: numberValue(sum.bonus + user.bonusBalance),
    reserved: numberValue(sum.reserved + user.reservedWithdrawalBalance)
  }), { real: 0, bonus: 0, reserved: 0 });

  const activity = [];
  const pushActivity = (type, item, text, amount = null) => activity.push({
    id: String(item.id || `${type}_${timestampOf(item)}`), type, text,
    uid: String(item.uid || item.userUid || ''), email: String(item.email || item.userEmail || ''),
    amount: amount == null ? null : numberValue(amount), createdAt: timestampOf(item), status: String(item.status || '')
  });
  tickets.forEach((item) => pushActivity('ticket', item, `شراء تذكرة ${item.drawLabel || item.drawType || ''}`, -(item.price || 1)));
  wheel.forEach((item) => pushActivity('wheel', item, `جولة عجلة ${item.label || ''}`, numberValue((item.payout || item.win) - (item.bet || 0))));
  deposits.forEach((item) => pushActivity('deposit', item, 'طلب إيداع ' + (item.status || 'pending'), depositAmountForReport(item)));
  withdrawals.forEach((item) => pushActivity('withdraw', item, `طلب سحب ${item.status || 'pending'}`, -(item.amount || 0)));
  objectValues(data.admin_notifications).forEach((item) => pushActivity('notification', item, item.text || item.title || 'نشاط إداري'));
  activity.sort((a, b) => b.createdAt - a.createdAt);

  const hours = Array.from({ length: 24 }, (_, index) => ({ hour: index, tickets: 0, games: 0, deposits: 0 }));
  tickets.forEach((item) => { const d = new Date(timestampOf(item)); if (timestampOf(item) >= now - 24 * 60 * 60 * 1000) hours[d.getHours()].tickets += 1; });
  wheel.forEach((item) => { const d = new Date(timestampOf(item)); if (timestampOf(item) >= now - 24 * 60 * 60 * 1000) hours[d.getHours()].games += 1; });
  deposits.forEach((item) => { const d = new Date(timestampOf(item)); if (timestampOf(item) >= now - 24 * 60 * 60 * 1000) hours[d.getHours()].deposits += depositAmountForReport(item); });

  return {
    ok: true,
    generatedAt: now,
    range: rangeKey || 'today',
    metrics: {
      totalUsers: users.length,
      newUsers: users.filter((user) => user.createdAt >= from).length,
      activeNow,
      vipUsers: users.filter((user) => user.isVIP).length,
      frozenUsers: users.filter((user) => user.isFrozen).length,
      tickets: tickets.length,
      ticketRevenue,
      wheelRounds: wheel.length,
      wheelBets,
      wheelPayouts,
      wheelNet: numberValue(wheelBets - wheelPayouts),
      approvedDeposits: approvedDeposits.reduce((sum, item) => sum + depositAmountForReport(item), 0),
      approvedWithdrawals: approvedWithdrawals.reduce((sum, item) => sum + numberValue(item.amount), 0),
      pendingDeposits: pendingDeposits.length,
      pendingWithdrawals: pendingWithdrawals.length,
      agents: agents.length,
      activeAgents: agents.filter((agent) => agent.active !== false).length,
      agentCredit: agents.reduce((sum, agent) => sum + agentBalanceFrom(agent), 0),
      openSupport: support.filter((item) => !['closed', 'answered'].includes(String(item.status || '').toLowerCase())).length,
      energyUsers: energy.length,
      balances
    },
    charts: { hours },
    recentActivity: activity.slice(0, 80),
    settings: {
      system: data.system_settings || {},
      lottery: data.lottery_settings || {},
      wheel: data.wheel_settings || {}
    }
  };
}

async function adminSearchUsers(query, limitValue) {
  const q = String(query || '').trim().toLowerCase();
  const limit = Math.min(200, Math.max(10, Number(limitValue || 80)));
  const snapshot = await firebaseDb.ref('users').once('value');
  const users = Object.entries(snapshot.val() || {})
    .map(([uid, user]) => safeUserForAdmin(uid, user))
    .filter((user) => !q || [user.uid, user.publicId, user.name, user.email, user.phoneNumber].join(' ').toLowerCase().includes(q))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, limit);
  return { ok: true, users };
}

async function adminUserDetail(uid) {
  if (!isValidFirebaseKey(uid)) {
    const error = new Error('INVALID_USER_ID');
    error.statusCode = 400;
    throw error;
  }
  const paths = [`users/${uid}`, `transactions/${uid}`, `user_tickets/${uid}`, `wheel_logs/${uid}`, `login_logs/${uid}`, `user_notifications/${uid}`];
  const snapshots = await Promise.all(paths.map((path) => firebaseDb.ref(path).once('value')));
  const profile = snapshots[0].val();
  if (!profile) {
    const error = new Error('USER_ACCOUNT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  const sortList = (value, limit = 100) => Object.entries(value || {}).map(([id, item]) => ({ ...(item || {}), id: item?.id || id })).sort((a, b) => timestampOf(b) - timestampOf(a)).slice(0, limit);
  return {
    ok: true,
    user: safeUserForAdmin(uid, profile),
    transactions: sortList(snapshots[1].val()),
    tickets: sortList(snapshots[2].val()),
    wheelRounds: sortList(snapshots[3].val()),
    logins: sortList(snapshots[4].val(), 40),
    notifications: sortList(snapshots[5].val(), 40)
  };
}

async function adminAdjustUserBalance(admin, body) {
  const uid = String(body.uid || '').trim();
  const field = String(body.field || '').trim();
  const amount = numberValue(body.amount);
  const reason = String(body.reason || '').trim().slice(0, 500);
  const allowed = new Set(['realBalance', 'bonusBalance', 'reservedWithdrawalBalance', 'freeSpins', 'freeTickets']);
  if (!isValidFirebaseKey(uid) || !allowed.has(field)) {
    const error = new Error('INVALID_ADMIN_ACTION'); error.statusCode = 400; throw error;
  }
  if (!amount || Math.abs(amount) > 1000000 || !reason) {
    const error = new Error(!reason ? 'ADMIN_REASON_REQUIRED' : 'INVALID_AMOUNT'); error.statusCode = 400; throw error;
  }

  const userRef = firebaseDb.ref(`users/${uid}`);
  let receipt = null;
  const result = await userRef.transaction((profile) => {
    if (!profile) return;
    const before = numberValue(profile[field]);
    const integerField = field === 'freeSpins' || field === 'freeTickets';
    let after = integerField ? Math.floor(before + amount) : numberValue(before + amount);
    if (after < 0) return;
    receipt = { before, after };
    return { ...profile, [field]: after, updatedAt: Date.now() };
  }, undefined, false);
  if (!result.committed || !receipt) {
    const error = new Error('BALANCE_ADJUSTMENT_FAILED'); error.statusCode = 409; throw error;
  }

  const now = Date.now();
  const id = `admin_adjust_${now}_${crypto.randomBytes(4).toString('hex')}`;
  const updates = {};
  updates[`transactions/${uid}/${id}`] = {
    id, type: `admin_${field}_adjust`, amount, field,
    balanceBefore: receipt.before, balanceAfter: receipt.after,
    note: reason, adminUid: admin.uid, adminEmail: admin.email, createdAt: now
  };
  updates[`finance_audit/${id}`] = {
    id, action: `admin_${field}_adjust`, uid, amount, before: receipt.before, after: receipt.after,
    reason, adminUid: admin.uid, adminEmail: admin.email, createdAt: now, source: 'admin_command_center'
  };
  updates[`user_notifications/${uid}/${id}`] = {
    id, type: 'admin_balance_adjust', title: 'تحديث على حسابك',
    text: `تم تحديث ${field} بمقدار ${amount}. السبب: ${reason}`,
    read: false, createdAt: now
  };
  await firebaseDb.ref().update(updates);
  return { ok: true, field, amount, before: receipt.before, after: receipt.after };
}

async function adminSetUserState(admin, body) {
  const uid = String(body.uid || '').trim();
  const action = String(body.action || '').trim();
  const enabled = body.enabled === true;
  const reason = String(body.reason || '').trim().slice(0, 500);
  if (!isValidFirebaseKey(uid) || !['freeze', 'vip'].includes(action)) {
    const error = new Error('INVALID_ADMIN_ACTION'); error.statusCode = 400; throw error;
  }
  const now = Date.now();
  const updates = { [`users/${uid}/updatedAt`]: now };
  if (action === 'freeze') {
    updates[`users/${uid}/isFrozen`] = enabled;
    updates[`users/${uid}/frozen`] = enabled;
    updates[`users/${uid}/freezeReason`] = enabled ? (reason || 'تم التجميد من الإدارة') : '';
    updates[`users/${uid}/frozenAt`] = enabled ? now : 0;
  } else {
    const days = Math.min(3650, Math.max(1, Number(body.days || 30)));
    updates[`users/${uid}/isVIP`] = enabled;
    updates[`users/${uid}/vipUntil`] = enabled ? now + days * 86400000 : 0;
  }
  const id = `admin_state_${now}_${crypto.randomBytes(4).toString('hex')}`;
  updates[`finance_audit/${id}`] = {
    id, action: `${action}_${enabled ? 'on' : 'off'}`, uid, reason,
    adminUid: admin.uid, adminEmail: admin.email, createdAt: now, source: 'admin_command_center'
  };
  updates[`user_notifications/${uid}/${id}`] = {
    id, type: action === 'freeze' ? (enabled ? 'account_freeze' : 'account_unfreeze') : (enabled ? 'vip_on' : 'vip_off'),
    title: action === 'freeze' ? (enabled ? 'تم تجميد الحساب' : 'تم فك تجميد الحساب') : (enabled ? 'تم تفعيل VIP' : 'تم إلغاء VIP'),
    text: reason || 'تم تحديث حالة حسابك من الإدارة.', read: false, createdAt: now
  };
  await firebaseDb.ref().update(updates);
  if (action === 'freeze' && enabled) {
    try { await firebaseAuth.revokeRefreshTokens(uid); } catch (error) { console.warn('REVOKE_TOKEN_FAILED', error.message); }
  }
  return { ok: true, action, enabled };
}

async function adminSendNotification(admin, body) {
  const target = String(body.target || 'all').trim();
  const uid = String(body.uid || '').trim();
  const title = String(body.title || '').trim().slice(0, 120);
  const text = String(body.text || '').trim().slice(0, 1500);
  const link = String(body.link || '').trim().slice(0, 500);
  const image = String(body.image || '').trim().slice(0, 1000);
  if (!title || !text) {
    const error = new Error('NOTIFICATION_CONTENT_REQUIRED'); error.statusCode = 400; throw error;
  }
  const usersSnapshot = await firebaseDb.ref('users').once('value');
  const users = Object.entries(usersSnapshot.val() || {});
  let recipients = users;
  if (target === 'user') recipients = users.filter(([userUid]) => userUid === uid);
  if (target === 'vip') recipients = users.filter(([, profile]) => profile?.isVIP === true);
  if (target === 'active') recipients = users.filter(([, profile]) => Date.now() - Number(profile?.lastActivityAt || profile?.updatedAt || 0) <= 7 * 86400000);
  if (!recipients.length) {
    const error = new Error('NOTIFICATION_TARGET_EMPTY'); error.statusCode = 404; throw error;
  }
  if (recipients.length > 10000) {
    const error = new Error('NOTIFICATION_TARGET_TOO_LARGE'); error.statusCode = 409; throw error;
  }
  const now = Date.now();
  const broadcastId = `broadcast_${now}_${crypto.randomBytes(4).toString('hex')}`;
  const notification = { id: broadcastId, type: 'admin_broadcast', title, text, link, image, read: false, createdAt: now, createdBy: admin.email };
  const updates = {};
  recipients.forEach(([recipientUid]) => { updates[`user_notifications/${recipientUid}/${broadcastId}`] = notification; });
  updates[`admin_broadcasts/${broadcastId}`] = { ...notification, target, uid: target === 'user' ? uid : '', recipientCount: recipients.length };
  updates[`finance_audit/${broadcastId}`] = { id: broadcastId, action: 'admin_broadcast_sent', target, recipientCount: recipients.length, adminUid: admin.uid, adminEmail: admin.email, createdAt: now };
  await firebaseDb.ref().update(updates);
  return { ok: true, broadcastId, recipientCount: recipients.length };
}

async function adminSaveSystemControls(admin, body) {
  const controls = body.controls && typeof body.controls === 'object' ? body.controls : {};
  const allowedKeys = ['registrationEnabled', 'loginEnabled', 'depositEnabled', 'withdrawEnabled', 'lotteryEnabled', 'wheelEnabled', 'gamesEnabled', 'maintenanceMode', 'supportEnabled'];
  const now = Date.now();
  const updates = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(controls, key)) updates[`system_settings/controls/${key}`] = controls[key] === true;
  }
  updates['system_settings/controls/maintenanceMessage'] = String(controls.maintenanceMessage || '').slice(0, 500);
  updates['system_settings/controls/updatedAt'] = now;
  updates['system_settings/controls/updatedBy'] = admin.email;
  const auditId = `controls_${now}_${crypto.randomBytes(4).toString('hex')}`;
  updates[`finance_audit/${auditId}`] = { id: auditId, action: 'system_controls_updated', adminUid: admin.uid, adminEmail: admin.email, controls, createdAt: now };
  await firebaseDb.ref().update(updates);
  return { ok: true };
}

async function adminFinanceList() {
  const [recentDeposits, pendingDeposits, processingDeposits, recentWithdrawals, pendingWithdrawals, processingWithdrawals] = await Promise.all([
    firebaseDb.ref('finance/deposits').orderByChild('createdAt').limitToLast(100).once('value'),
    firebaseDb.ref('finance/deposits').orderByChild('status').equalTo('pending').limitToLast(300).once('value'),
    firebaseDb.ref('finance/deposits').orderByChild('status').equalTo('processing').limitToLast(300).once('value'),
    firebaseDb.ref('finance/withdrawals').orderByChild('createdAt').limitToLast(100).once('value'),
    firebaseDb.ref('finance/withdrawals').orderByChild('status').equalTo('pending').limitToLast(300).once('value'),
    firebaseDb.ref('finance/withdrawals').orderByChild('status').equalTo('processing').limitToLast(300).once('value')
  ]);
  const combine = (...snapshots) => Object.assign({}, ...snapshots.map((snapshot) => snapshot.val() || {}));
  const receiptMigrations = {};
  const list = (value, kind) => Object.entries(value || {}).map(([id, item]) => {
    const source = item && typeof item === 'object' ? item : {};
    const { receiptDataUrl, ...safeItem } = source;
    if (kind === 'deposit' && receiptDataUrl) {
      receiptMigrations[`finance/deposit_receipts/${id}`] = { dataUrl: receiptDataUrl, migratedAt: Date.now() };
      receiptMigrations[`finance/deposits/${id}/receiptAvailable`] = true;
      receiptMigrations[`finance/deposits/${id}/receiptDataUrl`] = null;
      for (const targetUid of new Set([source.financialUid, source.authUid, source.uid].filter((uid) => isValidFirebaseKey(String(uid || ''))))) {
        receiptMigrations[`user_finance/${targetUid}/deposits/${id}/receiptDataUrl`] = null;
      }
    }
    return { ...safeItem, hasReceipt: !!receiptDataUrl || !!source.receiptAvailable, id };
  }).sort((a, b) => timestampOf(b) - timestampOf(a)).slice(0, 300);
  const deposits = list(combine(recentDeposits, pendingDeposits, processingDeposits), 'deposit');
  const withdrawals = list(combine(recentWithdrawals, pendingWithdrawals, processingWithdrawals), 'withdrawal').map((item) => {
    const fallbackMethod = {
      id: safeText(item.methodId || item.method, 120),
      name: safeText(item.methodName || item.method, 160),
      type: safeText(item.methodType || 'withdraw', 40),
      currency: safeText(item.currency, 30),
      network: safeText(item.network, 60)
    };
    const meta = withdrawalMethodMetadata(fallbackMethod, item.destinationDetails || item.destinationAddress || item.details || '');
    return {
      ...item,
      methodId: safeText(item.methodId || item.method, 120),
      methodName: safeText(item.methodName || item.method, 160),
      methodCategory: safeText(item.methodCategory || meta.category, 40),
      currency: safeText(item.currency || meta.currency, 30),
      network: safeText(item.network || meta.network, 60),
      destinationLabel: safeText(item.destinationLabel || meta.destinationLabel, 120),
      destinationAddress: safeText(item.destinationAddress || meta.destinationAddress || item.details, 500),
      destinationDetails: safeText(item.destinationDetails || item.details || meta.destinationDetails, 1000),
      receiverName: safeText(item.receiverName, 180),
      receiverNote: safeText(item.receiverNote || item.note, 500)
    };
  });
  if (Object.keys(receiptMigrations).length) await firebaseDb.ref().update(receiptMigrations);
  return { ok: true, deposits, withdrawals };
}
function buildDepositRequestMirrorUpdates(deposit, id, status, details = {}) {
  const now = Date.now();
  const authUid = String(deposit.authUid || deposit.uid || '').trim();
  const financialUid = String(deposit.financialUid || deposit.uid || authUid).trim();
  const requestedAmount = numberValue(deposit.requestedAmount ?? deposit.amount);
  const creditedAmount = status === 'approved'
    ? numberValue(details.creditedAmount ?? deposit.creditedAmount ?? deposit.receivedAmount ?? deposit.approvedAmount ?? requestedAmount)
    : 0;
  const reason = safeText(details.rejectReason || deposit.rejectReason || 'مرفوض من الإدارة', 500);
  const note = status === 'approved'
    ? `تم اعتماد الإيداع. المطلوب $${requestedAmount}، والمضاف فعليًا $${creditedAmount}.`
    : status === 'rejected'
      ? `تم رفض طلب الإيداع. السبب: ${reason}`
      : status === 'processing'
        ? 'طلب الإيداع قيد المعالجة لدى الإدارة.'
        : `طلب إيداع عبر ${safeText(deposit.methodName || deposit.method || 'طريقة الدفع', 160)}`;
  const reviewStatus = status === 'approved' ? 'تمت الموافقة'
    : status === 'rejected' ? 'مرفوض'
      : status === 'processing' ? 'قيد المعالجة' : 'بانتظار مراجعة الإدارة';
  const safeDeposit = { ...deposit };
  delete safeDeposit.receiptDataUrl;
  const safeDetails = { ...details };
  delete safeDetails.receiptDataUrl;
  if (status === 'approved' || status === 'rejected') {
    delete safeDeposit.processingAction;
    delete safeDeposit.processingAt;
    delete safeDeposit.processingBy;
    delete safeDeposit.processingAmount;
  }
  const updates = {};
  for (const targetUid of new Set([financialUid, authUid].filter(Boolean))) {
    updates[`user_finance/${targetUid}/deposits/${id}`] = {
      ...safeDeposit, ...safeDetails, status, reviewStatus, updatedAt: now
    };
    updates[`transactions/${targetUid}/deposit_request_${id}`] = {
      id: `deposit_request_${id}`,
      type: 'deposit_request',
      amount: requestedAmount,
      requestedAmount,
      creditedAmount,
      status,
      note,
      requestId: id,
      rejectReason: status === 'rejected' ? reason : '',
      createdAt: Number(deposit.createdAt || now),
      processedAt: status === 'approved' || status === 'rejected' ? Number(details.processedAt || now) : 0
    };
  }
  if (typeof details.receiptDataUrl === 'string' && details.receiptDataUrl.startsWith('data:image/')) {
    updates[`finance/deposit_receipts/${id}`] = { dataUrl: details.receiptDataUrl, createdAt: Number(deposit.createdAt || now) };
    updates[`finance/deposits/${id}/receiptAvailable`] = true;
  }
  const terminal = status === 'approved' || status === 'rejected';
  updates[`admin_notifications/deposit_${id}`] = {
    id: `deposit_${id}`,
    type: 'deposit_request',
    uid: financialUid,
    authUid,
    financialUid,
    email: safeText(deposit.email || '', 220),
    text: terminal ? note : `طلب إيداع جديد بقيمة $${requestedAmount} عبر ${safeText(deposit.methodName || deposit.method || 'طريقة الدفع', 160)}`,
    requestId: id,
    status: terminal ? 'done' : 'new',
    resolution: terminal ? status : '',
    adminEmail: safeText(details.adminEmail || '', 220),
    createdAt: Number(deposit.createdAt || now),
    updatedAt: now
  };
  return updates;
}

async function adminDepositReceipt(id) {
  if (!isValidFirebaseKey(id)) { const error = new Error('INVALID_FINANCE_REQUEST'); error.statusCode = 400; throw error; }
  const receiptPath = `finance/deposit_receipts/${id}`;
  const [receiptSnapshot, legacySnapshot] = await Promise.all([
    firebaseDb.ref(receiptPath).once('value'),
    firebaseDb.ref(`finance/deposits/${id}`).once('value')
  ]);
  const stored = receiptSnapshot.val() || {};
  let dataUrl = String(stored.dataUrl || '');
  const legacy = legacySnapshot.val() || {};
  if (!dataUrl && legacy.receiptDataUrl) {
    dataUrl = String(legacy.receiptDataUrl);
    await firebaseDb.ref().update({
      [receiptPath]: { dataUrl, migratedAt: Date.now() },
      [`finance/deposits/${id}/receiptAvailable`]: true,
      [`finance/deposits/${id}/receiptDataUrl`]: null
    });
  }
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) { const error = new Error('DEPOSIT_RECEIPT_NOT_FOUND'); error.statusCode = 404; throw error; }
  const image = Buffer.from(match[2], 'base64');
  if (!image.length || image.length > 1100000) { const error = new Error('DEPOSIT_RECEIPT_INVALID'); error.statusCode = 413; throw error; }
  return { mimeType: match[1].toLowerCase(), image };
}
async function resolveDepositFinancialAccount(deposit) {
  const authUid = String(deposit.authUid || deposit.uid || '').trim();
  const savedFinancialUid = String(deposit.financialUid || '').trim();
  if (savedFinancialUid) {
    if (!isValidFirebaseKey(savedFinancialUid)) {
      const error = new Error('USER_ACCOUNT_NOT_FOUND'); error.statusCode = 404; throw error;
    }
    const profileSnapshot = await firebaseDb.ref('users/' + savedFinancialUid).once('value');
    const profile = profileSnapshot.val() || null;
    if (!profileSnapshot.exists() || !profile || typeof profile !== 'object') {
      const error = new Error('USER_ACCOUNT_NOT_FOUND'); error.statusCode = 404; throw error;
    }
    return { authUid, uid: savedFinancialUid, profile, linked: authUid !== savedFinancialUid, source: 'deposit_financial_uid' };
  }
  return resolveWithdrawalFinancialAccount({
    uid: authUid,
    email: String(deposit.email || ''),
    phone_number: String(deposit.phoneNumber || deposit.phone || '')
  }, { publicId: deposit.publicId || '' });
}

async function adminProcessDeposit(admin, body) {
  const id = String(body.id || '').trim();
  const action = String(body.action || '').trim();
  const reason = String(body.reason || '').trim().slice(0, 500);
  if (!isValidFirebaseKey(id) || !['approve', 'reject'].includes(action)) {
    const error = new Error('INVALID_ADMIN_ACTION'); error.statusCode = 400; throw error;
  }

  const requestRef = firebaseDb.ref('finance/deposits/' + id);
  const initialSnapshot = await requestRef.once('value');
  const initial = initialSnapshot.val();
  if (!initialSnapshot.exists() || !initial || typeof initial !== 'object') {
    const error = new Error('INVALID_FINANCE_REQUEST'); error.statusCode = 404; throw error;
  }

  const initialStatus = String(initial.status || 'pending').toLowerCase();
  const wantedStatus = action === 'approve' ? 'approved' : 'rejected';
  const oppositeStatus = action === 'approve' ? 'rejected' : 'approved';
  if (initialStatus === wantedStatus) {
    const previousAmount = numberValue(initial.creditedAmount || initial.approvedAmount || initial.amount);
    const terminalDetails = action === 'approve'
      ? { creditedAmount: previousAmount, processedAt: initial.approvedAt || Date.now(), adminEmail: initial.approvedBy || admin.email }
      : { rejectReason: initial.rejectReason || 'مرفوض من الإدارة', processedAt: initial.rejectedAt || Date.now(), adminEmail: initial.rejectedBy || admin.email };
    await firebaseDb.ref().update(buildDepositRequestMirrorUpdates(initial, id, wantedStatus, terminalDetails));
    return { ok: true, alreadyProcessed: true, status: wantedStatus, amount: previousAmount, requestedAmount: numberValue(initial.requestedAmount || initial.amount), creditedAmount: action === 'approve' ? previousAmount : 0, balanceAfter: numberValue(initial.balanceAfter), financialUid: initial.financialUid || initial.uid };
  }
  if (initialStatus === oppositeStatus) {
    const error = new Error('FINANCE_REQUEST_ALREADY_PROCESSED'); error.statusCode = 409; throw error;
  }
  if (initialStatus !== 'pending' && initialStatus !== 'processing') {
    const error = new Error('FINANCE_REQUEST_NOT_PENDING'); error.statusCode = 409; throw error;
  }
  if (initialStatus === 'processing' && initial.processingAction && initial.processingAction !== action) {
    const error = new Error('FINANCE_REQUEST_PROCESSING'); error.statusCode = 409; throw error;
  }

  const requestedAmount = Number(numberValue(initial.requestedAmount ?? initial.amount).toFixed(2));
  if (!(requestedAmount > 0) || requestedAmount > 1000000) {
    const error = new Error('INVALID_FINANCE_REQUEST'); error.statusCode = 400; throw error;
  }
  const suppliedAmount = body.creditedAmount ?? body.receivedAmount ?? body.actualReceivedAmount;
  const hasSuppliedAmount = suppliedAmount !== undefined && suppliedAmount !== null && String(suppliedAmount).trim() !== '';
  const account = action === 'approve' ? await resolveDepositFinancialAccount(initial) : null;
  const financialUid = String(account ? account.uid : (initial.financialUid || initial.uid || '')).trim();
  const authUid = String(initial.authUid || (account && account.authUid) || initial.uid || '').trim();
  if (!isValidFirebaseKey(financialUid) || !isValidFirebaseKey(authUid)) {
    const error = new Error('INVALID_FINANCE_REQUEST'); error.statusCode = 400; throw error;
  }

  let previousReceipt = null;
  if (account && account.profile.serverAdminDepositReceipts && typeof account.profile.serverAdminDepositReceipts === 'object') {
    previousReceipt = account.profile.serverAdminDepositReceipts[id] || null;
  }
  const roundMoney = (value) => Number(numberValue(value).toFixed(2));
  let creditedAmount = action === 'approve'
    ? roundMoney(hasSuppliedAmount ? suppliedAmount : (previousReceipt && previousReceipt.amount || initial.processingAmount || initial.creditedAmount || requestedAmount))
    : 0;
  if (action === 'approve' && (!(creditedAmount > 0) || creditedAmount > 1000000)) {
    const error = new Error('INVALID_DEPOSIT_AMOUNT'); error.statusCode = 400; throw error;
  }
  if (action === 'approve' && previousReceipt && Math.abs(roundMoney(previousReceipt.amount) - creditedAmount) > 0.001) {
    const error = new Error('DEPOSIT_CREDIT_AMOUNT_LOCKED'); error.statusCode = 409; throw error;
  }
  const existingProcessingAmount = roundMoney(initial.processingAmount || initial.creditedAmount || 0);
  if (action === 'approve' && initialStatus === 'processing' && existingProcessingAmount > 0 && Math.abs(existingProcessingAmount - creditedAmount) > 0.001) {
    const error = new Error('DEPOSIT_CREDIT_AMOUNT_LOCKED'); error.statusCode = 409; throw error;
  }

  const now = Date.now();
  const claim = await requestRef.transaction((current) => {
    if (!current || typeof current !== 'object') return;
    const state = String(current.status || 'pending').toLowerCase();
    if (state === 'pending') {
      return {
        ...current,
        status: 'processing',
        processingAction: action,
        processingAmount: action === 'approve' ? creditedAmount : null,
        processingAt: now,
        processingBy: admin.email
      };
    }
    if (state === 'processing' && (!current.processingAction || current.processingAction === action)) {
      const lockedAmount = roundMoney(current.processingAmount || current.creditedAmount || 0);
      if (action === 'approve' && lockedAmount > 0 && Math.abs(lockedAmount - creditedAmount) > 0.001) return;
      return {
        ...current,
        processingAction: action,
        processingAmount: action === 'approve' ? (lockedAmount || creditedAmount) : null,
        processingAt: current.processingAt || now,
        processingBy: current.processingBy || admin.email
      };
    }
    return;
  }, undefined, false);

  let deposit = null;
  if (claim.committed) {
    deposit = claim.snapshot.val() || initial;
  } else {
    const latestSnapshot = await requestRef.once('value');
    const latest = latestSnapshot.val() || null;
    const latestStatus = String(latest && latest.status || '').toLowerCase();
    if (latestStatus === wantedStatus) {
      const previousAmount = numberValue(latest.creditedAmount || latest.approvedAmount || latest.amount);
      return { ok: true, alreadyProcessed: true, status: wantedStatus, amount: previousAmount, requestedAmount: numberValue(latest.requestedAmount || latest.amount), creditedAmount: action === 'approve' ? previousAmount : 0, balanceAfter: numberValue(latest.balanceAfter), financialUid: latest.financialUid || latest.uid };
    }
    const latestAction = String(latest && latest.processingAction || action);
    const latestAmount = roundMoney(latest && (latest.processingAmount || latest.creditedAmount) || 0);
    if (latestStatus !== 'processing' || latestAction !== action || (action === 'approve' && latestAmount > 0 && Math.abs(latestAmount - creditedAmount) > 0.001)) {
      const error = new Error('FINANCE_REQUEST_NOT_PENDING'); error.statusCode = 409; throw error;
    }
    deposit = latest;
  }

  if (action === 'reject') {
    const updates = {};
    updates['finance/deposits/' + id + '/status'] = 'rejected';
    updates['finance/deposits/' + id + '/rejectedAt'] = now;
    updates['finance/deposits/' + id + '/rejectedBy'] = admin.email;
    updates['finance/deposits/' + id + '/rejectReason'] = reason || 'مرفوض من الإدارة';
    updates['finance/deposits/' + id + '/processingAction'] = null;
    updates['finance/deposits/' + id + '/processingAt'] = null;
    updates['finance/deposits/' + id + '/processingBy'] = null;
    updates['finance/deposits/' + id + '/processingAmount'] = null;
    Object.assign(updates, buildDepositRequestMirrorUpdates(deposit, id, 'rejected', {
      rejectReason: reason || 'مرفوض من الإدارة', rejectedAt: now, rejectedBy: admin.email,
      processedAt: now, adminEmail: admin.email
    }));
    updates['user_notifications/' + authUid + '/deposit_' + id] = { id: 'deposit_' + id, type: 'deposit_rejected', title: 'تم رفض الإيداع', text: 'تم رفض طلب الإيداع بقيمة $' + requestedAmount + '. السبب: ' + (reason || 'راجع الدعم'), read: false, createdAt: now };
    updates['finance_audit/deposit_' + id] = { id: 'deposit_' + id, action: 'deposit_rejected', requestId: id, uid: financialUid, authUid, amount: requestedAmount, requestedAmount, reason, adminEmail: admin.email, createdAt: now };
    await firebaseDb.ref().update(updates);
    return { ok: true, status: 'rejected', requestedAmount, financialUid };
  }

  const settingsSnapshot = await firebaseDb.ref('system_settings/referral').once('value');
  const referralSettings = settingsSnapshot.val() || {};
  const bonusPercent = referralSettings.depositBonusEnabled ? Math.max(0, Number(referralSettings.depositBonusPercent || 0)) : 0;
  const bonusAdd = roundMoney(creditedAmount * bonusPercent / 100);
  const userRef = firebaseDb.ref('users/' + financialUid);
  let receipt = null;
  let receiptConflict = false;
  const result = await userRef.transaction((profile) => {
    if (!profile || typeof profile !== 'object') return;
    const receipts = profile.serverAdminDepositReceipts && typeof profile.serverAdminDepositReceipts === 'object' ? { ...profile.serverAdminDepositReceipts } : {};
    if (receipts[id]) {
      receipt = receipts[id];
      if (Math.abs(roundMoney(receipt.amount) - creditedAmount) > 0.001) {
        receiptConflict = true;
        return;
      }
      return profile;
    }
    const realBefore = roundMoney(profile.realBalance);
    const bonusBefore = roundMoney(profile.bonusBalance);
    receipt = {
      realBefore,
      realAfter: roundMoney(realBefore + creditedAmount),
      bonusBefore,
      bonusAfter: roundMoney(bonusBefore + bonusAdd),
      amount: creditedAmount,
      requestedAmount,
      bonusAdd,
      createdAt: now
    };
    receipts[id] = receipt;
    return { ...profile, realBalance: receipt.realAfter, bonusBalance: receipt.bonusAfter, serverAdminDepositReceipts: receipts, updatedAt: now };
  }, undefined, false);

  if (receiptConflict) {
    const error = new Error('DEPOSIT_CREDIT_AMOUNT_LOCKED'); error.statusCode = 409; throw error;
  }
  if (!result.committed || !receipt) {
    const error = new Error('DATABASE_TRANSACTION_FAILED'); error.statusCode = 409; throw error;
  }

  const finalBonusAdd = roundMoney(receipt.bonusAdd);
  const updates = {};
  updates['finance/deposits/' + id + '/status'] = 'approved';
  updates['finance/deposits/' + id + '/requestedAmount'] = requestedAmount;
  updates['finance/deposits/' + id + '/receivedAmount'] = creditedAmount;
  updates['finance/deposits/' + id + '/creditedAmount'] = creditedAmount;
  updates['finance/deposits/' + id + '/approvedAmount'] = creditedAmount;
  updates['finance/deposits/' + id + '/financialUid'] = financialUid;
  updates['finance/deposits/' + id + '/authUid'] = authUid;
  updates['finance/deposits/' + id + '/approvedAt'] = now;
  updates['finance/deposits/' + id + '/approvedBy'] = admin.email;
  updates['finance/deposits/' + id + '/balanceBefore'] = receipt.realBefore;
  updates['finance/deposits/' + id + '/balanceAfter'] = receipt.realAfter;
  updates['finance/deposits/' + id + '/bonusBefore'] = receipt.bonusBefore;
  updates['finance/deposits/' + id + '/bonusAfter'] = receipt.bonusAfter;
  updates['finance/deposits/' + id + '/processingAction'] = null;
  updates['finance/deposits/' + id + '/processingAt'] = null;
  updates['finance/deposits/' + id + '/processingBy'] = null;
  updates['finance/deposits/' + id + '/processingAmount'] = null;
  Object.assign(updates, buildDepositRequestMirrorUpdates(deposit, id, 'approved', {
    requestedAmount, creditedAmount, receivedAmount: creditedAmount, approvedAmount: creditedAmount,
    approvedAt: now, approvedBy: admin.email, processedAt: now,
    balanceBefore: receipt.realBefore, balanceAfter: receipt.realAfter,
    bonusBefore: receipt.bonusBefore, bonusAfter: receipt.bonusAfter, adminEmail: admin.email
  }));
  for (const targetUid of new Set([financialUid, authUid])) {
    const transactionPrefix = 'transactions/' + targetUid + '/deposit_' + id;
    updates[transactionPrefix] = { id: 'deposit_' + id, type: 'deposit_approved', amount: creditedAmount, requestedAmount, balanceBefore: receipt.realBefore, balanceAfter: receipt.realAfter, status: 'approved', note: 'قبول إيداع فعلي ' + id, adminEmail: admin.email, createdAt: now };
    if (finalBonusAdd > 0) {
      updates['transactions/' + targetUid + '/deposit_bonus_' + id] = { id: 'deposit_bonus_' + id, type: 'deposit_bonus', amount: finalBonusAdd, balanceBefore: receipt.bonusBefore, balanceAfter: receipt.bonusAfter, status: 'bonus', note: 'بونص إيداع ' + bonusPercent + '%', adminEmail: admin.email, createdAt: now + 1 };
    }
  }
  updates['user_notifications/' + authUid + '/deposit_' + id] = { id: 'deposit_' + id, type: 'deposit_approved', title: 'تم قبول الإيداع', text: 'تمت إضافة المبلغ الواصل $' + creditedAmount + ' إلى رصيدك الحقيقي. المبلغ المطلوب كان $' + requestedAmount + '.', read: false, createdAt: now };
  updates['finance_audit/deposit_' + id] = { id: 'deposit_' + id, action: 'deposit_approved', requestId: id, uid: financialUid, authUid, requestedAmount, receivedAmount: creditedAmount, creditedAmount, bonusAdd: finalBonusAdd, balanceBefore: receipt.realBefore, balanceAfter: receipt.realAfter, adminEmail: admin.email, createdAt: now };
  updates['referral_account_refresh/' + authUid] = { operationId: 'deposit_' + id + '_' + now, role: 'deposit', financialUid, updatedAt: now };
  await firebaseDb.ref().update(updates);
  return { ok: true, status: 'approved', requestedAmount, receivedAmount: creditedAmount, creditedAmount, amount: creditedAmount, bonusAdd: finalBonusAdd, balanceBefore: receipt.realBefore, balanceAfter: receipt.realAfter, financialUid };
}

async function adminProcessWithdrawal(admin, body) {
  const id = String(body.id || '').trim();
  const action = String(body.action || '').trim();
  const reason = String(body.reason || '').trim().slice(0, 500);
  if (!isValidFirebaseKey(id) || !['approve', 'reject'].includes(action)) {
    const error = new Error('INVALID_ADMIN_ACTION'); error.statusCode = 400; throw error;
  }

  const requestRef = firebaseDb.ref(`finance/withdrawals/${id}`);
  const verifiedRequestSnapshot = await requestRef.once('value');
  const verifiedRequest = verifiedRequestSnapshot.val();
  if (!verifiedRequestSnapshot.exists() || !verifiedRequest || typeof verifiedRequest !== 'object') {
    const error = new Error('INVALID_FINANCE_REQUEST'); error.statusCode = 404; throw error;
  }
  const now = Date.now();
  const wantedStatus = action === 'approve' ? 'approved' : 'rejected';
  const oppositeStatus = action === 'approve' ? 'rejected' : 'approved';
  const staleProcessingMs = 90 * 1000;
  let withdrawal = null;
  let claimOutcome = '';

  // V225: idempotent claim. A stale admin screen may still show "pending"
  // after the server already completed the request. Repeating the same action
  // must return success and refresh the UI, not report a misleading error.
  const claim = await requestRef.transaction((rawCurrent) => {
    claimOutcome = '';
    withdrawal = null;
    // Realtime Database can provisionally invoke a transaction with null.
    // Use the request that was verified immediately before the claim; Firebase
    // retries with the authoritative server value when it becomes available.
    const current = rawCurrent && typeof rawCurrent === 'object'
      ? { ...rawCurrent }
      : { ...verifiedRequest };

    const currentStatus = String(current.status || 'pending').toLowerCase();
    if (currentStatus === wantedStatus) {
      claimOutcome = 'already-same';
      withdrawal = current;
      return current;
    }
    if (currentStatus === oppositeStatus) {
      claimOutcome = 'already-other';
      withdrawal = current;
      return;
    }
    if (currentStatus === 'processing') {
      const processingAt = Number(current.processingAt || 0);
      const processingAge = processingAt > 0 ? now - processingAt : staleProcessingMs + 1;
      if (processingAge < staleProcessingMs) {
        claimOutcome = 'processing';
        withdrawal = current;
        return;
      }
      // A server restart/network failure can leave a request in processing.
      // Reclaim only after the lock is stale; the receipt below prevents any
      // duplicate reserved-balance settlement.
    } else if (currentStatus !== 'pending') {
      claimOutcome = 'not-pending';
      withdrawal = current;
      return;
    }

    claimOutcome = 'claimed';
    withdrawal = current;
    return {
      ...current,
      status: 'processing',
      processingAction: action,
      processingAt: now,
      processingBy: admin.email
    };
  }, undefined, false);

  if (claimOutcome === 'already-same' && withdrawal) {
    return {
      ok: true,
      status: wantedStatus,
      amount: numberValue(withdrawal.amount),
      alreadyProcessed: true,
      refreshed: true
    };
  }
  if (claimOutcome === 'already-other') {
    const error = new Error('FINANCE_REQUEST_FINALIZED_OTHER');
    error.statusCode = 409;
    error.details = { currentStatus: String(withdrawal?.status || '') };
    throw error;
  }
  if (claimOutcome === 'processing') {
    const error = new Error('FINANCE_REQUEST_PROCESSING'); error.statusCode = 409; throw error;
  }
  if (!claim.committed || claimOutcome !== 'claimed' || !withdrawal) {
    const error = new Error('FINANCE_REQUEST_NOT_PENDING'); error.statusCode = 409; throw error;
  }

  const uid = String(withdrawal.uid || withdrawal.financialUid || '');
  const amount = numberValue(withdrawal.amount);
  if (!isValidFirebaseKey(uid) || !(amount > 0)) {
    await requestRef.update({ status: 'pending', processingAction: null, processingAt: null, processingBy: null });
    const error = new Error('INVALID_FINANCE_REQUEST'); error.statusCode = 400; throw error;
  }

  const userRef = firebaseDb.ref(`users/${uid}`);
  const verifiedSnapshot = await userRef.once('value');
  const verifiedProfile = verifiedSnapshot.val();
  if (!verifiedSnapshot.exists() || !verifiedProfile || typeof verifiedProfile !== 'object') {
    await requestRef.update({ status: 'pending', processingAction: null, processingAt: null, processingBy: null });
    const error = new Error('USER_ACCOUNT_NOT_FOUND'); error.statusCode = 404; throw error;
  }

  let receipt = null;
  let receiptConflict = false;
  const result = await userRef.transaction((rawProfile) => {
    receiptConflict = false;
    // Firebase may provisionally call a transaction with null. Use the profile
    // that was read and verified immediately before the transaction.
    const profile = rawProfile && typeof rawProfile === 'object'
      ? { ...rawProfile }
      : { ...verifiedProfile };
    const receipts = profile.serverAdminWithdrawalReceipts && typeof profile.serverAdminWithdrawalReceipts === 'object'
      ? { ...profile.serverAdminWithdrawalReceipts }
      : {};

    if (receipts[id]) {
      if (String(receipts[id].action || '') !== action) {
        receiptConflict = true;
        return;
      }
      receipt = receipts[id];
      return profile;
    }

    const realBefore = numberValue(profile.realBalance);
    const reservedBefore = numberValue(profile.reservedWithdrawalBalance);
    // The amount was reserved when the user created the request. Never allow a
    // negative reserved balance, and never deduct the real balance again here.
    const reservedAfter = numberValue(Math.max(0, reservedBefore - amount));
    const realAfter = action === 'reject' ? numberValue(realBefore + amount) : realBefore;
    receipt = { action, realBefore, realAfter, reservedBefore, reservedAfter, amount, createdAt: now };
    receipts[id] = receipt;
    return {
      ...profile,
      realBalance: realAfter,
      reservedWithdrawalBalance: reservedAfter,
      serverAdminWithdrawalReceipts: receipts,
      updatedAt: now
    };
  }, undefined, false);

  if (receiptConflict) {
    await requestRef.update({ status: oppositeStatus, processingAction: null, processingAt: null, processingBy: null });
    const error = new Error('FINANCE_REQUEST_FINALIZED_OTHER'); error.statusCode = 409; throw error;
  }
  if (!result.committed || !receipt) {
    await requestRef.update({ status: 'pending', processingAction: null, processingAt: null, processingBy: null });
    const error = new Error('DATABASE_TRANSACTION_FAILED'); error.statusCode = 409; throw error;
  }

  const status = wantedStatus;
  const updates = {};
  updates[`finance/withdrawals/${id}/status`] = status;
  updates[`finance/withdrawals/${id}/${status}At`] = now;
  updates[`finance/withdrawals/${id}/${status}By`] = admin.email;
  if (status === 'rejected') updates[`finance/withdrawals/${id}/rejectReason`] = reason || 'مرفوض من الإدارة';
  updates[`finance/withdrawals/${id}/processingAction`] = null;
  updates[`finance/withdrawals/${id}/processingAt`] = null;
  updates[`finance/withdrawals/${id}/processingBy`] = null;
  updates[`user_finance/${uid}/withdrawals/${id}/status`] = status;
  updates[`transactions/${uid}/withdraw_${id}`] = {
    id: `withdraw_${id}`,
    type: status === 'approved' ? 'withdraw_approved' : 'withdraw_rejected_refund',
    amount: status === 'approved' ? -amount : amount,
    balanceBefore: receipt.realBefore,
    balanceAfter: receipt.realAfter,
    reservedBefore: receipt.reservedBefore,
    reservedAfter: receipt.reservedAfter,
    status,
    note: status === 'approved' ? `تم تنفيذ السحب ${id}` : `رفض السحب وإرجاع المبلغ: ${reason || ''}`,
    adminEmail: admin.email,
    createdAt: now
  };
  updates[`user_notifications/${uid}/withdraw_${id}`] = {
    id: `withdraw_${id}`,
    type: status === 'approved' ? 'withdraw_approved' : 'withdraw_rejected',
    title: status === 'approved' ? 'تم تنفيذ السحب' : 'تم رفض السحب',
    text: status === 'approved'
      ? `تم تنفيذ طلب السحب بقيمة $${amount}.`
      : `تم رفض السحب وإرجاع $${amount} إلى رصيدك. السبب: ${reason || 'راجع الدعم'}`,
    read: false,
    createdAt: now
  };
  updates[`finance_audit/withdraw_${id}`] = {
    id: `withdraw_${id}`,
    action: status === 'approved' ? 'withdraw_approved' : 'withdraw_rejected_refund',
    requestId: id,
    uid,
    amount,
    reason,
    methodId: safeText(withdrawal.methodId || withdrawal.method, 120),
    methodName: safeText(withdrawal.methodName, 160),
    currency: safeText(withdrawal.currency, 30),
    network: safeText(withdrawal.network, 60),
    destinationAddress: safeText(withdrawal.destinationAddress || withdrawal.details, 500),
    receiverName: safeText(withdrawal.receiverName, 180),
    adminEmail: admin.email,
    createdAt: now
  };
  await firebaseDb.ref().update(updates);
  return { ok: true, status, amount, alreadyProcessed: false, refreshed: true };
}


/* ADNOR V204 — UNIFIED FINANCE, REFERRALS, AND MASTER ADMIN */
const PUBLIC_SITE_URL = String(process.env.PUBLIC_SITE_URL || 'https://aadnor.onrender.com').replace(/\/$/, '');

function safeText(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function safeBoolean(value, fallback = false) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function requestKey(prefix, uid, requestId) {
  const clean = sanitizeRequestId(requestId) || crypto.randomBytes(12).toString('hex');
  const hash = crypto.createHash('sha256').update(`${prefix}|${uid}|${clean}`).digest('hex').slice(0, 28);
  return `${prefix}_${hash}`;
}

async function readSystemControls() {
  const snapshot = await firebaseDb.ref('system_settings/controls').once('value');
  const raw = snapshot.val() || {};
  return {
    registrationEnabled: raw.registrationEnabled !== false,
    loginEnabled: raw.loginEnabled !== false,
    depositEnabled: raw.depositEnabled !== false,
    withdrawEnabled: raw.withdrawEnabled !== false,
    lotteryEnabled: raw.lotteryEnabled !== false,
    wheelEnabled: raw.wheelEnabled !== false,
    gamesEnabled: raw.gamesEnabled !== false,
    supportEnabled: raw.supportEnabled !== false,
    maintenanceMode: raw.maintenanceMode === true,
    maintenanceMessage: safeText(raw.maintenanceMessage, 500),
    ...raw
  };
}

function paymentMethodSupports(method, mode) {
  if (!method || typeof method !== 'object' || method.active === false || method.enabled === false) return false;
  const type = String(method.type || method.mode || 'both').toLowerCase();
  if (mode === 'deposit') return ['deposit', 'both', 'إيداع', 'إيداع وسحب'].includes(type);
  return ['withdraw', 'withdrawal', 'both', 'سحب', 'إيداع وسحب'].includes(type);
}

async function getPaymentMethod(methodId, mode) {
  const id = safeText(methodId, 120);
  if (!isValidFirebaseKey(id)) {
    const error = new Error('PAYMENT_METHOD_REQUIRED'); error.statusCode = 400; throw error;
  }
  const snapshot = await firebaseDb.ref(`payment_methods/${id}`).once('value');
  const method = snapshot.val();
  if (!paymentMethodSupports(method, mode)) {
    const error = new Error('PAYMENT_METHOD_NOT_AVAILABLE'); error.statusCode = 409; throw error;
  }
  return { id, ...method };
}

function withdrawalMethodMetadata(method, destinationInput) {
  const name = safeText(method && (method.name || method.title || method.id), 160);
  const haystack = [
    method && method.id,
    name,
    method && method.details,
    method && method.hint,
    method && method.currency,
    method && method.network
  ].map((value) => String(value || '').toLowerCase()).join(' ');

  let category = 'other';
  let currency = safeText(method && method.currency, 30);
  let network = safeText(method && method.network, 60);
  let destinationLabel = 'بيانات الاستلام';

  if (haystack.includes('usdt') || haystack.includes('trc20') || haystack.includes('crypto') || haystack.includes('عملات رقمية')) {
    category = 'crypto';
    currency = currency || 'USDT';
    network = network || (haystack.includes('trc20') ? 'TRC20' : 'Crypto');
    destinationLabel = network === 'TRC20' ? 'عنوان محفظة USDT TRC20' : 'عنوان المحفظة الرقمية';
  } else if (haystack.includes('sham') || haystack.includes('شام')) {
    category = 'sham_cash';
    currency = currency || 'USD / TRY';
    network = network || 'Sham Cash';
    destinationLabel = 'رقم حساب ShamCash';
  } else if (haystack.includes('bank') || haystack.includes('iban') || haystack.includes('بنك') || haystack.includes('بنكي')) {
    category = 'bank';
    currency = currency || 'USD';
    network = network || 'Bank / IBAN';
    destinationLabel = 'IBAN / بيانات الحساب البنكي';
  } else {
    currency = currency || 'USD';
    network = network || name || 'Manual';
  }

  const destinationDetails = safeText(destinationInput, 1000);
  let destinationAddress = destinationDetails.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || destinationDetails;
  const tronAddress = destinationDetails.match(/\bT[1-9A-HJ-NP-Za-km-z]{33}\b/);
  const iban = destinationDetails.replace(/\s+/g, ' ').match(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/i);
  if (tronAddress) destinationAddress = tronAddress[0];
  else if (iban) destinationAddress = iban[0].replace(/\s+/g, '').toUpperCase();

  return {
    category,
    currency,
    network,
    destinationLabel,
    destinationAddress: safeText(destinationAddress, 500),
    destinationDetails
  };
}

async function createDepositRequest(decodedToken, body) {
  if (!MANUAL_DEPOSITS_ENABLED) {
    const error = new Error('MANUAL_DEPOSIT_DISABLED');
    error.statusCode = 409;
    throw error;
  }
  const controls = await readSystemControls();
  if (!controls.depositEnabled || controls.maintenanceMode) {
    const error = new Error('DEPOSIT_DISABLED'); error.statusCode = 409; throw error;
  }
  const account = await resolveWithdrawalFinancialAccount(decodedToken, { publicId: body.publicId });
  const uid = account.uid;
  const authUid = account.authUid;
  const profile = account.profile;
  const rawAmount = Number(body.amount);
  const amount = Number.isFinite(rawAmount) ? Number(rawAmount.toFixed(2)) : 0;
  if (!(amount > 0) || amount > 1000000) {
    const error = new Error('INVALID_DEPOSIT_AMOUNT'); error.statusCode = 400; throw error;
  }
  const method = await getPaymentMethod(body.methodId || body.method, 'deposit');
  const min = Math.max(0, numberValue(method.minDeposit || method.minimum || 0));
  if (min && amount < min) {
    const error = new Error('DEPOSIT_BELOW_MINIMUM'); error.statusCode = 409; error.details = { minimum: min }; throw error;
  }
  if (userFrozen(profile)) { const error = new Error('ACCOUNT_FROZEN'); error.statusCode = 403; throw error; }

  const receiptDataUrl = String(body.receiptDataUrl || '');
  if (receiptDataUrl && !receiptDataUrl.startsWith('data:image/')) {
    const error = new Error('RECEIPT_IMAGE_INVALID'); error.statusCode = 400; throw error;
  }
  if (Buffer.byteLength(receiptDataUrl, 'utf8') > 1400000) {
    const error = new Error('RECEIPT_TOO_LARGE'); error.statusCode = 413; throw error;
  }

  const id = requestKey('dep', uid, body.requestId);
  const now = Date.now();
  const record = {
    id,
    uid,
    authUid,
    financialUid: uid,
    publicId: safeText(body.publicId || profile.publicId || '', 30),
    email: safeText(decodedToken.email || profile.email, 220),
    phoneNumber: safeText(decodedToken.phone_number || profile.phoneNumber || profile.phone || '', 40),
    name: safeText(profile.name || profile.displayName || decodedToken.name, 160),
    amount,
    requestedAmount: amount,
    method: method.id,
    methodName: safeText(method.name || method.title || method.id, 160),
    methodAddress: safeText(method.address || method.account || '', 500),
    reference: safeText(body.reference, 300),
    receiptAvailable: !!receiptDataUrl,
    receiptFileName: safeText(body.receiptFileName, 180),
    status: 'pending',
    reviewStatus: 'بانتظار مراجعة الإدارة',
    createdAt: now,
    source: 'server_v228_manual_deposit'
  };

  if (receiptDataUrl) {
    await firebaseDb.ref(`finance/deposit_receipts/${id}`).set({ dataUrl: receiptDataUrl, createdAt: now });
  }
  let existing = null;
  const claim = await firebaseDb.ref('finance/deposits/' + id).transaction((current) => {
    if (current) { existing = current; return current; }
    return record;
  }, undefined, false);
  if (!claim.committed) { const error = new Error('DATABASE_TRANSACTION_FAILED'); error.statusCode = 409; throw error; }
  if (existing) {
    const existingStatus = String(existing.status || 'pending').toLowerCase();
    const details = existingStatus === 'approved'
      ? { creditedAmount: existing.creditedAmount || existing.receivedAmount || existing.approvedAmount || existing.amount, processedAt: existing.approvedAt || now, adminEmail: existing.approvedBy || '' }
      : existingStatus === 'rejected'
        ? { rejectReason: existing.rejectReason || 'مرفوض من الإدارة', processedAt: existing.rejectedAt || now, adminEmail: existing.rejectedBy || '' }
        : {};
    await firebaseDb.ref().update(buildDepositRequestMirrorUpdates(existing, id, existingStatus, { ...details, receiptDataUrl }));
    return { ok: true, duplicate: true, request: { ...existing, receiptDataUrl: undefined } };
  }

  await firebaseDb.ref().update(buildDepositRequestMirrorUpdates(record, id, 'pending', { receiptDataUrl }));
  return { ok: true, duplicate: false, request: { ...record, receiptDataUrl: undefined } };
}

async function reserveUniqueUsdtAmount(uid, intentId, baseCents, expiresAt) {
  const now = Date.now();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const verificationUnits = crypto.randomInt(1, 5000);
    const expectedRaw = BigInt(baseCents) * 10000n + BigInt(verificationUnits);
    const amountKey = expectedRaw.toString();
    const reservationRef = firebaseDb.ref(`finance/usdt_amount_reservations/${amountKey}`);
    const claim = await reservationRef.transaction((current) => {
      const active = current &&
        String(current.status || 'pending') === 'pending' &&
        Number(current.expiresAt || 0) > now;
      if (active) return;
      return {
        amountKey,
        intentId,
        uid,
        status: 'pending',
        createdAt: now,
        expiresAt
      };
    }, undefined, false);
    if (claim.committed) return { expectedRaw: amountKey, verificationUnits };
  }
  const error = new Error('TRON_DEPOSIT_AMOUNT_RESERVATION_FAILED');
  error.statusCode = 409;
  throw error;
}

async function createAutomaticUsdtDeposit(decodedToken, body) {
  const controls = await readSystemControls();
  if (!controls.depositEnabled || controls.maintenanceMode) {
    const error = new Error('DEPOSIT_DISABLED');
    error.statusCode = 409;
    throw error;
  }
  if (!tronDepositConfigured()) {
    const error = new Error('TRON_DEPOSIT_NOT_CONFIGURED');
    error.statusCode = 503;
    throw error;
  }

  const uid = decodedToken.uid;
  const baseCents = usdCents(body.amount);
  const minCents = usdCents(TRON_DEPOSIT_MIN_USD);
  const maxCents = usdCents(TRON_DEPOSIT_MAX_USD);
  if (baseCents < minCents || baseCents > maxCents) {
    const error = new Error('INVALID_DEPOSIT_AMOUNT');
    error.statusCode = 400;
    error.details = { minimum: TRON_DEPOSIT_MIN_USD, maximum: TRON_DEPOSIT_MAX_USD };
    throw error;
  }

  const profileSnapshot = await firebaseDb.ref(`users/${uid}`).once('value');
  const profile = profileSnapshot.val();
  if (!profile) {
    const error = new Error('USER_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  if (userFrozen(profile)) {
    const error = new Error('ACCOUNT_FROZEN');
    error.statusCode = 403;
    throw error;
  }

  const now = Date.now();
  const userIntentsSnapshot = await firebaseDb.ref(`user_finance/${uid}/usdt_intents`).once('value');
  const activeIntent = Object.values(userIntentsSnapshot.val() || {})
    .filter((item) => item && item.status === 'pending' && Number(item.expiresAt || 0) > now)
    .sort((first, second) => Number(second.createdAt || 0) - Number(first.createdAt || 0))[0];
  if (activeIntent) {
    return {
      ok: true,
      duplicate: true,
      intent: {
        id: activeIntent.id,
        status: activeIntent.status,
        baseAmount: activeIntent.baseAmount,
        expectedUsdt: activeIntent.expectedUsdt,
        address: TRON_DEPOSIT_ADDRESS,
        network: 'TRC20',
        asset: 'USDT',
        expiresAt: activeIntent.expiresAt,
        createdAt: activeIntent.createdAt
      }
    };
  }

  const id = requestKey('usdt', uid, body.requestId);
  const existingSnapshot = await firebaseDb.ref(`finance/usdt_intents/${id}`).once('value');
  const existing = existingSnapshot.val();
  if (existing) {
    if (existing.uid !== uid) {
      const error = new Error('TRON_DEPOSIT_REQUEST_NOT_FOUND');
      error.statusCode = 404;
      throw error;
    }
    return {
      ok: true,
      duplicate: true,
      intent: {
        id,
        status: existing.status,
        baseAmount: existing.baseAmount,
        expectedUsdt: existing.expectedUsdt,
        address: TRON_DEPOSIT_ADDRESS,
        network: 'TRC20',
        asset: 'USDT',
        expiresAt: existing.expiresAt,
        createdAt: existing.createdAt
      }
    };
  }

  const expiresAt = now + TRON_DEPOSIT_INTENT_TTL_MS;
  const expectedRaw = (BigInt(baseCents) * 10000n).toString();
  const expectedUsdt = (baseCents / 100).toFixed(2);
  const record = {
    id,
    uid,
    email: safeText(decodedToken.email || profile.email, 220),
    name: safeText(profile.name || profile.displayName || decodedToken.name, 160),
    status: 'pending',
    baseAmount: baseCents / 100,
    baseCents,
    expectedRaw,
    expectedUsdt,
    asset: 'USDT',
    network: 'TRC20',
    depositAddress: TRON_DEPOSIT_ADDRESS,
    contractAddress: TRON_USDT_CONTRACT,
    createdAt: now,
    expiresAt,
    source: 'server_v208_txid_actual_amount'
  };

  {
    const updates = {};
    updates[`finance/usdt_intents/${id}`] = record;
    updates[`finance/usdt_pending/${id}`] = {
      id,
      uid,
      expectedRaw: record.expectedRaw,
      createdAt: now,
      expiresAt
    };
    updates[`user_finance/${uid}/usdt_intents/${id}`] = record;
    updates[`transactions/${uid}/usdt_deposit_intent_${id}`] = {
      id: `usdt_deposit_intent_${id}`,
      type: 'usdt_deposit_intent',
      amount: record.baseAmount,
      status: 'pending',
      note: `بانتظار ${expectedUsdt} USDT عبر TRC20`,
      requestId: id,
      createdAt: now
    };
    await firebaseDb.ref().update(updates);
  }

  return {
    ok: true,
    duplicate: false,
    intent: {
      id,
      status: record.status,
      baseAmount: record.baseAmount,
      expectedUsdt,
      address: TRON_DEPOSIT_ADDRESS,
      network: 'TRC20',
      asset: 'USDT',
      expiresAt,
      createdAt: now
    }
  };
}

async function findConfirmedUsdtTransfer(intent) {
  const minimumTimestamp = Math.max(0, Number(intent.createdAt || 0) - 10000);
  let fingerprint = '';
  for (let page = 0; page < 5; page += 1) {
    const payload = await tronGridJson(
      `/v1/accounts/${encodeURIComponent(TRON_DEPOSIT_ADDRESS)}/transactions/trc20`,
      {
        only_confirmed: true,
        only_to: true,
        contract_address: TRON_USDT_CONTRACT,
        min_timestamp: minimumTimestamp,
        order_by: 'block_timestamp,desc',
        limit: 200,
        fingerprint
      }
    );

    const rows = Array.isArray(payload.data) ? payload.data : [];
    for (const row of rows) {
      if (!row || String(row.value || '') !== String(intent.expectedRaw || '')) continue;
      const transferType = String(row.type || '').trim().toLowerCase();
      if (!['transfer', 'transferfrom'].includes(transferType)) continue;
      if (!sameTronAddress(row.to, TRON_DEPOSIT_ADDRESS)) continue;
      const token = row.token_info || {};
      if (!sameTronAddress(token.address, TRON_USDT_CONTRACT)) continue;
      if (Number(token.decimals ?? TRON_USDT_DECIMALS) !== TRON_USDT_DECIMALS) continue;
      const timestamp = Number(row.block_timestamp || 0);
      if (timestamp < minimumTimestamp) continue;
      const txid = String(row.transaction_id || '').trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(txid)) continue;
      return {
        txid,
        from: normalizeTronAddress(row.from),
        to: normalizeTronAddress(row.to),
        rawAmount: String(row.value),
        receivedUsdt: formatTokenRaw(String(row.value), TRON_USDT_DECIMALS),
        blockTimestamp: timestamp,
        tokenSymbol: safeText(token.symbol || 'USDT', 20),
        tokenName: safeText(token.name || 'Tether USD', 80)
      };
    }

    fingerprint = String(payload.meta && payload.meta.fingerprint || '');
    if (!fingerprint || rows.length < 200) break;
  }
  return null;
}


async function findConfirmedUsdtTransferByTxid(intent, txidInput) {
  const wanted = String(txidInput || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(wanted)) {
    const error = new Error('TRON_DEPOSIT_TXID_INVALID'); error.statusCode = 400; throw error;
  }
  const minimumTimestamp = Math.max(0, Number(intent.createdAt || 0) - 10000);
  let fingerprint = '';
  for (let page = 0; page < 8; page += 1) {
    const payload = await tronGridJson(`/v1/accounts/${encodeURIComponent(TRON_DEPOSIT_ADDRESS)}/transactions/trc20`, {
      only_confirmed: true, only_to: true, contract_address: TRON_USDT_CONTRACT,
      min_timestamp: minimumTimestamp, order_by: 'block_timestamp,desc', limit: 200, fingerprint
    });
    const rows = Array.isArray(payload.data) ? payload.data : [];
    for (const row of rows) {
      const txid = String(row && row.transaction_id || '').trim().toLowerCase();
      if (txid !== wanted) continue;
      const token = row.token_info || {};
      if (!sameTronAddress(row.to, TRON_DEPOSIT_ADDRESS) || !sameTronAddress(token.address, TRON_USDT_CONTRACT)) continue;
      if (Number(token.decimals ?? TRON_USDT_DECIMALS) !== TRON_USDT_DECIMALS) continue;
      const timestamp = Number(row.block_timestamp || 0);
      if (timestamp < minimumTimestamp) continue;
      const receivedUsdt = formatTokenRaw(String(row.value), TRON_USDT_DECIMALS);
      const amountCents = tokenRawToUsdCents(String(row.value), TRON_USDT_DECIMALS);
      if (amountCents < usdCents(TRON_DEPOSIT_MIN_USD)) {
        const error = new Error('TRON_DEPOSIT_BELOW_MINIMUM'); error.statusCode = 400;
        error.details = { receivedUsdt, minimum: TRON_DEPOSIT_MIN_USD }; throw error;
      }
      return { txid, from: normalizeTronAddress(row.from), to: normalizeTronAddress(row.to), rawAmount: String(row.value), receivedUsdt, amountCents, blockTimestamp: timestamp, tokenSymbol: safeText(token.symbol || 'USDT',20), tokenName: safeText(token.name || 'Tether USD',80) };
    }
    fingerprint = String(payload.meta && payload.meta.fingerprint || '');
    if (!fingerprint || rows.length < 200) break;
  }
  return null;
}

async function creditAutomaticUsdtDeposit(intent, transfer) {
  const claimRef = firebaseDb.ref(`finance/usdt_tx_claims/${transfer.txid}`);
  const now = Date.now();
  let existingClaim = null;
  const claim = await claimRef.transaction((current) => {
    if (current && current.status === 'processing' && Number(current.createdAt || 0) < now - 5 * 60 * 1000) {
      return {
        txid: transfer.txid,
        uid: intent.uid,
        intentId: intent.id,
        status: 'processing',
        createdAt: now,
        recovered: true
      };
    }
    if (current) {
      existingClaim = current;
      return current;
    }
    return {
      txid: transfer.txid,
      uid: intent.uid,
      intentId: intent.id,
      status: 'processing',
      createdAt: now
    };
  }, undefined, false);

  if (!claim.committed) {
    const error = new Error('DATABASE_TRANSACTION_FAILED');
    error.statusCode = 409;
    throw error;
  }

  if (existingClaim) {
    if (existingClaim.uid === intent.uid && existingClaim.intentId === intent.id && existingClaim.status === 'credited') {
      const latest = await firebaseDb.ref(`finance/usdt_intents/${intent.id}`).once('value');
      return { duplicate: true, intent: latest.val() || intent };
    }
    const error = new Error('TRON_DEPOSIT_CLAIMED');
    error.statusCode = 409;
    throw error;
  }

  const settingsSnapshot = await firebaseDb.ref('system_settings/referral').once('value');
  const referralSettings = settingsSnapshot.val() || {};
  const bonusPercent = referralSettings.depositBonusEnabled
    ? Math.max(0, Number(referralSettings.depositBonusPercent || 0))
    : 0;
  const amount = Number((Number(transfer.amountCents || tokenRawToUsdCents(transfer.rawAmount, TRON_USDT_DECIMALS)) / 100).toFixed(2));
  const bonusAdd = numberValue(amount * bonusPercent / 100);
  let receipt = null;

  try {
    const userRef = firebaseDb.ref(`users/${intent.uid}`);
    const result = await userRef.transaction((profile) => {
      if (!profile) return;
      const receipts = profile.serverUsdtDepositReceipts && typeof profile.serverUsdtDepositReceipts === 'object'
        ? { ...profile.serverUsdtDepositReceipts }
        : {};
      if (receipts[transfer.txid]) {
        receipt = receipts[transfer.txid];
        return profile;
      }
      const realBefore = numberValue(profile.realBalance);
      const bonusBefore = numberValue(profile.bonusBalance);
      receipt = {
        txid: transfer.txid,
        intentId: intent.id,
        amount,
        bonusAdd,
        realBefore,
        realAfter: numberValue(realBefore + amount),
        bonusBefore,
        bonusAfter: numberValue(bonusBefore + bonusAdd),
        createdAt: now
      };
      receipts[transfer.txid] = receipt;
      return {
        ...profile,
        realBalance: receipt.realAfter,
        bonusBalance: receipt.bonusAfter,
        serverUsdtDepositReceipts: receipts,
        updatedAt: now
      };
    }, undefined, false);

    if (!result.committed || !receipt) {
      const error = new Error('TRON_DEPOSIT_CREDIT_FAILED');
      error.statusCode = 409;
      throw error;
    }

    const approvedRecord = {
      id: intent.id,
      uid: intent.uid,
      email: intent.email || '',
      name: intent.name || '',
      amount,
      receivedUsdt: transfer.receivedUsdt,
      expectedUsdt: intent.expectedUsdt,
      method: 'usdt_trc20_auto',
      methodName: 'USDT TRC20 — Automatic',
      methodAddress: TRON_DEPOSIT_ADDRESS,
      network: 'TRC20',
      asset: 'USDT',
      txid: transfer.txid,
      fromAddress: transfer.from,
      toAddress: transfer.to,
      status: 'approved',
      reviewStatus: 'تم التحقق تلقائيًا من شبكة TRON',
      automatic: true,
      createdAt: intent.createdAt,
      approvedAt: now,
      approvedBy: 'TRON_NETWORK_AUTO_VERIFIER',
      balanceBefore: receipt.realBefore,
      balanceAfter: receipt.realAfter,
      bonusAdd,
      blockTimestamp: transfer.blockTimestamp,
      source: 'server_v207_auto_usdt_trc20'
    };

    const updates = {};
    updates[`finance/usdt_intents/${intent.id}/status`] = 'paid';
    updates[`finance/usdt_intents/${intent.id}/paidAt`] = now;
    updates[`finance/usdt_intents/${intent.id}/txid`] = transfer.txid;
    updates[`finance/usdt_intents/${intent.id}/receivedUsdt`] = transfer.receivedUsdt;
    updates[`finance/usdt_intents/${intent.id}/creditedUsd`] = amount;
    updates[`finance/usdt_intents/${intent.id}/balanceAfter`] = receipt.realAfter;
    updates[`finance/usdt_pending/${intent.id}`] = null;
    updates[`user_finance/${intent.uid}/usdt_intents/${intent.id}/status`] = 'paid';
    updates[`user_finance/${intent.uid}/usdt_intents/${intent.id}/paidAt`] = now;
    updates[`user_finance/${intent.uid}/usdt_intents/${intent.id}/txid`] = transfer.txid;
    updates[`user_finance/${intent.uid}/usdt_intents/${intent.id}/receivedUsdt`] = transfer.receivedUsdt;
    updates[`finance/deposits/${intent.id}`] = approvedRecord;
    updates[`user_finance/${intent.uid}/deposits/${intent.id}`] = approvedRecord;
    updates[`transactions/${intent.uid}/usdt_deposit_${intent.id}`] = {
      id: `usdt_deposit_${intent.id}`,
      type: 'deposit_approved',
      amount,
      balanceBefore: receipt.realBefore,
      balanceAfter: receipt.realAfter,
      status: 'approved',
      note: `إيداع تلقائي ${transfer.receivedUsdt} USDT عبر TRC20`,
      txid: transfer.txid,
      requestId: intent.id,
      createdAt: now
    };
    if (bonusAdd > 0) {
      updates[`transactions/${intent.uid}/usdt_deposit_bonus_${intent.id}`] = {
        id: `usdt_deposit_bonus_${intent.id}`,
        type: 'deposit_bonus',
        amount: bonusAdd,
        balanceBefore: receipt.bonusBefore,
        balanceAfter: receipt.bonusAfter,
        status: 'bonus',
        note: `بونص إيداع تلقائي ${bonusPercent}%`,
        createdAt: now + 1
      };
    }
    updates[`user_notifications/${intent.uid}/usdt_deposit_${intent.id}`] = {
      id: `usdt_deposit_${intent.id}`,
      type: 'deposit_approved',
      title: 'تم الإيداع تلقائيًا',
      text: `تم تأكيد ${transfer.receivedUsdt} USDT وإضافة $${amount.toFixed(2)} إلى رصيدك الحقيقي${bonusAdd ? ` و$${bonusAdd.toFixed(2)} بونص` : ''}.`,
      read: false,
      createdAt: now
    };
    updates[`finance_audit/usdt_deposit_${intent.id}`] = {
      id: `usdt_deposit_${intent.id}`,
      action: 'automatic_usdt_trc20_deposit',
      requestId: intent.id,
      uid: intent.uid,
      amount,
      receivedUsdt: transfer.receivedUsdt,
      txid: transfer.txid,
      bonusAdd,
      createdAt: now
    };
    updates[`finance/usdt_tx_claims/${transfer.txid}/status`] = 'credited';
    updates[`finance/usdt_tx_claims/${transfer.txid}/creditedAt`] = now;
    updates[`finance/usdt_tx_claims/${transfer.txid}/amount`] = amount;
    await firebaseDb.ref().update(updates);

    return {
      duplicate: false,
      intent: {
        ...intent,
        status: 'paid',
        paidAt: now,
        txid: transfer.txid,
        receivedUsdt: transfer.receivedUsdt,
        creditedUsd: amount,
        balanceAfter: receipt.realAfter,
        bonusAdd
      },
      receipt
    };
  } catch (cause) {
    const current = await claimRef.once('value').then((snapshot) => snapshot.val()).catch(() => null);
    if (current && current.status === 'processing' && current.uid === intent.uid && current.intentId === intent.id) {
      await claimRef.remove().catch(() => {});
    }
    throw cause;
  }
}


let automaticUsdtSyncRunning = false;

async function syncAutomaticUsdtIntent(intent) {
  if (!intent || !intent.id || !intent.uid) return { status: 'missing', intent: null };
  if (intent.status === 'paid') return { status: 'paid', intent };

  const now = Date.now();
  if (Number(intent.expiresAt || 0) <= now) {
    const updates = {};
    updates[`finance/usdt_intents/${intent.id}/status`] = 'expired';
    updates[`finance/usdt_pending/${intent.id}`] = null;
    updates[`user_finance/${intent.uid}/usdt_intents/${intent.id}/status`] = 'expired';
    await firebaseDb.ref().update(updates);
    return { status: 'expired', intent: { ...intent, status: 'expired' } };
  }

  return { status: 'pending', intent };
}

async function syncPendingAutomaticUsdtDeposits() {
  if (automaticUsdtSyncRunning || !tronDepositConfigured()) return;
  automaticUsdtSyncRunning = true;
  try {
    const pendingSnapshot = await firebaseDb.ref('finance/usdt_pending').once('value');
    const pending = Object.values(pendingSnapshot.val() || {})
      .filter((item) => item && item.id)
      .sort((first, second) => Number(first.createdAt || 0) - Number(second.createdAt || 0))
      .slice(0, 20);

    for (const item of pending) {
      try {
        const intentSnapshot = await firebaseDb.ref(`finance/usdt_intents/${item.id}`).once('value');
        const intent = intentSnapshot.val();
        if (!intent) {
          await firebaseDb.ref(`finance/usdt_pending/${item.id}`).remove();
          continue;
        }
        await syncAutomaticUsdtIntent(intent);
      } catch (error) {
        console.error('AUTO_USDT_SYNC_ITEM_ERROR', item.id, error.message);
      }
    }
  } finally {
    automaticUsdtSyncRunning = false;
  }
}


async function verifyAutomaticUsdtDeposit(decodedToken, body) {
  if (!tronDepositConfigured()) { const error = new Error('TRON_DEPOSIT_NOT_CONFIGURED'); error.statusCode = 503; throw error; }
  const uid = decodedToken.uid;
  const id = safeText(body.id, 160);
  const txid = safeText(body.txid, 100).toLowerCase();
  if (!isValidFirebaseKey(id)) { const error = new Error('TRON_DEPOSIT_REQUEST_REQUIRED'); error.statusCode = 400; throw error; }
  const snapshot = await firebaseDb.ref(`finance/usdt_intents/${id}`).once('value');
  const intent = snapshot.val();
  if (!intent || intent.uid !== uid) { const error = new Error('TRON_DEPOSIT_REQUEST_NOT_FOUND'); error.statusCode = 404; throw error; }
  if (intent.status === 'paid') return { ok: true, status: 'paid', intent };
  if (Number(intent.expiresAt || 0) <= Date.now()) { const error = new Error('TRON_DEPOSIT_REQUEST_EXPIRED'); error.statusCode = 409; throw error; }
  const transfer = await findConfirmedUsdtTransferByTxid(intent, txid);
  if (!transfer) { const error = new Error('TRON_DEPOSIT_TX_NOT_FOUND'); error.statusCode = 404; throw error; }
  const credited = await creditAutomaticUsdtDeposit(intent, transfer);
  return { ok: true, status: 'paid', intent: credited.intent, receipt: credited.receipt, realBalance: credited.receipt && credited.receipt.realAfter, bonusBalance: credited.receipt && credited.receipt.bonusAfter };
}

async function automaticUsdtDepositStatus(decodedToken, url) {
  if (!tronDepositConfigured()) {
    const error = new Error('TRON_DEPOSIT_NOT_CONFIGURED');
    error.statusCode = 503;
    throw error;
  }
  const uid = decodedToken.uid;
  const id = safeText(url.searchParams.get('id'), 160);
  if (!isValidFirebaseKey(id)) {
    const error = new Error('TRON_DEPOSIT_REQUEST_REQUIRED');
    error.statusCode = 400;
    throw error;
  }
  const intentRef = firebaseDb.ref(`finance/usdt_intents/${id}`);
  const snapshot = await intentRef.once('value');
  const intent = snapshot.val();
  if (!intent || intent.uid !== uid) {
    const error = new Error('TRON_DEPOSIT_REQUEST_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }

  const synced = await syncAutomaticUsdtIntent(intent);
  if (synced.status === 'pending') {
    return {
      ok: true,
      status: 'pending',
      intent: {
        id,
        status: 'pending',
        baseAmount: intent.baseAmount,
        expectedUsdt: intent.expectedUsdt,
        address: TRON_DEPOSIT_ADDRESS,
        network: 'TRC20',
        asset: 'USDT',
        createdAt: intent.createdAt,
        expiresAt: intent.expiresAt
      }
    };
  }
  if (synced.status === 'expired') {
    return { ok: true, status: 'expired', intent: synced.intent };
  }
  return {
    ok: true,
    status: 'paid',
    intent: synced.intent,
    realBalance: synced.receipt ? synced.receipt.realAfter : synced.intent.balanceAfter,
    bonusBalance: synced.receipt ? synced.receipt.bonusAfter : undefined
  };
}

function withdrawalProfileMatchesAuth(profile, decodedToken) {
  if (!profile || typeof profile !== 'object') return false;
  const authUid = String(decodedToken && decodedToken.uid || '').trim();
  const emailLower = String(decodedToken && decodedToken.email || '').trim().toLowerCase();
  const phoneNumber = normalizeGameAccountPhone(decodedToken && decodedToken.phone_number || '');
  const identityUids = [profile.uid, profile.authUid, profile.firebaseAuthUid, profile.firebaseUid]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (authUid && identityUids.includes(authUid)) return true;
  const profileEmail = String(profile.emailLower || profile.email || '').trim().toLowerCase();
  if (emailLower && profileEmail && profileEmail === emailLower) return true;
  const profilePhone = normalizeGameAccountPhone(profile.phoneNumber || profile.phone || profile.mobile || '');
  return Boolean(phoneNumber && profilePhone && profilePhone === phoneNumber);
}

async function resolveWithdrawalFinancialAccount(decodedToken, hints = {}) {
  const authUid = String(decodedToken && decodedToken.uid || '').trim();
  const emailLower = String(decodedToken && decodedToken.email || '').trim().toLowerCase();
  const phoneNumber = String(decodedToken && decodedToken.phone_number || '').trim();
  const publicId = String(hints.publicId || '').replace(/\D/g, '').slice(0, 18);
  if (!authUid || !isValidFirebaseKey(authUid)) {
    const error = new Error('USER_ACCOUNT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }

  // Financial operations must prefer the server-owned auth link. This avoids
  // reading a zero-balance duplicate profile under the Firebase Auth UID while
  // the real wallet is stored under a legacy financial UID.
  const linkedSnapshot = await firebaseDb.ref(`auth_user_links/${authUid}`).once('value');
  const linkedUid = String(linkedSnapshot.val() || '').trim();
  if (linkedUid && isValidFirebaseKey(linkedUid)) {
    const profileSnapshot = await firebaseDb.ref(`users/${linkedUid}`).once('value');
    const profile = profileSnapshot.val() || null;
    if (profileSnapshot.exists() && gameAccountProfileLooksUsable(profile)) {
      cacheMapSetV219(gameAccountLinkCacheV219, authUid, linkedUid, 30 * 60 * 1000);
      return { authUid, uid: linkedUid, profile, linked: linkedUid !== authUid, source: 'auth_user_links' };
    }
  }

  const candidates = new Map();
  const addCandidate = (entry, trusted = false) => {
    if (!entry || !entry.uid || !isValidFirebaseKey(String(entry.uid))) return;
    const profile = entry.profile && typeof entry.profile === 'object' ? entry.profile : {};
    if (!gameAccountProfileLooksUsable(profile)) return;
    if (!trusted && !withdrawalProfileMatchesAuth(profile, decodedToken)) return;
    if (!candidates.has(String(entry.uid))) candidates.set(String(entry.uid), { uid: String(entry.uid), profile });
  };

  const cachedUid = cacheMapGetV219(gameAccountLinkCacheV219, authUid);
  if (cachedUid && isValidFirebaseKey(String(cachedUid))) {
    const cachedSnapshot = await firebaseDb.ref(`users/${cachedUid}`).once('value');
    if (cachedSnapshot.exists()) addCandidate({ uid: String(cachedUid), profile: cachedSnapshot.val() || {} }, true);
  }

  const directSnapshot = await firebaseDb.ref(`users/${authUid}`).once('value');
  if (directSnapshot.exists()) addCandidate({ uid: authUid, profile: directSnapshot.val() || {} });

  for (const field of ['authUid', 'firebaseAuthUid', 'firebaseUid', 'uid']) {
    try {
      for (const entry of await findUsersByChild(field, authUid)) addCandidate(entry, true);
    } catch (error) {
      console.warn('WITHDRAW_ACCOUNT_LOOKUP_SKIPPED', field, error.message);
    }
  }

  if (emailLower) {
    for (const field of ['emailLower', 'email']) {
      try {
        for (const entry of await findUsersByChild(field, field === 'emailLower' ? emailLower : decodedToken.email || emailLower)) addCandidate(entry);
      } catch (error) {
        console.warn('WITHDRAW_ACCOUNT_EMAIL_LOOKUP_SKIPPED', field, error.message);
      }
    }
  }

  if (phoneNumber) {
    for (const field of ['phoneNumber', 'phone', 'mobile']) {
      try {
        for (const entry of await findUsersByChild(field, phoneNumber)) addCandidate(entry);
      } catch (error) {
        console.warn('WITHDRAW_ACCOUNT_PHONE_LOOKUP_SKIPPED', field, error.message);
      }
    }
  }

  // The public number is only a lookup hint. It is never enough by itself to
  // claim a wallet; the mapped profile must also match the authenticated user.
  if (publicId && /^\d{4,18}$/.test(publicId)) {
    const mappingSnapshot = await firebaseDb.ref(`public_user_ids/${publicId}`).once('value');
    const mappedUid = String(mappingSnapshot.val() || '').trim();
    if (mappedUid && isValidFirebaseKey(mappedUid)) {
      const mappedSnapshot = await firebaseDb.ref(`users/${mappedUid}`).once('value');
      if (mappedSnapshot.exists()) addCandidate({ uid: mappedUid, profile: mappedSnapshot.val() || {} });
    }
  }

  let selected = chooseGameAccountCandidate(candidates, authUid, emailLower);
  if (!selected) {
    // Do not bootstrap a zero-balance profile during a money withdrawal. Search
    // old accounts by authenticated identity only, then fail safely.
    try {
      selected = await legacyScanGameAccount(authUid, emailLower, phoneNumber, '');
      if (selected && !withdrawalProfileMatchesAuth(selected.profile, decodedToken)) selected = null;
    } catch (error) {
      console.warn('WITHDRAW_ACCOUNT_LEGACY_SCAN_SKIPPED', error.message);
    }
  }

  if (!selected) {
    const error = new Error('USER_ACCOUNT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }

  const financialUid = String(selected.uid);
  const freshSnapshot = await firebaseDb.ref(`users/${financialUid}`).once('value');
  const profile = freshSnapshot.val() || null;
  if (!freshSnapshot.exists() || !gameAccountProfileLooksUsable(profile)) {
    const error = new Error('USER_ACCOUNT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }

  const updates = { [`auth_user_links/${authUid}`]: financialUid };
  if (!profile.uid) updates[`users/${financialUid}/uid`] = financialUid;
  if (!profile.authUid) updates[`users/${financialUid}/authUid`] = authUid;
  if (!profile.firebaseAuthUid) updates[`users/${financialUid}/firebaseAuthUid`] = authUid;
  if (!profile.firebaseUid) updates[`users/${financialUid}/firebaseUid`] = authUid;
  if (emailLower && !profile.emailLower) updates[`users/${financialUid}/emailLower`] = emailLower;
  if (phoneNumber && !profile.phoneNumber) updates[`users/${financialUid}/phoneNumber`] = phoneNumber;
  updates[`users/${financialUid}/accountLinkUpdatedAt`] = Date.now();
  try { await firebaseDb.ref().update(updates); } catch (error) {
    console.warn('WITHDRAW_ACCOUNT_LINK_UPDATE_SKIPPED', error.message);
  }
  cacheMapSetV219(gameAccountLinkCacheV219, authUid, financialUid, 30 * 60 * 1000);
  console.log('WITHDRAW_ACCOUNT_V223', { authUid, financialUid, linked: financialUid !== authUid });
  return { authUid, uid: financialUid, profile, linked: financialUid !== authUid, source: 'resolved_identity' };
}

async function createWithdrawalRequest(decodedToken, body, accountHints = {}) {
  const controls = await readSystemControls();
  if (!controls.withdrawEnabled || controls.maintenanceMode) {
    const error = new Error('WITHDRAW_DISABLED'); error.statusCode = 409; throw error;
  }
  const account = await resolveWithdrawalFinancialAccount(decodedToken, accountHints);
  const uid = account.uid;
  const authUid = account.authUid;
  const amount = numberValue(body.amount);
  if (!(amount > 0) || amount > 1000000) {
    const error = new Error('INVALID_WITHDRAW_AMOUNT'); error.statusCode = 400; throw error;
  }
  const details = safeText(body.details, 1000);
  if (details.length < 8) { const error = new Error('WITHDRAW_DETAILS_REQUIRED'); error.statusCode = 400; throw error; }
  const method = await getPaymentMethod(body.methodId || body.method, 'withdraw');
  const min = Math.max(0, numberValue(method.minWithdraw || method.minimum || 0));
  if (min && amount < min) {
    const error = new Error('WITHDRAW_BELOW_MINIMUM'); error.statusCode = 409; error.details = { minimum: min }; throw error;
  }

  const id = requestKey('wd', uid, body.requestId);
  const now = Date.now();
  let receipt = null;
  let duplicate = false;
  let abortCode = '';
  const userRef = firebaseDb.ref(`users/${uid}`);
  const verifiedProfile = account.profile && typeof account.profile === 'object' ? { ...account.profile } : null;
  const reserve = await userRef.transaction((rawProfile) => {
    // Firebase transactions can invoke the updater with null before the current
    // server value arrives. Use the already-verified financial profile for that
    // provisional pass, then Firebase retries with the authoritative value.
    const profile = rawProfile && typeof rawProfile === 'object'
      ? { ...rawProfile }
      : (gameAccountProfileLooksUsable(verifiedProfile) ? { ...verifiedProfile } : null);
    if (!profile) { abortCode = 'USER_ACCOUNT_NOT_FOUND'; return; }
    if (userFrozen(profile)) { abortCode = 'ACCOUNT_FROZEN'; return; }
    const receipts = profile.serverWithdrawalReservations && typeof profile.serverWithdrawalReservations === 'object'
      ? { ...profile.serverWithdrawalReservations } : {};
    if (receipts[id]) { receipt = receipts[id]; duplicate = true; return profile; }
    const realBefore = numberValue(profile.realBalance);
    const reservedBefore = numberValue(profile.reservedWithdrawalBalance);
    if (amount > realBefore) { abortCode = 'INSUFFICIENT_REAL_BALANCE'; return; }
    receipt = {
      id, amount,
      realBefore, realAfter: numberValue(realBefore - amount),
      reservedBefore, reservedAfter: numberValue(reservedBefore + amount),
      createdAt: now
    };
    receipts[id] = receipt;
    return {
      ...profile,
      realBalance: receipt.realAfter,
      reservedWithdrawalBalance: receipt.reservedAfter,
      serverWithdrawalReservations: receipts,
      updatedAt: now
    };
  }, undefined, false);

  if (!reserve.committed || !receipt) {
    const profileSnapshot = await userRef.once('value');
    const profile = profileSnapshot.val() || {};
    const realAvailable = numberValue(profile.realBalance);
    const code = userFrozen(profile)
      ? 'ACCOUNT_FROZEN'
      : (!profileSnapshot.exists() || !gameAccountProfileLooksUsable(profile))
        ? 'USER_ACCOUNT_NOT_FOUND'
        : amount > realAvailable
          ? 'INSUFFICIENT_REAL_BALANCE'
          : (abortCode || 'DATABASE_TRANSACTION_FAILED');
    const error = new Error(code);
    error.statusCode = code === 'ACCOUNT_FROZEN' ? 403 : code === 'USER_ACCOUNT_NOT_FOUND' ? 404 : 409;
    error.details = { requested: amount, available: realAvailable, financialUid: uid };
    throw error;
  }

  const committedProfile = reserve.snapshot && reserve.snapshot.val() || {};
  const receiverName = safeText(body.receiverName, 180);
  const receiverNote = safeText(body.note || body.receiverNote, 500);
  const destinationInput = safeText(body.receiverAddress || body.destinationAddress || details, 1000);
  const methodMeta = withdrawalMethodMetadata(method, destinationInput);
  const publicId = safeText(
    account.profile.publicId || account.profile.userId || account.profile.accountNumber || committedProfile.publicId || body.publicId,
    80
  );
  const phoneNumber = safeText(account.profile.phoneNumber || account.profile.phone || decodedToken.phone_number, 80);
  const methodName = safeText(method.name || method.title || method.id, 160);
  const record = {
    id, uid, authUid, financialUid: uid, publicId, phoneNumber,
    email: safeText(account.profile.email || decodedToken.email, 220),
    name: safeText(account.profile.name || account.profile.displayName || committedProfile.name || decodedToken.name, 160),
    receiverName,
    amount,
    method: method.id,
    methodId: method.id,
    methodName,
    methodType: safeText(method.type || method.mode || 'withdraw', 40),
    methodCategory: methodMeta.category,
    currency: methodMeta.currency,
    network: methodMeta.network,
    destinationLabel: methodMeta.destinationLabel,
    destinationAddress: methodMeta.destinationAddress,
    destinationDetails: methodMeta.destinationDetails,
    receiverNote,
    details: methodMeta.destinationDetails,
    methodSnapshot: {
      id: method.id,
      name: methodName,
      type: safeText(method.type || method.mode || 'withdraw', 40),
      category: methodMeta.category,
      currency: methodMeta.currency,
      network: methodMeta.network,
      minWithdraw: numberValue(method.minWithdraw || method.minimum || 0)
    },
    status: 'pending', reviewStatus: 'تم حجز المبلغ بانتظار مراجعة الإدارة',
    createdAt: receipt.createdAt || now,
    balanceBefore: receipt.realBefore, balanceAfter: receipt.realAfter,
    reservedBefore: receipt.reservedBefore, reservedAfter: receipt.reservedAfter,
    accountLinked: account.linked === true,
    source: 'server_v224_withdraw_full_admin_details'
  };
  if (!duplicate) {
    try {
      const updates = {};
      updates[`finance/withdrawals/${id}`] = record;
      updates[`user_finance/${uid}/withdrawals/${id}`] = record;
      updates[`transactions/${uid}/withdraw_request_${id}`] = {
        id: `withdraw_request_${id}`, type: 'withdraw_request', amount: -amount,
        status: 'pending', note: `طلب سحب عبر ${record.methodName} — المبلغ محجوز`,
        balanceBefore: receipt.realBefore, balanceAfter: receipt.realAfter,
        reservedBefore: receipt.reservedBefore, reservedAfter: receipt.reservedAfter,
        requestId: id, authUid, financialUid: uid, createdAt: now
      };
      updates[`admin_notifications/withdraw_${id}`] = {
        id: `withdraw_${id}`, type: 'withdraw_request', uid, authUid, email: record.email,
        text: `طلب سحب جديد بقيمة $${amount} عبر ${record.methodName} — ${record.network} — ${record.destinationAddress}`, requestId: id,
        status: 'new', createdAt: now
      };
      await firebaseDb.ref().update(updates);
    } catch (cause) {
      const committedFallback = committedProfile && typeof committedProfile === 'object' ? { ...committedProfile } : null;
      await userRef.transaction((rawProfile) => {
        const profile = rawProfile && typeof rawProfile === 'object'
          ? { ...rawProfile }
          : (gameAccountProfileLooksUsable(committedFallback) ? { ...committedFallback } : null);
        if (!profile) return;
        const receipts = { ...(profile.serverWithdrawalReservations || {}) };
        const saved = receipts[id];
        if (!saved || numberValue(saved.amount) !== amount) return profile;
        delete receipts[id];
        return {
          ...profile,
          realBalance: numberValue(numberValue(profile.realBalance) + amount),
          reservedWithdrawalBalance: numberValue(Math.max(0, numberValue(profile.reservedWithdrawalBalance) - amount)),
          serverWithdrawalReservations: receipts,
          updatedAt: Date.now()
        };
      }, undefined, false);
      const error = new Error('WITHDRAW_REQUEST_SAVE_FAILED'); error.statusCode = 500; error.cause = cause; throw error;
    }
  }
  return {
    ok: true,
    duplicate,
    request: record,
    financialUid: uid,
    linkedAccount: account.linked === true,
    realBalance: receipt.realAfter,
    reservedWithdrawalBalance: receipt.reservedAfter
  };
}

function referralOwn(source, key) {
  return !!source && Object.prototype.hasOwnProperty.call(source, key);
}

function cloneReferralRoot(root) {
  if (!root || typeof root !== 'object') return null;
  return JSON.parse(JSON.stringify(root));
}

function normalizeReferralReward(settings, target) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const prefix = target === 'newUser' ? 'newUser' : 'referrer';
  const legacyKey = target === 'newUser' ? 'newUserBonus' : 'referrerBonus';
  const amountKey = `${prefix}RewardAmount`;
  let typeRaw = safeText(source[`${prefix}RewardType`] || 'bonus', 30);
  if (typeRaw === 'lotteryTickets') typeRaw = 'tickets';
  const type = ['bonus', 'real', 'wheelSpins', 'tickets'].includes(typeRaw) ? typeRaw : 'bonus';
  // V227: when referral settings were never saved, both parties default to 1.
  // An explicitly saved zero is preserved and never converted to one.
  const hasConfiguredAmount = referralOwn(source, amountKey) || referralOwn(source, legacyKey);
  const rawAmount = referralOwn(source, amountKey) ? source[amountKey]
    : (referralOwn(source, legacyKey) ? source[legacyKey] : 1);
  let amount = Math.max(0, numberValue(hasConfiguredAmount ? rawAmount : 1));
  if (type === 'wheelSpins' || type === 'tickets') amount = Math.floor(amount);
  return { type, amount };
}

function normalizeReferralSettingsServer(raw) {
  const settings = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: settings.enabled !== false,
    adminCode: safeText(settings.adminCode || 'ADNORVIP', 32).toUpperCase().replace(/[^A-Z0-9_-]/g, ''),
    newUserRewardType: normalizeReferralReward(settings, 'newUser').type,
    newUserRewardAmount: normalizeReferralReward(settings, 'newUser').amount,
    referrerRewardType: normalizeReferralReward(settings, 'referrer').type,
    referrerRewardAmount: normalizeReferralReward(settings, 'referrer').amount,
    dailyReferralLimit: Math.max(0, Math.floor(Number(settings.dailyReferralLimit || 0))),
    blockSameDevice: settings.blockSameDevice === true,
    blockSameIp: settings.blockSameIp === true,
    depositBonusEnabled: settings.depositBonusEnabled === true,
    depositBonusPercent: Math.max(0, Math.min(500, Number(settings.depositBonusPercent || 0))),
    note: safeText(settings.note || 'شارك رابط الدعوة واستفد من المكافآت المحددة.', 500),
    updatedAt: Number(settings.updatedAt || 0),
    updatedBy: safeText(settings.updatedBy, 220)
  };
}

function serverReferralCode(uid, profile) {
  const current = safeText(profile && (profile.referralCode || profile.refCode), 32).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (current.length >= 5) return current;
  const basis = safeText(profile && (profile.publicId || profile.userId || profile.numericId), 16).replace(/\D/g, '');
  if (basis.length >= 4) return `ADN${basis}`.slice(0, 20);
  return `ADN${uid.replace(/[^A-Za-z0-9]/g, '').slice(-10).toUpperCase()}`;
}

async function ensureReferralIdentity(decodedToken, hints = {}) {
  const account = await resolveGameAccount(decodedToken, {
    publicId: String(hints.publicId || '').replace(/\D/g, '').slice(0, 18),
    allowBootstrap: true,
    force: hints.force === true
  });
  const uid = String(account.uid);
  const authUid = String(account.authUid || decodedToken.uid);
  const profile = account.profile || {};
  let code = serverReferralCode(uid, profile);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const codeSnapshot = await firebaseDb.ref(`referral_codes/${code}`).once('value');
    const existing = codeSnapshot.val();
    if (!existing || existing.ownerUid === uid || existing.ownerAuthUid === authUid) break;
    code = `${code.slice(0, 16)}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  }
  const now = Date.now();
  const updates = {};
  updates[`referral_codes/${code}`] = {
    code,
    ownerUid: uid,
    ownerAuthUid: authUid,
    ownerEmail: safeText(decodedToken.email || profile.email, 220),
    ownerName: safeText(profile.name || profile.displayName || decodedToken.name, 160),
    active: true,
    createdAt: Number(profile.referralCodeCreatedAt || now),
    updatedAt: now,
    source: 'server_v227_financial_identity'
  };
  updates[`users/${uid}/referralCode`] = code;
  updates[`users/${uid}/refCode`] = code;
  updates[`users/${uid}/referralCodeCreatedAt`] = Number(profile.referralCodeCreatedAt || now);
  updates[`auth_user_links/${authUid}`] = uid;
  await firebaseDb.ref().update(updates);
  return { profile, code, uid, authUid, linked: uid !== authUid };
}

function applyReferralRewardToProfile(profile, reward) {
  const next = { ...profile };
  const amount = Math.max(0, numberValue(reward.amount));
  if (!amount) return { profile: next, balanceBefore: 0, balanceAfter: 0, moneyAmount: 0 };
  if (reward.type === 'real') {
    const before = numberValue(next.realBalance); next.realBalance = numberValue(before + amount);
    return { profile: next, balanceBefore: before, balanceAfter: next.realBalance, moneyAmount: amount };
  }
  if (reward.type === 'wheelSpins') {
    const before = numberValue(next.freeSpins); next.freeSpins = numberValue(before + amount);
    return { profile: next, balanceBefore: before, balanceAfter: next.freeSpins, moneyAmount: 0 };
  }
  if (reward.type === 'tickets' || reward.type === 'lotteryTickets') {
    const before = numberValue(next.freeTickets ?? next.freeLotteryTickets);
    next.freeTickets = numberValue(before + amount);
    next.freeLotteryTickets = next.freeTickets;
    return { profile: next, balanceBefore: before, balanceAfter: next.freeTickets, moneyAmount: 0 };
  }
  const before = numberValue(next.bonusBalance); next.bonusBalance = numberValue(before + amount);
  return { profile: next, balanceBefore: before, balanceAfter: next.bonusBalance, moneyAmount: amount };
}

function rewardDescription(reward) {
  const amount = numberValue(reward.amount);
  if (reward.type === 'real') return `$${amount} رصيد حقيقي`;
  if (reward.type === 'wheelSpins') return `${amount} لفة مجانية`;
  if (reward.type === 'tickets' || reward.type === 'lotteryTickets') return `${amount} تذكرة مجانية`;
  return `$${amount} بونص`;
}

async function referralStatus(decodedToken, hints = {}) {
  const identity = await ensureReferralIdentity(decodedToken, hints);
  const [settingsSnapshot, referralsSnapshot, profileSnapshot] = await Promise.all([
    firebaseDb.ref('system_settings/referral').once('value'),
    firebaseDb.ref(`user_referrals/${identity.uid}`).once('value'),
    firebaseDb.ref(`users/${identity.uid}`).once('value')
  ]);
  const settings = normalizeReferralSettingsServer(settingsSnapshot.val());
  const referrals = objectValues(referralsSnapshot.val());
  const profile = profileSnapshot.val() || identity.profile || {};
  return {
    ok: true,
    code: identity.code,
    link: `${PUBLIC_SITE_URL}/?ref=${encodeURIComponent(identity.code)}`,
    alreadyReferred: !!(profile.referredBy || profile.referredByUid),
    referredBy: safeText(profile.referredBy, 32),
    successfulCount: referrals.filter((item) => item && item.status === 'approved').length,
    financialUid: identity.uid,
    authUid: identity.authUid,
    linkedAccount: identity.linked === true,
    account: {
      realBalance: numberValue(profile.realBalance),
      bonusBalance: numberValue(profile.bonusBalance),
      freeSpins: Math.max(0, Number(profile.freeSpins || 0)),
      freeTickets: Math.max(0, Number(profile.freeTickets || profile.freeLotteryTickets || 0))
    },
    settings,
    rewards: {
      newUser: normalizeReferralReward(settings, 'newUser'),
      referrer: normalizeReferralReward(settings, 'referrer')
    }
  };
}

async function applyReferralServer(decodedToken, body) {
  const authUid = String(decodedToken.uid);
  const code = safeText(body.code, 32).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (code.length < 4) { const error = new Error('INVALID_REFERRAL_CODE'); error.statusCode = 400; throw error; }
  const account = await resolveGameAccount(decodedToken, {
    publicId: String(body.publicId || body.userId || body.accountNumber || '').replace(/\D/g, '').slice(0, 18),
    allowBootstrap: true,
    force: body.forceAccountRepair === true
  });
  const uid = String(account.uid);
  const codeSnapshot = await firebaseDb.ref(`referral_codes/${code}`).once('value');
  const codeEntry = codeSnapshot.val();
  if (!codeEntry || codeEntry.active === false || !(codeEntry.ownerUid || codeEntry.ownerAuthUid)) {
    const error = new Error('REFERRAL_CODE_NOT_FOUND'); error.statusCode = 404; throw error;
  }
  const rawOwnerUid = String(codeEntry.ownerUid || codeEntry.ownerAuthUid);
  const ownerAuthUid = String(codeEntry.ownerAuthUid || rawOwnerUid);
  const ownerLinkSnapshot = await firebaseDb.ref(`auth_user_links/${ownerAuthUid}`).once('value');
  const linkedOwnerUid = String(ownerLinkSnapshot.val() || '');
  let ownerUidResolved = linkedOwnerUid && isValidFirebaseKey(linkedOwnerUid) ? linkedOwnerUid : rawOwnerUid;
  let ownerProfileSnapshot = await firebaseDb.ref(`users/${ownerUidResolved}`).once('value');
  if (!ownerProfileSnapshot.exists() && ownerUidResolved !== rawOwnerUid) {
    ownerUidResolved = rawOwnerUid;
    ownerProfileSnapshot = await firebaseDb.ref(`users/${ownerUidResolved}`).once('value');
  }
  if (!ownerProfileSnapshot.exists()) {
    const error = new Error('REFERRER_NOT_FOUND'); error.statusCode = 404; throw error;
  }
  if (ownerUidResolved === uid || ownerAuthUid === authUid) {
    const error = new Error('SELF_REFERRAL_NOT_ALLOWED'); error.statusCode = 409; throw error;
  }
  await firebaseDb.ref(`referral_codes/${code}`).update({
    ownerUid: ownerUidResolved,
    ownerAuthUid,
    updatedAt: Date.now()
  });

  const operationId = requestKey('ref', uid, code);
  const now = Date.now();
  const today = dayKey(now);
  // V227: root transactions may receive a provisional null. A verified full
  // snapshot prevents a false USER_NOT_FOUND/REFERRAL_FAILED on that pass.
  const baselineSnapshot = await firebaseDb.ref().once('value');
  const baselineRoot = baselineSnapshot.val();
  if (!baselineRoot || typeof baselineRoot !== 'object') {
    const error = new Error('REFERRAL_FAILED'); error.statusCode = 503; throw error;
  }

  let result = null;
  let failure = 'REFERRAL_FAILED';
  let duplicate = false;
  let repairedIncomplete = false;
  const transaction = await firebaseDb.ref().transaction((rawRoot) => {
    const root = rawRoot && typeof rawRoot === 'object' ? rawRoot : cloneReferralRoot(baselineRoot);
    if (!root) return;
    root.users = root.users || {};
    root.referral_codes = root.referral_codes || {};
    root.referrals = root.referrals || {};
    root.user_referrals = root.user_referrals || {};
    root.user_referrals_received = root.user_referrals_received || {};
    root.transactions = root.transactions || {};
    root.user_notifications = root.user_notifications || {};
    root.admin_notifications = root.admin_notifications || {};
    root.referral_daily = root.referral_daily || {};
    root.referral_account_refresh = root.referral_account_refresh || {};

    // V227 idempotency: a retry after a successful response never pays twice
    // and never returns "already used" for the same user+code operation.
    if (root.referrals[operationId]) {
      result = root.referrals[operationId];
      duplicate = true;
      return root;
    }

    const me = root.users[uid];
    if (!me) { failure = 'USER_NOT_FOUND'; return; }
    const authProfile = authUid !== uid ? root.users[authUid] : me;
    const receivedFinancial = root.user_referrals_received[uid] && Object.keys(root.user_referrals_received[uid]).length;
    const receivedAuth = authUid !== uid && root.user_referrals_received[authUid] && Object.keys(root.user_referrals_received[authUid]).length;
    const meReferralCode = safeText(me.referredBy, 32).toUpperCase();
    const authReferralCode = safeText(authProfile && authProfile.referredBy, 32).toUpperCase();
    const hasReferralMetadata = !!(me.referredBy || me.referredByUid || (authProfile && (authProfile.referredBy || authProfile.referredByUid)));
    const metadataMatchesCode = (!meReferralCode || meReferralCode === code) && (!authReferralCode || authReferralCode === code);
    const userTransactions = root.transactions[uid] && typeof root.transactions[uid] === 'object' ? Object.values(root.transactions[uid]) : [];
    const authTransactions = authUid !== uid && root.transactions[authUid] && typeof root.transactions[authUid] === 'object' ? Object.values(root.transactions[authUid]) : [];
    const hasPaidReferralTransaction = [...userTransactions, ...authTransactions].some((item) => {
      const type = safeText(item && item.type, 80).toLowerCase();
      const note = safeText(item && item.note, 500).toUpperCase();
      return (type === 'referral_new_user_reward' || type === 'referral_new_user_bonus') && (!note || note.includes(code));
    });
    // V227 also repairs a legacy partial state where referredBy was written but
    // neither party was paid and no referral record/transaction was created.
    const incompleteSameCode = hasReferralMetadata && metadataMatchesCode && !receivedFinancial && !receivedAuth && !hasPaidReferralTransaction;
    if ((hasReferralMetadata || receivedFinancial || receivedAuth || hasPaidReferralTransaction) && !incompleteSameCode) {
      failure = 'REFERRAL_ALREADY_USED'; return;
    }
    if (incompleteSameCode) repairedIncomplete = true;
    const entry = root.referral_codes[code] || codeEntry;
    if (!entry || entry.active === false) { failure = 'REFERRAL_CODE_NOT_FOUND'; return; }
    const ownerUid = ownerUidResolved;
    if (ownerUid === uid || ownerAuthUid === authUid) { failure = 'SELF_REFERRAL_NOT_ALLOWED'; return; }
    const owner = root.users[ownerUid];
    if (!owner) { failure = 'REFERRER_NOT_FOUND'; return; }
    const settings = normalizeReferralSettingsServer(root.system_settings && root.system_settings.referral);
    if (!settings.enabled) { failure = 'REFERRAL_DISABLED'; return; }
    const dayNode = root.referral_daily[ownerUid] || {};
    const dayCount = Number(dayNode[today] && dayNode[today].count || 0);
    if (settings.dailyReferralLimit > 0 && dayCount >= settings.dailyReferralLimit) { failure = 'REFERRAL_DAILY_LIMIT'; return; }

    const newReward = normalizeReferralReward(settings, 'newUser');
    const ownerReward = normalizeReferralReward(settings, 'referrer');
    const appliedNew = applyReferralRewardToProfile(me, newReward);
    const appliedOwner = applyReferralRewardToProfile(owner, ownerReward);
    appliedNew.profile.referredBy = code;
    appliedNew.profile.referredByUid = ownerUid;
    appliedNew.profile.referredByAuthUid = ownerAuthUid;
    appliedNew.profile.financialUid = uid;
    appliedNew.profile.updatedAt = now;
    appliedOwner.profile.referralBonusEarned = numberValue(Number(appliedOwner.profile.referralBonusEarned || 0) + appliedOwner.moneyAmount);
    appliedOwner.profile.financialUid = ownerUid;
    appliedOwner.profile.updatedAt = now;
    root.users[uid] = appliedNew.profile;
    root.users[ownerUid] = appliedOwner.profile;
    // Keep referral metadata visible on the Firebase-auth profile without
    // duplicating or moving any financial balance.
    if (authUid !== uid && root.users[authUid]) {
      root.users[authUid] = {
        ...root.users[authUid],
        referredBy: code,
        referredByUid: ownerUid,
        referredByAuthUid: ownerAuthUid,
        financialUid: uid,
        updatedAt: now
      };
    }
    root.referral_daily[ownerUid] = { ...dayNode, [today]: { count: dayCount + 1, updatedAt: now } };

    const newRewardText = rewardDescription(newReward);
    const ownerRewardText = rewardDescription(ownerReward);
    const record = {
      id: operationId, code,
      referrerUid: ownerUid, referrerFinancialUid: ownerUid, referrerAuthUid: ownerAuthUid,
      referrerEmail: safeText(entry.ownerEmail || owner.email, 220),
      referrerName: safeText(entry.ownerName || owner.name, 160),
      referredUid: uid, referredFinancialUid: uid, referredAuthUid: authUid,
      referredEmail: safeText(decodedToken.email || me.email, 220),
      referredName: safeText(me.name || decodedToken.name, 160),
      newUserRewardType: newReward.type, newUserRewardAmount: newReward.amount, newUserRewardText: newRewardText,
      referrerRewardType: ownerReward.type, referrerRewardAmount: ownerReward.amount, referrerRewardText: ownerRewardText,
      status: 'approved', referrerRewardStatus: 'claimed', createdAt: now, source: repairedIncomplete ? 'server_v227_legacy_incomplete_repair' : 'server_v227_referral_atomic_fix'
    };
    root.referrals[operationId] = record;
    root.user_referrals[ownerUid] = root.user_referrals[ownerUid] || {};
    root.user_referrals[ownerUid][operationId] = { ...record, referredEmail: maskEmail(record.referredEmail) };
    if (ownerAuthUid !== ownerUid && isValidFirebaseKey(ownerAuthUid)) {
      root.user_referrals[ownerAuthUid] = root.user_referrals[ownerAuthUid] || {};
      root.user_referrals[ownerAuthUid][operationId] = { ...record, referredEmail: maskEmail(record.referredEmail) };
    }
    root.user_referrals_received[uid] = root.user_referrals_received[uid] || {};
    root.user_referrals_received[uid][operationId] = record;
    if (authUid !== uid && isValidFirebaseKey(authUid)) {
      root.user_referrals_received[authUid] = root.user_referrals_received[authUid] || {};
      root.user_referrals_received[authUid][operationId] = record;
    }

    root.transactions[uid] = root.transactions[uid] || {};
    root.transactions[uid][`ref_new_${operationId}`] = {
      id: `ref_new_${operationId}`, type: 'referral_new_user_reward', amount: appliedNew.moneyAmount,
      rewardType: newReward.type, rewardAmount: newReward.amount,
      note: `مكافأة كود الدعوة ${code}: ${newRewardText}`,
      balanceBefore: appliedNew.balanceBefore, balanceAfter: appliedNew.balanceAfter, createdAt: now
    };
    root.transactions[ownerUid] = root.transactions[ownerUid] || {};
    root.transactions[ownerUid][`ref_owner_${operationId}`] = {
      id: `ref_owner_${operationId}`, type: 'referral_referrer_reward', amount: appliedOwner.moneyAmount,
      rewardType: ownerReward.type, rewardAmount: ownerReward.amount,
      note: `مكافأة دعوة مستخدم جديد: ${ownerRewardText}`,
      balanceBefore: appliedOwner.balanceBefore, balanceAfter: appliedOwner.balanceAfter, createdAt: now
    };

    const newNotification = {
      id: `ref_${operationId}`, type: 'referral_bonus', title: 'تم تفعيل كود الدعوة',
      text: `حصلت على ${newRewardText}.`, read: false, createdAt: now
    };
    const ownerNotification = {
      id: `ref_${operationId}`, type: 'referral_bonus', title: 'مكافأة دعوة جديدة',
      text: `حصلت على ${ownerRewardText}.`, read: false, createdAt: now
    };
    root.user_notifications[uid] = root.user_notifications[uid] || {};
    root.user_notifications[uid][`ref_${operationId}`] = newNotification;
    if (authUid !== uid && isValidFirebaseKey(authUid)) {
      root.user_notifications[authUid] = root.user_notifications[authUid] || {};
      root.user_notifications[authUid][`ref_${operationId}`] = newNotification;
    }
    root.user_notifications[ownerUid] = root.user_notifications[ownerUid] || {};
    root.user_notifications[ownerUid][`ref_${operationId}`] = ownerNotification;
    if (ownerAuthUid !== ownerUid && isValidFirebaseKey(ownerAuthUid)) {
      root.user_notifications[ownerAuthUid] = root.user_notifications[ownerAuthUid] || {};
      root.user_notifications[ownerAuthUid][`ref_${operationId}`] = ownerNotification;
    }

    // The app listens to this auth-UID marker and refreshes the linked financial
    // account immediately, so both balances appear without logout/reload.
    if (isValidFirebaseKey(authUid)) {
      root.referral_account_refresh[authUid] = {
        operationId, financialUid: uid, role: 'new_user', rewardText: newRewardText, updatedAt: now
      };
    }
    if (isValidFirebaseKey(ownerAuthUid)) {
      root.referral_account_refresh[ownerAuthUid] = {
        operationId, financialUid: ownerUid, role: 'referrer', rewardText: ownerRewardText, updatedAt: now
      };
    }
    root.admin_notifications[`ref_${operationId}`] = {
      id: `ref_${operationId}`, type: 'referral', uid, email: record.referredEmail,
      text: `تم تفعيل كود ${code} ودفع ${newRewardText} للجديد و${ownerRewardText} لصاحب الدعوة.`, status: 'new', createdAt: now
    };
    result = record;
    return root;
  }, undefined, false);

  if (!transaction.committed || !result) {
    const error = new Error(failure);
    error.statusCode = ['USER_NOT_FOUND', 'REFERRER_NOT_FOUND', 'REFERRAL_CODE_NOT_FOUND'].includes(failure) ? 404 : 409;
    throw error;
  }
  const freshProfileSnapshot = await firebaseDb.ref(`users/${uid}`).once('value');
  const freshProfile = freshProfileSnapshot.val() || {};
  return {
    ok: true,
    duplicate,
    repairedIncomplete,
    referral: result,
    financialUid: uid,
    authUid,
    linkedAccount: uid !== authUid,
    account: {
      realBalance: numberValue(freshProfile.realBalance),
      bonusBalance: numberValue(freshProfile.bonusBalance),
      freeSpins: Math.max(0, Number(freshProfile.freeSpins || 0)),
      freeTickets: Math.max(0, Number(freshProfile.freeTickets || freshProfile.freeLotteryTickets || 0))
    }
  };
}

async function adminReferralBundle() {
  const [settingsSnapshot, referralsSnapshot, codesSnapshot] = await Promise.all([
    firebaseDb.ref('system_settings/referral').once('value'),
    firebaseDb.ref('referrals').limitToLast(300).once('value'),
    firebaseDb.ref('referral_codes').limitToLast(300).once('value')
  ]);
  return {
    ok: true,
    settings: normalizeReferralSettingsServer(settingsSnapshot.val()),
    referrals: objectValues(referralsSnapshot.val()).sort((a, b) => timestampOf(b) - timestampOf(a)),
    codes: objectValues(codesSnapshot.val()).sort((a, b) => timestampOf(b) - timestampOf(a))
  };
}

async function adminSaveReferralSettings(admin, body) {
  const currentSnapshot = await firebaseDb.ref('system_settings/referral').once('value');
  const merged = normalizeReferralSettingsServer({
    ...(currentSnapshot.val() || {}),
    ...(body.settings || body),
    updatedAt: Date.now(),
    updatedBy: admin.email
  });
  const adminAccount = await resolveGameAccount(admin, {
    publicId: String(body.publicId || '').replace(/\D/g, '').slice(0, 18),
    allowBootstrap: true
  });
  const code = safeText(merged.adminCode || 'ADNORVIP', 32).toUpperCase().replace(/[^A-Z0-9_-]/g, '') || 'ADNORVIP';
  merged.adminCode = code;
  const oldCodeSnapshot = await firebaseDb.ref(`referral_codes/${code}`).once('value');
  const oldCode = oldCodeSnapshot.val() || {};
  const now = Date.now();
  const updates = {};
  updates['system_settings/referral'] = merged;
  updates[`referral_codes/${code}`] = {
    code,
    ownerUid: adminAccount.uid,
    ownerAuthUid: admin.uid,
    ownerEmail: safeText(admin.email || adminAccount.profile.email, 220),
    ownerName: safeText(adminAccount.profile.name || adminAccount.profile.displayName || 'ADNOR Admin', 160),
    type: 'admin_code',
    active: true,
    createdAt: Number(oldCode.createdAt || now),
    updatedAt: now,
    source: 'server_v226_admin_settings'
  };
  updates[`users/${adminAccount.uid}/referralCode`] = code;
  updates[`users/${adminAccount.uid}/refCode`] = code;
  updates[`auth_user_links/${admin.uid}`] = adminAccount.uid;
  updates[`finance_audit/referral_settings_${now}`] = {
    action: 'referral_settings_updated',
    adminUid: admin.uid,
    adminFinancialUid: adminAccount.uid,
    adminEmail: admin.email,
    settings: merged,
    createdAt: now
  };
  await firebaseDb.ref().update(updates);
  return { ok: true, settings: merged, code, financialUid: adminAccount.uid };
}

async function adminPaymentMethodsList() {
  const snapshot = await firebaseDb.ref('payment_methods').once('value');
  return { ok: true, methods: objectValues(snapshot.val()).sort((a, b) => timestampOf(b) - timestampOf(a)) };
}

async function adminSavePaymentMethod(admin, body) {
  const action = safeText(body.action || 'save', 20).toLowerCase();
  const rawId = safeText(body.id || body.method && body.method.id, 120);
  if (!isValidFirebaseKey(rawId)) { const error = new Error('INVALID_PAYMENT_METHOD_ID'); error.statusCode = 400; throw error; }
  if (action === 'delete') {
    await firebaseDb.ref(`payment_methods/${rawId}`).remove();
    return { ok: true, deleted: true };
  }
  const input = body.method && typeof body.method === 'object' ? body.method : body;
  const type = safeText(input.type || 'both', 30).toLowerCase();
  if (!['deposit', 'withdraw', 'withdrawal', 'both'].includes(type)) { const error = new Error('INVALID_PAYMENT_METHOD_TYPE'); error.statusCode = 400; throw error; }
  const now = Date.now();
  const method = {
    id: rawId,
    name: safeText(input.name || rawId, 160),
    type: type === 'withdrawal' ? 'withdraw' : type,
    category: safeText(input.category || 'other', 60),
    address: safeText(input.address, 1000),
    details: safeText(input.details, 2000),
    minDeposit: Math.max(0, numberValue(input.minDeposit)),
    minWithdraw: Math.max(0, numberValue(input.minWithdraw)),
    active: safeBoolean(input.active, true),
    enabled: safeBoolean(input.active, true),
    sortOrder: Number(input.sortOrder || 0),
    updatedAt: now, updatedBy: admin.email,
    createdAt: Number(input.createdAt || now)
  };
  await firebaseDb.ref(`payment_methods/${rawId}`).set(method);
  return { ok: true, method };
}

function flattenSupportTickets(raw) {
  const rows = [];
  if (!raw || typeof raw !== 'object') return rows;
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    if (value.uid || value.subject || value.title || value.message) rows.push({ id: value.id || key, ...value });
    else for (const [ticketId, ticket] of Object.entries(value)) if (ticket && typeof ticket === 'object') rows.push({ id: ticket.id || ticketId, uid: ticket.uid || key, ...ticket });
  }
  return rows.sort((a, b) => timestampOf(b) - timestampOf(a));
}

async function adminSupportList() {
  const [adminSnapshot, userSnapshot] = await Promise.all([
    firebaseDb.ref('admin_support_tickets').once('value'),
    firebaseDb.ref('support_tickets').once('value')
  ]);
  const byId = new Map();
  for (const item of [...flattenSupportTickets(userSnapshot.val()), ...flattenSupportTickets(adminSnapshot.val())]) byId.set(item.id, item);
  return { ok: true, tickets: [...byId.values()].sort((a, b) => timestampOf(b) - timestampOf(a)).slice(0, 500) };
}

async function adminReplySupport(admin, body) {
  const id = safeText(body.id, 160);
  const uid = safeText(body.uid, 160);
  const reply = safeText(body.reply, 4000);
  const status = safeText(body.status || 'answered', 30);
  if (!isValidFirebaseKey(id) || !isValidFirebaseKey(uid) || reply.length < 2) { const error = new Error('INVALID_SUPPORT_REPLY'); error.statusCode = 400; throw error; }
  const now = Date.now();
  const patch = { adminReply: reply, reply, status, answeredAt: now, answeredBy: admin.email, updatedAt: now };
  const updates = {};
  for (const path of [`support_tickets/${uid}/${id}`, `admin_support_tickets/${id}`, `admin_support_tickets/${uid}/${id}`]) {
    for (const [key, value] of Object.entries(patch)) updates[`${path}/${key}`] = value;
  }
  updates[`user_notifications/${uid}/support_${id}_${now}`] = {
    id: `support_${id}_${now}`, type: 'support_reply', title: 'رد جديد من الدعم',
    text: reply.slice(0, 300), link: 'app.html?section=support', read: false, createdAt: now
  };
  await firebaseDb.ref().update(updates);
  return { ok: true, status };
}

async function adminAgentsList() {
  const [agentsSnapshot, logsSnapshot] = await Promise.all([
    firebaseDb.ref('agents').once('value'),
    firebaseDb.ref('agent_recharges').limitToLast(300).once('value')
  ]);
  const agents = Object.entries(agentsSnapshot.val() || {}).map(([uid, value]) => ({ uid, ...(value || {}), balance: agentBalanceFrom(value) }));
  return { ok: true, agents: agents.sort((a, b) => timestampOf(b) - timestampOf(a)), logs: objectValues(logsSnapshot.val()).sort((a, b) => timestampOf(b) - timestampOf(a)) };
}

async function adminSaveAgent(admin, body) {
  const target = await findUserByTargetId(body.targetId || body.uid);
  const now = Date.now();
  const existingSnapshot = await firebaseDb.ref(`agents/${target.uid}`).once('value');
  const existing = existingSnapshot.val() || {};
  const active = safeBoolean(body.active, existing.active !== false);
  const balance = body.balance === undefined ? agentBalanceFrom(existing) : Math.max(0, numberValue(body.balance));
  const agent = {
    ...existing,
    uid: target.uid,
    publicId: safeText(target.user.publicId || target.user.userId || target.user.numericId, 80),
    name: safeText(target.user.name || target.user.displayName, 160),
    email: safeText(target.user.email, 220),
    active, frozen: !active,
    agentBalance: balance, balance,
    updatedAt: now, updatedBy: admin.email,
    createdAt: Number(existing.createdAt || now)
  };
  const updates = {};
  updates[`agents/${target.uid}`] = agent;
  updates[`users/${target.uid}/isAgent`] = active;
  updates[`users/${target.uid}/agentActive`] = active;
  updates[`finance_audit/agent_save_${target.uid}_${now}`] = { action: 'agent_saved', targetUid: target.uid, active, balance, adminEmail: admin.email, createdAt: now };
  await firebaseDb.ref().update(updates);
  return { ok: true, agent };
}

async function adminAdjustAgentBalance(admin, body) {
  const uid = safeText(body.uid || body.targetId, 160);
  const delta = numberValue(body.delta);
  const reason = safeText(body.reason, 500);
  if (!isValidFirebaseKey(uid) || !delta || reason.length < 3) { const error = new Error('INVALID_AGENT_ADJUSTMENT'); error.statusCode = 400; throw error; }
  let result = null;
  const tx = await firebaseDb.ref(`agents/${uid}`).transaction((agent) => {
    if (!agent) return;
    const before = agentBalanceFrom(agent);
    const after = numberValue(before + delta);
    if (after < 0) return;
    result = { before, after };
    return { ...agent, agentBalance: after, balance: after, updatedAt: Date.now(), updatedBy: admin.email };
  }, undefined, false);
  if (!tx.committed || !result) { const error = new Error('AGENT_BALANCE_ADJUSTMENT_FAILED'); error.statusCode = 409; throw error; }
  await firebaseDb.ref(`finance_audit/agent_balance_${uid}_${Date.now()}`).set({ action: 'agent_balance_adjusted', uid, delta, reason, ...result, adminEmail: admin.email, createdAt: Date.now() });
  return { ok: true, ...result };
}

async function adminSaveLotterySettings(admin, body) {
  const currentSnapshot = await firebaseDb.ref('lottery_settings').once('value');
  const current = currentSnapshot.val() || {};
  const input = body.settings || body;
  const now = Date.now();
  const settings = {
    ...current,
    ticketPrice: Math.max(0.01, numberValue(input.ticketPrice ?? current.ticketPrice ?? 1)),
    allowBonusForTickets: safeBoolean(input.allowBonusForTickets, current.allowBonusForTickets !== false),
    daily: { ...(current.daily || {}), enabled: safeBoolean(input.dailyEnabled, current.daily?.enabled !== false), prize: Math.max(0, numberValue(input.dailyPrize ?? current.daily?.prize ?? 4500)) },
    weekly: { ...(current.weekly || {}), enabled: safeBoolean(input.weeklyEnabled, current.weekly?.enabled !== false), prize: Math.max(0, numberValue(input.weeklyPrize ?? current.weekly?.prize ?? 15000)) },
    monthly: { ...(current.monthly || {}), enabled: safeBoolean(input.monthlyEnabled, current.monthly?.enabled !== false), prize: Math.max(0, numberValue(input.monthlyPrize ?? current.monthly?.prize ?? 45000)) },
    yearly: { ...(current.yearly || {}), enabled: safeBoolean(input.yearlyEnabled, current.yearly?.enabled !== false), prize: Math.max(0, numberValue(input.yearlyPrize ?? current.yearly?.prize ?? 750000)) },
    updatedAt: now, updatedBy: admin.email
  };
  await firebaseDb.ref('lottery_settings').set(settings);
  return { ok: true, settings };
}

async function findTicketByNumber(drawType, ticketNumber) {
  const type = normalizeDrawType(drawType);
  const groups = type ? [type] : ['daily', 'weekly', 'monthly', 'yearly'];
  const wanted = String(ticketNumber || '').replace(/\D/g, '');
  for (const group of groups) {
    const snapshot = await firebaseDb.ref(`tickets/${group}`).once('value');
    const matches = Object.entries(snapshot.val() || {})
      .filter(([, ticket]) => String(ticket && (ticket.number || ticket.ticketNumber) || '').replace(/\D/g, '') === wanted)
      .map(([id, ticket]) => ({ id, drawType: group, ...ticket }))
      .sort((a, b) => {
        const activeA = String(a.status || 'active') === 'active' ? 1 : 0;
        const activeB = String(b.status || 'active') === 'active' ? 1 : 0;
        if (activeA !== activeB) return activeB - activeA;
        return Number(b.createdAt || b.updatedAt || 0) - Number(a.createdAt || a.updatedAt || 0);
      });
    if (matches.length) return matches[0];
  }
  return null;
}

const PRIVATE_DRAW_SCHEDULE_PATH = 'admin_draw_schedule';
const PRIVATE_DRAW_RESULTS_PATH = 'draw_results_private';
const PRIVATE_DRAW_SETTLEMENTS_PATH = 'draw_settlements';
const PRIVATE_DRAW_SETTLEMENT_QUEUE_PATH = 'draw_settlement_queue';
const PRIVATE_DRAW_PUBLISH_ERRORS_PATH = 'draw_publish_errors';
const PUBLIC_OFFICIAL_RESULTS_PATH = 'system_settings/v108_official_draw_results';
let nextDrawWakeTimer = null;

function nextDrawTypeServer(drawType) {
  return { daily: 'weekly', weekly: 'monthly', monthly: 'yearly', yearly: '' }[drawType] || '';
}

function normalizePublishAt(value, fallback = Date.now()) {
  let timestamp = Number(value || fallback);
  if (timestamp > 0 && timestamp < 100000000000) timestamp *= 1000;
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp) : fallback;
}

function publicDrawResult(result, settlement = {}) {
  const now = Date.now();
  return {
    id: safeText(result.id, 180),
    drawType: normalizeDrawType(result.drawType),
    drawLabel: drawLabelServer(normalizeDrawType(result.drawType)),
    ticketNumber: safeText(result.ticketNumber, 20).replace(/\D/g, '').padStart(7, '0').slice(-7),
    winnerName: safeText(result.winnerName || 'مستخدم ADNOR', 160),
    winnerEmailMasked: safeText(result.winnerEmailMasked || '', 180),
    prize: Math.max(0, numberValue(result.prize)),
    status: 'published',
    settlementStatus: safeText(result.settlementStatus || (settlement && settlement.settledAt ? 'completed' : 'pending'), 40),
    publishAt: normalizePublishAt(result.publishAt, now),
    publishedAt: normalizePublishAt(result.publishedAt, now),
    createdAt: normalizePublishAt(result.createdAt, now),
    updatedAt: now,
    totalTickets: Number(settlement.totalTickets || result.totalTickets || 0),
    movedTickets: Number(settlement.movedTickets || result.movedTickets || 0),
    source: 'server_v222_publish_first_scheduler'
  };
}

async function resolveDrawFinancialOwner(storedUid, ticket = {}) {
  const originalUid = String(storedUid || '').trim();
  const emailLower = String(ticket.userEmail || ticket.email || '').trim().toLowerCase();
  if (!originalUid || !isValidFirebaseKey(originalUid)) return null;

  const directSnapshot = await firebaseDb.ref(`users/${originalUid}`).once('value');
  if (directSnapshot.exists() && gameAccountProfileLooksUsable(directSnapshot.val())) {
    return { uid: originalUid, profile: directSnapshot.val() || {}, linked: false };
  }

  const candidates = new Map();
  const addCandidate = (entry) => {
    if (!entry || !entry.uid || !isValidFirebaseKey(String(entry.uid))) return;
    if (!gameAccountProfileLooksUsable(entry.profile)) return;
    if (!candidates.has(String(entry.uid))) candidates.set(String(entry.uid), { uid: String(entry.uid), profile: entry.profile });
  };

  const linkSnapshot = await firebaseDb.ref(`auth_user_links/${originalUid}`).once('value');
  const linkedUid = String(linkSnapshot.val() || '').trim();
  if (linkedUid && isValidFirebaseKey(linkedUid)) {
    const linkedSnapshot = await firebaseDb.ref(`users/${linkedUid}`).once('value');
    if (linkedSnapshot.exists()) addCandidate({ uid: linkedUid, profile: linkedSnapshot.val() || {} });
  }

  for (const field of ['authUid', 'firebaseAuthUid', 'firebaseUid', 'uid']) {
    try {
      for (const entry of await findUsersByChild(field, originalUid)) addCandidate(entry);
    } catch (error) {
      console.warn('DRAW_ACCOUNT_LOOKUP_SKIPPED', field, error.message);
    }
  }

  if (emailLower) {
    for (const field of ['emailLower', 'email']) {
      try {
        for (const entry of await findUsersByChild(field, emailLower)) addCandidate(entry);
      } catch (error) {
        console.warn('DRAW_ACCOUNT_EMAIL_LOOKUP_SKIPPED', field, error.message);
      }
    }
  }

  let selected = chooseGameAccountCandidate(candidates, originalUid, emailLower);
  if (!selected) {
    try {
      selected = await legacyScanGameAccount(originalUid, emailLower, '', '');
    } catch (error) {
      console.warn('DRAW_ACCOUNT_LEGACY_SCAN_SKIPPED', error.message);
    }
  }
  if (!selected) return null;

  const updates = { [`auth_user_links/${originalUid}`]: selected.uid };
  if (!selected.profile.uid) updates[`users/${selected.uid}/uid`] = selected.uid;
  if (!selected.profile.authUid) updates[`users/${selected.uid}/authUid`] = originalUid;
  updates[`users/${selected.uid}/accountLinkUpdatedAt`] = Date.now();
  try { await firebaseDb.ref().update(updates); } catch (error) {
    console.warn('DRAW_ACCOUNT_LINK_UPDATE_SKIPPED', error.message);
  }
  return { uid: selected.uid, profile: selected.profile, linked: selected.uid !== originalUid };
}

async function awardDrawPrize(result, adminEmail) {
  if (!result || !result.winnerUid || !(Number(result.prize) > 0)) return null;
  const ownerHints = { userEmail: result.winnerEmail || result.userEmail || '' };
  const resolvedOwner = await resolveDrawFinancialOwner(result.winnerUid, ownerHints) ||
    await resolveDrawFinancialOwner(result.ticketOwnerUid, ownerHints);
  const creditUid = String(resolvedOwner?.uid || result.winnerUid || result.ticketOwnerUid || '');
  if (!creditUid || !isValidFirebaseKey(creditUid)) {
    const error = new Error('DRAW_PRIZE_ACCOUNT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }

  const receiptId = safeText(result.id, 160);
  let receipt = null;
  const tx = await firebaseDb.ref(`users/${creditUid}`).transaction((profile) => {
    if (!profile) return;
    const receipts = { ...(profile.serverDrawPrizeReceipts || {}) };
    if (receipts[receiptId]) { receipt = { ...receipts[receiptId], winnerUid: creditUid }; return profile; }
    const before = numberValue(profile.realBalance);
    const after = numberValue(before + Number(result.prize));
    receipt = { before, after, prize: Number(result.prize), winnerUid: creditUid, createdAt: Date.now() };
    receipts[receiptId] = receipt;
    return { ...profile, realBalance: after, serverDrawPrizeReceipts: receipts, updatedAt: Date.now() };
  }, undefined, false);

  if (!tx.committed || !receipt) {
    const error = new Error('DRAW_PRIZE_CREDIT_FAILED');
    error.statusCode = 409;
    throw error;
  }

  const now = Date.now();
  const updates = {};
  updates[`transactions/${creditUid}/draw_prize_${receiptId}`] = {
    id: `draw_prize_${receiptId}`, type: 'draw_prize', amount: Number(result.prize),
    balanceBefore: receipt.before, balanceAfter: receipt.after, drawType: result.drawType,
    ticketNumber: result.ticketNumber, createdAt: now
  };
  updates[`user_notifications/${creditUid}/draw_prize_${receiptId}`] = {
    id: `draw_prize_${receiptId}`, type: 'draw_prize', title: 'مبروك! ربحت في ADNOR',
    text: `ربحت $${Number(result.prize)} في ${result.drawLabel}.`, read: false, createdAt: now
  };
  updates[`finance_audit/draw_prize_${receiptId}`] = {
    action: 'draw_prize_credited', uid: creditUid, originalWinnerUid: result.winnerUid,
    prize: Number(result.prize), ticketNumber: result.ticketNumber, adminEmail, createdAt: now
  };
  await firebaseDb.ref().update(updates);
  return receipt;
}

async function settleDrawTickets(result) {
  const existingSnapshot = await firebaseDb.ref(`${PRIVATE_DRAW_SETTLEMENTS_PATH}/${result.id}`).once('value');
  if (existingSnapshot.exists()) return existingSnapshot.val();

  const drawType = normalizeDrawType(result.drawType);
  const [ticketsSnapshot, settingsSnapshot] = await Promise.all([
    firebaseDb.ref(`tickets/${drawType}`).once('value'),
    firebaseDb.ref('lottery_settings').once('value')
  ]);
  const ticketsObject = ticketsSnapshot.val() || {};
  const entries = Object.entries(ticketsObject).filter(([, ticket]) => ticket && typeof ticket === 'object');
  const winnerEntry = entries.find(([id, ticket]) =>
    id === result.ticketId ||
    (String(ticket.number || ticket.ticketNumber || '') === String(result.ticketNumber) && (!result.winnerUid || ticket.uid === result.winnerUid))
  );
  if (!winnerEntry) { const error = new Error('WINNING_TICKET_NOT_FOUND'); error.statusCode = 404; throw error; }

  const [winnerTicketId, winnerTicket] = winnerEntry;
  const winnerUid = result.winnerUid || winnerTicket.uid;
  const ticketOwnerUid = result.ticketOwnerUid || winnerTicket.uid;
  const activeEntries = entries.filter(([, ticket]) => String(ticket.status || 'active') === 'active');
  const settings = settingsSnapshot.val() || {};
  const nextType = settings.moveLosers !== false ? nextDrawTypeServer(drawType) : '';
  const now = Date.now();
  const updates = {};
  let movedTickets = 0;
  let lostTickets = 0;

  const winnerPatch = {
    status: 'winner', resultDrawId: result.id, publishAt: result.publishAt,
    publishedAt: now, updatedAt: now
  };
  Object.entries(winnerPatch).forEach(([key, value]) => {
    updates[`tickets/${drawType}/${winnerTicketId}/${key}`] = value;
    updates[`user_tickets/${winnerUid}/${winnerTicketId}/${key}`] = value;
    if (ticketOwnerUid && ticketOwnerUid !== winnerUid) {
      updates[`user_tickets/${ticketOwnerUid}/${winnerTicketId}/${key}`] = value;
    }
  });

  for (const [ticketId, ticket] of activeEntries) {
    if (ticketId === winnerTicketId) continue;
    if (nextType) {
      const movedId = requestKey('moved_ticket', ticket.uid || 'unknown', `${result.id}_${ticketId}`);
      const movedTicket = {
        ...ticket,
        id: movedId,
        previousTicketId: ticketId,
        previousDraw: drawType,
        drawType: nextType,
        drawLabel: drawLabelServer(nextType),
        status: 'active',
        movedAt: now,
        movedFromDrawId: result.id,
        resultDrawId: null,
        publishAt: null,
        updatedAt: now
      };
      updates[`tickets/${drawType}/${ticketId}/status`] = 'moved';
      updates[`tickets/${drawType}/${ticketId}/movedTo`] = nextType;
      updates[`tickets/${drawType}/${ticketId}/resultDrawId`] = result.id;
      updates[`tickets/${drawType}/${ticketId}/updatedAt`] = now;
      updates[`user_tickets/${ticket.uid}/${ticketId}/status`] = 'moved';
      updates[`user_tickets/${ticket.uid}/${ticketId}/movedTo`] = nextType;
      updates[`user_tickets/${ticket.uid}/${ticketId}/resultDrawId`] = result.id;
      updates[`user_tickets/${ticket.uid}/${ticketId}/updatedAt`] = now;
      updates[`tickets/${nextType}/${movedId}`] = movedTicket;
      updates[`user_tickets/${ticket.uid}/${movedId}`] = movedTicket;
      movedTickets += 1;
    } else {
      updates[`tickets/${drawType}/${ticketId}/status`] = 'lost';
      updates[`tickets/${drawType}/${ticketId}/resultDrawId`] = result.id;
      updates[`tickets/${drawType}/${ticketId}/updatedAt`] = now;
      updates[`user_tickets/${ticket.uid}/${ticketId}/status`] = 'lost';
      updates[`user_tickets/${ticket.uid}/${ticketId}/resultDrawId`] = result.id;
      updates[`user_tickets/${ticket.uid}/${ticketId}/updatedAt`] = now;
      lostTickets += 1;
    }
  }

  const settlement = {
    id: result.id,
    drawType,
    winnerUid,
    winnerTicketId,
    totalTickets: entries.length,
    activeTicketsAtPublish: activeEntries.length,
    movedTickets,
    lostTickets,
    nextDrawType: nextType || null,
    settledAt: now
  };
  updates[`${PRIVATE_DRAW_SETTLEMENTS_PATH}/${result.id}`] = settlement;
  await firebaseDb.ref().update(updates);
  return settlement;
}

async function resolveDrawWinner(result) {
  const drawType = normalizeDrawType(result.drawType);
  const ticketNumber = safeText(result.ticketNumber, 20).replace(/\D/g, '');
  let ticket = null;
  if (result.ticketId) {
    const snapshot = await firebaseDb.ref(`tickets/${drawType}/${result.ticketId}`).once('value');
    if (snapshot.exists()) ticket = { id: result.ticketId, ...snapshot.val() };
  }
  if (!ticket) ticket = await findTicketByNumber(drawType, ticketNumber);
  if (!ticket || !ticket.uid) {
    const error = new Error('WINNING_TICKET_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }

  const owner = await resolveDrawFinancialOwner(ticket.uid, ticket);
  const winnerUid = String(owner?.uid || ticket.uid);
  const user = owner?.profile || {};
  const winnerEmail = String(user.email || ticket.userEmail || result.winnerEmail || '').trim();

  return {
    ...result,
    drawType,
    drawLabel: drawLabelServer(drawType),
    ticketNumber,
    ticketId: ticket.id,
    ticketOwnerUid: ticket.uid,
    winnerUid,
    winnerEmail,
    winnerName: safeText(result.winnerName || user.name || user.displayName || ticket.userName || maskEmail(winnerEmail), 160),
    winnerEmailMasked: maskEmail(winnerEmail)
  };
}

async function persistPublishedDrawState(fullResult, settlement = {}, settlementStatus = 'pending') {
  const now = Date.now();
  const normalized = {
    ...fullResult,
    status: 'published',
    settlementStatus,
    publishedAt: normalizePublishAt(fullResult.publishedAt, now),
    updatedAt: now,
    source: 'server_v222_publish_first_scheduler'
  };
  const publicResult = publicDrawResult(normalized, settlement);
  const updates = {};

  updates[`${PRIVATE_DRAW_RESULTS_PATH}/${normalized.drawType}/${normalized.id}`] = { ...normalized, settlement };
  updates[`${PRIVATE_DRAW_RESULTS_PATH}_latest/${normalized.drawType}`] = { ...normalized, settlement };
  updates[`${PRIVATE_DRAW_SCHEDULE_PATH}/${normalized.drawType}`] = null;
  updates[`admin_draw_history/${normalized.drawType}/${normalized.id}`] = { ...normalized, settlement };

  updates[`public_draw_results/${normalized.drawType}`] = publicResult;
  updates[`${PUBLIC_OFFICIAL_RESULTS_PATH}/published/${normalized.drawType}`] = publicResult;
  updates[`${PUBLIC_OFFICIAL_RESULTS_PATH}/current/${normalized.drawType}`] = publicResult;
  updates[`${PUBLIC_OFFICIAL_RESULTS_PATH}/latestPublished`] = publicResult;
  updates[`${PUBLIC_OFFICIAL_RESULTS_PATH}/latest`] = publicResult;
  updates[`${PUBLIC_OFFICIAL_RESULTS_PATH}/history/${normalized.drawType}/${normalized.id}`] = publicResult;
  updates[`${PUBLIC_OFFICIAL_RESULTS_PATH}/tickerUpdatedAt`] = now;

  updates[`lottery_settings/v91_last_results/current/${normalized.drawType}`] = publicResult;
  updates['lottery_settings/v91_last_results/latest'] = publicResult;
  updates[`lottery_settings/v91_last_results/history/${normalized.drawType}/${normalized.id}`] = publicResult;
  updates[`lottery_settings/last_results/current/${normalized.drawType}`] = publicResult;
  updates['lottery_settings/last_results/latest'] = publicResult;
  updates[`lottery_settings/last_results/history/${normalized.drawType}/${normalized.id}`] = publicResult;
  updates[`system_settings/latest_draw_results/current/${normalized.drawType}`] = publicResult;
  updates['system_settings/latest_draw_results/latest'] = publicResult;
  updates[`system_settings/latest_draw_results/history/${normalized.drawType}/${normalized.id}`] = publicResult;
  updates[`draw_rounds/${normalized.drawType}/${normalized.id}`] = publicResult;
  updates[`draw_history/${normalized.id}`] = publicResult;

  updates[`lottery_settings/v91_last_results/scheduled/${normalized.drawType}`] = null;
  updates[`${PUBLIC_OFFICIAL_RESULTS_PATH}/scheduled/${normalized.drawType}`] = null;
  updates[`${PUBLIC_OFFICIAL_RESULTS_PATH}/upcoming/${normalized.drawType}`] = null;

  if (settlementStatus !== 'completed') {
    updates[`${PRIVATE_DRAW_SETTLEMENT_QUEUE_PATH}/${normalized.id}`] = {
      id: normalized.id,
      drawType: normalized.drawType,
      result: normalized,
      attempts: Number(normalized.settlementAttempts || 0),
      errorCode: safeText(normalized.settlementErrorCode || '', 160),
      lastErrorAt: Number(normalized.settlementUpdatedAt || 0),
      nextRetryAt: now + 15000,
      adminEmail: normalized.publishedBy || normalized.createdBy || 'system'
    };
  }

  await firebaseDb.ref().update(updates);
  return { fullResult: normalized, publicResult };
}

async function completePublishedDrawSettlement(fullResult, adminEmail = 'system') {
  const prizeReceipt = fullResult.legacyPrizeAlreadyCredited === true
    ? { winnerUid: fullResult.winnerUid, legacyCredited: true }
    : await awardDrawPrize(fullResult, adminEmail);

  const effectiveResult = {
    ...fullResult,
    winnerUid: String(prizeReceipt?.winnerUid || fullResult.winnerUid),
    settlementStatus: 'completed',
    settlementCompletedAt: Date.now()
  };
  const settlement = fullResult.legacyTicketsAlreadySettled === true
    ? {
        totalTickets: Number(fullResult.totalTickets || 0),
        movedTickets: Number(fullResult.movedTickets || 0),
        legacySettled: true,
        settledAt: Date.now()
      }
    : await settleDrawTickets(effectiveResult);

  const published = await persistPublishedDrawState(effectiveResult, settlement, 'completed');
  const updates = {};
  updates[`${PRIVATE_DRAW_SETTLEMENT_QUEUE_PATH}/${effectiveResult.id}`] = null;
  updates[`${PRIVATE_DRAW_PUBLISH_ERRORS_PATH}/${effectiveResult.id}`] = null;
  updates[`admin_notifications/draw_${effectiveResult.id}`] = {
    id: `draw_${effectiveResult.id}`, type: 'draw_result_published',
    text: `تم نشر نتيجة ${published.publicResult.drawLabel}: ${published.publicResult.ticketNumber}`,
    status: 'new', createdAt: Date.now()
  };
  await firebaseDb.ref().update(updates);
  return published.publicResult;
}

async function recordDrawSettlementFailure(fullResult, error, adminEmail = 'system') {
  const now = Date.now();
  const queueRef = firebaseDb.ref(`${PRIVATE_DRAW_SETTLEMENT_QUEUE_PATH}/${fullResult.id}`);
  const currentSnapshot = await queueRef.once('value');
  const current = currentSnapshot.val() || {};
  const attempts = Number(current.attempts || 0) + 1;
  const errorCode = safeText(error && (error.code || error.message) || 'DRAW_SETTLEMENT_FAILED', 160);
  const nextRetryAt = now + Math.min(300000, Math.max(15000, attempts * 15000));
  const pendingResult = {
    ...fullResult,
    status: 'published',
    settlementStatus: 'pending',
    settlementErrorCode: errorCode,
    settlementUpdatedAt: now
  };
  await persistPublishedDrawState(pendingResult, current.settlement || {}, 'pending');
  const updates = {};
  updates[`${PRIVATE_DRAW_SETTLEMENT_QUEUE_PATH}/${fullResult.id}`] = {
    id: fullResult.id,
    drawType: fullResult.drawType,
    result: pendingResult,
    attempts,
    errorCode,
    lastErrorAt: now,
    nextRetryAt,
    adminEmail
  };
  updates[`${PRIVATE_DRAW_PUBLISH_ERRORS_PATH}/${fullResult.id}`] = {
    id: fullResult.id,
    drawType: fullResult.drawType,
    ticketNumber: fullResult.ticketNumber,
    errorCode,
    attempts,
    createdAt: Number(current.createdAt || now),
    updatedAt: now
  };
  await firebaseDb.ref().update(updates);
  console.error('DRAW_SETTLEMENT_PENDING_V222', fullResult.drawType, fullResult.id, errorCode);
  return publicDrawResult(pendingResult, {});
}

async function retryPendingDrawSettlements() {
  const snapshot = await firebaseDb.ref(PRIVATE_DRAW_SETTLEMENT_QUEUE_PATH).once('value');
  const now = Date.now();
  const queue = Object.values(snapshot.val() || {})
    .filter((item) => item && item.result && Number(item.nextRetryAt || 0) <= now)
    .sort((a, b) => Number(a.nextRetryAt || 0) - Number(b.nextRetryAt || 0))
    .slice(0, 10);

  for (const item of queue) {
    try {
      await completePublishedDrawSettlement(item.result, item.adminEmail || 'system_retry_v222');
    } catch (error) {
      await recordDrawSettlementFailure(item.result, error, item.adminEmail || 'system_retry_v222');
    }
  }
}

async function publishLotteryResult(inputResult, adminEmail = 'system') {
  const now = Date.now();
  const validatedTicket = safeText(inputResult.ticketNumber, 20).replace(/\D/g, '');
  const validatedDrawType = normalizeDrawType(inputResult.drawType);
  const hasValidatedSchedule = /^\d{7}$/.test(validatedTicket) &&
    !!inputResult.id && !!inputResult.ticketId && !!inputResult.winnerUid && !!validatedDrawType;

  let resolved;
  if (hasValidatedSchedule) {
    resolved = {
      ...inputResult,
      drawType: validatedDrawType,
      drawLabel: drawLabelServer(validatedDrawType),
      ticketNumber: validatedTicket,
      winnerName: safeText(inputResult.winnerName || 'مستخدم ADNOR', 160),
      winnerEmailMasked: safeText(inputResult.winnerEmailMasked || '', 180)
    };
  } else {
    resolved = await resolveDrawWinner(inputResult);
  }

  const existingSnapshot = await firebaseDb.ref(`${PRIVATE_DRAW_RESULTS_PATH}/${resolved.drawType}/${resolved.id}`).once('value');
  const existing = existingSnapshot.val();
  if (existing && String(existing.status || '').toLowerCase() === 'published') {
    if (String(existing.settlementStatus || '') !== 'completed') {
      try { return await completePublishedDrawSettlement(existing, adminEmail); }
      catch (error) { return await recordDrawSettlementFailure(existing, error, adminEmail); }
    }
    return publicDrawResult(existing, existing.settlement || {});
  }

  const fullResult = {
    ...resolved,
    status: 'published',
    settlementStatus: 'pending',
    publishAt: normalizePublishAt(resolved.publishAt, now),
    publishedAt: now,
    updatedAt: now,
    publishedBy: adminEmail,
    source: 'server_v222_publish_first_scheduler'
  };

  const firstPublication = await persistPublishedDrawState(fullResult, {}, 'pending');
  try {
    const settledPublic = await completePublishedDrawSettlement(firstPublication.fullResult, adminEmail);
    scheduleNextDrawWakeup().catch((error) => console.error('DRAW_RESCHEDULE_ERROR', error.message));
    return settledPublic;
  } catch (error) {
    const pendingPublic = await recordDrawSettlementFailure(firstPublication.fullResult, error, adminEmail);
    scheduleNextDrawWakeup().catch((scheduleError) => console.error('DRAW_RESCHEDULE_ERROR', scheduleError.message));
    return pendingPublic;
  }
}

function collectLegacyScheduledCandidates(type, roots) {
  const candidates = [];
  const pushCandidate = (value) => {
    if (!value || typeof value !== 'object') return;
    if (String(value.status || '').toLowerCase() !== 'scheduled') return;
    const drawType = normalizeDrawType(value.drawType || type);
    if (drawType === type && value.ticketNumber) candidates.push({ ...value, drawType });
  };
  pushCandidate(roots.v91?.scheduled?.[type]);
  pushCandidate(roots.v91?.current?.[type]);
  pushCandidate(roots.old?.current?.[type]);
  pushCandidate(roots.latest?.current?.[type]);
  pushCandidate(roots.v108?.current?.[type]);
  pushCandidate(roots.v108?.upcoming?.[type]);
  const raw = roots.v108?.scheduled?.[type];
  if (raw && typeof raw === 'object') {
    if (raw.ticketNumber) pushCandidate(raw);
    else Object.values(raw).forEach(pushCandidate);
  }
  return candidates.sort((a, b) => normalizePublishAt(b.publishAt, 0) - normalizePublishAt(a.publishAt, 0));
}

let legacyDrawMigrationPromise = null;

async function migrateLegacyScheduledDrawResults() {
  if (legacyDrawMigrationPromise) return legacyDrawMigrationPromise;
  legacyDrawMigrationPromise = (async () => {
    // Read only the current/scheduled records. The old implementation downloaded and
    // rescanned every legacy result history on every 15-second scheduler tick.
    const [v91ScheduledSnap, v91CurrentSnap, oldCurrentSnap, latestCurrentSnap,
      v108ScheduledSnap, v108UpcomingSnap, v108CurrentSnap, privateSnap] = await Promise.all([
      firebaseDb.ref('lottery_settings/v91_last_results/scheduled').once('value'),
      firebaseDb.ref('lottery_settings/v91_last_results/current').once('value'),
      firebaseDb.ref('lottery_settings/last_results/current').once('value'),
      firebaseDb.ref('system_settings/latest_draw_results/current').once('value'),
      firebaseDb.ref(`${PUBLIC_OFFICIAL_RESULTS_PATH}/scheduled`).once('value'),
      firebaseDb.ref(`${PUBLIC_OFFICIAL_RESULTS_PATH}/upcoming`).once('value'),
      firebaseDb.ref(`${PUBLIC_OFFICIAL_RESULTS_PATH}/current`).once('value'),
      firebaseDb.ref(PRIVATE_DRAW_SCHEDULE_PATH).once('value')
    ]);
    const roots = {
      v91: { scheduled: v91ScheduledSnap.val() || {}, current: v91CurrentSnap.val() || {} },
      old: { current: oldCurrentSnap.val() || {} },
      latest: { current: latestCurrentSnap.val() || {} },
      v108: {
        scheduled: v108ScheduledSnap.val() || {},
        upcoming: v108UpcomingSnap.val() || {},
        current: v108CurrentSnap.val() || {}
      }
    };
    const privateScheduled = privateSnap.val() || {};
    const updates = {};

    for (const type of ['daily', 'weekly', 'monthly', 'yearly']) {
      if (!privateScheduled[type]) {
        const candidate = collectLegacyScheduledCandidates(type, roots)[0];
        if (candidate) {
          try {
            const resolved = await resolveDrawWinner(candidate);
            const id = safeText(candidate.id, 180) || requestKey(`result_${type}`, resolved.winnerUid, `${resolved.ticketNumber}_${resolved.publishAt}`);
            updates[`${PRIVATE_DRAW_SCHEDULE_PATH}/${type}`] = {
              ...resolved,
              id,
              status: 'scheduled',
              publishAt: normalizePublishAt(candidate.publishAt),
              createdAt: normalizePublishAt(candidate.createdAt, Date.now()),
              updatedAt: Date.now(),
              migratedFromLegacy: true,
              legacyPrizeAlreadyCredited: String(candidate.drawMode || '').toLowerCase() === 'manual_admin' || String(candidate.source || '').toLowerCase().includes('manual'),
              legacyTicketsAlreadySettled: String(candidate.drawMode || '').toLowerCase() === 'manual_admin' || String(candidate.source || '').toLowerCase().includes('manual'),
              source: 'server_v218_legacy_migration'
            };
          } catch (error) {
            console.warn('DRAW_LEGACY_MIGRATION_SKIPPED', type, error.message);
          }
        }
      }

      if (Object.prototype.hasOwnProperty.call(roots.v91.scheduled, type)) updates[`lottery_settings/v91_last_results/scheduled/${type}`] = null;
      if (Object.prototype.hasOwnProperty.call(roots.v108.scheduled, type)) updates[`${PUBLIC_OFFICIAL_RESULTS_PATH}/scheduled/${type}`] = null;
      if (Object.prototype.hasOwnProperty.call(roots.v108.upcoming, type)) updates[`${PUBLIC_OFFICIAL_RESULTS_PATH}/upcoming/${type}`] = null;
      for (const [path, item] of [
        [`lottery_settings/v91_last_results/current/${type}`, roots.v91.current[type]],
        [`lottery_settings/last_results/current/${type}`, roots.old.current[type]],
        [`system_settings/latest_draw_results/current/${type}`, roots.latest.current[type]],
        [`${PUBLIC_OFFICIAL_RESULTS_PATH}/current/${type}`, roots.v108.current[type]]
      ]) {
        if (item && String(item.status || '').toLowerCase() === 'scheduled') updates[path] = null;
      }
    }

    if (Object.keys(updates).length) await firebaseDb.ref().update(updates);
  })();
  try {
    await legacyDrawMigrationPromise;
  } catch (error) {
    legacyDrawMigrationPromise = null;
    throw error;
  }
}
async function adminSaveLotteryResult(admin, body) {
  const drawType = normalizeDrawType(body.drawType);
  const mode = safeText(body.mode || 'schedule', 20).toLowerCase();
  if (!drawType) { const error = new Error('INVALID_DRAW_TYPE'); error.statusCode = 400; throw error; }

  if (mode === 'cancel') {
    const existingSnapshot = await firebaseDb.ref(`${PRIVATE_DRAW_SCHEDULE_PATH}/${drawType}`).once('value');
    const existing = existingSnapshot.val();
    const now = Date.now();
    const updates = {};
    updates[`${PRIVATE_DRAW_SCHEDULE_PATH}/${drawType}`] = null;
    if (existing && existing.id) updates[`admin_draw_history/${drawType}/${existing.id}`] = { ...existing, status: 'cancelled', cancelledAt: now, cancelledBy: admin.email, updatedAt: now };
    updates[`finance_audit/draw_schedule_cancel_${drawType}_${now}`] = { action: 'draw_schedule_cancelled', drawType, resultId: existing?.id || '', adminEmail: admin.email, createdAt: now };
    await firebaseDb.ref().update(updates);
    await scheduleNextDrawWakeup();
    return { ok: true, cancelled: true, drawType };
  }

  const ticketNumber = safeText(body.ticketNumber, 20).replace(/\D/g, '');
  const prize = Math.max(0, numberValue(body.prize));
  const publishAt = mode === 'publish' ? Date.now() : normalizePublishAt(body.publishAt, 0);
  if (!/^\d{7}$/.test(ticketNumber) || !(prize > 0) || !(publishAt > 0)) { const error = new Error('INVALID_DRAW_RESULT'); error.statusCode = 400; throw error; }
  if (mode !== 'publish' && publishAt < Date.now() - 5000) { const error = new Error('INVALID_DRAW_RESULT'); error.statusCode = 400; throw error; }

  const ticket = await findTicketByNumber(drawType, ticketNumber);
  if (!ticket || !ticket.uid) { const error = new Error('WINNING_TICKET_NOT_FOUND'); error.statusCode = 404; throw error; }
  const owner = await resolveDrawFinancialOwner(ticket.uid, ticket);
  const winnerUid = String(owner?.uid || ticket.uid);
  const user = owner?.profile || {};
  const winnerEmail = String(user.email || ticket.userEmail || '').trim();
  const now = Date.now();
  const id = requestKey(`result_${drawType}`, winnerUid, body.requestId || `${ticketNumber}_${publishAt}`);
  const result = {
    id, drawType, drawLabel: drawLabelServer(drawType), ticketNumber,
    ticketId: ticket.id, ticketOwnerUid: ticket.uid, winnerUid, winnerEmail,
    winnerName: safeText(body.winnerName || user.name || user.displayName || ticket.userName || maskEmail(winnerEmail), 160),
    winnerEmailMasked: maskEmail(winnerEmail), prize,
    status: mode === 'publish' || publishAt <= now ? 'published' : 'scheduled',
    settlementStatus: mode === 'publish' || publishAt <= now ? 'pending' : 'not_due',
    publishAt: mode === 'publish' ? now : publishAt,
    createdAt: now, updatedAt: now, createdBy: admin.email,
    source: 'server_v222_publish_first_scheduler'
  };

  if (result.status === 'published') return { ok: true, result: await publishLotteryResult(result, admin.email) };

  const updates = {};
  updates[`${PRIVATE_DRAW_SCHEDULE_PATH}/${drawType}`] = result;
  updates[`admin_draw_history/${drawType}/${id}`] = result;
  updates[`finance_audit/draw_schedule_${id}`] = { action: 'draw_result_scheduled', drawType, resultId: id, ticketNumber, publishAt, adminEmail: admin.email, createdAt: now };
  // Explicitly erase all legacy public scheduled copies.
  updates[`lottery_settings/v91_last_results/scheduled/${drawType}`] = null;
  updates[`${PUBLIC_OFFICIAL_RESULTS_PATH}/scheduled/${drawType}`] = null;
  updates[`${PUBLIC_OFFICIAL_RESULTS_PATH}/upcoming/${drawType}`] = null;
  await firebaseDb.ref().update(updates);
  await scheduleNextDrawWakeup();
  return { ok: true, result };
}

async function adminLotteryResultsState() {
  await publishDueDrawResults();
  const [scheduledSnapshot, privateResultsSnapshot, publicSnapshot, settlementQueueSnapshot, publishErrorsSnapshot] = await Promise.all([
    firebaseDb.ref(PRIVATE_DRAW_SCHEDULE_PATH).once('value'),
    firebaseDb.ref(`${PRIVATE_DRAW_RESULTS_PATH}_latest`).once('value'),
    firebaseDb.ref('public_draw_results').once('value'),
    firebaseDb.ref(PRIVATE_DRAW_SETTLEMENT_QUEUE_PATH).once('value'),
    firebaseDb.ref(PRIVATE_DRAW_PUBLISH_ERRORS_PATH).once('value')
  ]);
  return {
    ok: true,
    serverTime: Date.now(),
    scheduled: scheduledSnapshot.val() || {},
    publishedPrivate: privateResultsSnapshot.val() || {},
    published: publicSnapshot.val() || {},
    settlementQueue: settlementQueueSnapshot.val() || {},
    publishErrors: publishErrorsSnapshot.val() || {}
  };
}

async function publicLotteryResults() {
  await publishDueDrawResults();
  const snapshot = await firebaseDb.ref('public_draw_results').once('value');
  return { ok: true, serverTime: Date.now(), results: snapshot.val() || {} };
}

async function publishDueDrawResults() {
  await migrateLegacyScheduledDrawResults();
  const snapshot = await firebaseDb.ref(PRIVATE_DRAW_SCHEDULE_PATH).once('value');
  const scheduled = snapshot.val() || {};
  const now = Date.now();
  for (const [drawType, result] of Object.entries(scheduled)) {
    if (result && String(result.status || '').toLowerCase() === 'scheduled' && normalizePublishAt(result.publishAt, 0) <= now) {
      try {
        await publishLotteryResult(
          { ...result, drawType: normalizeDrawType(result.drawType || drawType) },
          'system_scheduler_v222'
        );
      } catch (error) {
        const errorId = safeText(result.id || `${drawType}_${now}`, 180);
        await firebaseDb.ref(`${PRIVATE_DRAW_PUBLISH_ERRORS_PATH}/${errorId}`).set({
          id: errorId,
          drawType,
          ticketNumber: result.ticketNumber || '',
          errorCode: safeText(error.message || 'DRAW_AUTO_PUBLISH_ERROR', 160),
          createdAt: now,
          updatedAt: Date.now()
        });
        console.error('DRAW_AUTO_PUBLISH_ERROR_V222', drawType, error.message);
      }
    }
  }
  await retryPendingDrawSettlements();
  await scheduleNextDrawWakeup();
}

async function scheduleNextDrawWakeup() {
  if (nextDrawWakeTimer) clearTimeout(nextDrawWakeTimer);
  nextDrawWakeTimer = null;
  const snapshot = await firebaseDb.ref(PRIVATE_DRAW_SCHEDULE_PATH).once('value');
  const times = Object.values(snapshot.val() || {})
    .filter((result) => result && String(result.status || '').toLowerCase() === 'scheduled')
    .map((result) => normalizePublishAt(result.publishAt, 0))
    .filter((timestamp) => timestamp > 0)
    .sort((a, b) => a - b);
  if (!times.length) return;
  const delay = Math.max(0, Math.min(times[0] - Date.now(), 2147480000));
  nextDrawWakeTimer = setTimeout(() => {
    publishDueDrawResults().catch((error) => console.error('DRAW_EXACT_TIMER_ERROR', error.message));
  }, delay + 150);
  if (typeof nextDrawWakeTimer.unref === 'function') nextDrawWakeTimer.unref();
}

function buildAdminWheelSettings(admin, current, inputValue) {
  const input = inputValue && typeof inputValue === 'object' ? inputValue : {};
  const minBet = Math.max(0.01, numberValue(input.minBet ?? current.minBet ?? 1));
  const maxBet = Math.max(minBet, numberValue(input.maxBet ?? current.maxBet ?? 500));
  const segments = normalizeAdminWheelSegments(input.segments, current.segments);
  const luckyBoxCurrent = current.luckyBox && typeof current.luckyBox === 'object' ? current.luckyBox : {};
  const luckyBoxInput = input.luckyBox && typeof input.luckyBox === 'object' ? input.luckyBox : {};
  return {
    ...current,
    enabled: safeBoolean(input.enabled, current.enabled !== false),
    allowBonus: safeBoolean(input.allowBonusForWheel ?? input.allowBonus, current.allowBonusForWheel !== false && current.allowBonus !== false),
    allowBonusForWheel: safeBoolean(input.allowBonusForWheel ?? input.allowBonus, current.allowBonusForWheel !== false),
    minBet,
    maxBet,
    segments,
    luckyBox: {
      ...luckyBoxCurrent,
      ...luckyBoxInput,
      enabled: safeBoolean(luckyBoxInput.enabled, luckyBoxCurrent.enabled !== false),
      chance: Math.max(0, Math.min(100, wheelSegmentNumber(luckyBoxInput.chance, luckyBoxCurrent.chance ?? 35))),
      min: Math.max(0, numberValue(luckyBoxInput.min ?? luckyBoxCurrent.min ?? 0.1)),
      max: Math.max(0, numberValue(luckyBoxInput.max ?? luckyBoxCurrent.max ?? 1)),
      cooldownHours: Math.max(1, Math.min(168, wheelSegmentNumber(luckyBoxInput.cooldownHours, luckyBoxCurrent.cooldownHours ?? 24)))
    },
    controlVersion: 'V220',
    updatedAt: Date.now(),
    updatedBy: admin.email
  };
}

async function adminSaveWheelSettings(admin, body) {
  const currentSnapshot = await firebaseDb.ref('wheel_settings').once('value');
  const current = currentSnapshot.val() || {};
  const settings = buildAdminWheelSettings(admin, current, body.settings || body);
  await firebaseDb.ref('wheel_settings').set(settings);
  invalidateWheelRuntimeCacheV219();
  return { ok: true, settings };
}

async function adminSaveWheelControl(admin, body) {
  const [wheelSnapshot, treasurySnapshot] = await Promise.all([
    firebaseDb.ref('wheel_settings').once('value'),
    firebaseDb.ref('game_treasury/settings').once('value')
  ]);
  const currentWheel = wheelSnapshot.val() || {};
  const currentTreasury = treasurySnapshot.val() || {};
  const settings = buildAdminWheelSettings(admin, currentWheel, body.wheel || body.settings || body);
  const treasuryInput = body.treasury && typeof body.treasury === 'object' ? body.treasury : {};
  const treasurySettings = normalizeGameTreasurySettings({
    ...currentTreasury,
    ...treasuryInput,
    updatedAt: Date.now(),
    updatedBy: admin.email
  });
  const now = Date.now();
  const auditId = `wheel_control_${now}_${crypto.randomBytes(5).toString('hex')}`;
  await firebaseDb.ref().update({
    wheel_settings: settings,
    'game_treasury/settings': treasurySettings,
    [`admin_audit/${auditId}`]: {
      id: auditId,
      action: 'wheel_control_updated',
      adminEmail: admin.email,
      platformCutPercent: treasurySettings.platformCutPercent,
      playerRtpPercent: numberValue(100 - treasurySettings.platformCutPercent),
      requireFullCoverage: treasurySettings.requireFullCoverage,
      enabledMultipliers: settings.segments.filter((segment) => segment.enabled && Number(segment.w || 0) > 0).map((segment) => Number(segment.m || 0)),
      createdAt: now,
      source: 'server_v217'
    }
  });
  invalidateWheelRuntimeCacheV219();
  return { ok: true, settings, treasurySettings, auditId };
}

async function adminPublicSettings() {
  const [siteSnapshot, supportSnapshot, energySnapshot] = await Promise.all([
    firebaseDb.ref('public_site').once('value'),
    firebaseDb.ref('system_settings/public_support').once('value'),
    firebaseDb.ref('system_settings/adn_energy_config').once('value')
  ]);
  const root = siteSnapshot.val() || {};
  const publicSite = { ...root, ...(root.config || {}) };
  delete publicSite.config;
  return { ok: true, publicSite, support: supportSnapshot.val() || {}, energy: normalizeEnergyConfig(energySnapshot.val()) };
}

async function adminSavePublicSettings(admin, body) {
  const now = Date.now();
  const input = body.publicSite || body;
  const data = {
    brandName: safeText(input.brandName || 'ADNOR GLOBAL', 120),
    brandShort: safeText(input.brandShort || 'ADNOR', 40),
    brandTagline: safeText(input.brandTagline || 'GLOBAL DIGITAL PLATFORM', 160),
    platformScopeText: safeText(input.platformScopeText || 'منصة رقمية دولية متاحة عبر الإنترنت.', 700),
    legalAvailabilityText: safeText(input.legalAvailabilityText || 'ADNOR منصة رقمية دولية متاحة عبر الإنترنت. قد تختلف الخدمات المتاحة حسب بلد المستخدم.', 1200),
    referenceTimezone: safeText(input.referenceTimezone || 'UTC', 80),
    availableLanguages: safeText(input.availableLanguages || 'العربية، English، Türkçe', 300),
    supportedCurrencies: safeText(input.supportedCurrencies || 'USD', 300),
    availabilityMode: ['all_except_blocked','allowlist','information_only'].includes(String(input.availabilityMode)) ? String(input.availabilityMode) : 'information_only',
    allowedCountries: safeText(input.allowedCountries || '', 6000),
    blockedCountries: safeText(input.blockedCountries || '', 6000),
    operatorName: safeText(input.operatorName || '', 300),
    operatorRegistration: safeText(input.operatorRegistration || '', 300),
    operatorAddress: safeText(input.operatorAddress || '', 700),
    operatorCountry: safeText(input.operatorCountry || '', 200),
    showOperatorDetails: safeBoolean(input.showOperatorDetails, false),
    announcement: safeText(input.announcement, 500),
    heroTitle: safeText(input.heroTitle, 300),
    heroSubtitle: safeText(input.heroSubtitle, 1000),
    dailyDrawTime: safeText(input.dailyDrawTime || '20:00 UTC', 100),
    dailyNextDraw: safeText(input.dailyNextDraw, 120),
    registrationEnabled: safeBoolean(input.registrationEnabled, true),
    publicGamesEnabled: safeBoolean(input.publicGamesEnabled, true),
    officialResultsAuto: safeBoolean(input.officialResultsAuto, true),
    apkDownloadUrl: safeText(input.apkDownloadUrl, 1000),
    globalIdentityEnabled: true,
    updatedAt: now,
    updatedBy: admin.email
  };
  const updates = {};
  updates['public_site/config'] = data;
  for (const [key, value] of Object.entries(data)) updates[`public_site/${key}`] = value;
  await firebaseDb.ref().update(updates);
  return { ok: true, publicSite: data };
}

async function adminSaveSupportSettings(admin, body) {
  const now = Date.now();
  const data = {
    telegram: safeText(body.telegram, 120).replace(/^@/, ''),
    hours: safeText(body.hours, 300),
    active: safeBoolean(body.active, true),
    updatedAt: now, updatedBy: admin.email
  };
  const updates = {};
  updates['system_settings/public_support'] = data;
  updates['support_contacts/primary'] = { id: 'primary', type: 'telegram', name: 'دعم ADNOR على تيليجرام', value: data.telegram, active: data.active, updatedAt: now, updatedBy: admin.email };
  updates['support_contacts/whatsapp'] = null;
  await firebaseDb.ref().update(updates);
  return { ok: true, support: data };
}
async function adminSaveEnergySettings(admin, body) {
  const current = normalizeEnergyConfig((await firebaseDb.ref('system_settings/adn_energy_config').once('value')).val());
  const input = body.settings || body;
  const requestedMode = safeText(input.mode || current.mode, 30);
  const mode = ADN_ENERGY_ADS_LIVE && requestedMode === 'live' ? 'live' : requestedMode === 'disabled' ? 'disabled' : 'preview';
  const data = normalizeEnergyConfig({ ...current, ...input, mode, updatedAt: Date.now(), updatedBy: admin.email });
  await firebaseDb.ref('system_settings/adn_energy_config').set(data);
  return { ok: true, settings: data, rewardedAds: ADN_ENERGY_ADS_LIVE ? 'awaiting-ssv' : 'not-connected' };
}

async function adminAuditList(limitValue = 300) {
  const limit = Math.max(20, Math.min(1000, Number(limitValue || 300)));
  const [auditSnapshot, notificationsSnapshot] = await Promise.all([
    firebaseDb.ref('finance_audit').limitToLast(limit).once('value'),
    firebaseDb.ref('admin_notifications').limitToLast(limit).once('value')
  ]);
  return { ok: true, audit: objectValues(auditSnapshot.val()).sort((a, b) => timestampOf(b) - timestampOf(a)), notifications: objectValues(notificationsSnapshot.val()).sort((a, b) => timestampOf(b) - timestampOf(a)) };
}


/* ADNOR V204 MASTER ADMIN — migrated controls from the retired embedded admin */
const V204_BACKUP_PATHS = Object.freeze([
  'users','finance','transactions','user_finance','tickets','user_tickets',
  'support_tickets','admin_support_tickets','admin_notifications','user_notifications',
  'lottery_settings','draw_history','payment_methods','system_settings','promo_codes',
  'promo_redemptions','referrals','referral_codes','wheel_logs','wheel_settings',
  'support_contacts','finance_audit','agents','agent_recharges','adn_exchange'
]);

function normalizeVipSettingsV204(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const defaults = [
    { name: 'Bronze', emoji: '🥉', points: 0, perk: 'بداية المسار الملكي' },
    { name: 'Silver', emoji: '🥈', points: 100, perk: 'مزايا للمستخدم النشط' },
    { name: 'Gold', emoji: '🥇', points: 300, perk: 'مستوى ذهبي' },
    { name: 'Diamond', emoji: '💎', points: 800, perk: 'عضوية النخبة' },
    { name: 'Royal Crown', emoji: '👑', points: 1500, perk: 'أعلى مستوى ملكي' }
  ];
  const inputLevels = Array.isArray(value.levels) ? value.levels : objectValues(value.levels);
  const levels = defaults.map((base, index) => {
    const input = inputLevels[index] || {};
    return {
      name: safeText(input.name || base.name, 80), emoji: safeText(input.emoji || base.emoji, 10),
      points: Math.max(0, Math.floor(numberValue(input.points ?? base.points))),
      perk: safeText(input.perk || base.perk, 300)
    };
  }).sort((a, b) => a.points - b.points);
  return {
    enabled: safeBoolean(value.enabled, true),
    taskPoints: Math.max(0, Math.floor(numberValue(value.taskPoints ?? 10))),
    taskBonus: Math.max(0, numberValue(value.taskBonus ?? 0)),
    boxEnabled: safeBoolean(value.boxEnabled, true),
    boxMin: Math.max(0, numberValue(value.boxMin ?? 0)),
    boxMax: Math.max(0, numberValue(value.boxMax ?? 0)),
    boxPointsMin: Math.max(0, Math.floor(numberValue(value.boxPointsMin ?? 5))),
    boxPointsMax: Math.max(0, Math.floor(numberValue(value.boxPointsMax ?? 25))),
    levels,
    tasks: Array.isArray(value.tasks) ? value.tasks.slice(0, 20).map((task, index) => ({
      id: safeText(task.id || `task_${index + 1}`, 80), title: safeText(task.title || 'مهمة VIP', 160),
      desc: safeText(task.desc, 500), active: safeBoolean(task.active, true)
    })) : [],
    updatedAt: Number(value.updatedAt || 0), updatedBy: safeText(value.updatedBy, 220)
  };
}

function normalizeDailyLoginV204(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const inputDays = Array.isArray(value.days) ? value.days : objectValues(value.days);
  const allowedTypes = new Set(['bonus','real','vip','freeSpin','coupon','none']);
  const days = Array.from({ length: 7 }, (_, index) => {
    const input = inputDays[index] || {};
    const type = safeText(input.type || 'bonus', 30);
    return {
      enabled: safeBoolean(input.enabled, true), title: safeText(input.title || `اليوم ${index + 1}`, 120),
      type: allowedTypes.has(type) ? type : 'bonus', value: Math.max(0, numberValue(input.value)),
      coupon: safeText(input.coupon, 80), message: safeText(input.message, 500)
    };
  });
  return {
    enabled: safeBoolean(value.enabled, true), title: safeText(value.title || 'الصندوق الملكي اليومي', 160),
    days, updatedAt: Number(value.updatedAt || 0), updatedBy: safeText(value.updatedBy, 220)
  };
}

async function adminOperationsBundle() {
  const [vip, daily, promos, redemptions, knowledge, unanswered, backups] = await Promise.all([
    firebaseDb.ref('system_settings/vip').once('value'),
    firebaseDb.ref('system_settings/daily_login').once('value'),
    firebaseDb.ref('promo_codes').once('value'),
    firebaseDb.ref('promo_redemptions').once('value'),
    firebaseDb.ref('ai_knowledge').once('value'),
    firebaseDb.ref('ai_unanswered').limitToLast(300).once('value'),
    firebaseDb.ref('admin_backups').limitToLast(100).once('value')
  ]);
  return {
    ok: true,
    vip: normalizeVipSettingsV204(vip.val()),
    dailyLogin: normalizeDailyLoginV204(daily.val()),
    promoCodes: objectValues(promos.val()).sort((a, b) => timestampOf(b) - timestampOf(a)),
    promoRedemptions: redemptions.val() || {},
    aiKnowledge: objectValues(knowledge.val()).sort((a, b) => timestampOf(b) - timestampOf(a)),
    aiUnanswered: objectValues(unanswered.val()).sort((a, b) => timestampOf(b) - timestampOf(a)),
    backups: objectValues(backups.val()).sort((a, b) => timestampOf(b) - timestampOf(a))
  };
}

async function adminSaveVipV204(admin, body) {
  const settings = normalizeVipSettingsV204({ ...(body.settings || body), updatedAt: Date.now(), updatedBy: admin.email });
  if (settings.boxMax < settings.boxMin || settings.boxPointsMax < settings.boxPointsMin) {
    const error = new Error('INVALID_VIP_LIMITS'); error.statusCode = 400; throw error;
  }
  const now = Date.now();
  const updates = {};
  updates['system_settings/vip'] = settings;
  updates[`finance_audit/vip_settings_${now}`] = { action: 'vip_settings_updated', adminUid: admin.uid, adminEmail: admin.email, createdAt: now };
  await firebaseDb.ref().update(updates);
  return { ok: true, settings };
}

async function adminSaveDailyLoginV204(admin, body) {
  const settings = normalizeDailyLoginV204({ ...(body.settings || body), updatedAt: Date.now(), updatedBy: admin.email });
  const now = Date.now();
  const updates = {};
  updates['system_settings/daily_login'] = settings;
  updates[`finance_audit/daily_login_${now}`] = { action: 'daily_login_settings_updated', adminUid: admin.uid, adminEmail: admin.email, createdAt: now };
  await firebaseDb.ref().update(updates);
  return { ok: true, settings };
}

async function adminSavePromoV204(admin, body) {
  const action = safeText(body.action || 'save', 20).toLowerCase();
  const code = safeText(body.code || (body.promo && body.promo.code), 60).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (code.length < 3 || !isValidFirebaseKey(code)) { const error = new Error('INVALID_PROMO_CODE'); error.statusCode = 400; throw error; }
  const now = Date.now();
  if (action === 'delete') {
    await firebaseDb.ref(`promo_codes/${code}`).remove();
    await firebaseDb.ref(`finance_audit/promo_delete_${code}_${now}`).set({ action: 'promo_code_deleted', code, adminEmail: admin.email, createdAt: now });
    return { ok: true, deleted: true };
  }
  const input = body.promo && typeof body.promo === 'object' ? body.promo : body;
  const existing = (await firebaseDb.ref(`promo_codes/${code}`).once('value')).val() || {};
  const promo = {
    ...existing, code, active: safeBoolean(input.active, existing.active !== false),
    bonus: Math.max(0, numberValue(input.bonus)), freeSpins: Math.max(0, Math.floor(numberValue(input.freeSpins))),
    freeTicket: safeBoolean(input.freeTicket, false), maxUses: Math.max(0, Math.floor(numberValue(input.maxUses))),
    usedCount: Math.max(0, Math.floor(numberValue(existing.usedCount))), note: safeText(input.note, 500),
    createdAt: Number(existing.createdAt || now), updatedAt: now, updatedBy: admin.email
  };
  const updates = {};
  updates[`promo_codes/${code}`] = promo;
  updates[`finance_audit/promo_${code}_${now}`] = { action: 'promo_code_saved', code, adminEmail: admin.email, createdAt: now };
  await firebaseDb.ref().update(updates);
  return { ok: true, promo };
}

async function adminSaveAiKnowledgeV204(admin, body) {
  const action = safeText(body.action || 'save', 20).toLowerCase();
  const rawId = safeText(body.id, 100);
  if (action === 'delete') {
    if (!isValidFirebaseKey(rawId)) { const error = new Error('INVALID_AI_KNOWLEDGE_ID'); error.statusCode = 400; throw error; }
    await firebaseDb.ref(`ai_knowledge/${rawId}`).remove();
    return { ok: true, deleted: true };
  }
  const question = safeText(body.question, 500), answer = safeText(body.answer, 5000);
  if (question.length < 3 || answer.length < 3) { const error = new Error('INVALID_AI_KNOWLEDGE'); error.statusCode = 400; throw error; }
  const id = isValidFirebaseKey(rawId) ? rawId : `k_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const now = Date.now();
  const keys = Array.isArray(body.keys) ? body.keys.slice(0, 30).map(x => safeText(x, 80)).filter(Boolean) : safeText(body.keys, 1000).split(',').map(x => safeText(x.trim(), 80)).filter(Boolean);
  const entry = { id, question, answer, keys, active: safeBoolean(body.active, true), createdAt: Number(body.createdAt || now), updatedAt: now, adminEmail: admin.email };
  const updates = {};
  updates[`ai_knowledge/${id}`] = entry;
  if (body.fromUnanswered && isValidFirebaseKey(body.fromUnanswered)) updates[`ai_unanswered/${body.fromUnanswered}/status`] = 'answered';
  updates[`finance_audit/ai_${id}_${now}`] = { action: 'ai_answer_saved', question, adminEmail: admin.email, createdAt: now };
  await firebaseDb.ref().update(updates);
  return { ok: true, entry };
}

async function adminCreateBackupV204(admin) {
  const createdAt = Date.now();
  const id = `BKP-${createdAt}`;
  const snapshots = await Promise.all(V204_BACKUP_PATHS.map(path => firebaseDb.ref(path).once('value')));
  const data = {};
  V204_BACKUP_PATHS.forEach((path, index) => { data[path] = snapshots[index].val() ?? null; });
  const payload = { version: 'ADNOR_V204_BACKUP', project: 'adhamnnn-8a4d2', id, createdAt, createdBy: admin.email, paths: [...V204_BACKUP_PATHS], data };
  const json = JSON.stringify(payload);
  const sizeKB = Math.ceil(Buffer.byteLength(json, 'utf8') / 1024);
  if (sizeKB > 12000) { const error = new Error('BACKUP_TOO_LARGE'); error.statusCode = 413; throw error; }
  const metadata = { id, createdAt, createdBy: admin.email, sizeKB, paths: V204_BACKUP_PATHS.length, source: 'server_v204' };
  const updates = {};
  updates[`admin_backups/${id}`] = metadata;
  updates[`admin_backup_payloads/${id}`] = payload;
  updates[`finance_audit/backup_${id}`] = { action: 'backup_created', id, sizeKB, adminEmail: admin.email, createdAt };
  await firebaseDb.ref().update(updates);
  return { ok: true, backup: metadata };
}


/* ADNOR V198 — ADN EXCHANGE REAL-BALANCE MATCHING ENGINE */
const EXCHANGE_NODE = 'adn_exchange';
const EXCHANGE_TREASURY_UID = '__ADNOR_TREASURY__';
const EXCHANGE_INTERVALS = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000
};
const EXCHANGE_DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  buyEnabled: true,
  sellEnabled: true,
  symbol: 'ADN/USD',
  baseAsset: 'ADN',
  quoteAsset: 'USD',
  openingPrice: 0.1,
  totalSupply: 5000000,
  makerFeeBps: 50,
  takerFeeBps: 100,
  minOrderUsd: 5,
  maxOrderUsd: 5000,
  dailyVolumeLimitUsd: 10000,
  maxOpenOrdersPerUser: 20,
  maxLimitPriceDeviationPct: 25,
  maxMarketSlippagePct: 10,
  autoTreasuryLiquidityEnabled: true,
  autoTreasuryRepriceEnabled: true,
  treasuryAutoSellSpreadBps: 10,
  treasuryAutoBuySpreadBps: 10,
  requireTerms: true,
  termsVersion: 'ADN-EXCHANGE-2026-07',
  priceDecimals: 6,
  quantityDecimals: 4,
  circuitBreakerEnabled: true,
  circuitBreakerMovePct: 15,
  circuitBreakerWindowMs: 60 * 1000,
  haltedUntil: 0,
  riskNotice: 'سعر ADN قد يرتفع أو ينخفض. لا يوجد ربح مضمون، وقد تخسر جزءًا من قيمة الشراء أو كاملها.'
});

function exchangeError(code, statusCode = 409) {
  const error = new Error(code);
  error.statusCode = statusCode;
  return error;
}

function roundUsd(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round((numeric + Number.EPSILON) * 100) / 100 : 0;
}

function ceilUsd(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.ceil((numeric - Number.EPSILON) * 100) / 100 : 0;
}

function roundPrice(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 1000000) / 1000000 : 0;
}

function roundQty(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor((numeric + Number.EPSILON) * 10000) / 10000 : 0;
}

function exchangeFee(gross, bps) {
  return ceilUsd(roundUsd(gross) * Math.max(0, Number(bps || 0)) / 10000);
}

function exchangeBoolean(value, fallback = false) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function exchangePublicSettings(settings) {
  const value = { ...EXCHANGE_DEFAULT_SETTINGS, ...(settings || {}) };
  return {
    enabled: exchangeBoolean(value.enabled, false),
    buyEnabled: exchangeBoolean(value.buyEnabled, true),
    sellEnabled: exchangeBoolean(value.sellEnabled, true),
    symbol: String(value.symbol || 'ADN/USD'),
    baseAsset: 'ADN',
    quoteAsset: 'USD',
    openingPrice: roundPrice(value.openingPrice || 0.1),
    totalSupply: roundQty(value.totalSupply || 5000000),
    makerFeeBps: Math.max(0, Number(value.makerFeeBps || 0)),
    takerFeeBps: Math.max(0, Number(value.takerFeeBps || 0)),
    minOrderUsd: roundUsd(value.minOrderUsd || 5),
    maxOrderUsd: roundUsd(value.maxOrderUsd || 5000),
    dailyVolumeLimitUsd: roundUsd(value.dailyVolumeLimitUsd || 10000),
    maxOpenOrdersPerUser: Math.max(1, Number(value.maxOpenOrdersPerUser || 20)),
    maxLimitPriceDeviationPct: Math.max(1, Number(value.maxLimitPriceDeviationPct || 25)),
    maxMarketSlippagePct: Math.max(1, Number(value.maxMarketSlippagePct || 10)),
    autoTreasuryLiquidityEnabled: exchangeBoolean(value.autoTreasuryLiquidityEnabled, true),
    autoTreasuryRepriceEnabled: exchangeBoolean(value.autoTreasuryRepriceEnabled, true),
    treasuryAutoSellSpreadBps: Math.max(0, Math.min(500, Number(value.treasuryAutoSellSpreadBps || 10))),
    treasuryAutoBuySpreadBps: Math.max(0, Math.min(500, Number(value.treasuryAutoBuySpreadBps || 10))),
    requireTerms: value.requireTerms !== false,
    termsVersion: String(value.termsVersion || 'ADN-EXCHANGE-2026-07'),
    circuitBreakerEnabled: exchangeBoolean(value.circuitBreakerEnabled, true),
    circuitBreakerMovePct: Math.max(1, Number(value.circuitBreakerMovePct || 15)),
    circuitBreakerWindowMs: Math.max(10000, Number(value.circuitBreakerWindowMs || 60000)),
    haltedUntil: Number(value.haltedUntil || 0),
    riskNotice: String(value.riskNotice || EXCHANGE_DEFAULT_SETTINGS.riskNotice)
  };
}

function ensureExchangeState(root) {
  if (!root[EXCHANGE_NODE] || typeof root[EXCHANGE_NODE] !== 'object') root[EXCHANGE_NODE] = {};
  const exchange = root[EXCHANGE_NODE];
  exchange.settings = { ...EXCHANGE_DEFAULT_SETTINGS, ...(exchange.settings || {}) };
  if (!exchange.market || typeof exchange.market !== 'object') exchange.market = {};
  exchange.market.lastPrice = roundPrice(exchange.market.lastPrice || exchange.settings.openingPrice || 0.1);
  exchange.market.lastTradeAt = Number(exchange.market.lastTradeAt || 0);
  exchange.market.tradeCount = Number(exchange.market.tradeCount || 0);
  exchange.market.volumeTotalAdn = roundQty(exchange.market.volumeTotalAdn || 0);
  exchange.market.quoteVolumeTotalUsd = roundUsd(exchange.market.quoteVolumeTotalUsd || 0);
  exchange.market.issuedAdn = roundQty(exchange.market.issuedAdn || 0);
  if (!exchange.orders || typeof exchange.orders !== 'object') exchange.orders = {};
  if (!exchange.trades || typeof exchange.trades !== 'object') exchange.trades = {};
  if (!exchange.candles || typeof exchange.candles !== 'object') exchange.candles = {};
  if (!exchange.audit || typeof exchange.audit !== 'object') exchange.audit = {};
  if (!exchange.adminRequests || typeof exchange.adminRequests !== 'object') exchange.adminRequests = {};
  if (!exchange.treasury || typeof exchange.treasury !== 'object') exchange.treasury = {};
  exchange.treasury.adnAvailable = roundQty(exchange.treasury.adnAvailable || 0);
  exchange.treasury.adnReserved = roundQty(exchange.treasury.adnReserved || 0);
  exchange.treasury.usdAvailable = roundUsd(exchange.treasury.usdAvailable || 0);
  exchange.treasury.usdReserved = roundUsd(exchange.treasury.usdReserved || 0);
  exchange.treasury.feesUsd = roundUsd(exchange.treasury.feesUsd || 0);
  return exchange;
}

function exchangeUserProfile(root, uid) {
  if (!root.users || !root.users[uid] || typeof root.users[uid] !== 'object') {
    throw exchangeError('USER_ACCOUNT_NOT_FOUND', 404);
  }
  const profile = root.users[uid];
  if (userFrozen(profile)) throw exchangeError('USER_ACCOUNT_FROZEN', 403);
  profile.realBalance = roundUsd(profile.realBalance || 0);
  profile.bonusBalance = roundUsd(profile.bonusBalance || 0);
  profile.exchangeReservedUsd = roundUsd(profile.exchangeReservedUsd || 0);
  profile.adnBalance = roundQty(profile.adnBalance || 0);
  profile.adnReserved = roundQty(profile.adnReserved || 0);
  profile.adnCostBasisUsd = roundUsd(profile.adnCostBasisUsd || 0);
  profile.adnRealizedPnlUsd = roundUsd(profile.adnRealizedPnlUsd || 0);
  if (!profile.exchangeRequests || typeof profile.exchangeRequests !== 'object') profile.exchangeRequests = {};
  return profile;
}

function exchangeOwnerAccount(root, exchange, order) {
  if (order.ownerType === 'treasury' || order.uid === EXCHANGE_TREASURY_UID) {
    return { type: 'treasury', data: exchange.treasury, uid: EXCHANGE_TREASURY_UID };
  }
  return { type: 'user', data: exchangeUserProfile(root, order.uid), uid: order.uid };
}

function exchangeOpenOrderCount(exchange, uid, ownerType) {
  return Object.values(exchange.orders || {}).filter((order) =>
    order && order.uid === uid && order.ownerType === ownerType &&
    (order.status === 'open' || order.status === 'partial') && roundQty(order.remaining) > 0
  ).length;
}

function exchangeOrderNotional(quantity, price) {
  return roundUsd(roundQty(quantity) * roundPrice(price));
}

function exchangeValidatePrice(settings, price, lastPrice) {
  const normalized = roundPrice(price);
  if (normalized <= 0) throw exchangeError('EXCHANGE_INVALID_PRICE', 400);
  const reference = roundPrice(lastPrice || settings.openingPrice || 0.1);
  if (reference > 0) {
    const deviation = Math.abs((normalized - reference) / reference) * 100;
    if (deviation > Number(settings.maxLimitPriceDeviationPct || 25)) {
      throw exchangeError('EXCHANGE_PRICE_OUT_OF_RANGE', 409);
    }
  }
  return normalized;
}

function exchangeCheckTradingState(settings, side, isTreasury = false) {
  const now = Date.now();
  if (!isTreasury && settings.enabled === false) throw exchangeError('EXCHANGE_DISABLED', 403);
  if (!isTreasury && Number(settings.haltedUntil || 0) > now) throw exchangeError('EXCHANGE_MARKET_HALTED', 423);
  if (side === 'buy' && settings.buyEnabled === false) throw exchangeError('EXCHANGE_BUY_DISABLED', 403);
  if (side === 'sell' && settings.sellEnabled === false) throw exchangeError('EXCHANGE_SELL_DISABLED', 403);
}

function exchangeCurrentDailyVolume(profile, now) {
  const key = dayKey(now);
  return profile.exchangeDailyKey === key ? roundUsd(profile.exchangeDailyVolumeUsd || 0) : 0;
}

function exchangeAddDailyVolume(profile, gross, now) {
  const key = dayKey(now);
  const before = profile.exchangeDailyKey === key ? roundUsd(profile.exchangeDailyVolumeUsd || 0) : 0;
  profile.exchangeDailyKey = key;
  profile.exchangeDailyVolumeUsd = roundUsd(before + gross);
}

function exchangeUpdateCandle(exchange, interval, trade) {
  const ms = EXCHANGE_INTERVALS[interval];
  if (!ms) return;
  if (!exchange.candles[interval] || typeof exchange.candles[interval] !== 'object') exchange.candles[interval] = {};
  const bucket = Math.floor(Number(trade.createdAt) / ms) * ms;
  const key = String(bucket);
  const existing = exchange.candles[interval][key];
  if (!existing) {
    exchange.candles[interval][key] = {
      time: bucket,
      open: trade.price,
      high: trade.price,
      low: trade.price,
      close: trade.price,
      volume: trade.quantity,
      quoteVolume: trade.grossUsd,
      trades: 1
    };
  } else {
    existing.high = roundPrice(Math.max(Number(existing.high || trade.price), trade.price));
    existing.low = roundPrice(Math.min(Number(existing.low || trade.price), trade.price));
    existing.close = trade.price;
    existing.volume = roundQty(Number(existing.volume || 0) + trade.quantity);
    existing.quoteVolume = roundUsd(Number(existing.quoteVolume || 0) + trade.grossUsd);
    existing.trades = Number(existing.trades || 0) + 1;
  }
  const keys = Object.keys(exchange.candles[interval]);
  const max = interval === '1m' ? 1600 : interval === '5m' ? 1400 : 1000;
  if (keys.length > max) {
    keys.sort((a, b) => Number(a) - Number(b)).slice(0, keys.length - max).forEach((oldKey) => delete exchange.candles[interval][oldKey]);
  }
}

function exchangeUpdateMarket(exchange, trade) {
  const previousPrice = roundPrice(exchange.market.lastPrice || exchange.settings.openingPrice || trade.price);
  const previousAt = Number(exchange.market.lastTradeAt || 0);
  exchange.market.lastPrice = trade.price;
  exchange.market.lastTradeAt = trade.createdAt;
  exchange.market.tradeCount = Number(exchange.market.tradeCount || 0) + 1;
  exchange.market.volumeTotalAdn = roundQty(Number(exchange.market.volumeTotalAdn || 0) + trade.quantity);
  exchange.market.quoteVolumeTotalUsd = roundUsd(Number(exchange.market.quoteVolumeTotalUsd || 0) + trade.grossUsd);
  exchange.market.highAll = roundPrice(Math.max(Number(exchange.market.highAll || trade.price), trade.price));
  exchange.market.lowAll = roundPrice(exchange.market.lowAll ? Math.min(Number(exchange.market.lowAll), trade.price) : trade.price);
  if (exchange.settings.circuitBreakerEnabled !== false && previousPrice > 0 && previousAt > 0 && trade.createdAt - previousAt <= Number(exchange.settings.circuitBreakerWindowMs || 60000)) {
    const move = Math.abs((trade.price - previousPrice) / previousPrice) * 100;
    if (move >= Number(exchange.settings.circuitBreakerMovePct || 15)) {
      exchange.settings.haltedUntil = trade.createdAt + 5 * 60 * 1000;
      exchange.market.lastHaltReason = `تحرك السعر ${move.toFixed(2)}% خلال فترة قصيرة`;
      exchange.market.lastHaltAt = trade.createdAt;
    }
  }
  Object.keys(EXCHANGE_INTERVALS).forEach((interval) => exchangeUpdateCandle(exchange, interval, trade));
}

function exchangeLogUserTrade(root, uid, trade, role, feeUsd, netUsd) {
  if (uid === EXCHANGE_TREASURY_UID) return;
  if (!root.exchange_user_trades || typeof root.exchange_user_trades !== 'object') root.exchange_user_trades = {};
  if (!root.exchange_user_trades[uid] || typeof root.exchange_user_trades[uid] !== 'object') root.exchange_user_trades[uid] = {};
  root.exchange_user_trades[uid][trade.id] = {
    id: trade.id,
    role,
    side: role === 'buyer' ? 'buy' : 'sell',
    symbol: 'ADN/USD',
    price: trade.price,
    quantity: trade.quantity,
    grossUsd: trade.grossUsd,
    feeUsd,
    netUsd,
    createdAt: trade.createdAt
  };
  if (!root.transactions || typeof root.transactions !== 'object') root.transactions = {};
  if (!root.transactions[uid] || typeof root.transactions[uid] !== 'object') root.transactions[uid] = {};
  root.transactions[uid][`${trade.id}_${role}`] = {
    id: `${trade.id}_${role}`,
    type: role === 'buyer' ? 'adn_buy_fill' : 'adn_sell',
    amount: role === 'seller' ? netUsd : 0,
    quoteAmount: role === 'buyer' ? roundUsd(trade.grossUsd + feeUsd) : netUsd,
    adnQuantity: trade.quantity,
    price: trade.price,
    feeUsd,
    status: 'completed',
    note: role === 'buyer' ? `شراء ${trade.quantity} ADN بسعر ${trade.price}` : `بيع ${trade.quantity} ADN بسعر ${trade.price}`,
    source: 'adn_exchange_v198',
    createdAt: trade.createdAt
  };
}

function exchangeReleaseOrderReserve(root, exchange, order, now, reason) {
  const owner = exchangeOwnerAccount(root, exchange, order);
  if (order.side === 'buy') {
    const release = roundUsd(order.reservedUsd || 0);
    if (release > 0) {
      if (owner.type === 'user') {
        owner.data.exchangeReservedUsd = roundUsd(Math.max(0, owner.data.exchangeReservedUsd - release));
        owner.data.realBalance = roundUsd(owner.data.realBalance + release);
        if (!root.transactions || typeof root.transactions !== 'object') root.transactions = {};
        if (!root.transactions[owner.uid]) root.transactions[owner.uid] = {};
        root.transactions[owner.uid][`${order.id}_release_${now}`] = {
          id: `${order.id}_release_${now}`,
          type: 'adn_order_release',
          amount: release,
          status: 'completed',
          note: `إرجاع مبلغ محجوز من أمر ADN — ${reason}`,
          source: 'adn_exchange_v198',
          createdAt: now
        };
      } else {
        owner.data.usdReserved = roundUsd(Math.max(0, owner.data.usdReserved - release));
        owner.data.usdAvailable = roundUsd(owner.data.usdAvailable + release);
      }
      order.reservedUsd = 0;
    }
  } else {
    const release = roundQty(order.reservedAdn || 0);
    if (release > 0) {
      if (owner.type === 'user') {
        owner.data.adnReserved = roundQty(Math.max(0, owner.data.adnReserved - release));
        owner.data.adnBalance = roundQty(owner.data.adnBalance + release);
      } else {
        owner.data.adnReserved = roundQty(Math.max(0, owner.data.adnReserved - release));
        owner.data.adnAvailable = roundQty(owner.data.adnAvailable + release);
      }
      order.reservedAdn = 0;
    }
  }
}

function exchangeFinalizeOrder(root, exchange, order, now) {
  order.remaining = roundQty(order.remaining);
  if (order.remaining <= 0.00009) {
    order.remaining = 0;
    order.status = 'filled';
    order.filledAt = now;
    exchangeReleaseOrderReserve(root, exchange, order, now, 'اكتمال الأمر');
  } else if (roundQty(order.filledQuantity || 0) > 0) {
    order.status = 'partial';
  } else {
    order.status = 'open';
  }
  order.updatedAt = now;
}


function exchangeCancelTreasuryOrderForReprice(root, exchange, order, now) {
  if (!order || order.ownerType !== 'treasury' || !['open', 'partial'].includes(order.status)) return;
  exchangeReleaseOrderReserve(root, exchange, order, now, 'إعادة تسعير سيولة الخزينة تلقائيًا');
  order.status = 'cancelled';
  order.cancelledAt = now;
  order.cancelReason = 'auto_treasury_liquidity_reprice';
  order.updatedAt = now;
}

function exchangeReclaimOutOfRangeTreasuryLiquidity(root, exchange, incoming, eligibleOrderIds, settings, now) {
  if (settings.autoTreasuryRepriceEnabled !== true || incoming.ownerType === 'treasury') return;
  const opposite = incoming.side === 'buy' ? 'sell' : 'buy';
  Object.values(exchange.orders || {}).forEach((order) => {
    if (!order || order.ownerType !== 'treasury' || order.side !== opposite) return;
    if (!['open', 'partial'].includes(order.status) || roundQty(order.remaining) <= 0) return;
    if (eligibleOrderIds.has(order.id)) return;
    exchangeCancelTreasuryOrderForReprice(root, exchange, order, now);
  });
}

function exchangeCreateAutomaticTreasuryOrder(exchange, incoming, settings, now, requestedQuantity) {
  if (settings.autoTreasuryLiquidityEnabled !== true || incoming.ownerType === 'treasury') return null;
  const requested = roundQty(requestedQuantity);
  if (requested <= 0) return null;
  const last = roundPrice(exchange.market.lastPrice || settings.openingPrice || 0.1);
  if (last <= 0) return null;

  if (incoming.side === 'buy') {
    const price = roundPrice(last * (1 + Number(settings.treasuryAutoSellSpreadBps || 0) / 10000));
    const available = roundQty(exchange.treasury.adnAvailable || 0);
    const quantity = roundQty(Math.min(requested, available));
    if (quantity <= 0) return null;
    exchange.treasury.adnAvailable = roundQty(available - quantity);
    exchange.treasury.adnReserved = roundQty(Number(exchange.treasury.adnReserved || 0) + quantity);
    const id = `adn_auto_treasury_sell_${now}_${crypto.randomBytes(6).toString('hex')}`;
    const order = {
      id,
      uid: EXCHANGE_TREASURY_UID,
      ownerType: 'treasury',
      side: 'sell',
      type: 'limit',
      symbol: 'ADN/USD',
      price,
      quantity,
      remaining: quantity,
      filledQuantity: 0,
      filledQuoteUsd: 0,
      feesUsd: 0,
      reservedUsd: 0,
      reservedAdn: quantity,
      status: 'open',
      requestId: `auto_sell_${now}`,
      autoLiquidity: true,
      createdAt: now,
      updatedAt: now
    };
    exchange.orders[id] = order;
    return order;
  }

  const price = roundPrice(last * (1 - Number(settings.treasuryAutoBuySpreadBps || 0) / 10000));
  if (price <= 0) return null;
  const usdAvailable = roundUsd(exchange.treasury.usdAvailable || 0);
  let quantity = roundQty(Math.min(requested, usdAvailable / price));
  let reserve = ceilUsd(quantity * price);
  while (quantity > 0 && reserve > usdAvailable + 0.001) {
    quantity = roundQty(quantity - 0.0001);
    reserve = ceilUsd(quantity * price);
  }
  if (quantity <= 0 || reserve <= 0) return null;
  exchange.treasury.usdAvailable = roundUsd(usdAvailable - reserve);
  exchange.treasury.usdReserved = roundUsd(Number(exchange.treasury.usdReserved || 0) + reserve);
  const id = `adn_auto_treasury_buy_${now}_${crypto.randomBytes(6).toString('hex')}`;
  const order = {
    id,
    uid: EXCHANGE_TREASURY_UID,
    ownerType: 'treasury',
    side: 'buy',
    type: 'limit',
    symbol: 'ADN/USD',
    price,
    quantity,
    remaining: quantity,
    filledQuantity: 0,
    filledQuoteUsd: 0,
    feesUsd: 0,
    reservedUsd: reserve,
    reservedAdn: 0,
    status: 'open',
    requestId: `auto_buy_${now}`,
    autoLiquidity: true,
    createdAt: now,
    updatedAt: now
  };
  exchange.orders[id] = order;
  return order;
}

function exchangeMatchIncoming(root, exchange, incoming, now) {
  const settings = exchangePublicSettings(exchange.settings);
  const opposite = incoming.side === 'buy' ? 'sell' : 'buy';
  const last = roundPrice(exchange.market.lastPrice || settings.openingPrice);
  const marketCap = incoming.side === 'buy'
    ? roundPrice(last * (1 + settings.maxMarketSlippagePct / 100))
    : roundPrice(last * (1 - settings.maxMarketSlippagePct / 100));
  const candidates = Object.values(exchange.orders || {}).filter((order) => {
    if (!order || order.id === incoming.id || order.side !== opposite) return false;
    if (!['open', 'partial'].includes(order.status) || roundQty(order.remaining) <= 0) return false;
    if (order.uid === incoming.uid && order.ownerType === incoming.ownerType) return false;
    const makerPrice = roundPrice(order.price);
    if (incoming.type === 'market') return incoming.side === 'buy' ? makerPrice <= marketCap : makerPrice >= marketCap;
    return incoming.side === 'buy' ? makerPrice <= incoming.price : makerPrice >= incoming.price;
  });
  candidates.sort((a, b) => {
    const pa = Number(a.price || 0), pb = Number(b.price || 0);
    if (pa !== pb) return incoming.side === 'buy' ? pa - pb : pb - pa;
    return Number(a.createdAt || 0) - Number(b.createdAt || 0);
  });

  if (incoming.type === 'market' && incoming.ownerType !== 'treasury' && settings.autoTreasuryLiquidityEnabled === true) {
    const eligibleIds = new Set(candidates.map((order) => order.id));
    const visibleQuantity = roundQty(candidates.reduce((sum, order) => sum + Number(order.remaining || 0), 0));
    let shortfall = roundQty(Math.max(0, Number(incoming.remaining || 0) - visibleQuantity));
    if (shortfall > 0) {
      exchangeReclaimOutOfRangeTreasuryLiquidity(root, exchange, incoming, eligibleIds, settings, now);
      const automaticOrder = exchangeCreateAutomaticTreasuryOrder(exchange, incoming, settings, now, shortfall);
      if (automaticOrder) candidates.push(automaticOrder);
    }
  }

  const fills = [];
  for (const maker of candidates) {
    if (roundQty(incoming.remaining) <= 0) break;
    const quantity = roundQty(Math.min(Number(incoming.remaining || 0), Number(maker.remaining || 0)));
    if (quantity <= 0) continue;
    const price = roundPrice(maker.price);
    const grossUsd = roundUsd(quantity * price);
    if (grossUsd <= 0) continue;

    const buyerOrder = incoming.side === 'buy' ? incoming : maker;
    const sellerOrder = incoming.side === 'sell' ? incoming : maker;
    const buyer = exchangeOwnerAccount(root, exchange, buyerOrder);
    const seller = exchangeOwnerAccount(root, exchange, sellerOrder);
    const buyerIsTaker = buyerOrder.id === incoming.id;
    const sellerIsTaker = sellerOrder.id === incoming.id;
    const buyerFeeBps = buyer.type === 'treasury' ? 0 : (buyerIsTaker ? settings.takerFeeBps : settings.makerFeeBps);
    const sellerFeeBps = seller.type === 'treasury' ? 0 : (sellerIsTaker ? settings.takerFeeBps : settings.makerFeeBps);
    const buyerFee = exchangeFee(grossUsd, buyerFeeBps);
    const sellerFee = exchangeFee(grossUsd, sellerFeeBps);
    const buyerDebit = roundUsd(grossUsd + buyerFee);
    const sellerNet = roundUsd(grossUsd - sellerFee);

    if (roundUsd(buyerOrder.reservedUsd || 0) + 0.001 < buyerDebit) throw exchangeError('EXCHANGE_RESERVED_FUNDS_INVALID', 500);
    if (roundQty(sellerOrder.reservedAdn || 0) + 0.00001 < quantity) throw exchangeError('EXCHANGE_RESERVED_ASSET_INVALID', 500);

    const sellerTotalBefore = seller.type === 'user'
      ? roundQty(Number(seller.data.adnBalance || 0) + Number(seller.data.adnReserved || 0))
      : 0;
    const sellerCostBefore = seller.type === 'user' ? roundUsd(seller.data.adnCostBasisUsd || 0) : 0;
    const sellerAverageCost = sellerTotalBefore > 0 ? sellerCostBefore / sellerTotalBefore : 0;
    const costRemoved = seller.type === 'user' ? roundUsd(Math.min(sellerCostBefore, sellerAverageCost * quantity)) : 0;

    buyerOrder.reservedUsd = roundUsd(Math.max(0, Number(buyerOrder.reservedUsd || 0) - buyerDebit));
    if (buyer.type === 'user') {
      buyer.data.exchangeReservedUsd = roundUsd(Math.max(0, buyer.data.exchangeReservedUsd - buyerDebit));
      buyer.data.adnBalance = roundQty(buyer.data.adnBalance + quantity);
      buyer.data.adnCostBasisUsd = roundUsd(buyer.data.adnCostBasisUsd + buyerDebit);
      exchangeAddDailyVolume(buyer.data, grossUsd, now);
      buyer.data.updatedAt = now;
    } else {
      buyer.data.usdReserved = roundUsd(Math.max(0, buyer.data.usdReserved - buyerDebit));
      buyer.data.adnAvailable = roundQty(buyer.data.adnAvailable + quantity);
    }

    sellerOrder.reservedAdn = roundQty(Math.max(0, Number(sellerOrder.reservedAdn || 0) - quantity));
    if (seller.type === 'user') {
      seller.data.adnReserved = roundQty(Math.max(0, seller.data.adnReserved - quantity));
      seller.data.realBalance = roundUsd(seller.data.realBalance + sellerNet);
      seller.data.adnCostBasisUsd = roundUsd(Math.max(0, seller.data.adnCostBasisUsd - costRemoved));
      seller.data.adnRealizedPnlUsd = roundUsd(seller.data.adnRealizedPnlUsd + sellerNet - costRemoved);
      exchangeAddDailyVolume(seller.data, grossUsd, now);
      seller.data.updatedAt = now;
    } else {
      seller.data.adnReserved = roundQty(Math.max(0, seller.data.adnReserved - quantity));
      seller.data.usdAvailable = roundUsd(seller.data.usdAvailable + sellerNet);
    }

    exchange.treasury.feesUsd = roundUsd(exchange.treasury.feesUsd + buyerFee + sellerFee);
    incoming.remaining = roundQty(incoming.remaining - quantity);
    incoming.filledQuantity = roundQty(Number(incoming.filledQuantity || 0) + quantity);
    incoming.filledQuoteUsd = roundUsd(Number(incoming.filledQuoteUsd || 0) + grossUsd);
    incoming.feesUsd = roundUsd(Number(incoming.feesUsd || 0) + (incoming.side === 'buy' ? buyerFee : sellerFee));
    maker.remaining = roundQty(maker.remaining - quantity);
    maker.filledQuantity = roundQty(Number(maker.filledQuantity || 0) + quantity);
    maker.filledQuoteUsd = roundUsd(Number(maker.filledQuoteUsd || 0) + grossUsd);
    maker.feesUsd = roundUsd(Number(maker.feesUsd || 0) + (maker.side === 'buy' ? buyerFee : sellerFee));

    const tradeId = `adn_trade_${crypto.randomBytes(8).toString('hex')}_${now}_${fills.length}`;
    const trade = {
      id: tradeId,
      symbol: 'ADN/USD',
      price,
      quantity,
      grossUsd,
      buyerFeeUsd: buyerFee,
      sellerFeeUsd: sellerFee,
      buyerUid: buyer.uid,
      sellerUid: seller.uid,
      buyOrderId: buyerOrder.id,
      sellOrderId: sellerOrder.id,
      makerOrderId: maker.id,
      takerOrderId: incoming.id,
      createdAt: now
    };
    exchange.trades[tradeId] = trade;
    exchangeUpdateMarket(exchange, trade);
    exchangeLogUserTrade(root, buyer.uid, trade, 'buyer', buyerFee, -buyerDebit);
    exchangeLogUserTrade(root, seller.uid, trade, 'seller', sellerFee, sellerNet);
    exchangeFinalizeOrder(root, exchange, maker, now);
    fills.push({ id: tradeId, price, quantity, grossUsd, feeUsd: incoming.side === 'buy' ? buyerFee : sellerFee });
  }
  exchangeFinalizeOrder(root, exchange, incoming, now);
  return fills;
}

function exchangeNormalizeOrderInput(body) {
  const side = String(body.side || '').toLowerCase();
  const type = String(body.type || 'limit').toLowerCase();
  if (!['buy', 'sell'].includes(side)) throw exchangeError('EXCHANGE_INVALID_SIDE', 400);
  if (!['market', 'limit'].includes(type)) throw exchangeError('EXCHANGE_INVALID_ORDER_TYPE', 400);
  const quantity = roundQty(body.quantity);
  if (quantity <= 0) throw exchangeError('EXCHANGE_INVALID_QUANTITY', 400);
  return { side, type, quantity, price: type === 'limit' ? roundPrice(body.price) : 0 };
}

async function getExchangeWarmRootV219(force = false) {
  const now = Date.now();
  if (!force && exchangeRootWarmCacheV219.value && now - exchangeRootWarmCacheV219.updatedAt < 12000) {
    return exchangeRootWarmCacheV219.value;
  }
  if (!force && exchangeRootWarmCacheV219.promise) return exchangeRootWarmCacheV219.promise;
  exchangeRootWarmCacheV219.promise = firebaseDb.ref().once('value').then((snapshot) => {
    const value = snapshot.val();
    if (value && typeof value === 'object') {
      exchangeRootWarmCacheV219.value = value;
      exchangeRootWarmCacheV219.updatedAt = Date.now();
    }
    return value;
  }).finally(() => { exchangeRootWarmCacheV219.promise = null; });
  return exchangeRootWarmCacheV219.promise;
}

async function exchangeRootMutation(mutator) {
  const rootRef = firebaseDb.ref();
  const preflightRoot = await getExchangeWarmRootV219(false);
  if (!preflightRoot || typeof preflightRoot !== 'object' || !preflightRoot.users || typeof preflightRoot.users !== 'object') {
    throw exchangeError('EXCHANGE_DATABASE_NOT_READY', 503);
  }

  let abortCode = '';
  let abortStatus = 409;
  let response = null;
  const probeId = crypto.randomUUID();
  const result = await rootRef.transaction((root) => {
    abortCode = '';
    abortStatus = 409;
    response = null;
    if (root == null) {
      return { ...preflightRoot, __adnorExchangeTransactionProbe: { id: probeId, createdAt: Date.now() } };
    }
    if (root.__adnorExchangeTransactionProbe?.id === probeId) delete root.__adnorExchangeTransactionProbe;
    if (typeof root !== 'object' || !root.users || typeof root.users !== 'object') {
      abortCode = 'EXCHANGE_DATABASE_NOT_READY'; abortStatus = 503; return;
    }
    try { response = mutator(root); return root; }
    catch (error) { abortCode = String(error.message || 'EXCHANGE_TRANSACTION_FAILED'); abortStatus = Number(error.statusCode || 409); return; }
  }, undefined, false);

  if (!result.committed) throw exchangeError(abortCode || 'EXCHANGE_TRANSACTION_FAILED', abortStatus || 409);
  const committedRoot = result.snapshot ? result.snapshot.val() : null;
  if (committedRoot && typeof committedRoot === 'object') {
    exchangeRootWarmCacheV219.value = committedRoot;
    exchangeRootWarmCacheV219.updatedAt = Date.now();
  }
  if (response == null) {
    if (committedRoot?.__adnorExchangeTransactionProbe?.id === probeId) {
      await rootRef.child('__adnorExchangeTransactionProbe').remove();
      exchangeRootWarmCacheV219.updatedAt = 0;
    }
    return await exchangeRootMutation(mutator);
  }
  return response;
}

async function exchangePlaceOrder(owner, body) {
  const input = exchangeNormalizeOrderInput(body);
  const requestId = sanitizeRequestId(body.requestId || body.idempotencyKey);
  const now = Date.now();
  const ownerType = owner.treasury ? 'treasury' : 'user';
  const uid = owner.treasury ? EXCHANGE_TREASURY_UID : owner.uid;
  const orderId = secureOperationId('adn_order', uid, requestId);

  return await exchangeRootMutation((root) => {
    const exchange = ensureExchangeState(root);
    const settings = exchangePublicSettings(exchange.settings);
    exchangeCheckTradingState(settings, input.side, owner.treasury);
    const profile = owner.treasury ? null : exchangeUserProfile(root, uid);
    const requestStore = owner.treasury ? exchange.adminRequests : profile.exchangeRequests;
    const existingReceipt = requestStore[requestId];
    if (existingReceipt) {
      if (existingReceipt.side !== input.side || existingReceipt.type !== input.type || roundQty(existingReceipt.quantity) !== input.quantity || roundPrice(existingReceipt.price || 0) !== roundPrice(input.price || 0)) {
        throw exchangeError('REQUEST_ID_REUSED', 409);
      }
      const existingOrder = exchange.orders[existingReceipt.orderId];
      return { ok: true, idempotent: true, order: existingOrder || existingReceipt };
    }
    if (!owner.treasury && settings.requireTerms && String(profile.exchangeTermsVersion || '') !== settings.termsVersion) {
      throw exchangeError('EXCHANGE_TERMS_REQUIRED', 403);
    }
    if (exchangeOpenOrderCount(exchange, uid, ownerType) >= settings.maxOpenOrdersPerUser) {
      throw exchangeError('EXCHANGE_OPEN_ORDER_LIMIT', 409);
    }
    const lastPrice = roundPrice(exchange.market.lastPrice || settings.openingPrice);
    const price = input.type === 'limit' ? exchangeValidatePrice(settings, input.price, lastPrice) : 0;
    const referencePrice = price || lastPrice;
    const estimatedNotional = exchangeOrderNotional(input.quantity, referencePrice);
    if (estimatedNotional < settings.minOrderUsd) throw exchangeError('EXCHANGE_ORDER_BELOW_MINIMUM', 400);
    if (estimatedNotional > settings.maxOrderUsd && !owner.treasury) throw exchangeError('EXCHANGE_ORDER_ABOVE_MAXIMUM', 400);
    if (!owner.treasury && exchangeCurrentDailyVolume(profile, now) + estimatedNotional > settings.dailyVolumeLimitUsd) {
      throw exchangeError('EXCHANGE_DAILY_LIMIT_EXCEEDED', 409);
    }

    const order = {
      id: orderId,
      uid,
      ownerType,
      side: input.side,
      type: input.type,
      symbol: 'ADN/USD',
      price,
      quantity: input.quantity,
      remaining: input.quantity,
      filledQuantity: 0,
      filledQuoteUsd: 0,
      feesUsd: 0,
      reservedUsd: 0,
      reservedAdn: 0,
      status: 'open',
      requestId,
      createdAt: now,
      updatedAt: now
    };

    if (input.side === 'buy') {
      let reserve = 0;
      if (input.type === 'limit') {
        reserve = ceilUsd(input.quantity * price * (1 + settings.takerFeeBps / 10000));
      } else {
        const maxPrice = roundPrice(lastPrice * (1 + settings.maxMarketSlippagePct / 100));
        reserve = ceilUsd(input.quantity * maxPrice * (1 + settings.takerFeeBps / 10000));
      }
      if (owner.treasury) {
        if (exchange.treasury.usdAvailable + 0.001 < reserve) throw exchangeError('EXCHANGE_TREASURY_USD_INSUFFICIENT', 409);
        exchange.treasury.usdAvailable = roundUsd(exchange.treasury.usdAvailable - reserve);
        exchange.treasury.usdReserved = roundUsd(exchange.treasury.usdReserved + reserve);
      } else {
        if (profile.realBalance + 0.001 < reserve) throw exchangeError('EXCHANGE_REAL_BALANCE_INSUFFICIENT', 409);
        profile.realBalance = roundUsd(profile.realBalance - reserve);
        profile.exchangeReservedUsd = roundUsd(profile.exchangeReservedUsd + reserve);
        if (!root.transactions) root.transactions = {};
        if (!root.transactions[uid]) root.transactions[uid] = {};
        root.transactions[uid][orderId] = {
          id: orderId,
          type: 'adn_buy_order_reserve',
          amount: -reserve,
          status: 'reserved',
          note: `حجز رصيد حقيقي لأمر شراء ADN — البونص غير مستخدم`,
          source: 'adn_exchange_v198',
          createdAt: now
        };
      }
      order.reservedUsd = reserve;
    } else {
      const reserve = input.quantity;
      if (owner.treasury) {
        if (exchange.treasury.adnAvailable + 0.00001 < reserve) throw exchangeError('EXCHANGE_TREASURY_ADN_INSUFFICIENT', 409);
        exchange.treasury.adnAvailable = roundQty(exchange.treasury.adnAvailable - reserve);
        exchange.treasury.adnReserved = roundQty(exchange.treasury.adnReserved + reserve);
      } else {
        if (profile.adnBalance + 0.00001 < reserve) throw exchangeError('EXCHANGE_ADN_BALANCE_INSUFFICIENT', 409);
        profile.adnBalance = roundQty(profile.adnBalance - reserve);
        profile.adnReserved = roundQty(profile.adnReserved + reserve);
      }
      order.reservedAdn = reserve;
    }

    exchange.orders[orderId] = order;
    const fills = exchangeMatchIncoming(root, exchange, order, now);
    if (input.type === 'market' && roundQty(order.remaining) > 0) {
      throw exchangeError('EXCHANGE_MARKET_LIQUIDITY_INSUFFICIENT', 409);
    }
    requestStore[requestId] = {
      orderId,
      side: input.side,
      type: input.type,
      quantity: input.quantity,
      price,
      createdAt: now
    };
    exchange.audit[`${orderId}_created`] = {
      id: `${orderId}_created`,
      action: owner.treasury ? 'treasury_order_created' : 'user_order_created',
      uid,
      orderId,
      side: input.side,
      type: input.type,
      quantity: input.quantity,
      price,
      createdAt: now
    };
    return {
      ok: true,
      secure: true,
      order: { ...order },
      fills,
      balances: owner.treasury ? { treasury: { ...exchange.treasury } } : {
        realBalance: profile.realBalance,
        bonusBalance: profile.bonusBalance,
        bonusUsable: false,
        reservedUsd: profile.exchangeReservedUsd,
        adnBalance: profile.adnBalance,
        adnReserved: profile.adnReserved
      }
    };
  });
}

async function exchangeCancelOrder(owner, body, forceAdmin = false) {
  const orderId = String(body.orderId || '').trim();
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(orderId)) throw exchangeError('EXCHANGE_INVALID_ORDER_ID', 400);
  const now = Date.now();
  return await exchangeRootMutation((root) => {
    const exchange = ensureExchangeState(root);
    const order = exchange.orders[orderId];
    if (!order) throw exchangeError('EXCHANGE_ORDER_NOT_FOUND', 404);
    const expectedUid = owner.treasury ? EXCHANGE_TREASURY_UID : owner.uid;
    if (!forceAdmin && order.uid !== expectedUid) throw exchangeError('EXCHANGE_ORDER_ACCESS_DENIED', 403);
    if (!['open', 'partial'].includes(order.status)) throw exchangeError('EXCHANGE_ORDER_NOT_OPEN', 409);
    exchangeReleaseOrderReserve(root, exchange, order, now, forceAdmin ? 'إلغاء إداري' : 'إلغاء المستخدم');
    order.status = 'cancelled';
    order.cancelledAt = now;
    order.updatedAt = now;
    order.cancelReason = String(body.reason || (forceAdmin ? 'إلغاء من الإدارة' : 'إلغاء من المستخدم')).slice(0, 200);
    exchange.audit[`${orderId}_cancel_${now}`] = {
      id: `${orderId}_cancel_${now}`,
      action: forceAdmin ? 'order_cancelled_by_admin' : 'order_cancelled_by_owner',
      uid: order.uid,
      orderId,
      reason: order.cancelReason,
      createdAt: now
    };
    return { ok: true, order: { ...order } };
  });
}

async function exchangeAcceptTerms(decodedToken, body, financialUid = '') {
  const uid = String(financialUid || decodedToken.uid);
  const settingsSnapshot = await firebaseDb.ref(`${EXCHANGE_NODE}/settings`).once('value');
  const settings = exchangePublicSettings(settingsSnapshot.val() || {});
  if (body.accepted !== true) throw exchangeError('EXCHANGE_TERMS_REQUIRED', 400);
  const now = Date.now();
  await firebaseDb.ref(`users/${uid}`).transaction((profile) => {
    if (!profile) return profile;
    return {
      ...profile,
      exchangeTermsVersion: settings.termsVersion,
      exchangeTermsAcceptedAt: now,
      exchangeRiskAccepted: true,
      updatedAt: now
    };
  }, undefined, false);
  return { ok: true, termsVersion: settings.termsVersion, acceptedAt: now };
}

function exchangeAggregateBook(orders, side, limit = 24) {
  const levels = new Map();
  Object.values(orders || {}).forEach((order) => {
    if (!order || order.side !== side || !['open', 'partial'].includes(order.status) || roundQty(order.remaining) <= 0) return;
    const key = roundPrice(order.price).toFixed(6);
    const previous = levels.get(key) || { price: roundPrice(order.price), quantity: 0, orders: 0 };
    previous.quantity = roundQty(previous.quantity + roundQty(order.remaining));
    previous.orders += 1;
    levels.set(key, previous);
  });
  return Array.from(levels.values())
    .sort((a, b) => side === 'buy' ? b.price - a.price : a.price - b.price)
    .slice(0, limit)
    .map((level) => ({ ...level, totalUsd: roundUsd(level.price * level.quantity) }));
}

async function exchangeMarketDataFreshV219(interval = '1m', candleLimit = 160) {
  const normalizedInterval = EXCHANGE_INTERVALS[interval] ? interval : '1m';
  const safeLimit = Math.max(20, Math.min(500, Number(candleLimit || 160)));
  const [settingsSnapshot, marketSnapshot, ordersSnapshot, recentTradesSnapshot, dayTradesSnapshot, candlesSnapshot, treasurySnapshot] = await Promise.all([
    firebaseDb.ref(`${EXCHANGE_NODE}/settings`).once('value'),
    firebaseDb.ref(`${EXCHANGE_NODE}/market`).once('value'),
    firebaseDb.ref(`${EXCHANGE_NODE}/orders`).once('value'),
    firebaseDb.ref(`${EXCHANGE_NODE}/trades`).orderByChild('createdAt').limitToLast(50).once('value'),
    firebaseDb.ref(`${EXCHANGE_NODE}/trades`).orderByChild('createdAt').startAt(Date.now() - 24 * 60 * 60 * 1000).limitToLast(600).once('value'),
    firebaseDb.ref(`${EXCHANGE_NODE}/candles/${normalizedInterval}`).orderByChild('time').limitToLast(safeLimit).once('value'),
    firebaseDb.ref(`${EXCHANGE_NODE}/treasury`).once('value')
  ]);
  const settings = exchangePublicSettings(settingsSnapshot.val() || {});
  const market = marketSnapshot.val() || {};
  const orders = ordersSnapshot.val() || {};
  const recentTrades = Object.values(recentTradesSnapshot.val() || {}).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const dayTrades = Object.values(dayTradesSnapshot.val() || {}).sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  const lastPrice = roundPrice(market.lastPrice || settings.openingPrice);
  const open24 = dayTrades.length ? roundPrice(dayTrades[0].price) : lastPrice;
  const high24 = dayTrades.length ? roundPrice(Math.max(...dayTrades.map((trade) => Number(trade.price || 0)))) : lastPrice;
  const low24 = dayTrades.length ? roundPrice(Math.min(...dayTrades.map((trade) => Number(trade.price || lastPrice)))) : lastPrice;
  const volume24 = roundQty(dayTrades.reduce((sum, trade) => sum + Number(trade.quantity || 0), 0));
  const quoteVolume24 = roundUsd(dayTrades.reduce((sum, trade) => sum + Number(trade.grossUsd || 0), 0));
  const change24 = open24 > 0 ? Math.round(((lastPrice - open24) / open24) * 10000) / 100 : 0;
  const candles = Object.values(candlesSnapshot.val() || {}).sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
  const treasury = treasurySnapshot.val() || {};
  return {
    ok: true,
    realMarket: true,
    settings,
    market: {
      lastPrice,
      open24,
      high24,
      low24,
      change24,
      volume24,
      quoteVolume24,
      lastTradeAt: Number(market.lastTradeAt || 0),
      tradeCount: Number(market.tradeCount || 0),
      issuedAdn: roundQty(market.issuedAdn || 0),
      circulatingAdn: Math.max(0, roundQty(Number(market.issuedAdn || 0) - Number(treasury.adnAvailable || 0) - Number(treasury.adnReserved || 0)))
    },
    orderBook: {
      bids: exchangeAggregateBook(orders, 'buy'),
      asks: exchangeAggregateBook(orders, 'sell')
    },
    recentTrades: recentTrades.map((trade) => ({
      id: trade.id,
      price: roundPrice(trade.price),
      quantity: roundQty(trade.quantity),
      grossUsd: roundUsd(trade.grossUsd),
      createdAt: Number(trade.createdAt || 0),
      direction: trade.price >= lastPrice ? 'up' : 'down'
    })),
    interval: normalizedInterval,
    candles
  };
}

async function exchangeAccountDataFreshV219(decodedToken, financialUid = '') {
  const uid = String(financialUid || decodedToken.uid);
  const [profileSnapshot, ordersSnapshot, tradesSnapshot, marketSnapshot, settingsSnapshot] = await Promise.all([
    firebaseDb.ref(`users/${uid}`).once('value'),
    firebaseDb.ref(`${EXCHANGE_NODE}/orders`).orderByChild('uid').equalTo(uid).limitToLast(100).once('value'),
    firebaseDb.ref(`exchange_user_trades/${uid}`).orderByChild('createdAt').limitToLast(100).once('value'),
    firebaseDb.ref(`${EXCHANGE_NODE}/market`).once('value'),
    firebaseDb.ref(`${EXCHANGE_NODE}/settings`).once('value')
  ]);
  if (!profileSnapshot.exists()) throw exchangeError('USER_ACCOUNT_NOT_FOUND', 404);
  const profile = profileSnapshot.val() || {};
  const settings = exchangePublicSettings(settingsSnapshot.val() || {});
  const lastPrice = roundPrice(marketSnapshot.val()?.lastPrice || settings.openingPrice);
  const adnBalance = roundQty(profile.adnBalance || 0);
  const adnReserved = roundQty(profile.adnReserved || 0);
  const totalAdn = roundQty(adnBalance + adnReserved);
  const costBasis = roundUsd(profile.adnCostBasisUsd || 0);
  const currentValue = roundUsd(totalAdn * lastPrice);
  const averagePrice = totalAdn > 0 ? roundPrice(costBasis / totalAdn) : 0;
  const openOrders = Object.values(ordersSnapshot.val() || {}).filter((order) => ['open', 'partial'].includes(order.status)).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const trades = Object.values(tradesSnapshot.val() || {}).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  return {
    ok: true,
    realMarket: true,
    terms: {
      required: settings.requireTerms,
      version: settings.termsVersion,
      accepted: String(profile.exchangeTermsVersion || '') === settings.termsVersion,
      acceptedAt: Number(profile.exchangeTermsAcceptedAt || 0)
    },
    balances: {
      realBalance: roundUsd(profile.realBalance || 0),
      bonusBalance: roundUsd(profile.bonusBalance || 0),
      bonusUsable: false,
      reservedUsd: roundUsd(profile.exchangeReservedUsd || 0),
      adnBalance,
      adnReserved,
      totalAdn,
      averageBuyPrice: averagePrice,
      costBasisUsd: costBasis,
      currentValueUsd: currentValue,
      unrealizedPnlUsd: roundUsd(currentValue - costBasis),
      realizedPnlUsd: roundUsd(profile.adnRealizedPnlUsd || 0)
    },
    openOrders,
    recentTrades: trades,
    settings
  };
}

async function exchangeMarketData(interval = '1m', candleLimit = 160) {
  const normalizedInterval = EXCHANGE_INTERVALS[interval] ? interval : '1m';
  const safeLimit = Math.max(20, Math.min(300, Number(candleLimit || 160)));
  const key = `${normalizedInterval}:${safeLimit}`;
  const cached = cacheMapGetV219(exchangeMarketCacheV219, key);
  if (cached) return { ...cached, cached: true };
  const fresh = await exchangeMarketDataFreshV219(normalizedInterval, safeLimit);
  return cacheMapSetV219(exchangeMarketCacheV219, key, { ...fresh, cached: false }, 1800);
}

async function exchangeAccountData(decodedToken, financialUid = '') {
  const uid = String(financialUid || decodedToken?.uid || '');
  const cached = cacheMapGetV219(exchangeAccountCacheV219, uid);
  if (cached) return { ...cached, cached: true };
  const fresh = await exchangeAccountDataFreshV219(decodedToken, uid);
  return cacheMapSetV219(exchangeAccountCacheV219, uid, { ...fresh, cached: false }, 1200);
}

async function adminExchangeOverview() {
  const data = await exchangeMarketData('1m', 200);
  const [exchangeSnapshot, usersSnapshot] = await Promise.all([
    firebaseDb.ref(EXCHANGE_NODE).once('value'),
    firebaseDb.ref('users').once('value')
  ]);
  const exchange = exchangeSnapshot.val() || {};
  const users = usersSnapshot.val() || {};
  const investorCount = Object.values(users).filter((profile) => roundQty(Number(profile.adnBalance || 0) + Number(profile.adnReserved || 0)) > 0).length;
  const orders = Object.values(exchange.orders || {}).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  return {
    ...data,
    admin: true,
    investorCount,
    treasury: {
      adnAvailable: roundQty(exchange.treasury?.adnAvailable || 0),
      adnReserved: roundQty(exchange.treasury?.adnReserved || 0),
      usdAvailable: roundUsd(exchange.treasury?.usdAvailable || 0),
      usdReserved: roundUsd(exchange.treasury?.usdReserved || 0),
      feesUsd: roundUsd(exchange.treasury?.feesUsd || 0)
    },
    allOpenOrders: orders.filter((order) => ['open', 'partial'].includes(order.status)).slice(0, 300),
    recentOrders: orders.slice(0, 200)
  };
}

async function adminExchangeSaveSettings(admin, body) {
  const now = Date.now();
  let abortCode = '';
  let abortStatus = 409;
  let response = null;

  // Settings are saved on the exchange node itself. This deliberately avoids
  // a root-level transaction, so a temporary null root or unrelated user data
  // can never cancel an exchange switch update.
  const result = await firebaseDb.ref(EXCHANGE_NODE).transaction((rawExchange) => {
    abortCode = '';
    abortStatus = 409;
    response = null;

    try {
      const holder = {
        [EXCHANGE_NODE]: rawExchange && typeof rawExchange === 'object'
          ? rawExchange
          : {}
      };
      const exchange = ensureExchangeState(holder);
      const current = exchangePublicSettings(exchange.settings);
      const next = {
        ...exchange.settings,
        enabled: body.enabled !== undefined
          ? exchangeBoolean(body.enabled, current.enabled)
          : current.enabled,
        buyEnabled: body.buyEnabled !== undefined
          ? exchangeBoolean(body.buyEnabled, current.buyEnabled)
          : current.buyEnabled,
        sellEnabled: body.sellEnabled !== undefined
          ? exchangeBoolean(body.sellEnabled, current.sellEnabled)
          : current.sellEnabled,
        openingPrice: body.openingPrice !== undefined
          ? roundPrice(body.openingPrice)
          : current.openingPrice,
        totalSupply: body.totalSupply !== undefined
          ? roundQty(body.totalSupply)
          : current.totalSupply,
        makerFeeBps: body.makerFeeBps !== undefined
          ? Math.max(0, Math.min(500, Number(body.makerFeeBps)))
          : current.makerFeeBps,
        takerFeeBps: body.takerFeeBps !== undefined
          ? Math.max(0, Math.min(500, Number(body.takerFeeBps)))
          : current.takerFeeBps,
        minOrderUsd: body.minOrderUsd !== undefined
          ? roundUsd(body.minOrderUsd)
          : current.minOrderUsd,
        maxOrderUsd: body.maxOrderUsd !== undefined
          ? roundUsd(body.maxOrderUsd)
          : current.maxOrderUsd,
        dailyVolumeLimitUsd: body.dailyVolumeLimitUsd !== undefined
          ? roundUsd(body.dailyVolumeLimitUsd)
          : current.dailyVolumeLimitUsd,
        maxOpenOrdersPerUser: body.maxOpenOrdersPerUser !== undefined
          ? Math.max(1, Math.min(100, Number(body.maxOpenOrdersPerUser)))
          : current.maxOpenOrdersPerUser,
        maxLimitPriceDeviationPct: body.maxLimitPriceDeviationPct !== undefined
          ? Math.max(1, Math.min(100, Number(body.maxLimitPriceDeviationPct)))
          : current.maxLimitPriceDeviationPct,
        maxMarketSlippagePct: body.maxMarketSlippagePct !== undefined
          ? Math.max(1, Math.min(50, Number(body.maxMarketSlippagePct)))
          : current.maxMarketSlippagePct,
        autoTreasuryLiquidityEnabled: body.autoTreasuryLiquidityEnabled !== undefined
          ? exchangeBoolean(body.autoTreasuryLiquidityEnabled, current.autoTreasuryLiquidityEnabled)
          : current.autoTreasuryLiquidityEnabled,
        autoTreasuryRepriceEnabled: body.autoTreasuryRepriceEnabled !== undefined
          ? exchangeBoolean(body.autoTreasuryRepriceEnabled, current.autoTreasuryRepriceEnabled)
          : current.autoTreasuryRepriceEnabled,
        treasuryAutoSellSpreadBps: body.treasuryAutoSellSpreadBps !== undefined
          ? Math.max(0, Math.min(500, Number(body.treasuryAutoSellSpreadBps)))
          : current.treasuryAutoSellSpreadBps,
        treasuryAutoBuySpreadBps: body.treasuryAutoBuySpreadBps !== undefined
          ? Math.max(0, Math.min(500, Number(body.treasuryAutoBuySpreadBps)))
          : current.treasuryAutoBuySpreadBps,
        circuitBreakerEnabled: body.circuitBreakerEnabled !== undefined
          ? exchangeBoolean(body.circuitBreakerEnabled, current.circuitBreakerEnabled)
          : current.circuitBreakerEnabled,
        circuitBreakerMovePct: body.circuitBreakerMovePct !== undefined
          ? Math.max(1, Math.min(100, Number(body.circuitBreakerMovePct)))
          : current.circuitBreakerMovePct,
        riskNotice: body.riskNotice !== undefined
          ? String(body.riskNotice).trim().slice(0, 1000)
          : current.riskNotice,
        updatedAt: now,
        updatedBy: admin.email
      };

      if (
        next.openingPrice <= 0 ||
        next.totalSupply <= 0 ||
        next.minOrderUsd <= 0 ||
        next.maxOrderUsd < next.minOrderUsd
      ) {
        throw exchangeError('EXCHANGE_SETTINGS_INVALID', 400);
      }

      if (
        next.totalSupply + 0.0001 <
        roundQty(exchange.market?.issuedAdn || 0)
      ) {
        throw exchangeError('EXCHANGE_SUPPLY_BELOW_ISSUED', 409);
      }

      exchange.settings = next;
      if (!exchange.market.lastPrice) {
        exchange.market.lastPrice = next.openingPrice;
      }

      const auditId = `settings_${now}_${crypto.randomBytes(4).toString('hex')}`;
      exchange.audit[auditId] = {
        id: auditId,
        action: 'exchange_settings_updated',
        adminEmail: admin.email,
        enabled: next.enabled,
        buyEnabled: next.buyEnabled,
        sellEnabled: next.sellEnabled,
        circuitBreakerEnabled: next.circuitBreakerEnabled,
        createdAt: now
      };

      response = {
        ok: true,
        persisted: true,
        settings: exchangePublicSettings(next)
      };
      return exchange;
    } catch (error) {
      abortCode = String(error.message || 'EXCHANGE_SETTINGS_SAVE_FAILED');
      abortStatus = Number(error.statusCode || 409);
      return;
    }
  }, undefined, false);

  if (!result.committed) {
    throw exchangeError(
      abortCode || 'EXCHANGE_SETTINGS_SAVE_FAILED',
      abortStatus || 409
    );
  }

  const persistedExchange = result.snapshot.val() || {};
  const persistedSettings = exchangePublicSettings(
    persistedExchange.settings || {}
  );

  return {
    ...(response || { ok: true }),
    persisted: true,
    settings: persistedSettings,
    updatedAt: Number(persistedExchange.settings?.updatedAt || now)
  };
}

async function adminExchangeAdjustTreasury(admin, body) {
  const deltaAdn = roundQty(body.deltaAdn || 0);
  const deltaUsd = roundUsd(body.deltaUsd || 0);
  const reason = String(body.reason || '').trim();
  if (!reason || reason.length < 5) throw exchangeError('ADMIN_REASON_REQUIRED', 400);
  if (!deltaAdn && !deltaUsd) throw exchangeError('EXCHANGE_TREASURY_ADJUSTMENT_EMPTY', 400);
  const now = Date.now();
  return await exchangeRootMutation((root) => {
    const exchange = ensureExchangeState(root);
    const nextAdn = roundQty(exchange.treasury.adnAvailable + deltaAdn);
    const nextUsd = roundUsd(exchange.treasury.usdAvailable + deltaUsd);
    const nextIssued = roundQty(exchange.market.issuedAdn + deltaAdn);
    if (nextAdn < 0 || nextUsd < 0 || nextIssued < 0) throw exchangeError('EXCHANGE_TREASURY_NEGATIVE', 409);
    if (nextIssued > roundQty(exchange.settings.totalSupply || 5000000)) throw exchangeError('EXCHANGE_TOTAL_SUPPLY_EXCEEDED', 409);
    exchange.treasury.adnAvailable = nextAdn;
    exchange.treasury.usdAvailable = nextUsd;
    exchange.market.issuedAdn = nextIssued;
    const auditId = `treasury_${now}_${crypto.randomBytes(4).toString('hex')}`;
    exchange.audit[auditId] = {
      id: auditId,
      action: 'treasury_adjustment',
      deltaAdn,
      deltaUsd,
      reason,
      adminEmail: admin.email,
      adnAfter: nextAdn,
      usdAfter: nextUsd,
      issuedAdnAfter: nextIssued,
      createdAt: now
    };
    return { ok: true, treasury: { ...exchange.treasury }, issuedAdn: nextIssued };
  });
}




/* ADNOR V204 — server-only user rewards, promo codes and custom games */
function secureUnitRandom() {
  return crypto.randomInt(0, 1_000_000) / 1_000_000;
}

function integerBetween(minimum, maximum) {
  const min = Math.ceil(Number(minimum || 0));
  const max = Math.floor(Number(maximum || min));
  if (max <= min) return min;
  return crypto.randomInt(min, max + 1);
}

function ensureObjectNode(root, key) {
  if (!root[key] || typeof root[key] !== 'object') root[key] = {};
  return root[key];
}

function ensureUserObject(root, uid) {
  const users = ensureObjectNode(root, 'users');
  const profile = users[uid];
  if (!profile || typeof profile !== 'object') {
    const error = new Error('USER_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  if (userFrozen(profile)) {
    const error = new Error('ACCOUNT_FROZEN');
    error.statusCode = 403;
    throw error;
  }
  return profile;
}

function storeUserTransaction(root, uid, id, record) {
  const all = ensureObjectNode(root, 'transactions');
  if (!all[uid] || typeof all[uid] !== 'object') all[uid] = {};
  all[uid][id] = { id, ...record };
}

function storeUserNotification(root, uid, id, record) {
  const all = ensureObjectNode(root, 'user_notifications');
  if (!all[uid] || typeof all[uid] !== 'object') all[uid] = {};
  all[uid][id] = { id, read: false, ...record };
}

function storeAdminNotification(root, id, record) {
  const all = ensureObjectNode(root, 'admin_notifications');
  all[id] = { id, status: 'new', ...record };
}

function userReceipt(profile, namespace, requestId) {
  const receipts = profile.serverReceipts && typeof profile.serverReceipts === 'object'
    ? profile.serverReceipts : (profile.serverReceipts = {});
  const bucket = receipts[namespace] && typeof receipts[namespace] === 'object'
    ? receipts[namespace] : (receipts[namespace] = {});
  return { bucket, existing: bucket[requestId] || null };
}

async function openLuckyBoxServer(decodedToken, body) {
  const uid = decodedToken.uid;
  const requestId = sanitizeRequestId(body.requestId || crypto.randomUUID());
  const now = Date.now();
  const chanceRoll = secureUnitRandom();
  const amountRoll = secureUnitRandom();
  return await exchangeRootMutation((root) => {
    const profile = ensureUserObject(root, uid);
    const receiptStore = userReceipt(profile, 'luckyBox', requestId);
    if (receiptStore.existing) return { ok: true, duplicate: true, ...receiptStore.existing };
    const lucky = root.wheel_settings && root.wheel_settings.luckyBox && typeof root.wheel_settings.luckyBox === 'object'
      ? root.wheel_settings.luckyBox : {};
    if (lucky.enabled === false) { const error = new Error('LUCKY_BOX_DISABLED'); error.statusCode = 409; throw error; }
    const last = Number(profile.lastLuckyBoxAt || 0);
    if (last && now - last < 86_400_000) {
      const error = new Error('LUCKY_BOX_ALREADY_OPENED'); error.statusCode = 409;
      error.details = { nextAt: last + 86_400_000 }; throw error;
    }
    const chance = Math.max(0, Math.min(100, Number(lucky.chance ?? 35))) / 100;
    const min = Math.max(0, numberValue(lucky.min ?? 0.1));
    const max = Math.max(min, numberValue(lucky.max ?? 1));
    const won = chanceRoll < chance;
    const amount = won ? numberValue(min + amountRoll * (max - min)) : 0;
    const before = numberValue(profile.bonusBalance);
    const after = numberValue(before + amount);
    profile.lastLuckyBoxAt = now;
    profile.updatedAt = now;
    if (amount > 0) profile.bonusBalance = after;
    const id = secureOperationId('lucky_box', uid, requestId);
    const logs = ensureObjectNode(root, 'lucky_box_logs');
    if (!logs[uid] || typeof logs[uid] !== 'object') logs[uid] = {};
    logs[uid][id] = { id, uid, won, amount, createdAt: now, source: 'server_v204' };
    if (amount > 0) {
      storeUserTransaction(root, uid, id, { type: 'daily_lucky_box', amount, status: 'bonus', note: 'جائزة صندوق الحظ اليومي', balanceBefore: before, balanceAfter: after, createdAt: now });
    }
    storeUserNotification(root, uid, id, { type: 'daily_lucky_box', title: won ? 'مبروك! صندوق الحظ' : 'صندوق الحظ', text: won ? `ربحت $${amount} بونص.` : 'حظ أوفر غدًا.', createdAt: now });
    const receipt = { id, won, amount, balanceBefore: before, balanceAfter: after, nextAt: now + 86_400_000, createdAt: now };
    receiptStore.bucket[requestId] = receipt;
    return { ok: true, duplicate: false, ...receipt };
  });
}

async function claimDailyLoginServer(decodedToken, body) {
  const uid = decodedToken.uid;
  const requestId = sanitizeRequestId(body.requestId || crypto.randomUUID());
  const now = Date.now();
  const today = dayKey(now);
  return await exchangeRootMutation((root) => {
    const profile = ensureUserObject(root, uid);
    const receiptStore = userReceipt(profile, 'dailyLogin', requestId);
    if (receiptStore.existing) return { ok: true, duplicate: true, ...receiptStore.existing };
    const settings = normalizeDailyLoginV204(root.system_settings && root.system_settings.daily_login);
    if (!settings.enabled) { const error = new Error('DAILY_LOGIN_DISABLED'); error.statusCode = 409; throw error; }
    const current = profile.dailyLogin && typeof profile.dailyLogin === 'object' ? { ...profile.dailyLogin } : {};
    if (String(current.lastDate || '') === today) { const error = new Error('DAILY_LOGIN_ALREADY_CLAIMED'); error.statusCode = 409; throw error; }
    const index = Math.max(0, Math.min(6, Math.floor(Number(current.nextIndex || 0)) % 7));
    const day = settings.days[index] || { enabled: false, type: 'none', value: 0 };
    const rewardType = day.enabled === false ? 'none' : day.type;
    const value = Math.max(0, numberValue(day.value));
    let amount = 0, vipPoints = 0, freeSpins = 0, coupon = '';
    const before = { real: numberValue(profile.realBalance), bonus: numberValue(profile.bonusBalance), vip: numberValue(profile.vipPoints), spins: numberValue(profile.freeSpins) };
    if (rewardType === 'real' && value > 0) { profile.realBalance = numberValue(before.real + value); amount = value; }
    else if (rewardType === 'bonus' && value > 0) { profile.bonusBalance = numberValue(before.bonus + value); amount = value; }
    else if (rewardType === 'vip' && value > 0) { profile.vipPoints = numberValue(before.vip + value); vipPoints = value; }
    else if (rewardType === 'freeSpin' && value > 0) { profile.freeSpins = numberValue(before.spins + value); freeSpins = value; }
    else if (rewardType === 'coupon') {
      coupon = safeText(day.coupon || `ADNOR-DAY${index + 1}`, 80);
      if (!profile.coupons || typeof profile.coupons !== 'object') profile.coupons = {};
      profile.coupons[`daily_${now}`] = { code: coupon, title: day.title || 'قسيمة يومية', createdAt: now, used: false };
    }
    profile.dailyLogin = { ...current, lastDate: today, lastAt: now, lastDayIndex: index, nextIndex: (index + 1) % 7, totalClaims: Number(current.totalClaims || 0) + 1 };
    profile.updatedAt = now;
    const id = secureOperationId('daily_login', uid, requestId);
    const rewardText = rewardType === 'real' ? `$${value} رصيد حقيقي` : rewardType === 'bonus' ? `$${value} بونص` : rewardType === 'vip' ? `${value} نقطة VIP` : rewardType === 'freeSpin' ? `${value} لفة مجانية` : rewardType === 'coupon' ? `قسيمة ${coupon}` : 'حظ أوفر';
    storeUserTransaction(root, uid, id, { type: 'daily_login', dayIndex: index + 1, rewardType, amount, vipPoints, freeSpins, coupon, status: 'approved', note: safeText(day.message, 500), createdAt: now });
    storeUserNotification(root, uid, id, { type: 'daily_login', title: 'مكافأة التسجيل اليومي', text: `صندوق اليوم ${index + 1}: ${rewardText}.`, createdAt: now });
    const receipt = { id, dayIndex: index + 1, rewardType, value, coupon, rewardText, createdAt: now };
    receiptStore.bucket[requestId] = receipt;
    return { ok: true, duplicate: false, ...receipt };
  });
}

function hasTicketOnDay(root, uid, day) {
  const tickets = root.user_tickets && root.user_tickets[uid];
  if (!tickets || typeof tickets !== 'object') return false;
  return Object.values(tickets).some((ticket) => ticket && dayKey(Number(ticket.createdAt || 0)) === day);
}

async function claimVipTaskServer(decodedToken, body) {
  const uid = decodedToken.uid;
  const taskId = safeText(body.taskId, 80);
  if (!taskId) { const error = new Error('VIP_TASK_REQUIRED'); error.statusCode = 400; throw error; }
  const requestId = sanitizeRequestId(body.requestId || `${taskId}_${dayKey()}`);
  const now = Date.now();
  const today = dayKey(now);
  return await exchangeRootMutation((root) => {
    const profile = ensureUserObject(root, uid);
    const receiptStore = userReceipt(profile, 'vipTask', requestId);
    if (receiptStore.existing) return { ok: true, duplicate: true, ...receiptStore.existing };
    const settings = normalizeVipSettingsV204(root.system_settings && root.system_settings.vip);
    if (!settings.enabled) { const error = new Error('VIP_DISABLED'); error.statusCode = 409; throw error; }
    const task = (settings.tasks || []).find((item) => item.id === taskId) || { id: taskId, active: true };
    if (task.active === false) { const error = new Error('VIP_TASK_DISABLED'); error.statusCode = 409; throw error; }
    const claimed = profile.vipTasks && profile.vipTasks[today] && profile.vipTasks[today][taskId];
    if (claimed) { const error = new Error('VIP_TASK_ALREADY_CLAIMED'); error.statusCode = 409; throw error; }
    let ready = taskId === 'login';
    if (taskId === 'ticket') ready = hasTicketOnDay(root, uid, today);
    if (taskId === 'ai') ready = profile.vipUsedAiDay === today || profile.vipUsedAiToday === true;
    if (taskId === 'support') ready = profile.vipVisitedInfoDay === today || profile.vipVisitedInfoToday === true;
    if (!['login', 'ticket', 'ai', 'support'].includes(taskId)) ready = true;
    if (!ready) { const error = new Error('VIP_TASK_NOT_READY'); error.statusCode = 409; throw error; }
    if (!profile.vipTasks || typeof profile.vipTasks !== 'object') profile.vipTasks = {};
    if (!profile.vipTasks[today] || typeof profile.vipTasks[today] !== 'object') profile.vipTasks[today] = {};
    profile.vipTasks[today][taskId] = true;
    const points = Math.max(0, numberValue(settings.taskPoints));
    const bonus = Math.max(0, numberValue(settings.taskBonus));
    const beforeBonus = numberValue(profile.bonusBalance);
    profile.vipPoints = numberValue(Number(profile.vipPoints || 0) + points);
    profile.bonusBalance = numberValue(beforeBonus + bonus);
    profile.vipBonusEarned = numberValue(Number(profile.vipBonusEarned || 0) + bonus);
    profile.updatedAt = now;
    const id = secureOperationId('vip_task', uid, requestId);
    storeUserTransaction(root, uid, id, { type: 'vip_task', taskId, amount: bonus, vipPoints: points, status: 'approved', balanceBefore: beforeBonus, balanceAfter: profile.bonusBalance, createdAt: now });
    storeUserNotification(root, uid, id, { type: 'vip', title: 'مكافأة VIP', text: `تم استلام ${points} نقطة VIP و$${bonus} بونص.`, createdAt: now });
    const receipt = { id, taskId, points, bonus, createdAt: now };
    receiptStore.bucket[requestId] = receipt;
    return { ok: true, duplicate: false, ...receipt };
  });
}

async function openVipBoxServer(decodedToken, body) {
  const uid = decodedToken.uid;
  const requestId = sanitizeRequestId(body.requestId || dayKey());
  const now = Date.now();
  const today = dayKey(now);
  const bonusRoll = secureUnitRandom();
  const spinRoll = secureUnitRandom();
  return await exchangeRootMutation((root) => {
    const profile = ensureUserObject(root, uid);
    const receiptStore = userReceipt(profile, 'vipBox', requestId);
    if (receiptStore.existing) return { ok: true, duplicate: true, ...receiptStore.existing };
    const settings = normalizeVipSettingsV204(root.system_settings && root.system_settings.vip);
    if (!settings.enabled || !settings.boxEnabled) { const error = new Error('VIP_BOX_DISABLED'); error.statusCode = 409; throw error; }
    if (String(profile.vipBoxDay || '') === today) { const error = new Error('VIP_BOX_ALREADY_OPENED'); error.statusCode = 409; throw error; }
    const min = Math.max(0, numberValue(settings.boxMin));
    const max = Math.max(min, numberValue(settings.boxMax));
    const pointsMin = Math.max(0, Math.floor(Number(settings.boxPointsMin || 0)));
    const pointsMax = Math.max(pointsMin, Math.floor(Number(settings.boxPointsMax || pointsMin)));
    const bonus = numberValue(min + bonusRoll * (max - min));
    const points = integerBetween(pointsMin, pointsMax);
    const freeSpin = spinRoll < 0.18 ? 1 : 0;
    const beforeBonus = numberValue(profile.bonusBalance);
    profile.vipBoxDay = today;
    profile.vipBoxLastAt = now;
    profile.vipPoints = numberValue(Number(profile.vipPoints || 0) + points);
    profile.bonusBalance = numberValue(beforeBonus + bonus);
    profile.vipBonusEarned = numberValue(Number(profile.vipBonusEarned || 0) + bonus);
    if (freeSpin) profile.freeSpins = numberValue(Number(profile.freeSpins || 0) + 1);
    profile.updatedAt = now;
    const id = secureOperationId('vip_box', uid, requestId);
    storeUserTransaction(root, uid, id, { type: 'vip_box', amount: bonus, vipPoints: points, freeSpin, status: 'approved', balanceBefore: beforeBonus, balanceAfter: profile.bonusBalance, createdAt: now });
    storeUserNotification(root, uid, id, { type: 'vip', title: 'الصندوق الملكي', text: `ربحت $${bonus} بونص و${points} نقطة VIP${freeSpin ? ' ولفة مجانية' : ''}.`, createdAt: now });
    const receipt = { id, bonus, points, freeSpin, createdAt: now };
    receiptStore.bucket[requestId] = receipt;
    return { ok: true, duplicate: false, ...receipt };
  });
}

function promoTicketCandidates(uid, requestId) {
  const candidates = [];
  for (let index = 0; index < 16; index += 1) {
    const digest = crypto.createHash('sha256').update(`${uid}|${requestId}|${index}`).digest('hex');
    candidates.push(String(parseInt(digest.slice(0, 10), 16) % 10_000_000).padStart(7, '0'));
  }
  return candidates;
}

async function redeemPromoServer(decodedToken, body) {
  const uid = decodedToken.uid;
  const code = safeText(body.code, 60).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (code.length < 3 || !isValidFirebaseKey(code)) { const error = new Error('INVALID_PROMO_CODE'); error.statusCode = 400; throw error; }
  const requestId = sanitizeRequestId(body.requestId || code);
  const now = Date.now();
  const ticketNumbers = promoTicketCandidates(uid, requestId);
  return await exchangeRootMutation((root) => {
    const profile = ensureUserObject(root, uid);
    const promoCodes = ensureObjectNode(root, 'promo_codes');
    const promo = promoCodes[code];
    if (!promo || promo.active === false) { const error = new Error('PROMO_CODE_NOT_FOUND'); error.statusCode = 404; throw error; }
    const redemptions = ensureObjectNode(root, 'promo_redemptions');
    if (!redemptions[code] || typeof redemptions[code] !== 'object') redemptions[code] = {};
    if (redemptions[code][uid]) return { ok: true, duplicate: true, redemption: redemptions[code][uid] };
    const maxUses = Math.max(0, Math.floor(Number(promo.maxUses || 0)));
    const usedCount = Math.max(0, Math.floor(Number(promo.usedCount || 0)));
    if (maxUses > 0 && usedCount >= maxUses) { const error = new Error('PROMO_CODE_EXHAUSTED'); error.statusCode = 409; throw error; }
    const bonus = Math.max(0, numberValue(promo.bonus));
    const freeSpins = Math.max(0, Math.floor(Number(promo.freeSpins || 0)));
    const freeTicket = promo.freeTicket === true;
    const beforeBonus = numberValue(profile.bonusBalance);
    profile.bonusBalance = numberValue(beforeBonus + bonus);
    profile.freeSpins = numberValue(Number(profile.freeSpins || 0) + freeSpins);
    profile.updatedAt = now;
    let ticket = null;
    if (freeTicket) {
      const tickets = ensureObjectNode(root, 'tickets');
      if (!tickets.daily || typeof tickets.daily !== 'object') tickets.daily = {};
      const userTickets = ensureObjectNode(root, 'user_tickets');
      if (!userTickets[uid] || typeof userTickets[uid] !== 'object') userTickets[uid] = {};
      const existingNumbers = new Set(Object.values(tickets.daily).map((item) => String(item && item.number || '')));
      const ticketNumber = ticketNumbers.find((candidate) => !existingNumbers.has(candidate));
      if (!ticketNumber) { const error = new Error('TICKET_NUMBER_GENERATION_FAILED'); error.statusCode = 503; throw error; }
      const ticketId = secureOperationId('promo_ticket', uid, requestId);
      ticket = { id: ticketId, number: ticketNumber, uid, email: safeText(decodedToken.email, 220), drawType: 'daily', price: 0, status: 'active', promoCode: code, source: 'server_promo_v204', createdAt: now };
      tickets.daily[ticketId] = ticket;
      userTickets[uid][ticketId] = ticket;
    }
    promo.usedCount = usedCount + 1;
    promo.updatedAt = now;
    const redemption = { code, uid, email: safeText(decodedToken.email, 220), bonus, freeSpins, freeTicket, ticketId: ticket && ticket.id || '', ticketNumber: ticket && ticket.number || '', createdAt: now, source: 'server_v204' };
    redemptions[code][uid] = redemption;
    const id = secureOperationId('promo', uid, requestId);
    storeUserTransaction(root, uid, id, { type: 'promo_code_redeemed', amount: bonus, status: 'bonus', note: `استخدام كود دعائي ${code}`, balanceBefore: beforeBonus, balanceAfter: profile.bonusBalance, freeSpins, freeTicket, createdAt: now });
    storeUserNotification(root, uid, id, { type: 'promo_bonus', title: 'تم تفعيل الكود الدعائي', text: `حصلت على $${bonus} بونص و${freeSpins} لفة${ticket ? ` وتذكرة ${ticket.number}` : ''}.`, createdAt: now });
    storeAdminNotification(root, id, { type: 'promo_code_redeemed', uid, email: safeText(decodedToken.email, 220), text: `تم استخدام الكود ${code}.`, createdAt: now });
    return { ok: true, duplicate: false, redemption };
  });
}

const RETIRED_GAME_IDS = new Set(['golden_squirrel']);

function normalizeCustomGameServer(id, raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const gameId = safeText(id || value.id, 80).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return {
    id: gameId,
    gameType: safeText(value.gameType || 'simple', 40),
    name: safeText(value.name || 'لعبة ADNOR', 120),
    icon: safeText(value.icon || '🎮', 20),
    desc: safeText(value.desc, 600),
    enabled: safeBoolean(value.enabled, true),
    minBet: Math.max(0.01, numberValue(value.minBet || 1)),
    maxBet: Math.max(0.01, numberValue(value.maxBet || 100)),
    winChance: Math.max(0, Math.min(100, Number(value.winChance || 0))),
    multiplier: Math.max(0, Math.min(10000, Number(value.multiplier || 0))),
    maxMultiplier: Math.max(0, Math.min(10000, Number(value.maxMultiplier || value.multiplier || 0))),
    acceptBonus: safeBoolean(value.acceptBonus, false),
    acceptReal: safeBoolean(value.acceptReal, true),
    useTreasuryRtp: safeBoolean(value.useTreasuryRtp, true),
    order: Number(value.order || 10),
    updatedAt: Number(value.updatedAt || 0),
    updatedBy: safeText(value.updatedBy, 220)
  };
}


function normalizeGameTreasurySettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const rawPlatformCut = Number(value.platformCutPercent ?? 5);
  const migratedPlatformCut = rawPlatformCut > 30 ? 5 : rawPlatformCut;
  return {
    platformCutPercent: Math.max(0, Math.min(30, migratedPlatformCut)),
    reportHour: Math.max(0, Math.min(23, Math.floor(Number(value.reportHour ?? 20)))),
    carryOverPlayerPool: value.carryOverPlayerPool !== false,
    requireFullCoverage: value.requireFullCoverage !== false,
    defaultOpeningReserve: Math.max(0, numberValue(value.defaultOpeningReserve ?? 5000)),
    updatedAt: Number(value.updatedAt || 0),
    updatedBy: safeText(value.updatedBy, 220)
  };
}

function gameTreasuryWithMetrics(raw) {
  const value = raw && typeof raw === 'object' ? { ...raw } : {};
  const stakes = numberValue(Number(value.totalBetsReal || 0) + Number(value.totalBetsBonus || 0));
  const paid = numberValue(value.paidOut || 0);
  value.actualRtpPercent = stakes > 0 ? Math.round((paid / stakes) * 10000) / 100 : 0;
  value.platformNet = numberValue(Number(value.totalBetsReal || 0) - paid);
  return value;
}

function ensureGameTreasuryState(root, gameId, gameName = '') {
  const treasuryRoot = ensureObjectNode(root, 'game_treasury');
  const settings = normalizeGameTreasurySettings(treasuryRoot.settings);
  treasuryRoot.settings = { ...(treasuryRoot.settings || {}), ...settings };
  const aggregate = treasuryRoot.current && typeof treasuryRoot.current === 'object' ? treasuryRoot.current : (treasuryRoot.current = {});
  const byGame = treasuryRoot.by_game && typeof treasuryRoot.by_game === 'object' ? treasuryRoot.by_game : (treasuryRoot.by_game = {});
  let game = byGame[gameId];
  if (!game || typeof game !== 'object') {
    const seed = settings.defaultOpeningReserve;
    game = byGame[gameId] = {
      gameId, gameName: safeText(gameName || gameId, 120),
      playerPool: seed, platformFunding: seed, platformProfit: 0,
      totalBetsReal: 0, totalBetsBonus: 0, paidOut: 0, roundsCount: 0,
      createdAt: Date.now(), updatedAt: Date.now()
    };
    aggregate.playerPool = numberValue(Number(aggregate.playerPool || 0) + seed);
    aggregate.platformFunding = numberValue(Number(aggregate.platformFunding || 0) + seed);
  }
  game.gameName = safeText(gameName || game.gameName || gameId, 120);
  return { treasuryRoot, settings, aggregate, byGame, game };
}

function applyGameTreasuryAccounting(root, input) {
  const gameId = safeText(input.gameId, 80).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const bet = numberValue(input.bet);
  const paidFromReal = numberValue(input.paidFromReal);
  const paidFromBonus = numberValue(input.paidFromBonus);
  const payout = numberValue(input.payout);
  const maximumMultiplier = Math.max(0, Number(input.maximumMultiplier || 0));
  const now = Number(input.now || Date.now());
  const state = ensureGameTreasuryState(root, gameId, input.gameName);
  const edge = state.settings.platformCutPercent;
  const platformCut = input.promoRound ? 0 : numberValue(paidFromReal * edge / 100);
  const playerPoolAdd = input.promoRound ? 0 : numberValue(paidFromReal - platformCut);
  const availableAfterIncome = numberValue(Number(state.game.playerPool || 0) + playerPoolAdd);
  const maximumLiability = numberValue(bet * maximumMultiplier);
  if (state.settings.requireFullCoverage && maximumLiability > availableAfterIncome) {
    const error = new Error('GAME_TREASURY_LOW'); error.statusCode = 409;
    error.details = { available: availableAfterIncome, maximumLiability, gameId };
    throw error;
  }
  if (payout > availableAfterIncome) { const error = new Error('GAME_TREASURY_LOW'); error.statusCode = 409; throw error; }
  state.game.totalBetsReal = numberValue(Number(state.game.totalBetsReal || 0) + paidFromReal);
  state.game.totalBetsBonus = numberValue(Number(state.game.totalBetsBonus || 0) + paidFromBonus);
  state.game.platformProfit = numberValue(Number(state.game.platformProfit || 0) + platformCut);
  state.game.playerPool = numberValue(availableAfterIncome - payout);
  state.game.paidOut = numberValue(Number(state.game.paidOut || 0) + payout);
  state.game.roundsCount = Number(state.game.roundsCount || 0) + 1;
  state.game.updatedAt = now;
  state.aggregate.totalBetsReal = numberValue(Number(state.aggregate.totalBetsReal || 0) + paidFromReal);
  state.aggregate.totalBetsBonus = numberValue(Number(state.aggregate.totalBetsBonus || 0) + paidFromBonus);
  state.aggregate.platformProfit = numberValue(Number(state.aggregate.platformProfit || 0) + platformCut);
  state.aggregate.playerPool = numberValue(Number(state.aggregate.playerPool || 0) + playerPoolAdd - payout);
  state.aggregate.paidOut = numberValue(Number(state.aggregate.paidOut || 0) + payout);
  state.aggregate.roundsCount = Number(state.aggregate.roundsCount || 0) + 1;
  state.aggregate.updatedAt = now;
  return { ...state, platformCut, playerPoolAdd, availableAfterIncome };
}

async function playCustomGameServer(decodedToken, body) {
  const account = await resolveGameAccount(decodedToken, { publicId: body.publicId, allowBootstrap: true });
  const uid = account.uid;
  const gameId = safeText(body.gameId, 80).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!gameId) { const error = new Error('GAME_REQUIRED'); error.statusCode = 400; throw error; }
  if (RETIRED_GAME_IDS.has(gameId)) { const error = new Error('GAME_RETIRED'); error.statusCode = 410; throw error; }
  const bet = numberValue(body.bet);
  const requestId = sanitizeRequestId(body.requestId || crypto.randomUUID());
  const gameSnapshot = await firebaseDb.ref(`game_center/games/${gameId}`).once('value');
  const rawGame = gameSnapshot.val();
  const game = normalizeCustomGameServer(gameId, rawGame);
  if (!rawGame || game.enabled === false) { const error = new Error('GAME_NOT_AVAILABLE'); error.statusCode = 404; throw error; }
  if (bet < game.minBet || bet > game.maxBet) { const error = new Error('GAME_BET_OUT_OF_RANGE'); error.statusCode = 400; throw error; }
  const treasurySettings = normalizeGameTreasurySettings((await firebaseDb.ref('game_treasury/settings').once('value')).val());
  const targetRtp = (100 - treasurySettings.platformCutPercent) / 100;
  const effectiveChance = game.useTreasuryRtp && game.multiplier > 0
    ? Math.max(0, Math.min(100, targetRtp / game.multiplier * 100))
    : game.winChance;
  const won = secureUnitRandom() * 100 < effectiveChance;
  const payout = won ? numberValue(bet * game.multiplier) : 0;
  const now = Date.now();
  return await exchangeRootMutation((root) => {
    const profile = ensureUserObject(root, uid);
    const receiptStore = userReceipt(profile, 'customGameV212', requestId);
    if (receiptStore.existing) return { ok: true, duplicate: true, ...receiptStore.existing };
    const controls = normalizeSystemControls(root.system_settings && root.system_settings.controls);
    if (!controls.gamesEnabled || controls.maintenanceMode) { const error = new Error('GAMES_DISABLED'); error.statusCode = 409; throw error; }
    if (Number(profile.selfExcludedUntil || 0) > now) { const error = new Error('SELF_EXCLUDED'); error.statusCode = 403; throw error; }
    const realBefore = numberValue(profile.realBalance), bonusBefore = numberValue(profile.bonusBalance);
    let useBonus = game.acceptBonus ? Math.min(bonusBefore, bet) : 0;
    let remaining = numberValue(bet - useBonus);
    let useReal = game.acceptReal ? Math.min(realBefore, remaining) : 0;
    if (numberValue(useBonus + useReal) < bet) { const error = new Error('INSUFFICIENT_PLAYABLE_BALANCE'); error.statusCode = 409; throw error; }
    const treasury = applyGameTreasuryAccounting(root, {
      gameId, gameName: game.name, bet, paidFromReal: useReal, paidFromBonus: useBonus,
      payout, maximumMultiplier: game.multiplier, now
    });
    const realAfter = numberValue(realBefore - useReal + payout), bonusAfter = numberValue(bonusBefore - useBonus);
    profile.realBalance = realAfter; profile.bonusBalance = bonusAfter; profile.updatedAt = now;
    const id = secureOperationId('custom_game', uid, requestId);
    const log = {
      id, uid, email: safeText(decodedToken.email, 220), gameId, gameName: game.name, bet,
      win: payout, payout, won, multiplier: won ? game.multiplier : 0,
      paidFromReal: useReal, paidFromBonus: useBonus, realBefore, realAfter, bonusBefore, bonusAfter,
      platformCut: treasury.platformCut, playerPoolAdd: treasury.playerPoolAdd,
      playerPoolAfter: treasury.game.playerPool, targetRtpPercent: 100 - treasury.settings.platformCutPercent,
      createdAt: now, source: 'server_v212'
    };
    const customLogs = ensureObjectNode(root, 'custom_game_logs');
    if (!customLogs[uid] || typeof customLogs[uid] !== 'object') customLogs[uid] = {};
    customLogs[uid][id] = log;
    const rounds = treasury.treasuryRoot.rounds && typeof treasury.treasuryRoot.rounds === 'object' ? treasury.treasuryRoot.rounds : (treasury.treasuryRoot.rounds = {});
    rounds[id] = { ...log, label: won ? `X${game.multiplier}` : '0x' };
    storeUserTransaction(root, uid, id, {
      type: 'custom_game', amount: numberValue(payout - bet),
      balanceBefore: numberValue(realBefore + bonusBefore), balanceAfter: numberValue(realAfter + bonusAfter),
      realBefore, realAfter, bonusBefore, bonusAfter, paidFromReal: useReal, paidFromBonus: useBonus,
      note: `لعبة ${game.name} — ${won ? `ربح X${game.multiplier}` : 'خسارة'}`, source: 'server_v212', createdAt: now
    });
    storeAdminNotification(root, id, { type: 'custom_game', uid, email: safeText(decodedToken.email, 220), text: `لعبة ${game.name} — رهان $${bet} — ربح $${payout}`, source: 'server_v212', createdAt: now });
    const receipt = { id, gameId, gameName: game.name, bet, payout, won, multiplier: won ? game.multiplier : 0, balances: { realBalance: realAfter, bonusBalance: bonusAfter }, createdAt: now };
    receiptStore.bucket[requestId] = receipt;
    return { ok: true, duplicate: false, ...receipt };
  });
}

async function claimLegacyReferralServer(decodedToken, body) {
  const uid = decodedToken.uid;
  const rewardId = safeText(body.rewardId, 160);
  if (!rewardId || !isValidFirebaseKey(rewardId)) { const error = new Error('REFERRAL_REWARD_REQUIRED'); error.statusCode = 400; throw error; }
  const requestId = sanitizeRequestId(body.requestId || rewardId);
  const now = Date.now();
  return await exchangeRootMutation((root) => {
    const profile = ensureUserObject(root, uid);
    const receiptStore = userReceipt(profile, 'legacyReferral', requestId);
    if (receiptStore.existing) return { ok: true, duplicate: true, ...receiptStore.existing };
    const pending = root.pending_referral_rewards && root.pending_referral_rewards[uid] && root.pending_referral_rewards[uid][rewardId];
    if (!pending || pending.referrerUid !== uid) { const error = new Error('REFERRAL_REWARD_NOT_FOUND'); error.statusCode = 404; throw error; }
    if (pending.status === 'claimed' || pending.referrerRewardStatus === 'claimed') { const error = new Error('REFERRAL_REWARD_ALREADY_CLAIMED'); error.statusCode = 409; throw error; }
    const typeRaw = safeText(pending.referrerRewardType || 'bonus', 30);
    const type = ['bonus', 'real', 'wheelSpins', 'lotteryTickets', 'tickets'].includes(typeRaw) ? typeRaw : 'bonus';
    const amount = Math.max(0, numberValue(pending.referrerRewardAmount ?? pending.referrerBonus ?? pending.amount));
    const before = type === 'real' ? numberValue(profile.realBalance) : type === 'wheelSpins' ? numberValue(profile.freeSpins) : type === 'lotteryTickets' || type === 'tickets' ? numberValue(profile.freeLotteryTickets) : numberValue(profile.bonusBalance);
    if (type === 'real') profile.realBalance = numberValue(before + amount);
    else if (type === 'wheelSpins') profile.freeSpins = numberValue(before + amount);
    else if (type === 'lotteryTickets' || type === 'tickets') profile.freeLotteryTickets = numberValue(before + amount);
    else profile.bonusBalance = numberValue(before + amount);
    profile.updatedAt = now;
    pending.status = 'claimed'; pending.referrerRewardStatus = 'claimed'; pending.claimedAt = now;
    if (root.referrals && root.referrals[rewardId]) { root.referrals[rewardId].referrerRewardStatus = 'claimed'; root.referrals[rewardId].claimedAt = now; }
    if (!root.user_referrals || typeof root.user_referrals !== 'object') root.user_referrals = {};
    if (!root.user_referrals[uid] || typeof root.user_referrals[uid] !== 'object') root.user_referrals[uid] = {};
    root.user_referrals[uid][rewardId] = { ...pending };
    const id = secureOperationId('legacy_ref', uid, requestId);
    const after = type === 'real' ? profile.realBalance : type === 'wheelSpins' ? profile.freeSpins : type === 'lotteryTickets' || type === 'tickets' ? profile.freeLotteryTickets : profile.bonusBalance;
    storeUserTransaction(root, uid, id, { type: 'referral_referrer_reward', amount: type === 'real' || type === 'bonus' ? amount : 0, rewardType: type, rewardAmount: amount, balanceBefore: before, balanceAfter: after, createdAt: now });
    storeUserNotification(root, uid, id, { type: 'referral_bonus', title: 'وصلتك مكافأة دعوة', text: `تمت إضافة مكافأة الدعوة (${amount} ${type}).`, createdAt: now });
    const receipt = { id, rewardId, rewardType: type, rewardAmount: amount, createdAt: now };
    receiptStore.bucket[requestId] = receipt;
    return { ok: true, duplicate: false, ...receipt };
  });
}

async function adminCustomGamesBundle() {
  const [games, settings, current, byGame, logs] = await Promise.all([
    firebaseDb.ref('game_center/games').once('value'),
    firebaseDb.ref('game_treasury/settings').once('value'),
    firebaseDb.ref('game_treasury/current').once('value'),
    firebaseDb.ref('game_treasury/by_game').once('value'),
    firebaseDb.ref('custom_game_logs').once('value')
  ]);
  const gameRoot = games.val() || {};
  const flatLogs = [];
  Object.values(logs.val() || {}).forEach((byUser) => Object.values(byUser || {}).forEach((entry) => {
    if (entry && !RETIRED_GAME_IDS.has(String(entry.gameId || ''))) flatLogs.push(entry);
  }));
  const treasuries = {};
  Object.entries(byGame.val() || {}).forEach(([id, value]) => {
    if (!RETIRED_GAME_IDS.has(id)) treasuries[id] = gameTreasuryWithMetrics(value);
  });
  const aggregate = gameTreasuryWithMetrics(current.val() || {});
  const wheelTreasury = treasuries.wheel || gameTreasuryWithMetrics({ gameId: 'wheel', gameName: 'عجلة الحظ الملكية' });
  return {
    ok: true,
    games: Object.entries(gameRoot)
      .filter(([id]) => !RETIRED_GAME_IDS.has(id))
      .map(([id, value]) => normalizeCustomGameServer(id, value)),
    treasurySettings: normalizeGameTreasurySettings(settings.val()),
    treasury: wheelTreasury,
    aggregateTreasury: aggregate,
    treasuries,
    logs: flatLogs.sort((a, b) => timestampOf(b) - timestampOf(a)).slice(0, 300)
  };
}

async function adminSaveCustomGame(admin, body) {
  const action = safeText(body.action || 'save', 20).toLowerCase();
  const input = body.game && typeof body.game === 'object' ? body.game : body;
  const game = normalizeCustomGameServer(input.id, input);
  if (!game.id) { const error = new Error('INVALID_GAME_ID'); error.statusCode = 400; throw error; }
  if (RETIRED_GAME_IDS.has(game.id)) { const error = new Error('GAME_RETIRED'); error.statusCode = 410; throw error; }
  if (action === 'delete') {
    await firebaseDb.ref(`game_center/games/${game.id}`).remove();
    return { ok: true, deleted: true, id: game.id };
  }
  if (game.maxBet < game.minBet) { const error = new Error('INVALID_GAME_BET_LIMITS'); error.statusCode = 400; throw error; }
  game.updatedAt = Date.now(); game.updatedBy = admin.email;
  await firebaseDb.ref(`game_center/games/${game.id}`).set(game);
  return { ok: true, game };
}

async function adminSaveGameTreasurySettings(admin, body) {
  const currentSnapshot = await firebaseDb.ref('game_treasury/settings').once('value');
  const current = currentSnapshot.val() || {};
  const settings = normalizeGameTreasurySettings({ ...current, ...(body.settings || body), updatedAt: Date.now(), updatedBy: admin.email });
  await firebaseDb.ref('game_treasury/settings').set(settings);
  return { ok: true, settings };
}

async function adminAdjustGameTreasury(admin, body) {
  const gameId = safeText(body.gameId || 'wheel', 80).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const amount = numberValue(body.amount);
  const reason = safeText(body.reason, 500);
  if (!amount) { const error = new Error('GAME_TREASURY_ADJUSTMENT_REQUIRED'); error.statusCode = 400; throw error; }
  if (!reason) { const error = new Error('GAME_TREASURY_REASON_REQUIRED'); error.statusCode = 400; throw error; }
  const now = Date.now();
  return await exchangeRootMutation((root) => {
    const rawGame = root.game_center && root.game_center.games && root.game_center.games[gameId];
    if (RETIRED_GAME_IDS.has(gameId)) { const error = new Error('GAME_RETIRED'); error.statusCode = 410; throw error; }
    const game = normalizeCustomGameServer(gameId, rawGame || { id: gameId, name: gameId === 'wheel' ? 'عجلة الحظ الملكية' : gameId });
    const state = ensureGameTreasuryState(root, gameId, game.name);
    const before = numberValue(state.game.playerPool);
    const after = numberValue(before + amount);
    if (after < 0) { const error = new Error('GAME_TREASURY_NEGATIVE'); error.statusCode = 409; throw error; }
    state.game.playerPool = after;
    state.game.platformFunding = numberValue(Number(state.game.platformFunding || 0) + amount);
    state.game.updatedAt = now;
    state.aggregate.playerPool = numberValue(Number(state.aggregate.playerPool || 0) + amount);
    state.aggregate.platformFunding = numberValue(Number(state.aggregate.platformFunding || 0) + amount);
    state.aggregate.updatedAt = now;
    const logs = state.treasuryRoot.adjustments && typeof state.treasuryRoot.adjustments === 'object' ? state.treasuryRoot.adjustments : (state.treasuryRoot.adjustments = {});
    const id = `game_treasury_${now}_${crypto.randomBytes(5).toString('hex')}`;
    logs[id] = { id, gameId, gameName: game.name, amount, before, after, reason, createdAt: now, createdBy: admin.email };
    return { ok: true, id, gameId, before, after, amount };
  });
}

async function cleanupRetiredGameLiveNodes() {
  const updates = {};
  for (const gameId of RETIRED_GAME_IDS) {
    updates[`game_center/games/${gameId}`] = null;
    updates[`game_treasury/by_game/${gameId}`] = null;
  }
  await firebaseDb.ref().update(updates);
  console.log('RETIRED_GAME_LIVE_NODES_CLEANED');
}

try {
  initializeFirebase();
} catch (error) {
  console.error('FIREBASE_INIT_ERROR:', error.message);
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  try {
    const origin = req.headers.origin;

    if (origin && !isAllowedOrigin(origin)) {
      return sendJson(req, res, 403, {
        ok: false,
        error: 'ORIGIN_NOT_ALLOWED',
        message: 'هذا الرابط غير مسموح له بالاتصال بالسيرفر.'
      });
    }

    if (req.method === 'OPTIONS') {
      applySecurityHeaders(req, res);
      res.statusCode = 204;
      return res.end();
    }

    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`
    );

    if (req.method === 'GET' && url.pathname === '/') {
      return sendJson(req, res, 200, {
        ok: true,
        service: 'ADNOR API',
        version: API_VERSION,
        message: 'ADNOR secure server is running',
        firebase: 'initialized',
        database: 'initialized',
        authentication: 'ready',
        agentRecharge: 'ready',
        secureLottery: 'ready',
        secureWheel: 'ready',
        adnEnergy: 'template-ready',
        rewardedAds: ADN_ENERGY_ADS_LIVE ? 'awaiting-ssv' : 'not-connected',
        adminCommandCenter: 'ready',
        adnExchange: 'real-balance-ready',
        transactionFix: 'enabled',
        exchangeDatabaseWarmupFix: 'ready',
        exchangeAutomaticTreasuryLiquidity: 'ready',
        secureFinanceRequests: 'ready',
          manualDepositApprovalV228: 'ready',
          manualDepositRequestV228R2: 'ready',
          manualDepositMirrorSyncV233: 'ready',
          financeReceiptLazyLoadV233: 'ready',
          drawMigrationReadOptimizationV233: 'ready',
          telegramOnlyV228R3: 'ready',
        withdrawFinancialAccountResolverV223: 'ready',
        withdrawNullTransactionRepairV223: 'ready',
        withdrawalAdminFullDetailsV224: 'ready',
        withdrawalAdminIdempotentProcessingV225: 'ready',
        withdrawalStaleProcessingRecoveryV225: 'ready',
        secureReferrals: 'ready',
        referralFinancialAccountResolverV226: 'ready',
        referralAdminServerSettingsV226: 'ready',
        referralRewardFieldRepairV226: 'ready',
        referralNullTransactionRepairV227: 'ready',
        referralBothPartyBonusSyncV227: 'ready',
        referralIdempotentRetryV227: 'ready',
        unifiedAdminV204: 'ready',
        globalIdentityV206: 'ready',
        automaticUsdtTrc20Deposits: 'disabled',
        usdtTxidActualAmountV208: 'disabled',
        secureUserRewards: 'ready',
        securePromoRedemption: 'ready',
        secureCustomGames: 'ready',
        retiredGameCleanupV217: 'ready',
        wheelTreasuryAwareV217: 'ready',
        authoritativeDrawSchedulerV218: 'ready',
        privateScheduledResultsV218: 'ready',
        drawPublishFirstV222: 'ready',
        drawSettlementRetryV222: 'ready',
        drawFinancialOwnerRepairV222: 'ready',
        wheelScopedTransactionsV219: 'ready',
        financialAccountResolverV220: 'ready',
        legacyAccountLinkRepairV220: 'ready',
        resolvedExchangeIdentityV220: 'ready',
        wheelNullTransactionRepairV221: 'ready',
        wheelRootAccountFallbackV221: 'ready',
        exchangeWarmCacheV219: 'ready',
        fastMarketSnapshotsV219: 'ready',
        sharedGameTreasuryV212: 'ready',
        noDemoLabelsV213: 'ready',
        cors: 'enabled'
      });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      try {
        await Promise.all([
          firebaseAuth.listUsers(1),
          firebaseDb
            .ref('__adnor_server_health_check__')
            .limitToFirst(1)
            .once('value')
        ]);

        return sendJson(req, res, 200, {
          ok: true,
          service: 'ADNOR API',
          version: API_VERSION,
          status: 'healthy',
          firebase: 'connected',
          database: 'connected',
          authentication: 'ready',
          agentRecharge: 'ready',
          secureLottery: 'ready',
          secureWheel: 'ready',
          adnEnergy: 'template-ready',
          rewardedAds: ADN_ENERGY_ADS_LIVE ? 'awaiting-ssv' : 'not-connected',
          adminCommandCenter: 'ready',
          adnExchange: 'real-balance-ready',
          transactionFix: 'enabled',
          exchangeDatabaseWarmupFix: 'ready',
          exchangeAutomaticTreasuryLiquidity: 'ready',
          secureFinanceRequests: 'ready',
          manualDepositApprovalV228: 'ready',
          manualDepositRequestV228R2: 'ready',
          manualDepositMirrorSyncV233: 'ready',
          financeReceiptLazyLoadV233: 'ready',
          drawMigrationReadOptimizationV233: 'ready',
          telegramOnlyV228R3: 'ready',
        withdrawFinancialAccountResolverV223: 'ready',
        withdrawNullTransactionRepairV223: 'ready',
        withdrawalAdminFullDetailsV224: 'ready',
        withdrawalAdminIdempotentProcessingV225: 'ready',
        withdrawalStaleProcessingRecoveryV225: 'ready',
          secureReferrals: 'ready',
        referralFinancialAccountResolverV226: 'ready',
        referralAdminServerSettingsV226: 'ready',
        referralRewardFieldRepairV226: 'ready',
        referralNullTransactionRepairV227: 'ready',
        referralBothPartyBonusSyncV227: 'ready',
        referralIdempotentRetryV227: 'ready',
          unifiedAdminV204: 'ready',
          globalIdentityV206: 'ready',
          automaticUsdtTrc20Deposits: 'disabled',
          usdtTxidActualAmountV208: 'disabled',
          secureUserRewards: 'ready',
          securePromoRedemption: 'ready',
          secureCustomGames: 'ready',
          retiredGameCleanupV217: 'ready',
          wheelTreasuryAwareV217: 'ready',
        authoritativeDrawSchedulerV218: 'ready',
        privateScheduledResultsV218: 'ready',
        drawPublishFirstV222: 'ready',
        drawSettlementRetryV222: 'ready',
        drawFinancialOwnerRepairV222: 'ready',
        wheelScopedTransactionsV219: 'ready',
        financialAccountResolverV220: 'ready',
        legacyAccountLinkRepairV220: 'ready',
        resolvedExchangeIdentityV220: 'ready',
        wheelNullTransactionRepairV221: 'ready',
        wheelRootAccountFallbackV221: 'ready',
        exchangeWarmCacheV219: 'ready',
        fastMarketSnapshotsV219: 'ready',
          sharedGameTreasuryV212: 'ready',
          noDemoLabelsV213: 'ready',
          cors: 'enabled',
          time: new Date().toISOString()
        });
      } catch (error) {
        console.error(
          'FIREBASE_HEALTH_ERROR:',
          error.code || error.message
        );

        return sendJson(req, res, 503, {
          ok: false,
          service: 'ADNOR API',
          version: API_VERSION,
          status: 'unhealthy',
          firebase: 'connection-error',
          database: 'connection-error',
          error: 'Firebase connection failed',
          time: new Date().toISOString()
        });
      }
    }

    if (req.method === 'GET' && url.pathname === '/auth/me') {
      const decodedToken = await verifyUser(req);

      return sendJson(req, res, 200, {
        ok: true,
        authenticated: true,
        user: {
          uid: decodedToken.uid,
          email: decodedToken.email || null,
          phoneNumber: decodedToken.phone_number || null,
          emailVerified: decodedToken.email_verified === true,
          signInProvider:
            decodedToken.firebase?.sign_in_provider || null
        }
      });
    }


    if (req.method === 'GET' && url.pathname === '/auth/game-account') {
      const decodedToken = await verifyUser(req);
      const account = await resolveGameAccount(decodedToken, gameAccountHintsFromRequest(req, url, {}));
      return sendJson(req, res, 200, {
        ok: true,
        account: {
          authUid: account.authUid,
          financialUid: account.uid,
          linked: account.linked,
          realBalance: numberValue(account.profile && account.profile.realBalance),
          bonusBalance: numberValue(account.profile && account.profile.bonusBalance)
        }
      });
    }



    if (req.method === 'GET' && url.pathname === '/exchange/market') {
      const result = await exchangeMarketData(
        String(url.searchParams.get('interval') || '1m'),
        Number(url.searchParams.get('limit') || 160)
      );
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/exchange/account') {
      const decodedToken = await verifyUser(req);
      const account = await resolveGameAccount(decodedToken, gameAccountHintsFromRequest(req, url, {}));
      const result = await exchangeAccountData(decodedToken, account.uid);
      return sendJson(req, res, 200, { ...result, financialUid: account.uid, linkedAccount: account.linked });
    }

    if (req.method === 'POST' && url.pathname === '/exchange/terms/accept') {
      const decodedToken = await verifyUser(req);
      const body = await readJsonBody(req);
      const account = await resolveGameAccount(decodedToken, gameAccountHintsFromRequest(req, url, body));
      const result = await exchangeAcceptTerms(decodedToken, body, account.uid);
      invalidateExchangeCachesV219(account.uid);
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/exchange/order/place') {
      const decodedToken = await verifyUser(req);
      const body = await readJsonBody(req);
      const account = await resolveGameAccount(decodedToken, gameAccountHintsFromRequest(req, url, body));
      const result = await exchangePlaceOrder({ uid: account.uid, treasury: false }, body);
      invalidateExchangeCachesV219(account.uid);
      return sendJson(req, res, 200, { ...result, fastCacheV219: true, financialUid: account.uid });
    }

    if (req.method === 'POST' && url.pathname === '/exchange/order/cancel') {
      const decodedToken = await verifyUser(req);
      const body = await readJsonBody(req);
      const account = await resolveGameAccount(decodedToken, gameAccountHintsFromRequest(req, url, body));
      const result = await exchangeCancelOrder({ uid: account.uid, treasury: false }, body, false);
      invalidateExchangeCachesV219(account.uid);
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/admin/exchange') {
      const decodedToken = await verifyUser(req);
      await requireAdmin(decodedToken);
      const result = await adminExchangeOverview();
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/admin/exchange/settings') {
      const decodedToken = await verifyUser(req);
      const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      const result = await adminExchangeSaveSettings(admin, body);
      invalidateExchangeCachesV219();
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/admin/exchange/treasury/adjust') {
      const decodedToken = await verifyUser(req);
      const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      const result = await adminExchangeAdjustTreasury(admin, body);
      invalidateExchangeCachesV219();
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/admin/exchange/order/place') {
      const decodedToken = await verifyUser(req);
      await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      const result = await exchangePlaceOrder({ uid: EXCHANGE_TREASURY_UID, treasury: true }, body);
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/admin/exchange/order/cancel') {
      const decodedToken = await verifyUser(req);
      await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      const result = await exchangeCancelOrder({ uid: EXCHANGE_TREASURY_UID, treasury: true }, body, true);
      return sendJson(req, res, 200, result);
    }



    if (req.method === 'GET' && url.pathname === '/admin/overview') {
      const decodedToken = await verifyUser(req);
      await requireAdmin(decodedToken);
      const result = await adminOverview(url.searchParams.get('range') || 'today');
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/admin/users/search') {
      const decodedToken = await verifyUser(req);
      await requireAdmin(decodedToken);
      const result = await adminSearchUsers(url.searchParams.get('q') || '', url.searchParams.get('limit') || 80);
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/admin/user') {
      const decodedToken = await verifyUser(req);
      await requireAdmin(decodedToken);
      const result = await adminUserDetail(String(url.searchParams.get('uid') || ''));
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/admin/user/adjust-balance') {
      const decodedToken = await verifyUser(req);
      const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      const result = await adminAdjustUserBalance(admin, body);
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/admin/user/state') {
      const decodedToken = await verifyUser(req);
      const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      const result = await adminSetUserState(admin, body);
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/admin/notifications/send') {
      const decodedToken = await verifyUser(req);
      const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req, 64 * 1024);
      const result = await adminSendNotification(admin, body);
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/admin/system/controls') {
      const decodedToken = await verifyUser(req);
      const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      const result = await adminSaveSystemControls(admin, body);
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/admin/finance') {
      const decodedToken = await verifyUser(req);
      await requireAdmin(decodedToken);
      const result = await adminFinanceList();
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/admin/finance/deposit/receipt') {
      const decodedToken = await verifyUser(req);
      await requireAdmin(decodedToken);
      const { mimeType, image } = await adminDepositReceipt(String(url.searchParams.get('id') || ''));
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': image.length,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(image);
    }

    if (req.method === 'POST' && url.pathname === '/admin/finance/deposit') {
      const decodedToken = await verifyUser(req);
      const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      const result = await adminProcessDeposit(admin, body);
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/admin/finance/withdrawal') {
      const decodedToken = await verifyUser(req);
      const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      const result = await adminProcessWithdrawal(admin, body);
      return sendJson(req, res, 200, result);
    }


    if (req.method === 'POST' && url.pathname.startsWith('/finance/usdt/deposit/')) {
      const error = new Error('AUTOMATIC_DEPOSITS_DISABLED'); error.statusCode = 410; throw error;
    }

    if (req.method === 'GET' && url.pathname === '/finance/usdt/deposit/status') {
      const error = new Error('AUTOMATIC_DEPOSITS_DISABLED'); error.statusCode = 410; throw error;
    }

    if (req.method === 'POST' && url.pathname === '/finance/deposit/request') {
      const decodedToken = await verifyUser(req);
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      const result = await createDepositRequest(decodedToken, body);
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/finance/withdrawal/request') {
      const decodedToken = await verifyUser(req);
      const body = await readJsonBody(req, 64 * 1024);
      const result = await createWithdrawalRequest(decodedToken, body, gameAccountHintsFromRequest(req, url, body));
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/referral/status') {
      const decodedToken = await verifyUser(req);
      const result = await referralStatus(decodedToken, gameAccountHintsFromRequest(req, url));
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/referral/apply') {
      const decodedToken = await verifyUser(req);
      const body = await readJsonBody(req);
      const result = await applyReferralServer(decodedToken, body);
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/admin/referrals') {
      const decodedToken = await verifyUser(req); await requireAdmin(decodedToken);
      return sendJson(req, res, 200, await adminReferralBundle());
    }

    if (req.method === 'POST' && url.pathname === '/admin/referrals/settings') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      return sendJson(req, res, 200, await adminSaveReferralSettings(admin, body));
    }

    if (req.method === 'GET' && url.pathname === '/admin/payment-methods') {
      const decodedToken = await verifyUser(req); await requireAdmin(decodedToken);
      return sendJson(req, res, 200, await adminPaymentMethodsList());
    }

    if (req.method === 'POST' && url.pathname === '/admin/payment-methods/save') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      return sendJson(req, res, 200, await adminSavePaymentMethod(admin, body));
    }

    if (req.method === 'GET' && url.pathname === '/admin/support/tickets') {
      const decodedToken = await verifyUser(req); await requireAdmin(decodedToken);
      return sendJson(req, res, 200, await adminSupportList());
    }

    if (req.method === 'POST' && url.pathname === '/admin/support/reply') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req, 16 * 1024);
      return sendJson(req, res, 200, await adminReplySupport(admin, body));
    }

    if (req.method === 'GET' && url.pathname === '/admin/agents') {
      const decodedToken = await verifyUser(req); await requireAdmin(decodedToken);
      return sendJson(req, res, 200, await adminAgentsList());
    }

    if (req.method === 'POST' && url.pathname === '/admin/agents/save') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      return sendJson(req, res, 200, await adminSaveAgent(admin, body));
    }

    if (req.method === 'POST' && url.pathname === '/admin/agents/adjust') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      return sendJson(req, res, 200, await adminAdjustAgentBalance(admin, body));
    }

    if (req.method === 'GET' && url.pathname === '/lottery/results') {
      return sendJson(req, res, 200, await publicLotteryResults());
    }

    if (req.method === 'GET' && url.pathname === '/admin/lottery/results') {
      const decodedToken = await verifyUser(req); await requireAdmin(decodedToken);
      return sendJson(req, res, 200, await adminLotteryResultsState());
    }

    if (req.method === 'POST' && url.pathname === '/admin/lottery/settings') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      return sendJson(req, res, 200, await adminSaveLotterySettings(admin, body));
    }

    if (req.method === 'POST' && url.pathname === '/admin/lottery/result') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      return sendJson(req, res, 200, await adminSaveLotteryResult(admin, body));
    }

    if (req.method === 'POST' && url.pathname === '/admin/games/settings') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      return sendJson(req, res, 200, await adminSaveWheelSettings(admin, body));
    }

    if (req.method === 'POST' && url.pathname === '/admin/games/wheel-control') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req, 96 * 1024);
      return sendJson(req, res, 200, await adminSaveWheelControl(admin, body));
    }

    if (req.method === 'GET' && url.pathname === '/admin/public-settings') {
      const decodedToken = await verifyUser(req); await requireAdmin(decodedToken);
      return sendJson(req, res, 200, await adminPublicSettings());
    }

    if (req.method === 'POST' && url.pathname === '/admin/public-settings') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req, 64 * 1024);
      return sendJson(req, res, 200, await adminSavePublicSettings(admin, body));
    }

    if (req.method === 'POST' && url.pathname === '/admin/support/settings') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      return sendJson(req, res, 200, await adminSaveSupportSettings(admin, body));
    }

    if (req.method === 'POST' && url.pathname === '/admin/energy/settings') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req);
      return sendJson(req, res, 200, await adminSaveEnergySettings(admin, body));
    }


    if (req.method === 'GET' && url.pathname === '/admin/operations') {
      const decodedToken = await verifyUser(req); await requireAdmin(decodedToken);
      return sendJson(req, res, 200, await adminOperationsBundle());
    }

    if (req.method === 'POST' && url.pathname === '/admin/vip/settings') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req, 64 * 1024);
      return sendJson(req, res, 200, await adminSaveVipV204(admin, body));
    }

    if (req.method === 'POST' && url.pathname === '/admin/daily-login/settings') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req, 64 * 1024);
      return sendJson(req, res, 200, await adminSaveDailyLoginV204(admin, body));
    }

    if (req.method === 'POST' && url.pathname === '/admin/promo-code/save') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req, 64 * 1024);
      return sendJson(req, res, 200, await adminSavePromoV204(admin, body));
    }

    if (req.method === 'POST' && url.pathname === '/admin/ai/knowledge') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req, 128 * 1024);
      return sendJson(req, res, 200, await adminSaveAiKnowledgeV204(admin, body));
    }

    if (req.method === 'POST' && url.pathname === '/admin/backups/create') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      return sendJson(req, res, 200, await adminCreateBackupV204(admin));
    }

    if (req.method === 'GET' && url.pathname === '/admin/audit') {
      const decodedToken = await verifyUser(req); await requireAdmin(decodedToken);
      return sendJson(req, res, 200, await adminAuditList(url.searchParams.get('limit') || 300));
    }


    if (req.method === 'POST' && url.pathname === '/rewards/lucky-box/open') {
      const decodedToken = await verifyUser(req); const body = await readJsonBody(req);
      return sendJson(req, res, 200, await openLuckyBoxServer(decodedToken, body));
    }

    if (req.method === 'POST' && url.pathname === '/rewards/daily-login/claim') {
      const decodedToken = await verifyUser(req); const body = await readJsonBody(req);
      return sendJson(req, res, 200, await claimDailyLoginServer(decodedToken, body));
    }

    if (req.method === 'POST' && url.pathname === '/rewards/vip/task') {
      const decodedToken = await verifyUser(req); const body = await readJsonBody(req);
      return sendJson(req, res, 200, await claimVipTaskServer(decodedToken, body));
    }

    if (req.method === 'POST' && url.pathname === '/rewards/vip/box') {
      const decodedToken = await verifyUser(req); const body = await readJsonBody(req);
      return sendJson(req, res, 200, await openVipBoxServer(decodedToken, body));
    }

    if (req.method === 'POST' && url.pathname === '/promo/redeem') {
      const decodedToken = await verifyUser(req); const body = await readJsonBody(req);
      return sendJson(req, res, 200, await redeemPromoServer(decodedToken, body));
    }


    if (req.method === 'POST' && url.pathname === '/game/custom/play') {
      const decodedToken = await verifyUser(req); const body = await readJsonBody(req);
      return sendJson(req, res, 200, await playCustomGameServer(decodedToken, body));
    }

    if (req.method === 'POST' && url.pathname === '/referral/claim-pending') {
      const decodedToken = await verifyUser(req); const body = await readJsonBody(req);
      return sendJson(req, res, 200, await claimLegacyReferralServer(decodedToken, body));
    }

    if (req.method === 'GET' && url.pathname === '/admin/custom-games') {
      const decodedToken = await verifyUser(req); await requireAdmin(decodedToken);
      return sendJson(req, res, 200, await adminCustomGamesBundle());
    }

    if (req.method === 'POST' && url.pathname === '/admin/custom-games/save') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req, 64 * 1024);
      return sendJson(req, res, 200, await adminSaveCustomGame(admin, body));
    }

    if (req.method === 'POST' && url.pathname === '/admin/game-treasury/settings') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req, 64 * 1024);
      return sendJson(req, res, 200, await adminSaveGameTreasurySettings(admin, body));
    }

    if (req.method === 'POST' && url.pathname === '/admin/game-treasury/adjust') {
      const decodedToken = await verifyUser(req); const admin = await requireAdmin(decodedToken);
      const body = await readJsonBody(req, 64 * 1024);
      return sendJson(req, res, 200, await adminAdjustGameTreasury(admin, body));
    }

    if (req.method === 'GET' && url.pathname === '/energy/status') {
      const decodedToken = await verifyUser(req);
      const result = await getEnergyStatus(decodedToken);
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/energy/session/start') {
      const decodedToken = await verifyUser(req);
      await readJsonBody(req);
      await blockedEnergyAction(decodedToken);
    }

    if (req.method === 'POST' && url.pathname === '/energy/session/boost') {
      const decodedToken = await verifyUser(req);
      await readJsonBody(req);
      await blockedEnergyAction(decodedToken);
    }

    if (req.method === 'POST' && url.pathname === '/lottery/ticket/purchase') {
      const decodedToken = await verifyUser(req);
      const body = await readJsonBody(req);
      const result = await secureTicketPurchase(decodedToken, body);
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/game/wheel/spin') {
      const decodedToken = await verifyUser(req);
      const body = await readJsonBody(req);
      const result = await secureWheelSpin(decodedToken, body);
      return sendJson(req, res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/agent/dashboard') {
      const decodedToken = await verifyUser(req);
      const result = await agentDashboard(decodedToken);

      return sendJson(req, res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/agent/find-user') {
      const decodedToken = await verifyUser(req);
      const agentAccount = await requireAgent(decodedToken);
      const body = await readJsonBody(req);
      const found = await findUserByTargetId(body.targetId);

      validateTargetUser(agentAccount.uid, found.uid, found.user);

      return sendJson(req, res, 200, {
        ok: true,
        user: publicUser(found.uid, found.user)
      });
    }

    if (req.method === 'POST' && url.pathname === '/agent/recharge') {
      const decodedToken = await verifyUser(req);
      const body = await readJsonBody(req);
      const result = await handleAgentRecharge(decodedToken, body);

      return sendJson(req, res, 200, result);
    }

    return sendJson(req, res, 404, {
      ok: false,
      error: 'ROUTE_NOT_FOUND',
      message: 'المسار غير موجود.'
    });
  } catch (error) {
    const response = errorResponse(error);

    if (response.statusCode >= 500) {
      console.error(
        'REQUEST_ERROR:',
        error.code || error.message,
        error.cause && (error.cause.code || error.cause.message)
      );
    }

    return sendJson(req, res, response.statusCode, response.payload);
  }
});

server.on('error', (error) => {
  console.error('SERVER_ERROR:', error.message);
  process.exit(1);
});

setTimeout(() => cleanupRetiredGameLiveNodes().catch((error) => console.error('RETIRED_GAME_CLEANUP_ERROR', error.message)), 3000);
setTimeout(() => getWheelRuntimeConfigV219(true).catch((error) => console.error('WHEEL_CACHE_WARM_ERROR', error.message)), 1200);
setTimeout(() => getExchangeWarmRootV219(true).catch((error) => console.error('EXCHANGE_CACHE_WARM_ERROR', error.message)), 1800);

setTimeout(() => syncPendingAutomaticUsdtDeposits().catch((error) => console.error('AUTO_USDT_SCHEDULER_START_ERROR', error.message)), 15000);
const automaticUsdtScheduler = setInterval(() => syncPendingAutomaticUsdtDeposits().catch((error) => console.error('AUTO_USDT_SCHEDULER_ERROR', error.message)), 60000);
if (typeof automaticUsdtScheduler.unref === 'function') automaticUsdtScheduler.unref();

setTimeout(() => publishDueDrawResults().catch((error) => console.error('DRAW_SCHEDULER_START_ERROR', error.message)), 5000);
const drawScheduler = setInterval(() => publishDueDrawResults().catch((error) => console.error('DRAW_SCHEDULER_ERROR', error.message)), 15000);
if (typeof drawScheduler.unref === 'function') drawScheduler.unref();

server.listen(PORT, HOST, () => {
  console.log(`ADNOR API ${API_VERSION} running on http://${HOST}:${PORT}`);
  console.log(
    `ALLOWED_ORIGINS: ${Array.from(allowedOrigins).join(', ')}`
  );
});
