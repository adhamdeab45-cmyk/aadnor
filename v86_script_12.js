
(function(){
  'use strict';
  window.ADNOR_V83_LASER_AUTH = true;
  function $(id){ return document.getElementById(id); }
  function safeLog(m){ try{ if(window.authLog) authLog(m); else console.log('[ADNOR V8.3]', m); }catch(e){} }
  function showErr(m){ try{ if(window.showAuthError) showAuthError(m); else alert(m); }catch(e){ alert(m); } }
  function clearErr(){ try{ if(window.clearAuthError) clearAuthError(); }catch(e){} }
  function setLegalAlwaysOk(){
    try{ localStorage.setItem('ADNOR_LEGAL_OK','1'); }catch(e){}
    var a=$('age18'), t=$('termsOk');
    if(a) a.checked = true;
    if(t) t.checked = true;
    if(window.AUTH){
      AUTH.needLegal = function(){ try{ localStorage.setItem('ADNOR_LEGAL_OK','1'); }catch(e){} return true; };
      AUTH.saveLegal = function(){ try{ localStorage.setItem('ADNOR_LEGAL_OK','1'); }catch(e){} return true; };
    }
  }
  async function googleRedirectLogin(){
    setLegalAlwaysOk();
    clearErr();
    if(!window.firebase || !firebase.auth){ showErr('Firebase غير جاهز بعد. انتظر ثانيتين وجرب مرة ثانية.'); return false; }
    var btn=$('googleBtn');
    var old=btn ? btn.innerHTML : '';
    try{
      if(btn){ btn.disabled=true; btn.innerHTML='⏳ جاري التحويل إلى Google...'; }
      var provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt:'select_account' });
      safeLog('V8.3 redirect start domain='+location.hostname+' authDomain=adhamnnn-8a4d2.firebaseapp.com');
      await firebase.auth().signInWithRedirect(provider);
    }catch(e){
      safeLog('V8.3 redirect error '+((e&&e.code)||'')+' '+((e&&e.message)||e));
      if(btn){ btn.disabled=false; btn.innerHTML=old || '<i class="fa-brands fa-google"></i> تسجيل الدخول بجوجل'; }
      var code=(e&&e.code)||'';
      if(code==='auth/unauthorized-domain') showErr('الدومين غير مضاف في Firebase. أضف '+location.hostname+' داخل Authentication > Settings > Authorized domains.');
      else if(code==='auth/operation-not-allowed') showErr('Google غير مفعّل في Firebase Authentication. فعّل Google من Sign-in method.');
      else showErr('Google فشل: '+((e&&e.message)||String(e||'خطأ غير معروف')));
    }
    return false;
  }
  window.ADNOR_GOOGLE_LOGIN = googleRedirectLogin;
  function applyUI(){
    try{
      setLegalAlwaysOk();
      document.body.classList.add('adnor-v83-laser');
      var brandP=document.querySelector('#auth .brand p');
      if(brandP) brandP.textContent='دخول سريع وآمن — Google أو رقم الهاتف فقط';
      var loginTitle=$('adnorV8AuthTitle');
      if(loginTitle) loginTitle.innerHTML='👑 ADNOR Login<br><span style="font-size:12px;color:#cbd5e1">اختار طريقة الدخول فقط: Google أو رقم الهاتف.</span>';
      var mg=$('methodGoogle'), mp=$('methodPhone');
      if(mg) mg.innerHTML='<i class="fa-brands fa-google"></i> دخول Google';
      if(mp) mp.innerHTML='📱 دخول رقم الهاتف';
      var gb=$('googleBtn');
      if(gb){
        gb.type='button';
        gb.innerHTML='<i class="fa-brands fa-google"></i> تسجيل الدخول بجوجل';
        gb.onclick=function(ev){ if(ev){ev.preventDefault(); ev.stopPropagation();} return googleRedirectLogin(); };
      }
      var authBtn=$('authBtn');
      if(authBtn){
        if(window.AUTH && AUTH.method==='phone'){
          authBtn.style.display='';
          authBtn.textContent=(AUTH.phoneStep==='otp')?'تأكيد الكود والدخول':'إرسال كود الهاتف';
        }else{
          authBtn.style.display='none';
        }
      }
      if(!$('adnorV83Note')){
        var ref=$('secGoogle') || $('googleBtn')?.parentElement;
        if(ref){
          var note=document.createElement('div');
          note.id='adnorV83Note';
          note.className='adnor-v83-note';
          note.textContent='تم حذف تأكيد العمر وسياسة ADNOR من واجهة الدخول. الدخول الآن فقط عبر Google أو رقم الهاتف.';
          ref.appendChild(note);
        }
      }
      if(window.AUTH && !AUTH.__v83LaserPatched){
        AUTH.__v83LaserPatched=true;
        var oldSet=AUTH.setMethod ? AUTH.setMethod.bind(AUTH) : null;
        AUTH.google=googleRedirectLogin;
        AUTH.setMethod=function(m){
          m=(m==='phone')?'phone':'google';
          var r=oldSet ? oldSet(m) : null;
          setLegalAlwaysOk();
          setTimeout(applyUI,0);
          return r;
        };
        var oldSubmit=AUTH.submit ? AUTH.submit.bind(AUTH) : null;
        AUTH.submit=function(){
          setLegalAlwaysOk();
          if(AUTH.method==='phone') return oldSubmit ? oldSubmit() : false;
          return googleRedirectLogin();
        };
      }
      if(window.AUTH && (!AUTH.method || AUTH.method==='email')) AUTH.setMethod('google');
    }catch(e){ console.warn('ADNOR V8.3 applyUI error', e); }
  }
  document.addEventListener('DOMContentLoaded', applyUI);
  setTimeout(applyUI,50); setTimeout(applyUI,300); setTimeout(applyUI,1000); setTimeout(applyUI,2000); setInterval(applyUI,1000);
  console.log('ADNOR V8.3 LASER AUTH — Google redirect + phone only, no legal check UI');
})();
