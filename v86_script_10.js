
(function ADNOR_V8_GMAIL_PHONE_FINAL(){
  if(window.__ADNOR_V8_GMAIL_PHONE_FINAL__) return;
  window.__ADNOR_V8_GMAIL_PHONE_FINAL__ = true;

  function $(id){ return document.getElementById(id); }
  function q(sel){ return document.querySelector(sel); }
  function qa(sel){ return Array.from(document.querySelectorAll(sel)); }
  function esc2(v){
    return String(v == null ? '' : v).replace(/[&<>"']/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]});
  }
  function shortCode(u){
    var id = (u && u.uid) ? String(u.uid) : 'ADNOR';
    return id.slice(0,5).toUpperCase();
  }
  function publicName(u){
    if(!u) return 'ADNOR USER';
    var n = (u.name || u.displayName || '').trim();
    if(n && !/@/.test(n)) return n;
    if(u.phone) return 'ADNOR USER';
    return 'ADNOR USER';
  }
  function showSafeError(msg){
    try{ if(window.showAuthError) return showAuthError(msg); }catch(e){}
    var el=$('authError'); if(el){el.textContent=msg; el.style.display='block';}
  }
  function clearSafeError(){ try{ if(window.clearAuthError) return clearAuthError(); }catch(e){} var el=$('authError'); if(el){el.textContent='';el.style.display='none';} }
  function toast2(t){ try{ if(window.toast) return toast(t); }catch(e){} alert(t); }

  function installLoginUI(){
    var style=$('adnorV8LoginStyle');
    if(!style){
      style=document.createElement('style');
      style.id='adnorV8LoginStyle';
      style.textContent = `
        #loginTab,#registerTab,#methodEmail,#secEmail,#resetPassBtn,#nameWrap,#confirmPassWrap{display:none!important;visibility:hidden!important;height:0!important;overflow:hidden!important}
        .auth-card .brand p{font-weight:800;color:#ffe29b!important}
        .adnor-v7-auth-title{margin:10px 0 12px;text-align:center;padding:12px;border:1px solid rgba(245,189,63,.28);border-radius:18px;background:linear-gradient(135deg,rgba(245,189,63,.13),rgba(18,201,255,.06));color:#f7d98a;font-weight:900;line-height:1.7}
        .adnor-v7-domain{margin-top:10px;display:grid;gap:7px}.adnor-v7-domain code{display:block;direction:ltr;text-align:center;background:rgba(0,0,0,.25);border:1px solid rgba(245,189,63,.25);border-radius:12px;padding:8px;color:#93c5fd;font-size:12px;word-break:break-all}
        #googleBtn{min-height:54px;font-size:16px;border-radius:16px!important;box-shadow:0 10px 28px rgba(255,255,255,.12)!important}
        #methodGoogle,#methodPhone{border-radius:16px!important;min-height:50px!important}.phone-tip{font-size:12px;color:#b9c7dc;line-height:1.7;margin:6px 0 0}
        #userChip{max-width:180px!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.profile-email-line{display:none!important}
      `;
      document.head.appendChild(style);
    }
    var brandP=q('.auth-card .brand p');
    if(brandP) brandP.textContent='دخول آمن — Google أو رقم الهاتف فقط';
    var tabs=q('.auth-card .auth-tabs');
    if(tabs) tabs.style.display='none';
    var methods=$('methodGoogle') && $('methodGoogle').parentElement;
    if(methods && !$('adnorV8AuthTitle')){
      methods.insertAdjacentHTML('beforebegin','<div id="adnorV8AuthTitle" class="adnor-v7-auth-title">👑 ADNOR Login<br><span style="font-size:12px;color:#cbd5e1">لا يوجد إيميل مع كلمة سر. الدخول فقط عبر Google أو الهاتف.</span></div>');
    }
    var emailBtn=$('methodEmail'); if(emailBtn){ emailBtn.classList.add('hidden'); emailBtn.style.display='none'; }
    var secEmail=$('secEmail'); if(secEmail){ secEmail.classList.add('hidden'); secEmail.style.display='none'; }
    var reset=$('resetPassBtn'); if(reset){ reset.classList.add('hidden'); reset.style.display='none'; }
    var phoneNum=$('authPhoneNum');
    if(phoneNum && !phoneNum.dataset.v7Tip){
      phoneNum.dataset.v7Tip='1';
      phoneNum.insertAdjacentHTML('afterend','<div class="phone-tip">اكتب الرقم بصيغة دولية، مثال تركيا: +905xxxxxxxxx</div>');
    }
    if(!$('copyDomainBtn') && $('googleNote')){
      $('googleNote').insertAdjacentHTML('afterend','<div class="adnor-v7-domain"><button type="button" id="copyDomainBtn" class="btn ghost full">نسخ دومين الموقع</button><code id="domainCopyText">'+esc2(location.hostname)+'</code></div>');
      $('copyDomainBtn').onclick=function(){
        var h=location.hostname;
        if(navigator.clipboard) navigator.clipboard.writeText(h).catch(function(){});
        toast2('تم نسخ الدومين: '+h);
      };
    }
    if(window.AUTH){
      if(!AUTH.method || AUTH.method==='email') AUTH.method='google';
      try{ AUTH.setMethod(AUTH.method); }catch(e){}
    }
  }

  function patchAuthCore(){
    if(!window.AUTH || AUTH.__v7AuthPatched) return;
    AUTH.__v7AuthPatched = true;
    var oldSetMethod = AUTH.setMethod ? AUTH.setMethod.bind(AUTH) : null;
    AUTH.setMethod = function(m){
      m = (m==='phone') ? 'phone' : 'google';
      this.method=m;
      clearSafeError();
      ['Google','Phone','Email'].forEach(function(x){
        var btn=$('method'+x), sec=$('sec'+x);
        if(btn){ btn.classList.toggle('active', x.toLowerCase()===m); if(x==='Email'){btn.classList.add('hidden'); btn.style.display='none';} }
        if(sec){ sec.classList.toggle('hidden', x.toLowerCase()!==m); if(x==='Email'){sec.classList.add('hidden'); sec.style.display='none';} }
      });
      var authBtn=$('authBtn');
      if(authBtn){ authBtn.style.display=(m==='phone')?'':'none'; authBtn.textContent=(this.phoneStep==='otp')?'تحقق والدخول':'إرسال كود التحقق'; }
      var reset=$('resetPassBtn'); if(reset){reset.classList.add('hidden'); reset.style.display='none';}
      var phoneName=$('phoneNameWrap'); if(phoneName) phoneName.classList.add('hidden');
      var otp=$('otpWrap'); if(otp && this.phoneStep!=='otp') otp.classList.add('hidden');
      var pn=$('authPhoneNum'); if(pn && this.phoneStep!=='otp') pn.disabled=false;
    };
    AUTH.submit = function(){
      if(this.busy) return;
      if(this.method==='phone') return this._submitPhone();
      return this.google();
    };
    AUTH.friendlyError = function(e){
      var code=(e&&e.code)||'';
      if(code==='auth/unauthorized-domain') return 'الدومين غير مضاف في Firebase Authorized Domains: '+location.hostname;
      if(code==='auth/operation-not-allowed') return 'طريقة الدخول غير مفعلة في Firebase. فعّل Google أو Phone من Authentication.';
      if(code==='auth/popup-closed-by-user') return 'تم إغلاق نافذة Google قبل إكمال الدخول.';
      if(code==='auth/popup-blocked') return 'المتصفح منع نافذة Google. افتح الموقع من تبويب عادي أو اسمح بالنوافذ المنبثقة.';
      if(code==='auth/invalid-phone-number') return 'رقم الهاتف غير صحيح. استخدم الصيغة الدولية مثل +905xxxxxxxxx';
      if(code==='auth/invalid-verification-code') return 'رمز التحقق غير صحيح.';
      if(code==='auth/code-expired') return 'انتهت صلاحية رمز التحقق، أرسل كود جديد.';
      if(code==='auth/too-many-requests') return 'محاولات كثيرة. انتظر قليلاً ثم جرّب مرة ثانية.';
      if(code==='auth/captcha-check-failed') return 'فشل reCAPTCHA. حدّث الصفحة وجرب مرة ثانية.';
      return (e && (e.message||e.code)) || String(e||'خطأ غير معروف');
    };
    AUTH.google = async function(){
      if(this.busy) return;
      if(!this.needLegal()) return;
      this.busy=true; clearSafeError();
      var btn=$('googleBtn'), old=btn?btn.innerHTML:'';
      if(btn){btn.disabled=true;btn.innerHTML='⏳ جاري فتح Google...';}
      try{
        await this.ready();
        var ref = new URLSearchParams(location.search).get('ref') || localStorage.getItem('ADNOR_REF') || '';
        if(ref) localStorage.setItem('ADNOR_REF', ref);
        var provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({prompt:'select_account'});
        // مهم: authDomain ثابت على adhamnnn-8a4d2.firebaseapp.com، وليس دومين Render. هذا أصلح redirect_uri_mismatch.
        try{
          await auth.signInWithPopup(provider);
        }catch(pe){
          if(pe && (pe.code==='auth/popup-blocked' || pe.code==='auth/cancelled-popup-request')){
            await auth.signInWithRedirect(provider);
            return;
          }
          if(pe && pe.code==='auth/popup-closed-by-user'){ clearSafeError(); return; }
          throw pe;
        }
      }catch(e){
        var note=$('googleNote'); if(note) note.style.display='';
        showSafeError('Google Login فشل: '+AUTH.friendlyError(e));
      }finally{
        this.busy=false;
        if(btn){btn.disabled=false;btn.innerHTML=old || '<i class="fa-brands fa-google"></i> متابعة بحساب Google';}
      }
    };
    AUTH.completeRedirect = async function(){
      try{
        await this.ready();
        var res = await auth.getRedirectResult();
        if(res && res.user){ try{ if(window.authLog) authLog('redirect OK uid='+res.user.uid); }catch(e){} }
      }catch(e){
        if(e && (e.code==='auth/no-auth-event'||e.code==='auth/null-user')) return;
        showSafeError('Google Redirect فشل: '+AUTH.friendlyError(e));
      }
    };
    try{ AUTH.setMethod('google'); }catch(e){}
  }

  function patchPhoneRecaptcha(){
    if(!window.AUTH || AUTH.__v7PhonePatched) return;
    AUTH.__v7PhonePatched = true;
    AUTH._sendOTP = async function(){
      if(!this.needLegal()) return;
      clearSafeError();
      var phone=($('authPhoneNum')&&$('authPhoneNum').value||'').trim().replace(/\s+/g,'');
      if(!phone || phone.charAt(0)!=='+') return showSafeError('اكتب رقم الهاتف بصيغة دولية مثل +905xxxxxxxxx');
      this.busy=true;
      var btn=$('authBtn'); if(btn){btn.disabled=true;btn.textContent='⏳ جاري إرسال الكود...';}
      try{
        await this.ready();
        var holder=$('recaptchaContainer');
        if(holder) holder.innerHTML='';
        this.recaptcha = new firebase.auth.RecaptchaVerifier('recaptchaContainer',{size:'invisible'});
        await this.recaptcha.render();
        this.phoneConfirm = await auth.signInWithPhoneNumber(phone,this.recaptcha);
        this.phoneStep='otp';
        var otp=$('otpWrap'); if(otp) otp.classList.remove('hidden');
        var pn=$('authPhoneNum'); if(pn) pn.disabled=true;
        if(btn){btn.disabled=false;btn.textContent='تحقق والدخول';}
        showSafeError('✅ تم إرسال الكود إلى '+phone+'\nأدخل رمز التحقق واضغط تحقق والدخول.');
        var err=$('authError'); if(err){err.style.background='rgba(24,242,155,.10)';err.style.color='#a7ffd3';err.style.borderColor='rgba(24,242,155,.3)';}
      }catch(e){
        if(this.recaptcha){ try{this.recaptcha.clear();}catch(x){} this.recaptcha=null; }
        showSafeError('Phone OTP فشل: '+AUTH.friendlyError(e));
      }finally{
        this.busy=false;
        if(btn && this.phoneStep!=='otp'){btn.disabled=false;btn.textContent='إرسال كود التحقق';}
      }
    };
  }

  function patchPublicIdentity(){
    if(!window.UI || UI.__v7IdentityPatched) return;
    UI.__v7IdentityPatched = true;
    var oldRender = UI.render ? UI.render.bind(UI) : null;
    UI.render = function(){
      if(oldRender) oldRender();
      if(!window.APP || !APP.user) return;
      var chip=$('userChip');
      if(chip) chip.textContent = publicName(APP.user)+' | '+shortCode(APP.user);
      var pc=$('profileContent');
      if(pc){
        var u=APP.user;
        pc.innerHTML='<div class="profile-head"><b>'+esc2(publicName(u))+'</b><small>'+esc2(u.uid||'')+'</small></div>'+ 
          '<div class="mini"><span>ID الحساب</span><b class="ltr">'+esc2(shortCode(u))+'</b></div>'+ 
          '<div class="mini"><span>الهاتف</span><b>'+esc2(u.phone||'-')+'</b></div>'+ 
          '<div class="mini"><span>الرصيد الأساسي</span><b>'+((window.money)?money(u.balance):('$'+Number(u.balance||0).toFixed(2)))+'</b></div>'+ 
          '<div class="mini"><span>البونص</span><b>'+((window.money)?money(u.bonus):('$'+Number(u.bonus||0).toFixed(2)))+'</b></div>'+ 
          '<div class="mini"><span>التذاكر</span><b>'+((Array.isArray(u.tickets)?u.tickets.length:0))+'</b></div>'+ 
          '<div class="mini"><span>العمليات</span><b>'+((Array.isArray(u.txs)?u.txs.length:0))+'</b></div>'+ 
          '<button class="btn full" style="grid-column:1/-1" onclick="UI.changeName()">تغيير الاسم</button>';
      }
    };
    var oldSettings = UI.settings ? UI.settings.bind(UI) : null;
    UI.settings = function(){
      var u=APP.user||{};
      UI.modal('<h3>⚙️ الإعدادات والملف الشخصي</h3><div class="profile-grid" style="margin-bottom:12px"><div class="profile-head"><b>'+esc2(publicName(u))+'</b><small>'+esc2(u.uid||'')+'</small></div><div class="mini"><span>اسم العرض</span><b>'+esc2(u.name||publicName(u))+'</b></div><div class="mini"><span>ID الحساب</span><b class="ltr">'+esc2(shortCode(u))+'</b></div><div class="mini"><span>الهاتف</span><b>'+esc2(u.phone||'-')+'</b></div></div><div class="field"><label>تغيير الاسم</label><input id="newName" class="finp" value="'+esc2(u.name||'')+'"></div><button class="btn full" onclick="APP.user.name=document.getElementById(\'newName\').value.trim()||APP.user.name;USER.save();UI.closeModal();UI.render();toast(\'✅ تم حفظ الإعدادات\')">حفظ</button>');
    };
  }

  function patchUserCreateIdentity(){
    if(!window.USER || USER.__v7UserPatched) return;
    USER.__v7UserPatched = true;
    USER.ensure = async function(u){
      var snap=await db.ref('users/'+u.uid).once('value');
      if(!snap.exists()){
        var nm = u.displayName || (u.phoneNumber ? 'ADNOR USER' : 'ADNOR USER');
        await USER.create(u,{name:nm,email:u.email||'',phone:u.phoneNumber||'',ref:localStorage.getItem('ADNOR_REF')||''});
      }else{
        var upd={lastLogin:Date.now()};
        if(u.phoneNumber) upd.phone=u.phoneNumber;
        if(u.email) upd.email=u.email;
        if(u.displayName && (!snap.val().name || /@/.test(snap.val().name))) upd.name=u.displayName;
        await db.ref('users/'+u.uid).update(upd).catch(function(){});
      }
    };
  }

  function patchWheelDefaults(){
    try{
      if(!window.APP || !APP.settings) return;
      APP.settings.wheel = APP.settings.wheel || {};
      if(!APP.settings.wheel.v7RoyalValues){
        APP.settings.wheel.slices = [
          {label:'1x',mult:1,weight:22,color:'#d4af37'},
          {label:'2x',mult:2,weight:16,color:'#0d65b7'},
          {label:'4x',mult:4,weight:10,color:'#f59e0b'},
          {label:'8x',mult:8,weight:6,color:'#15803d'},
          {label:'16x',mult:16,weight:4,color:'#7c3aed'},
          {label:'32x',mult:32,weight:2.5,color:'#0f766e'},
          {label:'64x',mult:64,weight:1.5,color:'#b45309'},
          {label:'128x',mult:128,weight:1,color:'#be123c'},
          {label:'236x',mult:236,weight:.55,color:'#2563eb'},
          {label:'472x',mult:472,weight:.30,color:'#16a34a'},
          {label:'5 تذاكر',mult:0,weight:3,color:'#d97706',ticketPrize:5},
          {label:'1000x',mult:1000,weight:.08,color:'#7f1d1d'},
          {label:'0x',mult:0,weight:34,color:'#111827'}
        ];
        APP.settings.wheel.v7RoyalValues = true;
        APP.settings.wheel.userOverrides = APP.settings.wheel.userOverrides || {};
      }
    }catch(e){}
  }

  function boot(){
    try{
      installLoginUI();
      patchAuthCore();
      patchPhoneRecaptcha();
      patchPublicIdentity();
      patchUserCreateIdentity();
      patchWheelDefaults();
      if(window.AUTH) AUTH.setMethod(AUTH.method==='phone'?'phone':'google');
      var top=$('topStatus'); if(top) top.textContent='ADNOR — Google/Phone Secure V8';
    }catch(e){ console.error('ADNOR V8 patch error', e); }
  }
  document.addEventListener('DOMContentLoaded', boot);
  setTimeout(boot,100); setTimeout(boot,500); setTimeout(boot,1500); setTimeout(boot,3500); setInterval(boot,6000);
  console.log('ADNOR COMPLETE V8 — fixed Firebase authDomain, Gmail/Phone only, public email hidden');
})();
