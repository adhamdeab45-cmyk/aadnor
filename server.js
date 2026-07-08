'use strict';

/*
  ADNOR 24H SERVER V8 ADNOR-VP
  - Express serves the website from /public
  - Firebase Admin runs trusted 24/7 jobs
  - Manual draw numbers are saved in Firebase by admin panel, then server publishes at schedule
*/

require('dotenv').config();
process.env.TZ = process.env.DRAW_TIMEZONE || 'Europe/Istanbul';

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cron = require('node-cron');

const PORT = Number(process.env.PORT || 3000);
const TIMEZONE = process.env.DRAW_TIMEZONE || 'Europe/Istanbul';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'CHANGE_ME_ADMIN_TOKEN';
const FIREBASE_DATABASE_URL = (process.env.FIREBASE_DATABASE_URL || 'https://adnor-vp-default-rtdb.firebaseio.com').replace(/\/$/, '');

const LEVELS = ['daily', 'weekly', 'monthly', 'yearly'];
const LABEL = { daily: 'اليومي', weekly: 'الأسبوعي', monthly: 'الشهري', yearly: 'السنوي' };
const NEXT = { daily: 'weekly', weekly: 'monthly', monthly: 'yearly', yearly: null };

/*
  ADMIN SDK READY MODE
  الأفضل تشغيل السيرفر بمفتاح خدمة Firebase Admin داخل Render باسم FIREBASE_SERVICE_ACCOUNT_JSON.
  إذا لم يوجد المفتاح، يعمل السيرفر بوضع REST محدود وقد ترفض قواعد Firebase عمليات الكتابة.
  لا تفتح قواعد قاعدة البيانات للعموم؛ استخدم Admin SDK للإنتاج.
*/

class Snap {
  constructor(value) { this._value = value; }
  val() { return this._value; }
  exists() { return this._value !== null && this._value !== undefined; }
}

function joinPath(base, child) {
  const a = String(base || '').replace(/^\/+|\/+$/g, '');
  const b = String(child || '').replace(/^\/+|\/+$/g, '');
  return [a, b].filter(Boolean).join('/');
}

function encodeDbPath(p) {
  const clean = String(p || '').replace(/^\/+|\/+$/g, '');
  if (!clean) return '';
  return clean.split('/').map(encodeURIComponent).join('/');
}

class RestRef {
  constructor(db, p = '', query = '') { this.db = db; this.p = String(p || '').replace(/^\/+|\/+$/g, ''); this.query = query || ''; }
  child(c) { return new RestRef(this.db, joinPath(this.p, c)); }
  limitToLast(n) { return new RestRef(this.db, this.p, 'orderBy="$key"&limitToLast=' + Number(n || 1)); }
  _url(extraQuery = '') {
    const pathPart = encodeDbPath(this.p);
    const q = [this.query, extraQuery].filter(Boolean).join('&');
    return this.db.base + '/' + pathPart + '.json' + (q ? '?' + q : '');
  }
  async _request(method, body, headers = {}, extraQuery = '') {
    const opts = { method, headers: { ...headers } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(this._url(extraQuery), opts);
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (_) { data = text; } }
    if (!res.ok) {
      const msg = data && data.error ? data.error : (typeof data === 'string' ? data : res.statusText);
      throw new Error('Firebase REST ' + res.status + ': ' + msg);
    }
    return { data, res };
  }
  async once(_event) { const { data } = await this._request('GET'); return new Snap(data); }
  async set(v) { await this._request('PUT', v); return v; }
  async update(v) { await this._request('PATCH', v || {}); return v; }
  async remove() { await this._request('DELETE'); }
  async push(v) {
    const key = 'srv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    const r = this.child(key);
    if (v !== undefined) await r.set(v);
    return r;
  }
  async transaction(updater) {
    const first = await this._request('GET', undefined, { 'X-Firebase-ETag': 'true' });
    const etag = first.res.headers.get('etag') || '*';
    const next = updater(first.data);
    if (next === undefined) return { committed: false, snapshot: new Snap(first.data) };
    try {
      const out = await this._request('PUT', next, { 'if-match': etag });
      return { committed: true, snapshot: new Snap(out.data) };
    } catch (e) {
      if (/412/.test(e.message)) return { committed: false, snapshot: new Snap(first.data) };
      throw e;
    }
  }
}

