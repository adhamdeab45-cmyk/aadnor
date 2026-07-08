const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.database();

const ADMIN_EMAILS = ['adhamdeab2@gmail.com', 'adhamdeab45@gmail.com'];
const WALLET_FIELDS = new Set(['realBalance', 'bonusBalance', 'reservedWithdrawalBalance', 'freeSpins', 'freeTickets']);

function nowId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function requireUser(request) {
  const uid = request.auth && request.auth.uid;
  const email = ((request.auth && request.auth.token && request.auth.token.email) || '').toLowerCase();
  if (!uid) throw new HttpsError('unauthenticated', 'يجب تسجيل الدخول.');
  return { uid, email };
}

async function requireAdmin(request) {
  const user = await requireUser(request);
  const adminSnap = await db.ref(`admins/${user.uid}`).get();
  if (adminSnap.val() === true || ADMIN_EMAILS.includes(user.email)) return user;
  throw new HttpsError('permission-denied', 'هذه العملية للأدمن فقط.');
}

function num(v, def = 0) {
  const n = Number(v ?? def);
  if (!Number.isFinite(n)) throw new HttpsError('invalid-argument', 'رقم غير صالح.');
  return Math.round(n * 100) / 100;
}


function agentLooseNum(v, def = 0) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : def;
  if (v == null) return def;
  let s = String(v).trim();
  if (!s) return def;
  const ar = '٠١٢٣٤٥٦٧٨٩';
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  s = s.replace(/[٠-٩]/g, d => String(ar.indexOf(d))).replace(/[۰-۹]/g, d => String(fa.indexOf(d)));
  s = s.replace(/\s/g, '').replace(/,/g, '.').replace(/[^0-9.\-]/g, '');
  const parts = s.split('.');
  if (parts.length > 2) s = parts.shift() + '.' + parts.join('');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : def;
}
function agentBalanceValue(agent) {
  if (!agent) return 0;
  const vals = [agent.agentBalance, agent.balance, agent.walletBalance, agent.credit, agent.amount, agent.wallet && agent.wallet.balance, agent.wallet && agent.wallet.agentBalance, agent.agentWalletBalance, agent.walletAmount];
  let sawZero = false;
  for (const v of vals) {
    const n = agentLooseNum(v, NaN);
    if (Number.isFinite(n) && n > 0) return n;
    if (v === 0 || v === '0') sawZero = true;
  }
  return sawZero ? 0 : 0;
}

function cleanText(v, max = 500) {
  return String(v || '').trim().slice(0, max);
}

function normalizeAgentLogin(v) {
  const raw = cleanText(v, 220).toLowerCase();
  if (!raw) throw new HttpsError('invalid-argument', 'اسم دخول الوكيل أو الإيميل مطلوب.');
  if (raw.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
      throw new HttpsError('invalid-argument', 'إيميل الوكيل غير صحيح. اكتب إيميل كامل مثل agent@gmail.com أو اسم دخول إنكليزي مثل adhamagent.');
    }
    return { email: raw, loginId: raw.split('@')[0] };
  }
  const loginId = raw.replace(/\s+/g, '');
  if (!/^[a-z0-9._-]{3,60}$/.test(loginId)) {
    throw new HttpsError('invalid-argument', 'اسم الدخول لازم يكون إنكليزي فقط: حروف أو أرقام أو نقطة أو شرطة، أقل شيء 3 أحرف.');
  }
  return { email: `${loginId}@adnor-agent.com`, loginId };
}

function adminEmailOf(user) {
  return user.email || 'admin';
}

async function userOrFail(uid) {
  const snap = await db.ref(`users/${uid}`).get();
  const user = snap.val();
  if (!user) throw new HttpsError('not-found', 'المستخدم غير موجود.');
  return user;
}

function notif(type, title, message, extra = {}) {
  return { type, title, message, read: false, createdAt: Date.now(), ...extra };
}

exports.adminAdjustBalance = onCall(async (request) => {
  const adminUser = await requireAdmin(request);
  const uid = cleanText(request.data && request.data.uid, 120);
  const field = cleanText(request.data && request.data.field, 80);
  const amount = num(request.data && request.data.amount);
  const note = cleanText(request.data && request.data.note, 800);
  if (!uid || !WALLET_FIELDS.has(field)) throw new HttpsError('invalid-argument', 'نوع الرصيد أو المستخدم غير صحيح.');
  if (!amount) throw new HttpsError('invalid-argument', 'القيمة لا يمكن أن تكون صفر.');
  if (note.length < 3) throw new HttpsError('invalid-argument', 'سبب التعديل إلزامي.');

  const user = await userOrFail(uid);
  const before = num(user[field]);
  const after = num(before + amount);
  if (after < 0) throw new HttpsError('failed-precondition', 'لا يمكن أن يصبح الرصيد سالبًا.');

  const now = Date.now();
  const auditId = nowId('audit_wallet');
  const txId = nowId('tx_wallet');
  const updates = {};
  updates[`users/${uid}/${field}`] = after;
  updates[`users/${uid}/updatedAt`] = now;
  updates[`transactions/${uid}/${txId}`] = {
    id: txId,
    type: 'server_admin_balance_adjust',
    walletField: field,
    amount,
    balanceBefore: before,
    balanceAfter: after,
    note,
    status: 'approved',
    adminEmail: adminEmailOf(adminUser),
    createdAt: now,
    source: 'cloud_functions',
  };
  updates[`admin_user_notes/${uid}/${auditId}`] = {
    id: auditId,
    type: 'server_balance_adjust',
    walletField: field,
    amount,
    before,
    after,
    note,
    adminEmail: adminEmailOf(adminUser),
    createdAt: now,
  };
  updates[`finance_audit/${auditId}`] = {
    id: auditId,
    action: 'server_admin_balance_adjust',
    uid,
    email: user.email || '',
    walletField: field,
    amount,
    before,
    after,
    note,
    adminEmail: adminEmailOf(adminUser),
    createdAt: now,
    source: 'cloud_functions',
  };
  updates[`user_notifications/${uid}/${auditId}`] = notif(
    'admin_balance_adjust',
    'تم تعديل رصيدك من الإدارة',
    `${note}`,
    { amount, walletField: field, auditId }
  );
  await db.ref().update(updates);
  return { ok: true, uid, field, before, after, auditId };
});

exports.adminToggleFreeze = onCall(async (request) => {
  const adminUser = await requireAdmin(request);
  const uid = cleanText(request.data && request.data.uid, 120);
  const frozen = !!(request.data && request.data.frozen);
  const reason = cleanText(request.data && request.data.reason, 800) || 'قرار إداري';
  if (!uid) throw new HttpsError('invalid-argument', 'المستخدم غير صحيح.');
  const user = await userOrFail(uid);
  const now = Date.now();
  const auditId = nowId('audit_account');
  const updates = {};
  updates[`users/${uid}/isFrozen`] = frozen;
  updates[`users/${uid}/freezeReason`] = frozen ? reason : '';
  updates[`users/${uid}/updatedAt`] = now;
  updates[`admin_user_notes/${uid}/${auditId}`] = {
    id: auditId,
    type: frozen ? 'account_freeze' : 'account_unfreeze',
    reason,
    adminEmail: adminEmailOf(adminUser),
    createdAt: now,
  };
  updates[`finance_audit/${auditId}`] = {
    id: auditId,
    action: frozen ? 'server_account_freeze' : 'server_account_unfreeze',
    uid,
    email: user.email || '',
    reason,
    adminEmail: adminEmailOf(adminUser),
    createdAt: now,
    source: 'cloud_functions',
  };
  updates[`user_notifications/${uid}/${auditId}`] = notif(
    frozen ? 'account_freeze' : 'account_unfreeze',
    frozen ? 'تم تجميد الحساب' : 'تم فك تجميد الحساب',
    frozen ? `تم إيقاف بعض العمليات مؤقتًا. السبب: ${reason}` : `تمت إعادة تفعيل حسابك. السبب: ${reason}`,
    { auditId }
  );
  await db.ref().update(updates);
  return { ok: true, uid, frozen, auditId };
});

exports.adminSendUserMessage = onCall(async (request) => {
  const adminUser = await requireAdmin(request);
  const uid = cleanText(request.data && request.data.uid, 120);
  const title = cleanText(request.data && request.data.title, 160);
  const message = cleanText(request.data && request.data.message, 2000);
  if (!uid || title.length < 2 || message.length < 3) throw new HttpsError('invalid-argument', 'المستخدم والعنوان والرسالة مطلوبة.');
  const user = await userOrFail(uid);
  const now = Date.now();
  const id = nowId('msg');
  const row = {
    id,
    uid,
    email: user.email || '',
    title,
    message,
    status: 'sent',
    read: false,
    adminEmail: adminEmailOf(adminUser),
    createdAt: now,
    source: 'cloud_functions',
  };
  const updates = {};
  updates[`user_direct_messages/${uid}/${id}`] = row;
  updates[`admin_user_messages/${id}`] = row;
  updates[`finance_audit/${id}`] = {
    id,
    action: 'server_admin_direct_message',
    uid,
    email: user.email || '',
    note: `${title} — ${message}`,
    adminEmail: adminEmailOf(adminUser),
    createdAt: now,
    source: 'cloud_functions',
  };
  updates[`user_notifications/${uid}/${id}`] = notif('admin_direct_message', title, message, { messageId: id });
  await db.ref().update(updates);
  return { ok: true, id };
});

