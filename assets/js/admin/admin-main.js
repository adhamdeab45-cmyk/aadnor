import { auth, db, ref, onValue, query, limitToLast, signInWithEmailAndPassword, signOut } from "../core/firebase.js";
import { api } from "../core/api.js";
import { $, $$, showStatus, setBusy, escapeHtml, money, num, cleanText } from "../core/utils.js";

let currentUser = null;
let isAdmin = false;

function setupAdminTabs(){
  $$('[data-admin-tab]').forEach(btn=>btn.addEventListener('click',()=>{
    $$('[data-admin-tab]').forEach(b=>b.classList.toggle('active',b===btn));
    $$('[data-admin-page]').forEach(p=>p.hidden=p.dataset.adminPage!==btn.dataset.adminTab);
  }));
}
function renderAuth(){
  $('#adminLogin').classList.toggle('hide', !!currentUser && isAdmin);
  $('#adminApp').classList.toggle('hide', !(currentUser && isAdmin));
  $('#adminAuthBox').innerHTML = currentUser ? `<button id="adminLogout" class="btn secondary">خروج</button>` : `<span class="muted">غير مسجل</span>`;
  $('#adminLogout')?.addEventListener('click',()=>signOut(auth));
}
async function checkAdmin(user){
  currentUser = user; isAdmin = false; renderAuth();
  if(!user) return;
  try { const r = await api.syncProfile({}); isAdmin = !!r.isAdmin; }
  catch (_) { isAdmin = false; }
  if(!isAdmin) showStatus($('#adminLoginStatus'), 'هذا الحساب ليس أدمن.', 'error');
  renderAuth(); if(isAdmin) startAdminWatchers();
}

auth.onAuthStateChanged(checkAdmin);
$('#btnAdminLogin')?.addEventListener('click', async e=>{
  setBusy(e.currentTarget,true);
  try { await signInWithEmailAndPassword(auth, cleanText($('#adminEmail').value), cleanText($('#adminPass').value)); }
  catch(err){ showStatus($('#adminLoginStatus'), err.message, 'error'); }
  finally{ setBusy(e.currentTarget,false); }
});

function startAdminWatchers(){
  onValue(ref(db,'agents'), snap=>renderAgents(snap.val()||{}));
  onValue(query(ref(db,'finance_requests'), limitToLast(50)), snap=>renderFinance(snap.val()||{}));
  onValue(query(ref(db,'users'), limitToLast(100)), snap=>renderUsers(snap.val()||{}));
  onValue(query(ref(db,'adn_trades'), limitToLast(50)), snap=>renderTrades(snap.val()||{}));
}

function renderAgents(agents){
  const entries = Object.entries(agents).reverse();
  if(!entries.length){ $('#agentsList').textContent='لا يوجد وكلاء بعد.'; return; }
  $('#agentsList').innerHTML = `<table class="table"><tr><th>الوكيل</th><th>الدخول</th><th>الرصيد</th><th>الحالة</th><th>تحكم</th></tr>${entries.map(([uid,a])=>`
    <tr><td>${escapeHtml(a.name)}</td><td>${escapeHtml(a.loginId || a.email)}</td><td>${money(a.balance)}</td><td>${a.active?'مفعل':'موقوف'}</td><td>
      <button class="btn secondary" data-add-agent="${uid}">+ رصيد</button>
      <button class="btn secondary" data-toggle-agent="${uid}" data-active="${a.active?1:0}">${a.active?'إيقاف':'تفعيل'}</button>
    </td></tr>`).join('')}</table>`;
  $$('[data-add-agent]').forEach(b=>b.addEventListener('click',async()=>{
    const amount = prompt('كم تريد إضافة/خصم؟ ضع - للخصم', '100'); if(amount===null) return;
    try{ await api.adminAdjustAgentBalance({ agentUid:b.dataset.addAgent, amount:num(amount) }); }catch(e){ alert(e.message); }
  }));
  $$('[data-toggle-agent]').forEach(b=>b.addEventListener('click',async()=>{
    try{ await api.adminSetAgentActive({ agentUid:b.dataset.toggleAgent, active: b.dataset.active !== '1' }); }catch(e){ alert(e.message); }
  }));
}

$('#btnCreateAgent')?.addEventListener('click', async e=>{
  setBusy(e.currentTarget,true); const st=$('#agentCreateStatus');
  try{
    const res = await api.adminCreateAgent({ name:cleanText($('#agentName').value), loginId:cleanText($('#agentLogin').value), password:cleanText($('#agentPass').value), balance:num($('#agentBalance').value) });
    showStatus(st, `تم إنشاء الوكيل: ${res.loginId}`, 'ok');
  }catch(err){ showStatus(st, err.message, 'error'); }
  finally{ setBusy(e.currentTarget,false); }
});

function renderFinance(data){
  const rows = Object.entries(data).reverse();
  if(!rows.length){ $('#financeRequests').textContent='لا توجد طلبات.'; return; }
  $('#financeRequests').innerHTML = `<table class="table"><tr><th>النوع</th><th>المبلغ</th><th>الحالة</th><th>مستخدم</th><th>تحكم</th></tr>${rows.map(([id,r])=>`<tr><td>${escapeHtml(r.type)}</td><td>${money(r.amount)}</td><td>${escapeHtml(r.status)}</td><td class="ltr">${escapeHtml(r.uid)}</td><td>${r.status==='pending'?`<button class="btn" data-finance-ok="${id}">قبول</button> <button class="btn danger" data-finance-no="${id}">رفض</button>`:''}</td></tr>`).join('')}</table>`;
  $$('[data-finance-ok]').forEach(b=>b.addEventListener('click',()=>api.adminFinanceDecision({requestId:b.dataset.financeOk, decision:'approved'}).catch(e=>alert(e.message))));
  $$('[data-finance-no]').forEach(b=>b.addEventListener('click',()=>api.adminFinanceDecision({requestId:b.dataset.financeNo, decision:'rejected', reason:'مرفوض من الإدارة'}).catch(e=>alert(e.message))));
}
function renderUsers(users){
  const rows = Object.entries(users).reverse();
  $('#usersList').innerHTML = `<table class="table"><tr><th>الاسم</th><th>الإيميل</th><th>Real</th><th>ADN</th><th>دور</th></tr>${rows.map(([uid,u])=>`<tr><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.email)}</td><td>${money(u.realBalance)}</td><td>${Number(u.adnBalance||0).toLocaleString()}</td><td>${escapeHtml(u.role||'user')}</td></tr>`).join('')}</table>`;
}
function renderTrades(trades){
  const rows = Object.entries(trades).reverse();
  if(!rows.length){ $('#adnTrades').textContent='لا توجد عمليات.'; return; }
  $('#adnTrades').innerHTML = `<table class="table"><tr><th>النوع</th><th>USD</th><th>ADN</th><th>مستخدم</th><th>وقت</th></tr>${rows.map(([id,t])=>`<tr><td>${escapeHtml(t.side)}</td><td>${money(t.usd)}</td><td>${Number(t.adn||0).toLocaleString()}</td><td class="ltr">${escapeHtml(t.uid)}</td><td>${escapeHtml(t.createdAt)}</td></tr>`).join('')}</table>`;
}
setupAdminTabs();
renderAuth();