class RestDB {
  constructor(base) { this.base = base.replace(/\/$/, ''); }
  ref(p = '') { return new RestRef(this, p); }
}

function parseServiceAccount(raw) {
  if (!raw) return null;
  let txt = String(raw).trim();
  try {
    if (txt.startsWith('{')) return JSON.parse(txt);
    // Render sometimes stores JSON as base64 to avoid escaping problems.
    const decoded = Buffer.from(txt, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (e) {
    console.error('[Firebase Admin] Invalid FIREBASE_SERVICE_ACCOUNT_JSON:', e.message);
    return null;
  }
}

function makeDatabase() {
  const serviceAccount = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (serviceAccount) {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: FIREBASE_DATABASE_URL,
      });
    }
    console.log('[Firebase Admin] Connected with service account. Secure rules can stay enabled.');
    return admin.database();
  }
  console.warn('[Firebase Admin] FIREBASE_SERVICE_ACCOUNT_JSON is missing. Using limited REST mode; strict Firebase rules may deny server writes.');
  return new RestDB(FIREBASE_DATABASE_URL);
}

const db = makeDatabase();

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function arr(v) { return Array.isArray(v) ? v : []; }
function pad7(v) {
  const digits = String(v || '').replace(/\D/g, '').slice(0, 7);
  return digits ? digits.padStart(7, '0') : '';
}
function money(v) { return Number(n(v).toFixed(2)); }
function nowStr() { return new Date().toLocaleString('ar-EG', { timeZone: TIMEZONE }); }
function uidSafe(uid) { return String(uid || '').replace(/[.#$\[\]/]/g, '_'); }

function defaultSettings() {
  return {
    drawHour: 20,
    server24h: {
      enabled: true,
      timezone: TIMEZONE,
      lastHeartbeat: 0,
      lastJob: '',
      note: 'ADNOR 24H server is responsible for scheduled draws and counters.',
    },
    legal: {
      enabled: true,
      title: 'تأكيد العمر وشروط ADNOR',
      text: 'هذه المنصة مخصصة للمستخدمين فوق 18 عاماً. باستخدامك للموقع أنت توافق على الشروط وسياسة الاستخدام وتتحمل مسؤولية عملياتك داخل المنصة.',
    },
    referral: { referrerBonus: 2, newUserBonus: 1, type: 'bonus' },
    scratch: { enabled: true, min: 0.10, max: 1, chance: 35, cooldownHours: 24 },
    contacts: [
      { name: 'WhatsApp', value: 'https://wa.me/905000000000', type: 'whatsapp' },
      { name: 'Telegram', value: 'https://t.me/adnor_support', type: 'telegram' },
    ],
    payment: {
      deposit: [
        { id: 'usdt', name: 'USDT TRC20', details: 'ضع عنوان محفظة USDT من الأدمن' },
        { id: 'shamcash', name: 'Sham Cash', details: 'ضع رقم شام كاش من الأدمن' },
      ],
      withdraw: [
        { id: 'usdt', name: 'USDT TRC20', details: 'سحب USDT TRC20' },
        { id: 'shamcash', name: 'Sham Cash', details: 'سحب شام كاش' },
      ],
      banks: [],
    },
    draws: {
      daily: { base: 50, targetMin: 4000, targetMax: 5200, carry: 0, participants: 0, manualNumber: '', releaseAt: 0, lastResult: '0000000', lastStatus: 'انتظار', lastAt: 0 },
      weekly: { base: 3500, targetMin: 12000, targetMax: 25000, carry: 0, participants: 3500, manualNumber: '', releaseAt: 0, lastResult: '0000000', lastStatus: 'انتظار', lastAt: 0 },
      monthly: { base: 15000, targetMin: 45000, targetMax: 150000, carry: 0, participants: 15000, manualNumber: '', releaseAt: 0, lastResult: '0000000', lastStatus: 'انتظار', lastAt: 0 },
      yearly: { base: 100000, targetMin: 250000, targetMax: 1000000, carry: 0, participants: 100000, manualNumber: '', releaseAt: 0, lastResult: '0000000', lastStatus: 'انتظار', lastAt: 0 },
    },
    games: [
      { id: 'wheel', name: 'عجلة الحظ الملكية', icon: '🎡', enabled: true },
      { id: 'scratch', name: 'اكتشف واربح', icon: '🎁', enabled: true },
    ],
    wheel: { slices: [
      { label: '0x', mult: 0, weight: 18, color: '#0b2444' },
      { label: '1x', mult: 1, weight: 22, color: '#1b4332' },
      { label: '2x', mult: 2, weight: 12, color: '#9c6500' },
      { label: '0x', mult: 0, weight: 18, color: '#240b36' },
      { label: '100x', mult: 100, weight: 1, color: '#7f1d1d' },
      { label: '1x', mult: 1, weight: 22, color: '#1b4332' },
      { label: '10000x', mult: 10000, weight: 0.1, color: '#111827' },
      { label: '2x', mult: 2, weight: 10, color: '#9c6500' },
      { label: '0.5x', mult: 0.5, weight: 14, color: '#0f172a' },
      { label: '5x', mult: 5, weight: 6, color: '#854d0e' },
      { label: 'خسارة', mult: 0, weight: 18, color: '#3f0d12' },
      { label: '10x', mult: 10, weight: 3, color: '#065f46' },
    ] },
    injectCodes: [],
  };
}

function deepMerge(incoming, fallback) {
  if (!incoming || typeof incoming !== 'object') return fallback;
  const out = Array.isArray(fallback) ? [...fallback] : { ...fallback };
  for (const [k, v] of Object.entries(incoming)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && fallback && typeof fallback[k] === 'object' && !Array.isArray(fallback[k])) {
      out[k] = deepMerge(v, fallback[k]);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function getSettings() {
  const snap = await db.ref('global_system/settings').once('value');
  const settings = deepMerge(snap.val() || {}, defaultSettings());
  if (!snap.exists()) await db.ref('global_system/settings').set(settings);
  return settings;
}

async function saveDraws(draws) {
  await db.ref('global_system/settings/draws').set(draws);
}

function startOf(level, settings, now = new Date()) {
  const h = Number(settings.drawHour || 20);
  const d = new Date(now);
  let s = new Date(d);
  if (level === 'daily') {
    s.setHours(h, 0, 0, 0);
    if (d < s) s.setDate(s.getDate() - 1);
  } else if (level === 'weekly') {
    const diff = (d.getDay() + 6) % 7;
    s.setDate(d.getDate() - diff);
    s.setHours(h, 0, 0, 0);
    if (d < s) s.setDate(s.getDate() - 7);
  } else if (level === 'monthly') {
    s = new Date(d.getFullYear(), d.getMonth(), 1, h, 0, 0, 0);
    if (d < s) s = new Date(d.getFullYear(), d.getMonth() - 1, 1, h, 0, 0, 0);
  } else {
    s = new Date(d.getFullYear(), 0, 1, h, 0, 0, 0);
    if (d < s) s = new Date(d.getFullYear() - 1, 0, 1, h, 0, 0, 0);
  }
  return s.getTime();
}

function endOf(level, settings, now = new Date()) {
  const d = new Date(startOf(level, settings, now));
  if (level === 'daily') d.setDate(d.getDate() + 1);
  else if (level === 'weekly') d.setDate(d.getDate() + 7);
  else if (level === 'monthly') d.setMonth(d.getMonth() + 1);
  else d.setFullYear(d.getFullYear() + 1);
  return d.getTime();
}

function periodKey(level, settings, now = new Date()) {
  const d = new Date(startOf(level, settings, now));
  return `${level}_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}_${String(d.getDate()).padStart(2, '0')}`;
}

function progress(level, settings) {
  const now = Date.now();
  const st = startOf(level, settings);
  const en = endOf(level, settings);
  return Math.max(0, Math.min(1, (now - st) / (en - st)));
}
function eased(p) { return 1 - Math.pow(1 - p, 2.15); }

function currentPrize(level, settings) {
  const d = settings.draws[level] || {};
  const base = n(d.base);
  const target = n(d.targetMax || d.targetMin || base);
  const grow = base + ((target - base) * eased(progress(level, settings)));
  return money(grow + n(d.carry));
}

async function ticketsFor(level, settings) {
  const pk = periodKey(level, settings);
  const snap = await db.ref(`tickets/${level}/${pk}`).once('value');
  return { key: pk, tickets: snap.val() || {} };
}

async function countTickets(level, settings) {
  const { tickets } = await ticketsFor(level, settings);
  return Object.keys(tickets).length;
}

async function moveTickets(fromLevel, toLevel, settings, exceptNumber = '') {
  const fromPk = periodKey(fromLevel, settings);
  const toPk = periodKey(toLevel, settings);
  const snap = await db.ref(`tickets/${fromLevel}/${fromPk}`).once('value');
  const tickets = snap.val() || {};
  const updates = {};
  let moved = 0;
  for (const [numKey, t] of Object.entries(tickets)) {
    if (exceptNumber && pad7(t.number || numKey) === exceptNumber) continue;
    const newTicket = { ...t, number: pad7(t.number || numKey), level: toLevel, periodKey: toPk, movedFrom: fromLevel, movedAt: Date.now() };
    updates[`tickets/${toLevel}/${toPk}/${newTicket.number}`] = newTicket;
    updates[`tickets/${fromLevel}/${fromPk}/${numKey}`] = null;
    moved++;
  }
  if (moved) await db.ref().update(updates);
  return moved;
}

async function updateUserTicketsAfterMove(fromLevel, toLevel, settings, exceptNumber = '') {
  const usersSnap = await db.ref('users').once('value');
  const users = usersSnap.val() || {};
  const fromPk = periodKey(fromLevel, settings);
  const toPk = toLevel ? periodKey(toLevel, settings) : '';
  const updates = {};
  for (const [uid, user] of Object.entries(users)) {
    const tickets = arr(user.tickets);
    let changed = false;
    const nextTickets = [];
    for (const t of tickets) {
      const sameLevel = t.level === fromLevel;
      const samePeriod = !t.periodKey || t.periodKey === fromPk;
      const isWinningTicket = exceptNumber && pad7(t.number) === exceptNumber;
      if (sameLevel && samePeriod) {
        changed = true;
        if (toLevel && !isWinningTicket) nextTickets.push({ ...t, level: toLevel, periodKey: toPk, movedFrom: fromLevel, movedAt: Date.now() });
      } else {
        nextTickets.push(t);
      }
    }
    if (changed) updates[`users/${uidSafe(uid)}/tickets`] = nextTickets;
  }
  if (Object.keys(updates).length) await db.ref().update(updates);
}

async function creditWinners(winners, amount, level, number) {
  if (!winners.length) return { winnersCount: 0, share: 0 };
  const share = money(amount / winners.length);
  const updates = {};
  for (const w of winners) {
    const uid = uidSafe(w.uid);
    if (!uid) continue;
    const us = await db.ref(`users/${uid}`).once('value');
    const u = us.val() || {};
    const txs = arr(u.txs);
    const tickets = arr(u.tickets).filter(t => !(t.level === level && pad7(t.number) === number));
    txs.unshift({ type: `🏆 ربح سحب ${LABEL[level]}`, amt: share, status: '✅', ticket: number, level, time: nowStr(), at: Date.now() });
    updates[`users/${uid}/balance`] = money(n(u.balance) + share);
    updates[`users/${uid}/txs`] = txs.slice(0, 300);
    updates[`users/${uid}/tickets`] = tickets;
  }
  if (Object.keys(updates).length) await db.ref().update(updates);
  return { winnersCount: winners.length, share };
}

async function clearAllTicketsAndUserCards() {
  const updates = {};
  for (const level of LEVELS) updates[`tickets/${level}`] = null;
  const usersSnap = await db.ref('users').once('value');
  const users = usersSnap.val() || {};
  for (const uid of Object.keys(users)) updates[`users/${uidSafe(uid)}/tickets`] = [];
  await db.ref().update(updates);
}

async function processDraw(level, options = {}) {
  if (!LEVELS.includes(level)) throw new Error('Invalid draw level');
  const settings = await getSettings();
  const draws = settings.draws;
  const d = draws[level];
  const pk = periodKey(level, settings);
  const force = !!options.force;
  const manualNumber = pad7(options.manualNumber || d.manualNumber || '');

  if (!manualNumber) {
    await db.ref('server_logs').push({ type: 'draw-skip', level, reason: 'no-manual-number', periodKey: pk, at: Date.now(), time: nowStr() });
    return { ok: false, skipped: true, reason: 'لا يوجد رقم فائز محفوظ من الأدمن', level, periodKey: pk };
  }

  if (!force && d.executedKey === pk) {
    return { ok: true, skipped: true, reason: 'هذا السحب منفذ سابقاً', level, periodKey: pk };
  }

  const { tickets } = await ticketsFor(level, settings);
  const entries = Object.entries(tickets);
  const winners = entries.map(([number, ticket]) => ({ number: pad7(ticket.number || number), ...ticket })).filter(t => pad7(t.number) === manualNumber);
  const amount = currentPrize(level, settings);
  const next = NEXT[level];
  const result = {
    level,
    label: LABEL[level],
    periodKey: pk,
    manualNumber,
    amount,
    ticketCount: entries.length,
    winnersCount: winners.length,
    movedCount: 0,
    at: Date.now(),
    time: nowStr(),
  };

  d.lastResult = manualNumber;
  d.lastAt = Date.now();
  d.executedKey = pk;
  d.releaseAt = 0;
  d.manualNumber = '';

  if (winners.length) {
    const paid = await creditWinners(winners, amount, level, manualNumber);
    result.share = paid.share;
    if (next) {
      result.movedCount = await moveTickets(level, next, settings, manualNumber);
      await updateUserTicketsAfterMove(level, next, settings, manualNumber);
    } else {
      await clearAllTicketsAndUserCards();
      result.movedCount = 0;
    }
    d.carry = 0;
    d.lastStatus = `فائزين: ${winners.length}`;
  } else if (next) {
    draws[next].carry = money(n(draws[next].carry) + amount);
    result.movedCount = await moveTickets(level, next, settings);
    await updateUserTicketsAfterMove(level, next, settings);
    d.carry = 0;
    d.lastStatus = `لا يوجد فائز، انتقلت الجائزة إلى ${LABEL[next]}`;
  } else {
    await clearAllTicketsAndUserCards();
    for (const x of LEVELS) {
      draws[x].carry = 0;
      draws[x].participants = x === 'daily' ? 0 : n(draws[x].base);
      draws[x].manualNumber = '';
      draws[x].releaseAt = 0;
    }
    d.lastStatus = 'انتهى السحب السنوي، بدأ النظام من جديد';
  }

  if (level === 'daily') d.participants = 0;
  await saveDraws(draws);
  await db.ref(`draw_results/${level}/${pk}`).set(result);
  await db.ref('draw_history').push(result);
  await db.ref('server_logs').push({ type: 'draw-executed', ...result });
  await syncCounters();
  return { ok: true, result };
}

async function syncCounters() {
  const settings = await getSettings();
  const draws = settings.draws;
  const updates = {};
  for (const level of LEVELS) {
    const count = await countTickets(level, settings);
    const d = draws[level] || {};
    let extra;
    if (level === 'daily') extra = Math.ceil(count * 0.35) + Math.floor(progress(level, settings) * 5000);
    else if (level === 'weekly') extra = Math.ceil(count * 0.25) + 3500;
    else if (level === 'monthly') extra = Math.ceil(count * 0.20) + 15000;
    else extra = Math.ceil(count * 0.15) + 100000;
    const nextParticipants = Math.max(n(d.participants), count + extra, count);
    updates[`global_system/settings/draws/${level}/participants`] = nextParticipants;
    updates[`global_system/settings/draws/${level}/serverTicketCount`] = count;
    updates[`global_system/settings/draws/${level}/serverPrize`] = currentPrize(level, settings);
  }
  updates['global_system/settings/server24h/lastHeartbeat'] = Date.now();
  updates['global_system/settings/server24h/timezone'] = TIMEZONE;
  await db.ref().update(updates);
  return updates;
}

async function reserveTicket(uid, level, number, price = 1) {
  const settings = await getSettings();
  if (!LEVELS.includes(level)) level = 'daily';
  number = pad7(number);
  if (!uid || !number) throw new Error('uid and 7-digit ticket number are required');
  const pk = periodKey(level, settings);
  const ticketRef = db.ref(`tickets/${level}/${pk}/${number}`);
  const tx = await ticketRef.transaction(current => {
    if (current) return;
    return { uid, number, level, periodKey: pk, price: n(price), createdAt: Date.now(), time: nowStr(), source: 'server' };
  });
  if (!tx.committed) throw new Error('هذا الرقم محجوز سابقاً');
  const userRef = db.ref(`users/${uidSafe(uid)}`);
  const us = await userRef.once('value');
  const u = us.val() || {};
  let balance = n(u.balance);
  let bonus = n(u.bonus);
  const cost = n(price || 1);
  if (balance + bonus < cost) {
    await ticketRef.remove();
    throw new Error('الرصيد غير كافٍ');
  }
  if (balance >= cost) balance = money(balance - cost);
  else { const rest = money(cost - balance); balance = 0; bonus = money(bonus - rest); }
  const tickets = arr(u.tickets);
  const txs = arr(u.txs);
  tickets.unshift({ number, level, periodKey: pk, price: cost, createdAt: Date.now() });
  txs.unshift({ type: `🎫 شراء تذكرة ${LABEL[level]}`, amt: -cost, status: '✅', ticket: number, time: nowStr(), at: Date.now() });
  await userRef.update({ balance, bonus, tickets: tickets.slice(0, 1000), txs: txs.slice(0, 300) });
  await syncCounters();
  return { ok: true, uid, level, number, periodKey: pk };
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token || req.body?.token;
  if (!ADMIN_TOKEN || ADMIN_TOKEN === 'CHANGE_ME_ADMIN_TOKEN') {
    return res.status(500).json({ ok: false, error: 'ADMIN_TOKEN is not configured on the server.' });
  }
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: 'Unauthorized admin token.' });
  next();
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, frameguard: false }));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));


