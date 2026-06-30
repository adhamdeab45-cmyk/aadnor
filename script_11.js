
(function(){
  'use strict';
  window.ADNOR_V82_REDIRECT_ONLY = true;
  function $(id){return document.getElementById(id)}
  function log(msg){try{ if(window.authLog) authLog(msg); else console.log(msg); }catch(e){}}
  function err(msg){try{ if(window.showAuthError) showAuthError(msg); else alert(msg); }catch(e){alert(msg)}}
  function clear(){try{ if(window.clearAuthError) clearAuthError(); }catch(e){}}
  function legalOk(){
    var a=$('age18'), t=$('termsOk');
    if(!a || !t) return true;
    if(!a.checked || !t.checked){
      err('⚠️ يجب تأكيد العمر والموافقة على الشروط أولاً. ضع صح على المربعين ثم اضغط Google.');
      return false;
    }
    try{ localStorage.setItem('ADNOR_LEGAL_OK','1'); }catch(e){}
    return true;
  }
  async function googleRedirectOnly(){
    if(!legalOk()) return;
    if(!window.firebase || !window.auth){ err('Firebase غير جاهز بعد، انتظر ثانيتين وجرب.'); return; }
    clear();
    var btn=$('googleBtn') || document.querySelector('button[onclick*="AUTH.google"], .google-login, #authGoogleBtn');
    var old=btn?btn.innerHTML:'';
    try{
      if(btn){ btn.disabled=true; btn.innerHTML='⏳ تحويل إلى Google...'; }
      var provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt:'select_account' });
      log('V8.2 Google redirect ONLY domain='+location.hostname+' authDomain=adhamnnn-8a4d2.firebaseapp.com');
      await auth.signInWithRedirect(provider);
    }catch(e){
      log('V8.2 redirect error: '+(e && e.code)+' '+(e && e.message));
      if(btn){ btn.disabled=false; btn.innerHTML=old || 'متابعة بحساب Google'; }
      err('Google Redirect فشل: '+((window.AUTH&&AUTH.friendlyError)?AUTH.friendlyError(e):(e&&e.message||e)));
    }
  }
  function install(){
    try{
      if(window.AUTH && !AUTH.__v82RedirectOnly){
        AUTH.__v82RedirectOnly=true;
        AUTH.google = googleRedirectOnly;
      }
      var g=$('googleBtn');
      if(g && !g.__v82){
        g.__v82=true;
        g.onclick=function(ev){ if(ev) ev.preventDefault(); googleRedirectOnly(); return false; };
        g.innerHTML='<i class="fa-brands fa-google"></i> دخول بحساب Google';
      }
      var submit=$('authSubmit');
      if(submit && !submit.__v82){
        submit.__v82=true;
        submit.onclick=function(ev){
          try{ if(window.AUTH && AUTH.method==='phone') return AUTH.submit(); }catch(e){}
          if(ev) ev.preventDefault();
          googleRedirectOnly();
          return false;
        };
      }
      var title=$('topStatus'); if(title) title.textContent='ADNOR — Google Redirect V8.2 / Phone';
      var box=document.querySelector('.auth-debug, #authLogBox');
      var noteId='adnorV82Note';
      if(!$(noteId)){
        var wrap=$('googleBtn') || $('authSubmit');
        if(wrap && wrap.parentElement){
          var div=document.createElement('div');
          div.id=noteId;
          div.style.cssText='margin:10px 0;padding:10px;border:1px solid rgba(212,175,55,.35);border-radius:14px;color:#f8e7b0;background:rgba(212,175,55,.08);font-weight:700;line-height:1.7;text-align:center';
          div.textContent='تم تفعيل دخول Google بطريقة التحويل الآمن. إذا فتح Google، اختر الحساب ولا تغلق الصفحة.';
          wrap.parentElement.insertBefore(div, wrap.nextSibling);
        }
      }
    }catch(e){ console.warn('V8.2 install error', e); }
  }
  document.addEventListener('DOMContentLoaded', install);
  setTimeout(install,50); setTimeout(install,300); setTimeout(install,1000); setInterval(install,2500);
  console.log('ADNOR V8.2 — Google redirect-only fix loaded');
})();
