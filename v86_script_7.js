
(function(){
  if(window.__ADNOR_REFERRAL_PRO_V3__) return;
  window.__ADNOR_REFERRAL_PRO_V3__ = true;

  function $(id){ return document.getElementById(id); }
  function safe(v){ return String(v == null ? '' : v); }
  function h(v){ try { return esc(v); } catch(e){ return safe(v).replace(/[&<>"']/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]}); } }
  function toNum(v){ try { return n(v); } catch(e){ var x=Number(v); return Number.isFinite(x)?x:0; } }
  function cash(v){ try { return money(v); } catch(e){ return '$'+toNum(v).toFixed(2); } }
  function msg(t){ try { toast(t); } catch(e){ alert(t); } }
  function cleanCode(v){ return safe(v).trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,32); }
  function ownCode(uid){ return ('AD'+safe(uid||'USER').replace(/[^A-Za-z0-9]/g,'').slice(-8)).toUpperCase(); }
  function refSettings(){
    var r = (APP && APP.settings && APP.settings.referral) || {};
    if(r.enabled === undefined) r.enabled = true;
    if(r.referrerBonus === undefined) r.referrerBonus = 1;
    if(r.newUserBonus === undefined) r.newUserBonus = 1;
    if(!r.type) r.type = 'bonus';
    return r;
  }
  function getTypedOrUrlRef(){
    var qs = new URLSearchParams(location.search);
    var fromUrl = qs.get('ref') || qs.get('invite') || qs.get('code') || '';
    var fromInput = $('authRefCode') ? $('authRefCode').value : '';
    var val = cleanCode(fromInput || fromUrl || localStorage.getItem('ADNOR_REF') || '');
    if(val) localStorage.setItem('ADNOR_REF', val);
    return val;
  }

  function installStyles(){
    if($('adnorReferralStyle')) return;
    var st = document.createElement('style');
    st.id = 'adnorReferralStyle';
    st.textContent = '.ref-code-pill{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 12px;border:1px solid rgba(245,189,63,.55);border-radius:999px;background:rgba(245,189,63,.10);color:#ffe8a3;font-weight:900;letter-spacing:1px;direction:ltr}.ref-admin-kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}.ref-admin-code{border:1px solid rgba(245,189,63,.24);border-radius:14px;padding:10px;margin:8px 0;background:rgba(0,0,0,.18)}.ref-admin-code.off{opacity:.55}.ref-note{font-size:12px;color:#b9c7dc;line-height:1.7;margin-top:7px}#authRefWrap{transition:.2s ease}';
    document.head.appendChild(st);
  }

  function installAuthReferralField(){
    if(!$('secEmail') || $('authRefWrap')) { toggleAuthRefField(); return; }
    var wrap = document.createElement('div');
    wrap.id = 'authRefWrap';
    wrap.className = 'field hidden';
    wrap.innerHTML = '<label>كود الدعوة / اختياري</label><input id="authRefCode" placeholder="مثال: AD123456" style="direction:ltr;text-align:left;text-transform:uppercase"><div class="ref-note">إذا دخلت من رابط دعوة، سيظهر الكود تلقائياً. المكافأة يحددها الأدمن.</div>';
    var after = $('confirmPassWrap') || $('secEmail').lastElementChild;
    if(after && after.parentNode) after.parentNode.insertBefore(wrap, after.nextSibling); else $('secEmail').appendChild(wrap);
    var v = getTypedOrUrlRef();
    if(v && $('authRefCode')) $('authRefCode').value = v;
    $('authRefCode') && $('authRefCode').addEventListener('input', function(){ localStorage.setItem('ADNOR_REF', cleanCode(this.value)); });
    toggleAuthRefField();
  }
  function toggleAuthRefField(){
    var wrap = $('authRefWrap');
    if(!wrap) return;
    var isReg = APP && APP.authMode === 'register';
    wrap.classList.toggle('hidden', !isReg);
  }

  async function ensureUserReferralCode(uid){
    if(!uid || !db) return '';
    var u = (APP.users && APP.users[uid]) || (APP.user && APP.user.uid === uid ? APP.user : {}) || {};
    var code = cleanCode(u.refCode || ownCode(uid));
    try{
      if(!u.refCode) await db.ref('users/'+uid).update({refCode:code});
      var lk = await db.ref('referral_lookup/'+code).once('value');
      if(!lk.exists()) await db.ref('referral_lookup/'+code).set({uid:uid,createdAt:Date.now(),type:'user'});
    }catch(e){ console.warn('ref code ensure failed', e); }
    return code;
  }

  async function resolveReferral(code, newUid){
    code = cleanCode(code);
    if(!code) return null;
    var r = refSettings();
    try{
      var cs = await db.ref('referral_codes/'+code).once('value');
      if(cs.exists()){
        var c = cs.val() || {};
        if(c.enabled === false) return {blocked:true, reason:'الكود متوقف'};
        if(c.usageLimit && toNum(c.usedCount) >= toNum(c.usageLimit)) return {blocked:true, reason:'انتهى حد استخدام الكود'};
        var owner = c.ownerUid || '';
        if(owner && owner === newUid) return {blocked:true, reason:'لا يمكن استخدام كودك لنفسك'};
        return {code:code, ownerUid:owner, custom:true, referrerBonus:toNum(c.referrerBonus ?? r.referrerBonus), newUserBonus:toNum(c.newUserBonus ?? r.newUserBonus), type:c.type || r.type || 'bonus'};
      }
      var ls = await db.ref('referral_lookup/'+code).once('value');
      if(ls.exists()){
        var val = ls.val();
        var uid = typeof val === 'string' ? val : (val && val.uid) || '';
        if(uid && uid !== newUid) return {code:code, ownerUid:uid, custom:false, referrerBonus:toNum(r.referrerBonus), newUserBonus:toNum(r.newUserBonus), type:r.type || 'bonus'};
      }
      var us = await db.ref('users/'+code).once('value');
      if(us.exists() && code !== newUid) return {code:code, ownerUid:code, custom:false, referrerBonus:toNum(r.referrerBonus), newUserBonus:toNum(r.newUserBonus), type:r.type || 'bonus'};
    }catch(e){ console.warn('resolve referral failed', e); }
    return {blocked:true, reason:'كود الدعوة غير موجود'};
  }

  async function creditUser(uid, field, amount, tx){
    amount = toNum(amount);
    if(!uid || amount <= 0) return;
    field = field === 'balance' ? 'balance' : 'bonus';
    var snap = await db.ref('users/'+uid).once('value');
    if(!snap.exists()) return;
    var u = snap.val() || {};
    var txs = Array.isArray(u.txs) ? u.txs : (u.txs && typeof u.txs === 'object' ? Object.values(u.txs) : []);
    txs.unshift(Object.assign({amt:amount,status:'✅',time:(typeof nowStr==='function'?nowStr():new Date().toLocaleString('ar'))}, tx || {}));
    var upd = {}; upd[field] = toNum(u[field]) + amount; upd.txs = txs;
    await db.ref('users/'+uid).update(upd);
  }

  async function applyReferralReward(newUid, code){
    code = cleanCode(code);
    if(!newUid || !code) return;
    var used = await db.ref('referral_used/'+newUid).once('value');
    if(used.exists()) return;
    var data = await resolveReferral(code, newUid);
    if(!data || data.blocked){
      await db.ref('referral_used/'+newUid).set({code:code,ok:false,reason:(data&&data.reason)||'غير صالح',at:Date.now()});
      return;
    }
    var field = data.type === 'balance' ? 'balance' : 'bonus';
    if(toNum(data.newUserBonus) > 0) await creditUser(newUid, field, data.newUserBonus, {type:'🎁 مكافأة تسجيل بكود دعوة',code:code});
    if(data.ownerUid && toNum(data.referrerBonus) > 0) await creditUser(data.ownerUid, field, data.referrerBonus, {type:'🔗 مكافأة دعوة مستخدم',code:code,user:newUid});
    await db.ref('referral_used/'+newUid).set({code:code,ok:true,ownerUid:data.ownerUid||'',newUserBonus:toNum(data.newUserBonus),referrerBonus:toNum(data.referrerBonus),type:field,at:Date.now()});
    await db.ref('referral_logs').push({code:code,newUid:newUid,ownerUid:data.ownerUid||'',newUserBonus:toNum(data.newUserBonus),referrerBonus:toNum(data.referrerBonus),type:field,time:(typeof nowStr==='function'?nowStr():new Date().toLocaleString('ar')),at:Date.now()});
    if(data.custom) await db.ref('referral_codes/'+code).update({usedCount: firebase.database.ServerValue.increment ? firebase.database.ServerValue.increment(1) : (toNum((APP.referralCodes&&APP.referralCodes[code]&&APP.referralCodes[code].usedCount))+1), lastUsedAt:Date.now()}).catch(async function(){
      var s=await db.ref('referral_codes/'+code+'/usedCount').once('value');
      await db.ref('referral_codes/'+code).update({usedCount:toNum(s.val())+1,lastUsedAt:Date.now()});
    });
  }

  function patchUserCreate(){
    if(!window.USER || USER.__referralPatched) return;
    USER.create = async function(u,data){
      data = data || {};
      var pendingRef = cleanCode(data.ref || getTypedOrUrlRef());
      var userCode = ownCode(u.uid);
      var user = {
        uid:u.uid,
        name:data.name || (u.displayName || (u.email ? u.email.split('@')[0] : 'مستخدم')),
        email:data.email || u.email || '',
        phone:data.phone || u.phoneNumber || '',
        balance:0,
        bonus:0,
        tickets:[],
        txs:[],
        createdAt:Date.now(),
        lastLogin:Date.now(),
        invitedBy:pendingRef || '',
        refCode:userCode,
        frozen:false
      };
      await db.ref('users/'+u.uid).set(user);
      await db.ref('referral_lookup/'+userCode).set({uid:u.uid,createdAt:Date.now(),type:'user'});
      if(pendingRef) await applyReferralReward(u.uid, pendingRef);
      localStorage.removeItem('ADNOR_REF');
    };
    USER.ensure = async function(u){
      var snap = await db.ref('users/'+u.uid).once('value');
      if(!snap.exists()) await USER.create(u,{name:u.displayName || (u.email?u.email.split('@')[0]:'مستخدم'),email:u.email||'',phone:u.phoneNumber||'',ref:getTypedOrUrlRef()});
      else { await ensureUserReferralCode(u.uid); await db.ref('users/'+u.uid).update({lastLogin:Date.now()}).catch(function(){}); }
    };
    USER.__referralPatched = true;
  }

  function patchAuthSubmit(){
    if(!window.AUTH || AUTH.__referralInputPatched) return;
    var oldSubmit = AUTH.submit;
    AUTH.submit = function(){ getTypedOrUrlRef(); return oldSubmit.apply(this, arguments); };
    var oldGoogle = AUTH.google;
    AUTH.google = async function(){ getTypedOrUrlRef(); return oldGoogle.apply(this, arguments); };
    var oldSet = AUTH.setMethod;
    AUTH.setMethod = function(){ var r = oldSet.apply(this, arguments); installAuthReferralField(); toggleAuthRefField(); return r; };
    AUTH.__referralInputPatched = true;
  }

  function patchUIRender(){
    if(!window.UI || UI.__referralPatched) return;
    var oldRender = UI.render;
    UI.render = function(){
      var r = oldRender.apply(this, arguments);
      updateReferralCard();
      return r;
    };
    UI.__referralPatched = true;
  }
  async function updateReferralCard(){
    try{
      if(!APP.user || !$('refLink')) return;
      var code = cleanCode(APP.user.refCode || ownCode(APP.user.uid));
      if(!APP.user.refCode){ APP.user.refCode = code; ensureUserReferralCode(APP.user.uid); }
      var link = location.origin + location.pathname + '?ref=' + encodeURIComponent(code);
      $('refLink').textContent = link;
      var box = $('refLink').parentElement;
      if(box && !$('myRefCodeShow')){
        var pill = document.createElement('div');
        pill.id = 'myRefCodeShow';
        pill.style.margin = '10px 0';
        pill.innerHTML = '<span class="muted">كود دعوتك:</span><br><span class="ref-code-pill">'+h(code)+'</span>';
        box.insertBefore(pill, $('refLink'));
      } else if($('myRefCodeShow')) {
        $('myRefCodeShow').innerHTML = '<span class="muted">كود دعوتك:</span><br><span class="ref-code-pill">'+h(code)+'</span>';
      }
    }catch(e){ console.warn('ref card update failed', e); }
  }

  function installReferralListeners(){
    if(APP.__referralListeners) return;
    APP.referralCodes = APP.referralCodes || {};
    APP.referralLogs = APP.referralLogs || {};
    try{ db.ref('referral_codes').on('value', function(s){ APP.referralCodes=s.val()||{}; if(ADMIN&&ADMIN.refreshIfOpen)ADMIN.refreshIfOpen(); }); }catch(e){}
    try{ db.ref('referral_logs').limitToLast(80).on('value', function(s){ APP.referralLogs=s.val()||{}; if(ADMIN&&ADMIN.refreshIfOpen)ADMIN.refreshIfOpen(); }); }catch(e){}
    APP.__referralListeners = true;
  }

  function addAdminReferralMenu(){
    var menu = document.querySelector('.admin-menu');
    if(!menu || $('adm-referrals')) return;
    var b = document.createElement('button');
    b.id = 'adm-referrals';
    b.innerHTML = '🔗 الدعوات';
    b.onclick = function(){ ADMIN.sec('referrals'); };
    var before = $('adm-inject') || menu.lastElementChild;
    menu.insertBefore(b, before);
  }
  function patchAdminReferral(){
    if(!window.ADMIN || ADMIN.__referralPatched) return;
    var oldRender = ADMIN.render;
    ADMIN.render = function(){
      addAdminReferralMenu();
      if(this.section === 'referrals'){
        var m = $('adminMain'); if(!m) return;
        document.querySelectorAll('.admin-menu button').forEach(function(x){x.classList.remove('active')});
        var btn = $('adm-referrals'); if(btn) btn.classList.add('active');
        m.innerHTML = ADMIN.referrals();
        return;
      }
      return oldRender.apply(this, arguments);
    };
    ADMIN.referrals = function(){
      var r = refSettings();
      var codes = APP.referralCodes || {};
      var logs = APP.referralLogs || {};
      var totalCodes = Object.keys(codes).length;
      var totalLogs = Object.keys(logs).length;
      var activeCodes = Object.values(codes).filter(function(c){return c && c.enabled!==false}).length;
      var recentLogs = Object.entries(logs).sort(function(a,b){return toNum(b[1].at)-toNum(a[1].at)}).slice(0,50);
      var codesHtml = Object.entries(codes).sort(function(a,b){return safe(a[0]).localeCompare(safe(b[0]))}).map(function(pair){
        var code=pair[0], c=pair[1]||{};
        return '<div class="ref-admin-code '+(c.enabled===false?'off':'')+'"><div class="row"><div><b class="ref-code-pill">'+h(code)+'</b><small>صاحب الكود: '+h(c.ownerUid||'عام')+' | استخدام: '+toNum(c.usedCount)+'/'+(c.usageLimit?toNum(c.usageLimit):'∞')+'</small></div><button class="smallbtn" onclick="ADMIN.toggleReferralCode(\''+h(code)+'\')">'+(c.enabled===false?'تفعيل':'إيقاف')+'</button></div><small>صاحب الدعوة: '+cash(c.referrerBonus)+' | الجديد: '+cash(c.newUserBonus)+' | النوع: '+h(c.type||r.type||'bonus')+'</small></div>';
      }).join('') || '<p class="muted">لا توجد أكواد مخصصة بعد.</p>';
      var logHtml = recentLogs.map(function(pair){var x=pair[1]||{}; return '<div class="row"><div><b>'+h(x.code||'')+'</b><small>جديد: '+h(x.newUid||'')+' | صاحب الدعوة: '+h(x.ownerUid||'')+' | '+h(x.time||'')+'</small></div><span class="badge">+'+cash(toNum(x.referrerBonus)+toNum(x.newUserBonus))+'</span></div>';}).join('') || '<p class="muted">لا توجد عمليات دعوة بعد.</p>';
      return '<div class="card"><h3>🔗 إدارة كود الدعوة</h3><p class="muted">هنا تحدد كم يربح صاحب الدعوة وكم يربح المستخدم الجديد. المكافأة تُضاف مرة واحدة فقط عند إنشاء الحساب.</p><div class="ref-admin-kpi"><div class="mini"><span>الأكواد</span><b>'+totalCodes+'</b></div><div class="mini"><span>المفعلة</span><b>'+activeCodes+'</b></div><div class="mini"><span>عمليات دعوة</span><b>'+totalLogs+'</b></div></div><div class="admin-grid"><div class="admin-field"><label>مكافأة صاحب الدعوة $</label><input id="refSetA" class="finp" type="number" value="'+toNum(r.referrerBonus)+'"></div><div class="admin-field"><label>مكافأة المستخدم الجديد $</label><input id="refSetB" class="finp" type="number" value="'+toNum(r.newUserBonus)+'"></div><div class="admin-field"><label>مكان الإضافة</label><select id="refSetType" class="finp"><option value="bonus" '+((r.type||'bonus')==='bonus'?'selected':'')+'>بونص</option><option value="balance" '+(r.type==='balance'?'selected':'')+'>رصيد أساسي</option></select></div><div class="admin-field"><label>تفعيل الدعوات</label><select id="refSetEnabled" class="finp"><option value="1" '+(r.enabled!==false?'selected':'')+'>مفعلة</option><option value="0" '+(r.enabled===false?'selected':'')+'>متوقفة</option></select></div></div><button class="btn full" onclick="ADMIN.saveReferralSettings()">حفظ إعدادات الدعوات</button></div><div class="card"><h3>➕ إضافة كود دعوة مخصص</h3><div class="field"><label>الكود</label><input id="newRefCode" class="finp" placeholder="ADNOR1" style="direction:ltr;text-align:left;text-transform:uppercase"></div><div class="field"><label>UID صاحب الكود / اختياري</label><input id="newRefOwner" class="finp" placeholder="UID المستخدم الذي سيربح" style="direction:ltr;text-align:left"></div><div class="admin-grid"><div class="admin-field"><label>ربح صاحب الكود</label><input id="newRefA" class="finp" type="number" value="'+toNum(r.referrerBonus)+'"></div><div class="admin-field"><label>ربح المسجل الجديد</label><input id="newRefB" class="finp" type="number" value="'+toNum(r.newUserBonus)+'"></div><div class="admin-field"><label>حد الاستخدام</label><input id="newRefLimit" class="finp" type="number" placeholder="0 = مفتوح"></div></div><button class="btn green full" onclick="ADMIN.addReferralCode()">إضافة / تحديث الكود</button></div><div class="card"><h3>الأكواد المحفوظة</h3>'+codesHtml+'</div><div class="card"><h3>سجل الدعوات</h3>'+logHtml+'</div>';
    };
    ADMIN.saveReferralSettings = async function(){
      var r = {enabled:$('refSetEnabled').value==='1', referrerBonus:toNum($('refSetA').value), newUserBonus:toNum($('refSetB').value), type:$('refSetType').value||'bonus', requireCode:true};
      await db.ref('global_system/settings/referral').set(r);
      msg('✅ تم حفظ إعدادات الدعوات');
    };
    ADMIN.addReferralCode = async function(){
      var code = cleanCode(($('newRefCode')||{}).value);
      if(!code) return msg('اكتب كود الدعوة');
      var owner = safe(($('newRefOwner')||{}).value).trim();
      var obj = {code:code, ownerUid:owner, referrerBonus:toNum(($('newRefA')||{}).value), newUserBonus:toNum(($('newRefB')||{}).value), usageLimit:toNum(($('newRefLimit')||{}).value), usedCount:(APP.referralCodes&&APP.referralCodes[code]&&APP.referralCodes[code].usedCount)||0, type:(APP.settings.referral&&APP.settings.referral.type)||'bonus', enabled:true, updatedAt:Date.now()};
      await db.ref('referral_codes/'+code).set(obj);
      msg('✅ تم حفظ كود الدعوة');
      if(ADMIN.refreshIfOpen) ADMIN.refreshIfOpen();
    };
    ADMIN.toggleReferralCode = async function(code){
      code = cleanCode(code);
      var c = (APP.referralCodes||{})[code] || {};
      await db.ref('referral_codes/'+code).update({enabled:c.enabled===false,updatedAt:Date.now()});
      msg(c.enabled===false?'✅ تم تفعيل الكود':'⛔ تم إيقاف الكود');
    };
    ADMIN.__referralPatched = true;
  }

  function bootReferral(){
    try{
      installStyles();
      installReferralListeners();
      installAuthReferralField();
      patchUserCreate();
      patchAuthSubmit();
      patchUIRender();
      patchAdminReferral();
      addAdminReferralMenu();
      updateReferralCard();
    }catch(e){ console.error('ADNOR referral boot error', e); }
  }
  setTimeout(bootReferral,200);
  setTimeout(bootReferral,1000);
  setTimeout(bootReferral,2500);
  setInterval(bootReferral,5000);
})();