// Firebase Auth redirect helper proxy for non-Firebase hosting (Replit/custom domain).
// This makes Google signInWithRedirect work more reliably on mobile browsers.
app.all('/__/auth/*', async (req, res) => {
  try {
    const target = 'https://adnor-vp.firebaseapp.com' + req.originalUrl;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    const opts = { method: req.method, headers };
    if (!['GET', 'HEAD'].includes(req.method) && req.body && Object.keys(req.body).length) {
      opts.body = JSON.stringify(req.body);
      opts.headers['content-type'] = 'application/json';
    }
    const upstream = await fetch(target, opts);
    const buf = Buffer.from(await upstream.arrayBuffer());
    const passHeaders = ['content-type', 'cache-control', 'expires', 'pragma', 'location'];
    for (const h of passHeaders) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.status(upstream.status).send(buf);
  } catch (e) {
    res.status(502).send('Firebase auth helper proxy failed: ' + e.message);
  }
});

app.get('/api/health', async (_req, res) => {
  // Health must only confirm that the Node service is alive. Firebase may be protected by rules.
  const out = { ok: true, app: 'ADNOR 24H SERVER V8.1 ADNOR-VP', timezone: TIMEZONE, uptime: process.uptime(), now: new Date().toISOString() };
  try {
    await db.ref('global_system/settings/server24h').update({ lastHeartbeat: Date.now(), timezone: TIMEZONE, processUptime: process.uptime() });
    out.firebase = 'connected';
  } catch (e) {
    out.firebase = 'not-authorized-or-unavailable';
    out.firebaseError = e.message;
  }
  res.json(out);
});