exports.requestDeposit = onCall(async (request) => {
  const user = await requireUser(request);
  const amount = num(request.data && request.data.amount);
  const method = cleanText(request.data && request.data.method, 120);
  const reference = cleanText(request.data && request.data.reference, 250);
  const note = cleanText(request.data && request.data.note, 800);
  if (amount <= 0) throw new HttpsError('invalid-argument', 'مبلغ الإيداع غير صحيح.');
  if (!method) throw new HttpsError('invalid-argument', 'طريقة الإيداع مطلوبة.');
  const profile = await userOrFail(user.uid);
  const now = Date.now();
  const id = nowId('dep');
  const row = { id, uid: user.uid, email: profile.email || user.email || '', amount, method, reference, note, status: 'pending', createdAt: now, source: 'cloud_functions' };
  const updates = {};
  updates[`finance/deposits/${id}`] = row;
  updates[`user_finance/${user.uid}/deposits/${id}`] = row;
  updates[`finance_audit/${id}`] = { id, action: 'server_deposit_requested', uid: user.uid, email: row.email, amount, method, createdAt: now, source: 'cloud_functions' };
  updates[`admin_notifications/${id}`] = { id, type: 'deposit_pending', uid: user.uid, email: row.email, text: `طلب إيداع ${amount} عبر ${method}`, status: 'pending', createdAt: now };
  await db.ref().update(updates);
  return { ok: true, id };
});

exports.requestWithdraw = onCall(async (request) => {
  const user = await requireUser(request);
  const amount = num(request.data && request.data.amount);
  const method = cleanText(request.data && request.data.method, 120);
  const destination = cleanText(request.data && request.data.destination, 500);
  if (amount <= 0) throw new HttpsError('invalid-argument', 'مبلغ السحب غير صحيح.');
  if (!method || destination.length < 3) throw new HttpsError('invalid-argument', 'طريقة السحب ومعلومات الاستلام مطلوبة.');
  const profile = await userOrFail(user.uid);
  const realBefore = num(profile.realBalance);
  const reservedBefore = num(profile.reservedWithdrawalBalance);
  if (realBefore < amount) throw new HttpsError('failed-precondition', 'الرصيد الحقيقي لا يكفي.');
  const now = Date.now();
  const id = nowId('wd');
  const realAfter = num(realBefore - amount);
  const reservedAfter = num(reservedBefore + amount);
  const row = { id, uid: user.uid, email: profile.email || user.email || '', amount, method, destination, status: 'pending', realBefore, realAfter, reservedBefore, reservedAfter, createdAt: now, source: 'cloud_functions' };
  const updates = {};
  updates[`users/${user.uid}/realBalance`] = realAfter;
  updates[`users/${user.uid}/reservedWithdrawalBalance`] = reservedAfter;
  updates[`users/${user.uid}/updatedAt`] = now;
  updates[`finance/withdrawals/${id}`] = row;
  updates[`user_finance/${user.uid}/withdrawals/${id}`] = row;
  updates[`transactions/${user.uid}/${id}`] = { id, type: 'server_withdraw_reserved', amount, balanceBefore: realBefore, balanceAfter: realAfter, reservedBefore, reservedAfter, status: 'pending', note: 'طلب سحب وحجز المبلغ', createdAt: now, source: 'cloud_functions' };
  updates[`finance_audit/${id}`] = { id, action: 'server_withdraw_requested_reserved', uid: user.uid, email: row.email, amount, method, beforeReal: realBefore, afterReal: realAfter, beforeReserved: reservedBefore, afterReserved: reservedAfter, createdAt: now, source: 'cloud_functions' };
  updates[`admin_notifications/${id}`] = { id, type: 'withdraw_pending', uid: user.uid, email: row.email, text: `طلب سحب ${amount} عبر ${method}`, status: 'pending', createdAt: now };
  await db.ref().update(updates);
  return { ok: true, id, realAfter, reservedAfter };
});

exports.adminApproveDeposit = onCall(async (request) => {
  const adminUser = await requireAdmin(request);
  const id = cleanText(request.data && request.data.id, 160);
  if (!id) throw new HttpsError('invalid-argument', 'رقم الطلب مطلوب.');
  const snap = await db.ref(`finance/deposits/${id}`).get();
  const dep = snap.val();
  if (!dep || dep.status !== 'pending') throw new HttpsError('failed-precondition', 'طلب الإيداع غير متاح.');
  const profile = await userOrFail(dep.uid);
  const before = num(profile.realBalance);
  const amount = num(dep.amount);
  const after = num(before + amount);
  const now = Date.now();
  const txId = nowId('tx_dep');
  const updates = {};
  updates[`finance/deposits/${id}/status`] = 'approved';
  updates[`finance/deposits/${id}/approvedAt`] = now;
  updates[`finance/deposits/${id}/approvedBy`] = adminEmailOf(adminUser);
  updates[`finance/deposits/${id}/balanceBefore`] = before;
  updates[`finance/deposits/${id}/balanceAfter`] = after;
  updates[`user_finance/${dep.uid}/deposits/${id}/status`] = 'approved';
  updates[`user_finance/${dep.uid}/deposits/${id}/approvedAt`] = now;
  updates[`user_finance/${dep.uid}/deposits/${id}/balanceAfter`] = after;
  updates[`users/${dep.uid}/realBalance`] = after;
  updates[`users/${dep.uid}/updatedAt`] = now;
  updates[`transactions/${dep.uid}/${txId}`] = { id: txId, type: 'server_deposit_approved', amount, balanceBefore: before, balanceAfter: after, status: 'approved', note: `قبول إيداع رقم ${id}`, adminEmail: adminEmailOf(adminUser), createdAt: now, source: 'cloud_functions' };
  updates[`finance_audit/${id}_approved`] = { id: `${id}_approved`, action: 'server_deposit_approved', requestId: id, uid: dep.uid, email: dep.email || '', amount, before, after, adminEmail: adminEmailOf(adminUser), createdAt: now, source: 'cloud_functions' };
  updates[`user_notifications/${dep.uid}/${id}_approved`] = notif('deposit_approved', 'تم قبول الإيداع', `تم إضافة ${amount}$ إلى رصيدك الحقيقي.`, { amount, requestId: id });
  await db.ref().update(updates);
  return { ok: true, id, before, after };
});

exports.adminRejectDeposit = onCall(async (request) => {
  const adminUser = await requireAdmin(request);
  const id = cleanText(request.data && request.data.id, 160);
  const reason = cleanText(request.data && request.data.reason, 800) || 'مرفوض من الإدارة';
  const snap = await db.ref(`finance/deposits/${id}`).get();
  const dep = snap.val();
  if (!dep || dep.status !== 'pending') throw new HttpsError('failed-precondition', 'طلب الإيداع غير متاح.');
  const now = Date.now();
  const updates = {};
  updates[`finance/deposits/${id}/status`] = 'rejected';
  updates[`finance/deposits/${id}/rejectedAt`] = now;
  updates[`finance/deposits/${id}/rejectedBy`] = adminEmailOf(adminUser);
  updates[`finance/deposits/${id}/rejectReason`] = reason;
  updates[`user_finance/${dep.uid}/deposits/${id}/status`] = 'rejected';
  updates[`user_finance/${dep.uid}/deposits/${id}/rejectedAt`] = now;
  updates[`user_finance/${dep.uid}/deposits/${id}/rejectReason`] = reason;
  updates[`finance_audit/${id}_rejected`] = { id: `${id}_rejected`, action: 'server_deposit_rejected', requestId: id, uid: dep.uid, email: dep.email || '', amount: dep.amount || 0, reason, adminEmail: adminEmailOf(adminUser), createdAt: now, source: 'cloud_functions' };
  updates[`user_notifications/${dep.uid}/${id}_rejected`] = notif('deposit_rejected', 'تم رفض الإيداع', `سبب الرفض: ${reason}`, { requestId: id });
  await db.ref().update(updates);
  return { ok: true, id };
});

exports.adminApproveWithdraw = onCall(async (request) => {
  const adminUser = await requireAdmin(request);
  const id = cleanText(request.data && request.data.id, 160);
  const snap = await db.ref(`finance/withdrawals/${id}`).get();
  const wd = snap.val();
  if (!wd || wd.status !== 'pending') throw new HttpsError('failed-precondition', 'طلب السحب غير متاح.');
  const profile = await userOrFail(wd.uid);
  const amount = num(wd.amount);
  const beforeReserved = num(profile.reservedWithdrawalBalance);
  if (beforeReserved < amount) throw new HttpsError('failed-precondition', 'الرصيد المحجوز لا يكفي لاعتماد السحب.');
  const afterReserved = num(beforeReserved - amount);
  const now = Date.now();
  const updates = {};
  updates[`finance/withdrawals/${id}/status`] = 'approved';
  updates[`finance/withdrawals/${id}/approvedAt`] = now;
  updates[`finance/withdrawals/${id}/approvedBy`] = adminEmailOf(adminUser);
  updates[`finance/withdrawals/${id}/reservedAfterFinal`] = afterReserved;
  updates[`user_finance/${wd.uid}/withdrawals/${id}/status`] = 'approved';
  updates[`user_finance/${wd.uid}/withdrawals/${id}/approvedAt`] = now;
  updates[`users/${wd.uid}/reservedWithdrawalBalance`] = afterReserved;
  updates[`users/${wd.uid}/updatedAt`] = now;
  updates[`transactions/${wd.uid}/${id}_approved`] = { id: `${id}_approved`, type: 'server_withdraw_approved', amount, beforeReserved, afterReserved, status: 'approved', note: `قبول سحب رقم ${id}`, adminEmail: adminEmailOf(adminUser), createdAt: now, source: 'cloud_functions' };
  updates[`finance_audit/${id}_approved`] = { id: `${id}_approved`, action: 'server_withdraw_approved', requestId: id, uid: wd.uid, email: wd.email || '', amount, beforeReserved, afterReserved, adminEmail: adminEmailOf(adminUser), createdAt: now, source: 'cloud_functions' };
  updates[`user_notifications/${wd.uid}/${id}_approved`] = notif('withdraw_approved', 'تم قبول السحب', `تم قبول طلب السحب ${amount}$.`, { amount, requestId: id });
  await db.ref().update(updates);
  return { ok: true, id, afterReserved };
});