app.get('/api/public/state', async (_req, res) => {
  try {
    // Keep public counters fresh whenever the website asks for state.
    await syncCounters();
    const settings = await getSettings();
    const publicDraws = {};
    for (const level of LEVELS) {
      const ticketCount = await countTickets(level, settings);
      const d = settings.draws[level] || {};
      publicDraws[level] = {
        prize: currentPrize(level, settings),
        participants: Math.max(n(d.participants), ticketCount),
        ticketCount,
        lastResult: d.lastResult || '0000000',
        lastStatus: d.lastStatus || 'انتظار',
        lastAt: d.lastAt || 0,
        manualNumberSaved: !!d.manualNumber,
        releaseAt: d.releaseAt || 0,
        periodKey: periodKey(level, settings),
      };
    }
    let history = [];
    try {
      const hs = await db.ref('draw_history').limitToLast(12).once('value');
      const raw = hs.val() || {};
      history = Object.values(raw).sort((a, b) => n(b.at) - n(a.at));
    } catch (_) {}
    res.json({ ok: true, app: 'ADNOR 24H SERVER V8 ADNOR-VP', timezone: TIMEZONE, drawHour: settings.drawHour, draws: publicDraws, history });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/draw/manual-number', requireAdmin, async (req, res) => {
  try {
    const level = req.body.level || 'daily';
    const number = pad7(req.body.number);
    if (!LEVELS.includes(level)) return res.status(400).json({ ok: false, error: 'Invalid level' });
    if (!number) return res.status(400).json({ ok: false, error: 'رقم غير صحيح' });
    const settings = await getSettings();
    const patch = {
      manualNumber: number,
      releaseAt: endOf(level, settings),
      savedByServerAt: Date.now(),
      savedByServerTime: nowStr(),
      lastStatus: `تم حفظ رقم ${LABEL[level]} وينتظر وقت النشر`,
    };
    await db.ref(`global_system/settings/draws/${level}`).update(patch);
    await db.ref('server_logs').push({ type: 'manual-number-saved', level, number, releaseAt: patch.releaseAt, at: Date.now(), time: nowStr() });
    res.json({ ok: true, level, number, releaseAt: patch.releaseAt, message: 'تم حفظ رقم الفائز على السيرفر' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/draw/settings', requireAdmin, async (req, res) => {
  try {
    const level = req.body.level || 'daily';
    if (!LEVELS.includes(level)) return res.status(400).json({ ok: false, error: 'Invalid level' });
    const settings = await getSettings();
    const d = settings.draws[level] || {};
    const patch = {
      base: money(req.body.base ?? d.base),
      targetMin: money(req.body.targetMin ?? d.targetMin),
      targetMax: money(req.body.targetMax ?? d.targetMax),
      participants: Math.max(n(req.body.participants), await countTickets(level, settings)),
      updatedByAdminAt: Date.now(),
    };
    await db.ref(`global_system/settings/draws/${level}`).update(patch);
    await syncCounters();
    res.json({ ok: true, level, patch });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


app.post('/api/admin/draw/schedule', requireAdmin, async (req, res) => {
  try {
    const level = req.body.level || 'daily';
    const number = pad7(req.body.number);
    if (!LEVELS.includes(level)) return res.status(400).json({ ok: false, error: 'Invalid level' });
    if (!number) return res.status(400).json({ ok: false, error: 'رقم غير صحيح' });
    const settings = await getSettings();
    const releaseAt = endOf(level, settings);
    await db.ref(`global_system/settings/draws/${level}`).update({
      manualNumber: number,
      releaseAt,
      scheduledAt: Date.now(),
      scheduledTime: nowStr(),
      pendingApproval: false,
      lastStatus: `تمت جدولة رقم ${LABEL[level]} للظهور الساعة ${settings.drawHour || 20}:00`,
    });
    await db.ref('server_logs').push({ type: 'draw-scheduled', level, number, releaseAt, at: Date.now(), time: nowStr() });
    res.json({ ok: true, level, number, releaseAt, message: 'تمت جدولة رقم الفائز' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/draw/run', requireAdmin, async (req, res) => {
  try {
    const out = await processDraw(req.body.level || 'daily', { manualNumber: req.body.number, force: !!req.body.force });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/counters/sync', requireAdmin, async (_req, res) => {
  try {
    const updates = await syncCounters();
    res.json({ ok: true, updated: Object.keys(updates).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/tickets/buy', async (req, res) => {
  try {
    const result = await reserveTicket(req.body.uid, req.body.level || 'daily', req.body.number, req.body.price || 1);
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1m', etag: true }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function scheduleJob(name, expression, handler) {
  cron.schedule(expression, async () => {
    try {
      await db.ref('global_system/settings/server24h').update({ lastJob: name, lastJobAt: Date.now(), timezone: TIMEZONE });
      const out = await handler();
      // لا نخزن كائن updates كامل داخل server_logs لأن أسماء المفاتيح قد تحتوي / وهذا ممنوع داخل Firebase data keys.
      const outSummary = out && typeof out === 'object'
        ? { ok: out.ok !== false, updatedCount: Object.keys(out).length, level: out.level || '', periodKey: out.periodKey || '', status: out.status || '', autoExecuted: !!out.autoExecuted }
        : out;
      await db.ref('server_logs').push({ type: 'cron-ok', name, expression, out: outSummary, at: Date.now(), time: nowStr() });
      console.log('[CRON OK]', name, outSummary);
    } catch (e) {
      try { await db.ref('server_logs').push({ type: 'cron-error', name, expression, error: e.message, at: Date.now(), time: nowStr() }); }
      catch (logErr) { console.warn('[CRON LOG SKIPPED]', logErr.message); }
      console.error('[CRON ERROR]', name, e);
    }
  }, { timezone: TIMEZONE });
}


async function markDrawPending(level) {
  const settings = await getSettings();
  const pk = periodKey(level, settings);
  const d = settings.draws[level] || {};

  // If admin saved/scheduled a winning number before 8:00, execute it automatically at 8:00.
  if (d.manualNumber) {
    const out = await processDraw(level, { manualNumber: d.manualNumber, force: false });
    return { ok: true, level, periodKey: pk, autoExecuted: true, out };
  }

  const status = `حان وقت سحب ${LABEL[level]}، بانتظار إدخال رقم الفائز من الأدمن`;
  await db.ref(`global_system/settings/draws/${level}`).update({
    lastStatus: status,
    pendingApproval: true,
    pendingPeriodKey: pk,
    pendingAt: Date.now(),
  });
  return { ok: true, level, periodKey: pk, status, manualNumberSaved: false };
}

scheduleJob('sync-counters-every-minute', '* * * * *', syncCounters);
scheduleJob('daily-draw-pending-20-00', process.env.DAILY_CRON || '0 20 * * *', () => markDrawPending('daily'));
scheduleJob('weekly-draw-pending-sunday-20-05', process.env.WEEKLY_CRON || '5 20 * * 0', () => markDrawPending('weekly'));
scheduleJob('monthly-draw-pending-day-1-20-10', process.env.MONTHLY_CRON || '10 20 1 * *', () => markDrawPending('monthly'));
scheduleJob('yearly-draw-pending-jan-1-20-15', process.env.YEARLY_CRON || '15 20 1 1 *', () => markDrawPending('yearly'));

app.listen(PORT, async () => {
  try {
    await db.ref('global_system/settings/server24h').update({ enabled: true, startedAt: Date.now(), lastHeartbeat: Date.now(), timezone: TIMEZONE, port: PORT });
  } catch (e) {
    console.warn('[Startup] Firebase heartbeat skipped:', e.message);
  }
  console.log(`ADNOR 24H SERVER V8.1 ADNOR-VP running on port ${PORT} timezone=${TIMEZONE}`);
});

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