exports.adminRejectWithdraw = onCall(async (request) => {
  const adminUser = await requireAdmin(request);
  const id = cleanText(request.data && request.data.id, 160);
  const reason = cleanText(request.data && request.data.reason, 800) || 'مرفوض من الإدارة';
  const snap = await db.ref(`finance/withdrawals/${id}`).get();
  const wd = snap.val();
  if (!wd || wd.status !== 'pending') throw new HttpsError('failed-precondition', 'طلب السحب غير متاح.');
  const profile = await userOrFail(wd.uid);
  const amount = num(wd.amount);
  const beforeReal = num(profile.realBalance);
  const beforeReserved = num(profile.reservedWithdrawalBalance);
  if (beforeReserved < amount) throw new HttpsError('failed-precondition', 'الرصيد المحجوز لا يكفي لرفض السحب وإرجاعه.');
  const afterReal = num(beforeReal + amount);
  const afterReserved = num(beforeReserved - amount);
  const now = Date.now();
  const updates = {};
  updates[`finance/withdrawals/${id}/status`] = 'rejected';
  updates[`finance/withdrawals/${id}/rejectedAt`] = now;
  updates[`finance/withdrawals/${id}/rejectedBy`] = adminEmailOf(adminUser);
  updates[`finance/withdrawals/${id}/rejectReason`] = reason;
  updates[`user_finance/${wd.uid}/withdrawals/${id}/status`] = 'rejected';
  updates[`user_finance/${wd.uid}/withdrawals/${id}/rejectedAt`] = now;
  updates[`user_finance/${wd.uid}/withdrawals/${id}/rejectReason`] = reason;
  updates[`users/${wd.uid}/realBalance`] = afterReal;
  updates[`users/${wd.uid}/reservedWithdrawalBalance`] = afterReserved;
  updates[`users/${wd.uid}/updatedAt`] = now;
  updates[`transactions/${wd.uid}/${id}_rejected`] = { id: `${id}_rejected`, type: 'server_withdraw_rejected_refund', amount, balanceBefore: beforeReal, balanceAfter: afterReal, beforeReserved, afterReserved, status: 'rejected', note: `رفض السحب وإرجاع المبلغ: ${reason}`, adminEmail: adminEmailOf(adminUser), createdAt: now, source: 'cloud_functions' };
  updates[`finance_audit/${id}_rejected`] = { id: `${id}_rejected`, action: 'server_withdraw_rejected_refund', requestId: id, uid: wd.uid, email: wd.email || '', amount, reason, beforeReal, afterReal, beforeReserved, afterReserved, adminEmail: adminEmailOf(adminUser), createdAt: now, source: 'cloud_functions' };
  updates[`user_notifications/${wd.uid}/${id}_rejected`] = notif('withdraw_rejected', 'تم رفض السحب وإرجاع الرصيد', `سبب الرفض: ${reason}`, { amount, requestId: id });
  await db.ref().update(updates);
  return { ok: true, id, afterReal, afterReserved };
});


// ADNOR V141 — server-side direct ADN buy: updates user wallet, market state, candles, trades and audit together.
function adnNum(v, def = 0) { const n = Number(v ?? def); return Number.isFinite(n) ? n : def; }
function adnRound4(v) { return Math.round(Number(v || 0) * 10000) / 10000; }
function adnDefaultSettings() { return { enabled:true,buyEnabled:true,sellEnabled:true,totalSupply:5000000,saleSupply:5000000,startPrice:0.10,currentPrice:0.10,minBuy:1,maxBuy:100000,sellFeePercent:2,impactPer10000:0.35,minPrice:0.01,maxPrice:100 }; }
function adnDefaultState() { return { price:0.10,openPrice:0.10,highPrice:0.10,lowPrice:0.10,totalSupply:5000000,saleSupply:5000000,soldSupply:0,remainingSupply:5000000,fundUsd:0,buyVolumeUsd:0,sellVolumeUsd:0,buyVolumeToken:0,sellVolumeToken:0,tradesCount:0,lastTradeAt:0,investorsCount:0,updatedAt:Date.now() }; }
function adnMergeSettings(v){ const d=adnDefaultSettings(); const s={...d,...(v||{})}; ['totalSupply','saleSupply','startPrice','currentPrice','minBuy','maxBuy','sellFeePercent','impactPer10000','minPrice','maxPrice'].forEach(k=>s[k]=adnNum(s[k],d[k])); s.enabled=s.enabled!==false; s.buyEnabled=s.buyEnabled!==false; s.sellEnabled=s.sellEnabled!==false; return s; }
function adnMergeState(v){ const d=adnDefaultState(); const s={...d,...(v||{})}; Object.keys(d).forEach(k=>s[k]=adnNum(s[k],d[k])); return s; }
function adnNewPriceServer(settings, oldPrice, type, qty){ const impact=(adnNum(settings.impactPer10000,0.35)/100)*(adnNum(qty)/10000); const next=type==='buy'?oldPrice*(1+impact):oldPrice*(1-impact); return Math.max(adnNum(settings.minPrice,0.01),Math.min(adnNum(settings.maxPrice,100),next)); }
exports.buyAdnDirect = onCall(async (request) => {
  const user = await requireUser(request);
  const qty = Math.floor(adnNum(request.data && request.data.amountToken, 0));
  if (qty <= 0) throw new HttpsError('invalid-argument', 'اكتب كمية ADN صحيحة.');
  const profile = await userOrFail(user.uid);
  if (profile.isFrozen) throw new HttpsError('failed-precondition', 'الحساب مجمّد مؤقتًا.');
  const settings = adnMergeSettings((await db.ref('game_treasury/settings/adn_market').get()).val());
  const state = adnMergeState((await db.ref('game_treasury/current/adn_market_state').get()).val());
  if (settings.enabled === false || settings.buyEnabled === false) throw new HttpsError('failed-precondition', 'شراء ADN متوقف مؤقتًا.');
  if (qty < adnNum(settings.minBuy, 1)) throw new HttpsError('failed-precondition', `أقل شراء هو ${settings.minBuy} ADN.`);
  if (qty > adnNum(settings.maxBuy, 100000)) throw new HttpsError('failed-precondition', `أعلى شراء هو ${settings.maxBuy} ADN.`);
  if (qty > adnNum(state.remainingSupply, settings.saleSupply)) throw new HttpsError('failed-precondition', 'الكمية أكبر من المتبقي للبيع.');
  const realBefore = adnRound4(profile.realBalance || 0), tokenBefore = adnRound4(profile.adnBalance || 0);
  const oldPrice = Math.max(adnNum(settings.minPrice,0.01), Math.min(adnNum(state.price || settings.currentPrice || settings.startPrice, 0.10), adnNum(settings.maxPrice,100)));
  const amountUsd = adnRound4(qty * oldPrice);
  if (realBefore < amountUsd) throw new HttpsError('failed-precondition', 'الرصيد الحقيقي لا يكفي. البونص لا يشتري ADN.');
  const newPrice = adnRound4(adnNewPriceServer(settings, oldPrice, 'buy', qty));
  const realAfter = adnRound4(realBefore - amountUsd), tokenAfter = adnRound4(tokenBefore + qty);
  const now = Date.now(), txId = nowId('adn_buy'), tradeId = nowId('adn_trade'), candleKey = Math.floor(now / 60000);
  const oldCandle = (await db.ref(`game_treasury/current/adn_market_candles/${candleKey}`).get()).val() || { t:candleKey*60000, open:oldPrice, high:oldPrice, low:oldPrice, close:oldPrice, volumeUsd:0, buyUsd:0, sellUsd:0, createdAt:now };
  const marketState = {...state,price:newPrice,highPrice:Math.max(adnNum(state.highPrice,oldPrice),newPrice),lowPrice:Math.min(adnNum(state.lowPrice,oldPrice),newPrice),soldSupply:adnNum(state.soldSupply)+qty,remainingSupply:Math.max(0,adnNum(state.remainingSupply)-qty),fundUsd:adnRound4(adnNum(state.fundUsd)+amountUsd),buyVolumeUsd:adnRound4(adnNum(state.buyVolumeUsd)+amountUsd),buyVolumeToken:adnNum(state.buyVolumeToken)+qty,tradesCount:adnNum(state.tradesCount)+1,investorsCount:adnNum(state.investorsCount)+(tokenBefore<=0?1:0),lastTradeAt:now,updatedAt:now};
  const candle = {...oldCandle, high:Math.max(adnNum(oldCandle.high,oldPrice),oldPrice,newPrice), low:Math.min(adnNum(oldCandle.low,oldPrice),oldPrice,newPrice), close:newPrice, volumeUsd:adnRound4(adnNum(oldCandle.volumeUsd)+amountUsd), buyUsd:adnRound4(adnNum(oldCandle.buyUsd)+amountUsd), updatedAt:now};
  const email = profile.email || user.email || '', userName = profile.name || profile.displayName || email || 'مستخدم ADNOR';
  const updates = {};
  updates[`users/${user.uid}/realBalance`] = realAfter; updates[`users/${user.uid}/adnBalance`] = tokenAfter; updates[`users/${user.uid}/updatedAt`] = now;
  updates['game_treasury/current/adn_market_state'] = marketState; updates[`game_treasury/current/adn_market_candles/${candleKey}`] = candle;
  updates[`game_treasury/current/adn_market_trades/${tradeId}`] = { id:tradeId,type:'buy',uid:user.uid,email,userName,amountToken:qty,amountUsd,price:oldPrice,marketPriceBefore:oldPrice,marketPriceAfter:newPrice,source:'cloud_functions',createdAt:now };
  updates[`transactions/${user.uid}/${txId}`] = { id:txId,type:'server_adn_buy_direct',status:'completed',amount:-amountUsd,amountToken:qty,price:oldPrice,marketPriceAfter:newPrice,balanceBefore:realBefore,balanceAfter:realAfter,adnBefore:tokenBefore,adnAfter:tokenAfter,note:'شراء ADN من السيرفر وتحديث السعر والشمعة',createdAt:now,source:'cloud_functions' };
  updates[`finance_audit/${txId}`] = { id:txId,action:'server_adn_buy_direct',uid:user.uid,email,qty,amountUsd,oldPrice,newPrice,createdAt:now,source:'cloud_functions' };
  updates[`user_notifications/${user.uid}/${txId}`] = notif('adn','تم شراء ADN بنجاح',`تم شراء ${qty} ADN بقيمة $${amountUsd.toFixed(2)}. السعر الجديد: $${newPrice.toFixed(4)}`,{amountToken:qty,amountUsd,oldPrice,newPrice});
  await db.ref().update(updates);
  return { ok:true, qty, amountUsd, oldPrice, newPrice, realAfter, tokenAfter, tradeId, txId };
});

// ADNOR V176 — server-side direct ADN sell: automatic safe sell for normal users.
exports.sellAdnDirect = onCall(async (request) => {
  const user = await requireUser(request);
  const qty = Math.floor(adnNum(request.data && request.data.amountToken, 0));
  if (qty <= 0) throw new HttpsError('invalid-argument', 'اكتب كمية ADN صحيحة.');
  const profile = await userOrFail(user.uid);
  if (profile.isFrozen) throw new HttpsError('failed-precondition', 'الحساب مجمّد مؤقتًا.');
  const settings = adnMergeSettings((await db.ref('game_treasury/settings/adn_market').get()).val());
  const state = adnMergeState((await db.ref('game_treasury/current/adn_market_state').get()).val());
  if (settings.enabled === false || settings.sellEnabled === false) throw new HttpsError('failed-precondition', 'بيع ADN متوقف مؤقتًا.');
  const realBefore = adnRound4(profile.realBalance || 0), tokenBefore = adnRound4(profile.adnBalance || 0);
  if (tokenBefore < qty) throw new HttpsError('failed-precondition', 'رصيد ADN لا يكفي للبيع.');
  const oldPrice = Math.max(adnNum(settings.minPrice,0.01), Math.min(adnNum(state.price || settings.currentPrice || settings.startPrice, 0.10), adnNum(settings.maxPrice,100)));
  const sellPrice = adnRound4(oldPrice * (1 - adnNum(settings.sellFeePercent,0) / 100));
  const amountUsd = adnRound4(qty * sellPrice);
  if (amountUsd <= 0) throw new HttpsError('failed-precondition', 'قيمة البيع غير صالحة.');
  if (adnNum(state.fundUsd) < amountUsd) throw new HttpsError('failed-precondition', 'سيولة صندوق ADN لا تكفي لتنفيذ البيع الآن.');
  const newPrice = adnRound4(adnNewPriceServer(settings, oldPrice, 'sell', qty));
  const realAfter = adnRound4(realBefore + amountUsd), tokenAfter = adnRound4(tokenBefore - qty);
  const now = Date.now(), txId = nowId('adn_sell'), tradeId = nowId('adn_trade'), candleKey = Math.floor(now / 60000);
  const oldCandle = (await db.ref(`game_treasury/current/adn_market_candles/${candleKey}`).get()).val() || { t:candleKey*60000, open:oldPrice, high:oldPrice, low:oldPrice, close:oldPrice, volumeUsd:0, buyUsd:0, sellUsd:0, createdAt:now };
  const marketState = {...state,price:newPrice,highPrice:Math.max(adnNum(state.highPrice,oldPrice),newPrice),lowPrice:Math.min(adnNum(state.lowPrice,oldPrice),newPrice),soldSupply:Math.max(0,adnNum(state.soldSupply)-qty),remainingSupply:adnNum(state.remainingSupply)+qty,fundUsd:adnRound4(Math.max(0,adnNum(state.fundUsd)-amountUsd)),sellVolumeUsd:adnRound4(adnNum(state.sellVolumeUsd)+amountUsd),sellVolumeToken:adnNum(state.sellVolumeToken)+qty,tradesCount:adnNum(state.tradesCount)+1,investorsCount:Math.max(0,adnNum(state.investorsCount)-((tokenAfter<=0)?1:0)),lastTradeAt:now,updatedAt:now};
  const candle = {...oldCandle, high:Math.max(adnNum(oldCandle.high,oldPrice),oldPrice,newPrice), low:Math.min(adnNum(oldCandle.low,oldPrice),oldPrice,newPrice), close:newPrice, volumeUsd:adnRound4(adnNum(oldCandle.volumeUsd)+amountUsd), sellUsd:adnRound4(adnNum(oldCandle.sellUsd)+amountUsd), updatedAt:now};
  const email = profile.email || user.email || '', userName = profile.name || profile.displayName || email || 'مستخدم ADNOR';
  const updates = {};
  updates[`users/${user.uid}/realBalance`] = realAfter; updates[`users/${user.uid}/adnBalance`] = tokenAfter; updates[`users/${user.uid}/updatedAt`] = now;
  updates['game_treasury/current/adn_market_state'] = marketState; updates[`game_treasury/current/adn_market_candles/${candleKey}`] = candle;
  updates[`game_treasury/current/adn_market_trades/${tradeId}`] = { id:tradeId,type:'sell',uid:user.uid,email,userName,amountToken:qty,amountUsd,price:sellPrice,marketPriceBefore:oldPrice,marketPriceAfter:newPrice,source:'cloud_functions',createdAt:now };
  updates[`transactions/${user.uid}/${txId}`] = { id:txId,type:'server_adn_sell_direct',status:'completed',amount:amountUsd,amountToken:qty,price:sellPrice,marketPriceAfter:newPrice,balanceBefore:realBefore,balanceAfter:realAfter,adnBefore:tokenBefore,adnAfter:tokenAfter,note:'بيع ADN من السيرفر ورجوع المبلغ للرصيد الحقيقي',createdAt:now,source:'cloud_functions' };
  updates[`finance_audit/${txId}`] = { id:txId,action:'server_adn_sell_direct',uid:user.uid,email,qty,amountUsd,oldPrice,sellPrice,newPrice,createdAt:now,source:'cloud_functions' };
  updates[`user_notifications/${user.uid}/${txId}`] = notif('adn','تم بيع ADN بنجاح',`تم بيع ${qty} ADN بقيمة $${amountUsd.toFixed(2)}. السعر الجديد: $${newPrice.toFixed(4)}`,{amountToken:qty,amountUsd,oldPrice,sellPrice,newPrice});
  await db.ref().update(updates);
  return { ok:true, qty, amountUsd, oldPrice, sellPrice, newPrice, realAfter, tokenAfter, tradeId, txId };
});



// ADNOR V142 — Limit orders for ADN market: reserve balance/token, execute when price reaches target, cancel with refund.
function adnOrderId(prefix='adn_limit'){ return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
function adnTradePrice(settings, state){ return Math.max(adnNum(settings.minPrice,0.01), Math.min(adnNum(state.price || settings.currentPrice || settings.startPrice, 0.10), adnNum(settings.maxPrice,100))); }
function adnSellExecPrice(settings, state){ return adnRound4(adnTradePrice(settings,state) * (1 - adnNum(settings.sellFeePercent,0)/100)); }
async function adnLoadMarket(){ const settings=adnMergeSettings((await db.ref('game_treasury/settings/adn_market').get()).val()); const state=adnMergeState((await db.ref('game_treasury/current/adn_market_state').get()).val()); return {settings,state}; }
exports.placeAdnLimitOrder = onCall(async (request) => {
  const user = await requireUser(request);
  const type = cleanText(request.data && request.data.type, 20) === 'sell' ? 'sell' : 'buy';
  const qty = Math.floor(adnNum(request.data && request.data.amountToken, 0));
  const targetPrice = adnRound4(adnNum(request.data && request.data.targetPrice, 0));
  if (qty <= 0 || targetPrice <= 0) throw new HttpsError('invalid-argument', 'الكمية أو السعر غير صحيح.');
  const profile = await userOrFail(user.uid);
  if (profile.isFrozen) throw new HttpsError('failed-precondition', 'الحساب مجمّد مؤقتًا.');
  const {settings,state} = await adnLoadMarket();
  if (settings.enabled === false) throw new HttpsError('failed-precondition', 'سوق ADN متوقف مؤقتًا.');
  if (type === 'buy' && settings.buyEnabled === false) throw new HttpsError('failed-precondition', 'الشراء متوقف مؤقتًا.');
  if (type === 'sell' && settings.sellEnabled === false) throw new HttpsError('failed-precondition', 'البيع متوقف مؤقتًا.');
  if (qty < adnNum(settings.minBuy,1) || qty > adnNum(settings.maxBuy,100000)) throw new HttpsError('failed-precondition', 'الكمية خارج حدود السوق.');
  const now = Date.now(), id = adnOrderId();
  const email = profile.email || user.email || '', userName = profile.name || profile.displayName || email || 'مستخدم ADNOR';
  const realBefore = adnRound4(profile.realBalance || 0), tokenBefore = adnRound4(profile.adnBalance || 0);
  const reservedUsdBefore = adnRound4(profile.adnReservedUsd || 0), reservedTokenBefore = adnRound4(profile.adnReservedToken || 0);
  const updates = {};
  let reservedUsd = 0, reservedToken = 0;
  if (type === 'buy') {
    reservedUsd = adnRound4(qty * targetPrice);
    if (qty > adnNum(state.remainingSupply, settings.saleSupply)) throw new HttpsError('failed-precondition', 'الكمية أكبر من المتبقي للبيع.');
    if (realBefore < reservedUsd) throw new HttpsError('failed-precondition', 'الرصيد الحقيقي لا يكفي لحجز أمر الشراء.');
    updates[`users/${user.uid}/realBalance`] = adnRound4(realBefore - reservedUsd);
    updates[`users/${user.uid}/adnReservedUsd`] = adnRound4(reservedUsdBefore + reservedUsd);
  } else {
    reservedToken = qty;
    if (tokenBefore < qty) throw new HttpsError('failed-precondition', 'رصيد ADN لا يكفي لحجز أمر البيع.');
    updates[`users/${user.uid}/adnBalance`] = adnRound4(tokenBefore - qty);
    updates[`users/${user.uid}/adnReservedToken`] = adnRound4(reservedTokenBefore + qty);
  }
  const order = { id, uid:user.uid, email, userName, type, status:'pending', amountToken:qty, targetPrice, reservedUsd, reservedToken, marketPriceAtCreate:adnTradePrice(settings,state), createdAt:now, updatedAt:now, source:'cloud_functions' };
  updates[`adn_limit_orders/${id}`] = order;
  updates[`user_adn_limit_orders/${user.uid}/${id}`] = order;
  updates[`users/${user.uid}/updatedAt`] = now;
  updates[`transactions/${user.uid}/${id}`] = { id, type:'server_adn_limit_order_created', status:'pending', tradeType:type, amountToken:qty, targetPrice, reservedUsd, reservedToken, note:'إنشاء أمر ADN بسعر محدد وحجز الرصيد/العملة', createdAt:now, source:'cloud_functions' };
  updates[`finance_audit/${id}`] = { id, action:'server_adn_limit_order_created', uid:user.uid, email, type, qty, targetPrice, reservedUsd, reservedToken, createdAt:now, source:'cloud_functions' };
  updates[`user_notifications/${user.uid}/${id}`] = notif('adn','تم وضع أمر ADN بسعر محدد', type === 'buy' ? `تم حجز $${reservedUsd.toFixed(2)} بانتظار وصول السعر إلى $${targetPrice.toFixed(4)}.` : `تم حجز ${qty} ADN بانتظار وصول السعر إلى $${targetPrice.toFixed(4)}.`, { orderId:id });
  await db.ref().update(updates);
  return { ok:true, id, order, message: type === 'buy' ? 'تم وضع أمر شراء محدد وحجز المبلغ' : 'تم وضع أمر بيع محدد وحجز العملة' };
});

exports.cancelAdnLimitOrder = onCall(async (request) => {
  const user = await requireUser(request);
  const orderId = cleanText(request.data && request.data.orderId, 160);
  if (!orderId) throw new HttpsError('invalid-argument', 'رقم الأمر مطلوب.');
  const snap = await db.ref(`adn_limit_orders/${orderId}`).get();
  const order = snap.val();
  if (!order || order.uid !== user.uid) throw new HttpsError('not-found', 'الأمر غير موجود.');
  if (order.status !== 'pending') throw new HttpsError('failed-precondition', 'لا يمكن إلغاء أمر تمت معالجته.');
  const profile = await userOrFail(user.uid);
  const now = Date.now();
  const updates = {};
  if (order.type === 'buy') {
    const reserved = adnRound4(order.reservedUsd || 0);
    updates[`users/${user.uid}/realBalance`] = adnRound4((profile.realBalance || 0) + reserved);
    updates[`users/${user.uid}/adnReservedUsd`] = Math.max(0, adnRound4((profile.adnReservedUsd || 0) - reserved));
  } else {
    const reserved = adnRound4(order.reservedToken || order.amountToken || 0);
    updates[`users/${user.uid}/adnBalance`] = adnRound4((profile.adnBalance || 0) + reserved);
    updates[`users/${user.uid}/adnReservedToken`] = Math.max(0, adnRound4((profile.adnReservedToken || 0) - reserved));
  }
  const done = { ...order, status:'cancelled', cancelledAt:now, updatedAt:now };
  updates[`adn_limit_orders/${orderId}`] = done;
  updates[`user_adn_limit_orders/${user.uid}/${orderId}`] = done;
  updates[`users/${user.uid}/updatedAt`] = now;
  updates[`finance_audit/${orderId}_cancel`] = { id:`${orderId}_cancel`, action:'server_adn_limit_order_cancelled', uid:user.uid, email:order.email||'', type:order.type, qty:order.amountToken, createdAt:now, source:'cloud_functions' };
  updates[`user_notifications/${user.uid}/${orderId}_cancel`] = notif('adn','تم إلغاء أمر ADN','تم إلغاء الأمر ورجوع المحجوز إلى حسابك.',{orderId});
  await db.ref().update(updates);
  return { ok:true, orderId };
});

exports.processAdnLimitOrder = onCall(async (request) => {
  const user = await requireUser(request);
  const orderId = cleanText(request.data && request.data.orderId, 160);
  if (!orderId) throw new HttpsError('invalid-argument', 'رقم الأمر مطلوب.');
  const snap = await db.ref(`adn_limit_orders/${orderId}`).get();
  const order = snap.val();
  if (!order || order.uid !== user.uid) throw new HttpsError('not-found', 'الأمر غير موجود.');
  if (order.status !== 'pending') return { ok:true, executed:false, status:order.status };
  const profile = await userOrFail(user.uid);
  const {settings,state} = await adnLoadMarket();
  const currentPrice = adnTradePrice(settings,state);
  const target = adnRound4(order.targetPrice || 0);
  const hit = order.type === 'buy' ? currentPrice <= target : currentPrice >= target;
  if (!hit) return { ok:true, executed:false, waiting:true, price:currentPrice, targetPrice:target };
  const qty = Math.floor(adnNum(order.amountToken));
  if (qty <= 0) throw new HttpsError('failed-precondition', 'كمية الأمر غير صالحة.');
  const now = Date.now(), txId=adnOrderId('adn_limit_tx'), tradeId=adnOrderId('adn_trade'), candleKey=Math.floor(now/60000);
  let type = order.type === 'sell' ? 'sell' : 'buy';
  let executionPrice = type === 'buy' ? currentPrice : adnSellExecPrice(settings,state);
  let amountUsd = adnRound4(qty * executionPrice);
  const tokenBefore = adnRound4(profile.adnBalance || 0), realBefore = adnRound4(profile.realBalance || 0);
  const reservedUsdBefore = adnRound4(profile.adnReservedUsd || 0), reservedTokenBefore = adnRound4(profile.adnReservedToken || 0);
  const updates = {};
  if (type === 'buy') {
    const reservedUsd = adnRound4(order.reservedUsd || qty * target);
    if (reservedUsdBefore < reservedUsd) throw new HttpsError('failed-precondition', 'الرصيد المحجوز غير كافٍ.');
    if (qty > adnNum(state.remainingSupply, settings.saleSupply)) throw new HttpsError('failed-precondition', 'الكمية أكبر من المتبقي للبيع.');
    const refund = Math.max(0, adnRound4(reservedUsd - amountUsd));
    updates[`users/${user.uid}/realBalance`] = adnRound4(realBefore + refund);
    updates[`users/${user.uid}/adnReservedUsd`] = Math.max(0, adnRound4(reservedUsdBefore - reservedUsd));
    updates[`users/${user.uid}/adnBalance`] = adnRound4(tokenBefore + qty);
  } else {
    const reservedToken = adnRound4(order.reservedToken || qty);
    if (reservedTokenBefore < reservedToken) throw new HttpsError('failed-precondition', 'ADN المحجوز غير كافٍ.');
    if (adnNum(state.fundUsd) < amountUsd) throw new HttpsError('failed-precondition', 'سيولة صندوق ADN لا تكفي لتنفيذ البيع الآن.');
    updates[`users/${user.uid}/adnReservedToken`] = Math.max(0, adnRound4(reservedTokenBefore - reservedToken));
    updates[`users/${user.uid}/realBalance`] = adnRound4(realBefore + amountUsd);
  }
  const newPrice = adnRound4(adnNewPriceServer(settings, currentPrice, type, qty));
  const oldCandle = (await db.ref(`game_treasury/current/adn_market_candles/${candleKey}`).get()).val() || { t:candleKey*60000, open:currentPrice, high:currentPrice, low:currentPrice, close:currentPrice, volumeUsd:0, buyUsd:0, sellUsd:0, createdAt:now };
  const marketState = type === 'buy'
    ? { ...state, price:newPrice, highPrice:Math.max(adnNum(state.highPrice,currentPrice),newPrice), lowPrice:Math.min(adnNum(state.lowPrice,currentPrice),newPrice), soldSupply:adnNum(state.soldSupply)+qty, remainingSupply:Math.max(0,adnNum(state.remainingSupply)-qty), fundUsd:adnRound4(adnNum(state.fundUsd)+amountUsd), buyVolumeUsd:adnRound4(adnNum(state.buyVolumeUsd)+amountUsd), buyVolumeToken:adnNum(state.buyVolumeToken)+qty, tradesCount:adnNum(state.tradesCount)+1, investorsCount:adnNum(state.investorsCount)+(tokenBefore<=0?1:0), lastTradeAt:now, updatedAt:now }
    : { ...state, price:newPrice, highPrice:Math.max(adnNum(state.highPrice,currentPrice),newPrice), lowPrice:Math.min(adnNum(state.lowPrice,currentPrice),newPrice), soldSupply:Math.max(0,adnNum(state.soldSupply)-qty), remainingSupply:adnNum(state.remainingSupply)+qty, fundUsd:Math.max(0,adnRound4(adnNum(state.fundUsd)-amountUsd)), sellVolumeUsd:adnRound4(adnNum(state.sellVolumeUsd)+amountUsd), sellVolumeToken:adnNum(state.sellVolumeToken)+qty, tradesCount:adnNum(state.tradesCount)+1, lastTradeAt:now, updatedAt:now };
  const candle = { ...oldCandle, high:Math.max(adnNum(oldCandle.high,currentPrice),currentPrice,newPrice), low:Math.min(adnNum(oldCandle.low,currentPrice),currentPrice,newPrice), close:newPrice, volumeUsd:adnRound4(adnNum(oldCandle.volumeUsd)+amountUsd), buyUsd:adnRound4(adnNum(oldCandle.buyUsd)+(type==='buy'?amountUsd:0)), sellUsd:adnRound4(adnNum(oldCandle.sellUsd)+(type==='sell'?amountUsd:0)), updatedAt:now };
  updates[`users/${user.uid}/updatedAt`] = now;
  updates['game_treasury/current/adn_market_state'] = marketState;
  updates[`game_treasury/current/adn_market_candles/${candleKey}`] = candle;
  const email = profile.email || user.email || '', userName = profile.name || profile.displayName || email || 'مستخدم ADNOR';
  updates[`game_treasury/current/adn_market_trades/${tradeId}`] = { id:tradeId,type,uid:user.uid,email,userName,amountToken:qty,amountUsd,price:executionPrice,marketPriceBefore:currentPrice,marketPriceAfter:newPrice,orderId,source:'cloud_functions_limit_order',createdAt:now };
  const done = { ...order, status:'executed', executedAt:now, executionPrice, amountUsd, marketPriceAfter:newPrice, updatedAt:now };
  updates[`adn_limit_orders/${orderId}`] = done;
  updates[`user_adn_limit_orders/${user.uid}/${orderId}`] = done;
  updates[`transactions/${user.uid}/${txId}`] = { id:txId,type:'server_adn_limit_order_executed',status:'completed',tradeType:type,amountToken:qty,amount:type==='buy'?-amountUsd:amountUsd,price:executionPrice,marketPriceAfter:newPrice,balanceBefore:realBefore,balanceAfter:updates[`users/${user.uid}/realBalance`] ?? realBefore, note:'تنفيذ أمر ADN بسعر محدد',createdAt:now,source:'cloud_functions' };
  updates[`finance_audit/${txId}`] = { id:txId,action:'server_adn_limit_order_executed',uid:user.uid,email,type,qty,amountUsd,executionPrice,orderId,createdAt:now,source:'cloud_functions' };
  updates[`user_notifications/${user.uid}/${txId}`] = notif('adn','تم تنفيذ أمر ADN', type === 'buy' ? `تم شراء ${qty} ADN بسعر $${executionPrice.toFixed(4)}.` : `تم بيع ${qty} ADN بسعر $${executionPrice.toFixed(4)}.`, { orderId, amountToken:qty, amountUsd, executionPrice });
  await db.ref().update(updates);
  return { ok:true, executed:true, orderId, type, qty, amountUsd, price:executionPrice, newPrice };
});


/* ADNOR V144 — Official Draw Scheduler Functions
   هذه الدوال اختيارية لكنها تجعل النشر الحقيقي يتم من السيرفر أيضًا.
   الواجهة تعمل بدونها، لكن نشر functions يجعل النتائج المستحقة تنتقل إلى published تلقائيًا. */
const DRAW_TYPES_V144 = new Set(['daily','weekly','monthly','yearly']);
const DRAW_LABELS_V144 = { daily:'السحب اليومي', weekly:'السحب الأسبوعي', monthly:'السحب الشهري', yearly:'السحب السنوي' };
const DRAW_RESULTS_PATH_V144 = 'system_settings/v108_official_draw_results';

function drawTypeV144(v) {
  const t = cleanText(v, 20);
  if (!DRAW_TYPES_V144.has(t)) throw new HttpsError('invalid-argument', 'نوع السحب غير صحيح.');
  return t;
}
function ticketV144(v) {
  const n = String(v || '').replace(/\D/g, '').slice(0, 7).padStart(7, '0');
  if (!n || n === '0000000') throw new HttpsError('invalid-argument', 'رقم التذكرة غير صحيح.');
  return n;
}
function resultIdV144(type) { return nowId(`draw_${type}`); }
async function publishDueDrawResultsV144() {
  const now = Date.now();
  const snap = await db.ref(`${DRAW_RESULTS_PATH_V144}/scheduled`).get();
  const scheduled = snap.val() || {};
  const updates = {};
  let published = 0;
  for (const type of Object.keys(scheduled)) {
    if (!DRAW_TYPES_V144.has(type)) continue;
    for (const [id, row] of Object.entries(scheduled[type] || {})) {
      if (!row || row.status === 'hidden' || row.status === 'published') continue;
      if (Number(row.publishAt || 0) > now) continue;
      const done = { ...row, id: row.id || id, drawType: type, status: 'published', publishedAt: now, updatedAt: now, source: 'cloud_functions_v144_due_publisher' };
      updates[`${DRAW_RESULTS_PATH_V144}/published/${type}`] = done;
      updates[`${DRAW_RESULTS_PATH_V144}/current/${type}`] = done;
      updates[`${DRAW_RESULTS_PATH_V144}/scheduled/${type}/${id}/status`] = 'published';
      updates[`${DRAW_RESULTS_PATH_V144}/scheduled/${type}/${id}/publishedAt`] = now;
      updates[`${DRAW_RESULTS_PATH_V144}/scheduled/${type}/${id}/updatedAt`] = now;
      updates[`${DRAW_RESULTS_PATH_V144}/history/${type}/${done.id}`] = done;
      updates[`${DRAW_RESULTS_PATH_V144}/latestPublished`] = done;
      updates[`${DRAW_RESULTS_PATH_V144}/latest`] = done;
      updates[`${DRAW_RESULTS_PATH_V144}/tickerUpdatedAt`] = now;
      updates[`admin_notifications/${done.id}_published`] = { id:`${done.id}_published`, type:'draw_result_published', drawType:type, text:`تم نشر نتيجة ${DRAW_LABELS_V144[type]} تلقائيًا`, status:'done', createdAt:now };
      published++;
    }
  }
  if (published) await db.ref().update(updates);
  return { ok:true, published };
}

exports.adminScheduleOfficialDrawResult = onCall(async (request) => {
  const adminUser = await requireAdmin(request);
  const type = drawTypeV144(request.data && request.data.drawType);
  const publishNow = !!(request.data && request.data.publishNow);
  const winnerName = cleanText(request.data && request.data.winnerName, 160);
  const ticketNumber = ticketV144(request.data && request.data.ticketNumber);
  const prize = num(request.data && request.data.prize);
  const publishAt = publishNow ? Date.now() : Number(request.data && request.data.publishAt);
  if (!winnerName) throw new HttpsError('invalid-argument', 'اسم الفائز مطلوب.');
  if (!prize || prize <= 0) throw new HttpsError('invalid-argument', 'قيمة الجائزة غير صحيحة.');
  if (!publishAt || Number.isNaN(publishAt)) throw new HttpsError('invalid-argument', 'وقت النشر غير صحيح.');
  const now = Date.now();
  const id = resultIdV144(type);
  const row = { id, drawType:type, drawLabel:DRAW_LABELS_V144[type], winnerName, ticketNumber, prize, status: publishNow || publishAt <= now ? 'published' : 'scheduled', publishAt: publishNow ? now : publishAt, publishedAt: publishNow || publishAt <= now ? now : 0, createdAt:now, updatedAt:now, adminEmail:adminEmailOf(adminUser), source:'cloud_functions_v144_admin_schedule' };
  const updates = {};
  if (row.status === 'published') {
    updates[`${DRAW_RESULTS_PATH_V144}/published/${type}`] = row;
    updates[`${DRAW_RESULTS_PATH_V144}/current/${type}`] = row;
    updates[`${DRAW_RESULTS_PATH_V144}/latestPublished`] = row;
    updates[`${DRAW_RESULTS_PATH_V144}/latest`] = row;
  } else {
    updates[`${DRAW_RESULTS_PATH_V144}/scheduled/${type}/${id}`] = row;
    updates[`${DRAW_RESULTS_PATH_V144}/upcoming/${type}`] = row;
  }
  updates[`${DRAW_RESULTS_PATH_V144}/history/${type}/${id}`] = row;
  updates[`${DRAW_RESULTS_PATH_V144}/tickerUpdatedAt`] = now;
  updates[`finance_audit/${id}`] = { id, action:'server_draw_result_scheduled', drawType:type, winnerName, ticketNumber, prize, publishAt:row.publishAt, status:row.status, adminEmail:adminEmailOf(adminUser), createdAt:now, source:'cloud_functions' };
  await db.ref().update(updates);
  return { ok:true, id, drawType:type, status:row.status, publishAt:row.publishAt };
});

exports.publishDueOfficialDrawResults = onCall(async (request) => {
  await requireAdmin(request);
  return await publishDueDrawResultsV144();
});

exports.scheduledPublishDueOfficialDrawResults = onSchedule({ schedule: 'every 1 minutes', timeZone: 'Europe/Istanbul' }, async () => {
  await publishDueDrawResultsV144();
});

/* ADNOR V159 — Agent Recharge Wallet System
   نظام وكلاء الشحن: محفظة خاصة للوكيل + شحن مستخدم عبر ID/UID/refCode/email من السيرفر. */
function agentIdClean(v) {
  return cleanText(v, 180).replace(/[\n\r\t]/g, '').trim();
}
function agentStatusLabel(active) { return active === false ? 'stopped' : 'active'; }
async function requireAgent(request) {
  const user = await requireUser(request);
  const snap = await db.ref(`agents/${user.uid}`).get();
  const agent = snap.val();
  if (!agent) throw new HttpsError('permission-denied', 'هذا الحساب ليس وكيل شحن.');
  if (agent.active === false) throw new HttpsError('permission-denied', 'تم إيقاف حساب وكيل الشحن.');
  const fixedBalance = agentBalanceValue(agent);
  if (agent.agentBalance !== fixedBalance) { await db.ref(`agents/${user.uid}`).update({ agentBalance: fixedBalance, updatedAt: Date.now(), balanceFixedBy: 'functions_v165' }).catch(() => null); agent.agentBalance = fixedBalance; }
  return { ...user, agent };
}
async function findUserByPublicIdOrUid(rawId) {
  const q = agentIdClean(rawId);
  if (!q) throw new HttpsError('invalid-argument', 'ID المستخدم مطلوب.');
  const direct = await db.ref(`users/${q}`).get();
  if (direct.exists()) return { uid: q, user: direct.val() || {} };
  const usersSnap = await db.ref('users').get();
  const all = usersSnap.val() || {};
  const qLower = q.toLowerCase();
  for (const [uid, u] of Object.entries(all)) {
    if (!u) continue;
    const candidates = [u.publicId, u.userId, u.uid, u.refCode, u.email, u.phone].filter(Boolean).map(x => String(x).toLowerCase());
    if (candidates.includes(qLower)) return { uid, user: u };
  }
  throw new HttpsError('not-found', 'لم يتم العثور على المستخدم. استخدم UID أو كود الدعوة أو البريد.');
}
async function agentBalanceTransaction(agentUid, delta) {
  const refBal = db.ref(`agents/${agentUid}/agentBalance`);
  const res = await refBal.transaction((current) => {
    const before = agentLooseNum(current, 0);
    const after = Math.round((before + delta) * 100) / 100;
    if (!Number.isFinite(after) || after < 0) return;
    return after;
  });
  if (!res.committed) throw new HttpsError('failed-precondition', 'رصيد الوكيل لا يكفي أو العملية غير متاحة.');
  return num(res.snapshot.val());
}
async function userRealBalanceTransaction(uid, delta) {
  const refBal = db.ref(`users/${uid}/realBalance`);
  const res = await refBal.transaction((current) => {
    const before = agentLooseNum(current, 0);
    const after = Math.round((before + delta) * 100) / 100;
    if (!Number.isFinite(after) || after < 0) return;
    return after;
  });
  if (!res.committed) throw new HttpsError('failed-precondition', 'تعذر تعديل رصيد المستخدم.');
  return num(res.snapshot.val());
}
exports.getAgentDashboard = onCall(async (request) => {
  const a = await requireAgent(request);
  const agentSnap = await db.ref(`agents/${a.uid}`).get();
  const agent = agentSnap.val() || {};
  const logsSnap = await db.ref(`agent_recharges_by_agent/${a.uid}`).orderByChild('createdAt').limitToLast(60).get();
  const logs = Object.values(logsSnap.val() || {}).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
  return {
    ok: true,
    agent: {
      uid: a.uid,
      name: agent.name || a.email || 'وكيل شحن',
      email: agent.email || a.email || '',
      active: agent.active !== false,
      agentBalance: agentBalanceValue(agent),
      totalCharged: num(agent.totalCharged),
      totalOperations: Number(agent.totalOperations || 0),
      dailyLimit: num(agent.dailyLimit),
      monthlyLimit: num(agent.monthlyLimit),
      status: agentStatusLabel(agent.active)
    },
    logs
  };
});
exports.agentFindUser = onCall(async (request) => {
  await requireAgent(request);
  const { uid, user } = await findUserByPublicIdOrUid(request.data && request.data.targetId);
  return { ok: true, user: { uid, name: user.name || user.displayName || 'مستخدم ADNOR', email: user.email || '', realBalance: num(user.realBalance), bonusBalance: num(user.bonusBalance), refCode: user.refCode || '', isFrozen: !!user.isFrozen } };
});
exports.agentRechargeUser = onCall(async (request) => {
  const a = await requireAgent(request);
  const targetId = request.data && request.data.targetId;
  const amount = num(request.data && request.data.amount);
  const note = cleanText(request.data && request.data.note, 800) || 'شحن من وكيل ADNOR';
  if (amount <= 0) throw new HttpsError('invalid-argument', 'مبلغ الشحن غير صحيح.');
  if (amount > 100000) throw new HttpsError('invalid-argument', 'المبلغ كبير جدًا.');
  const { uid: targetUid, user: targetUser } = await findUserByPublicIdOrUid(targetId);
  if (targetUser.isFrozen) throw new HttpsError('failed-precondition', 'حساب المستخدم مجمّد.');
  if (targetUid === a.uid) throw new HttpsError('failed-precondition', 'لا يمكن للوكيل شحن نفسه من محفظة الوكيل.');
  const storedAgentBalance = agentLooseNum((await db.ref(`agents/${a.uid}/agentBalance`).get()).val(), 0);
  const effectiveAgentBalance = Math.max(storedAgentBalance, agentBalanceValue(a.agent));
  if (storedAgentBalance !== effectiveAgentBalance) {
    await db.ref(`agents/${a.uid}/agentBalance`).set(effectiveAgentBalance).catch(() => null);
  }
  const agentBefore = effectiveAgentBalance;
  if (agentBefore < amount) throw new HttpsError('failed-precondition', 'رصيد الوكيل لا يكفي. الرصيد المقروء: $' + agentBefore.toFixed(2));
  const userBefore = num(targetUser.realBalance);
  const now = Date.now();
  const id = nowId('agent_recharge');
  let agentAfter;
  try {
    agentAfter = await agentBalanceTransaction(a.uid, -amount);
  } catch (e) {
    throw e;
  }
  let userAfter;
  try {
    userAfter = await userRealBalanceTransaction(targetUid, amount);
  } catch (e) {
    await agentBalanceTransaction(a.uid, amount).catch(() => null);
    throw e;
  }
  const committedAgentBefore = num(agentAfter + amount);
  const committedUserBefore = num(userAfter - amount);
  const agentName = a.agent.name || a.email || 'وكيل شحن';
  const targetName = targetUser.name || targetUser.displayName || targetUser.email || targetUid;
  const row = {
    id,
    agentUid: a.uid,
    agentName,
    agentEmail: a.agent.email || a.email || '',
    targetUid,
    targetUserId: agentIdClean(targetId),
    targetName,
    targetEmail: targetUser.email || '',
    amount,
    note,
    status: 'completed',
    beforeAgentBalance: committedAgentBefore,
    afterAgentBalance: agentAfter,
    beforeUserBalance: committedUserBefore,
    afterUserBalance: userAfter,
    createdAt: now,
    source: 'cloud_functions_agent_recharge'
  };
  const txUserId = `${id}_user`;
  const txAgentId = `${id}_agent`;
  const updates = {};
  updates[`agents/${a.uid}/totalCharged`] = admin.database.ServerValue.increment(amount);
  updates[`agents/${a.uid}/totalOperations`] = admin.database.ServerValue.increment(1);
  updates[`agents/${a.uid}/lastRechargeAt`] = now;
  updates[`agents/${a.uid}/updatedAt`] = now;
  updates[`users/${targetUid}/updatedAt`] = now;
  updates[`agent_recharges/${id}`] = row;
  updates[`agent_recharges_by_agent/${a.uid}/${id}`] = row;
  updates[`agent_recharges_by_user/${targetUid}/${id}`] = row;
  updates[`transactions/${targetUid}/${txUserId}`] = { id: txUserId, type: 'agent_recharge_credit', amount, balanceBefore: committedUserBefore, balanceAfter: userAfter, status: 'completed', note, agentUid: a.uid, agentName, createdAt: now, source: 'cloud_functions' };
  updates[`transactions/${a.uid}/${txAgentId}`] = { id: txAgentId, type: 'agent_wallet_debit', amount: -amount, balanceBefore: committedAgentBefore, balanceAfter: agentAfter, status: 'completed', note: `شحن المستخدم ${targetName}`, targetUid, createdAt: now, source: 'cloud_functions' };
  updates[`finance_audit/${id}`] = { id, action: 'server_agent_recharge', agentUid: a.uid, agentEmail: a.agent.email || a.email || '', targetUid, targetEmail: targetUser.email || '', amount, beforeAgentBalance: committedAgentBefore, afterAgentBalance: agentAfter, beforeUserBalance: committedUserBefore, afterUserBalance: userAfter, note, createdAt: now, source: 'cloud_functions' };
  updates[`user_notifications/${targetUid}/${id}`] = notif('agent_recharge', 'تم شحن رصيدك', `تم إضافة ${amount}$ إلى رصيدك الحقيقي عبر وكيل ADNOR.`, { amount, agentName, rechargeId: id });
  updates[`admin_notifications/${id}`] = { id, type: 'agent_recharge_completed', agentUid: a.uid, targetUid, text: `${agentName} شحن ${amount}$ للمستخدم ${targetName}`, status: 'done', createdAt: now };
  await db.ref().update(updates);
  return { ok: true, id, agentAfter, userAfter, targetName, amount };
});
exports.adminListAgents = onCall(async (request) => {
  await requireAdmin(request);
  const snap = await db.ref('agents').get();
  const agents = Object.entries(snap.val() || {}).map(([uid, a]) => ({ uid, ...(a || {}), agentBalance: agentBalanceValue(a), totalCharged: num(a && a.totalCharged), active: (a && a.active) !== false })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { ok: true, agents };
});
exports.adminListAgentRecharges = onCall(async (request) => {
  await requireAdmin(request);
  const limit = Math.max(10, Math.min(Number(request.data && request.data.limit) || 100, 300));
  const snap = await db.ref('agent_recharges').orderByChild('createdAt').limitToLast(limit).get();
  const recharges = Object.values(snap.val() || {}).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { ok: true, recharges };
});
exports.adminUpsertAgent = onCall(async (request) => {
  const adminUser = await requireAdmin(request);
  const name = cleanText(request.data && request.data.name, 160);
  const login = normalizeAgentLogin(request.data && request.data.email);
  const email = login.email;
  const loginId = login.loginId;
  const password = String((request.data && request.data.password) || '').trim();
  const initialBalance = num(request.data && request.data.initialBalance);
  const dailyLimit = num(request.data && request.data.dailyLimit);
  const monthlyLimit = num(request.data && request.data.monthlyLimit);
  if (!name) throw new HttpsError('invalid-argument', 'اسم الوكيل مطلوب.');
  let authUser;
  try {
    authUser = await admin.auth().getUserByEmail(email);
    if (password) await admin.auth().updateUser(authUser.uid, { password, displayName: name, disabled: false });
  } catch (e) {
    if (e && e.code && e.code !== 'auth/user-not-found') {
      throw new HttpsError('invalid-argument', 'تعذر إنشاء/تعديل حساب الوكيل: ' + (e.message || e.code));
    }
    if (!password || password.length < 6) throw new HttpsError('invalid-argument', 'كلمة سر الوكيل مطلوبة عند إنشاء وكيل جديد، أقل شيء 6 أحرف.');
    try {
      authUser = await admin.auth().createUser({ email, password, displayName: name, emailVerified: true, disabled: false });
    } catch (e2) {
      throw new HttpsError('invalid-argument', 'تعذر إنشاء الوكيل. تأكد من اسم الدخول/الإيميل وكلمة السر. التفاصيل: ' + (e2.message || e2.code || 'خطأ غير معروف'));
    }
  }
  await admin.auth().setCustomUserClaims(authUser.uid, { agent: true });
  const now = Date.now();
  const oldSnap = await db.ref(`agents/${authUser.uid}`).get();
  const old = oldSnap.val() || {};
  const updates = {};
  updates[`agents/${authUser.uid}`] = {
    ...old,
    uid: authUser.uid,
    name,
    email,
    loginId,
    role: 'agent',
    active: request.data && request.data.active === false ? false : true,
    agentBalance: agentBalanceValue(old),
    totalCharged: num(old.totalCharged),
    totalOperations: Number(old.totalOperations || 0),
    dailyLimit: dailyLimit || num(old.dailyLimit),
    monthlyLimit: monthlyLimit || num(old.monthlyLimit),
    createdAt: old.createdAt || now,
    updatedAt: now,
    createdBy: old.createdBy || adminEmailOf(adminUser),
    updatedBy: adminEmailOf(adminUser)
  };
  updates[`users/${authUser.uid}/uid`] = authUser.uid;
  updates[`users/${authUser.uid}/name`] = name;
  updates[`users/${authUser.uid}/email`] = email;
  updates[`users/${authUser.uid}/loginId`] = loginId;
  updates[`users/${authUser.uid}/role`] = 'agent';
  updates[`users/${authUser.uid}/isAgent`] = true;
  updates[`users/${authUser.uid}/updatedAt`] = now;
  updates[`finance_audit/${nowId('agent_create')}`] = { action: old.createdAt ? 'server_agent_updated' : 'server_agent_created', agentUid: authUser.uid, email, name, adminEmail: adminEmailOf(adminUser), createdAt: now, source: 'cloud_functions' };
  await db.ref().update(updates);
  if (initialBalance > 0) {
    await agentBalanceTransaction(authUser.uid, initialBalance);
    const aid = nowId('agent_fund');
    await db.ref().update({
      [`agent_wallet_logs/${authUser.uid}/${aid}`]: { id: aid, agentUid: authUser.uid, type: 'admin_agent_balance_add', amount: initialBalance, note: 'رصيد بداية من الأدمن', adminEmail: adminEmailOf(adminUser), createdAt: Date.now() },
      [`finance_audit/${aid}`]: { id: aid, action: 'server_agent_balance_add', agentUid: authUser.uid, amount: initialBalance, note: 'رصيد بداية من الأدمن', adminEmail: adminEmailOf(adminUser), createdAt: Date.now(), source: 'cloud_functions' }
    });
  }
  return { ok: true, uid: authUser.uid, email, loginId, name };
});
exports.adminAdjustAgentBalance = onCall(async (request) => {
  const adminUser = await requireAdmin(request);
  const agentUid = cleanText(request.data && request.data.agentUid, 140);
  const amount = num(request.data && request.data.amount);
  const note = cleanText(request.data && request.data.note, 800) || 'تعديل رصيد وكيل';
  if (!agentUid || !amount) throw new HttpsError('invalid-argument', 'الوكيل والمبلغ مطلوبان.');
  const snap = await db.ref(`agents/${agentUid}`).get();
  const agent = snap.val();
  if (!agent) throw new HttpsError('not-found', 'الوكيل غير موجود.');
  const before = agentBalanceValue(agent);
  const after = await agentBalanceTransaction(agentUid, amount);
  const now = Date.now();
  const id = nowId('agent_wallet');
  const row = { id, agentUid, agentName: agent.name || '', agentEmail: agent.email || '', type: amount > 0 ? 'admin_add' : 'admin_deduct', amount, before, after, note, adminEmail: adminEmailOf(adminUser), createdAt: now, source: 'cloud_functions' };
  await db.ref().update({
    [`agents/${agentUid}/updatedAt`]: now,
    [`agents/${agentUid}/updatedBy`]: adminEmailOf(adminUser),
    [`agent_wallet_logs/${agentUid}/${id}`]: row,
    [`finance_audit/${id}`]: { ...row, action: amount > 0 ? 'server_agent_balance_add' : 'server_agent_balance_deduct' }
  });
  return { ok: true, agentUid, before, after };
});
exports.adminToggleAgent = onCall(async (request) => {
  const adminUser = await requireAdmin(request);
  const agentUid = cleanText(request.data && request.data.agentUid, 140);
  const active = !!(request.data && request.data.active);
  const reason = cleanText(request.data && request.data.reason, 500) || (active ? 'تفعيل الوكيل' : 'إيقاف الوكيل');
  const snap = await db.ref(`agents/${agentUid}`).get();
  const agent = snap.val();
  if (!agent) throw new HttpsError('not-found', 'الوكيل غير موجود.');
  const now = Date.now();
  const id = nowId('agent_toggle');
  await admin.auth().updateUser(agentUid, { disabled: !active }).catch(() => null);
  await db.ref().update({
    [`agents/${agentUid}/active`]: active,
    [`agents/${agentUid}/updatedAt`]: now,
    [`agents/${agentUid}/updatedBy`]: adminEmailOf(adminUser),
    [`agent_wallet_logs/${agentUid}/${id}`]: { id, agentUid, type: active ? 'agent_enabled' : 'agent_disabled', reason, adminEmail: adminEmailOf(adminUser), createdAt: now },
    [`finance_audit/${id}`]: { id, action: active ? 'server_agent_enabled' : 'server_agent_disabled', agentUid, email: agent.email || '', reason, adminEmail: adminEmailOf(adminUser), createdAt: now, source: 'cloud_functions' }
  });
  return { ok: true, agentUid, active };
});
