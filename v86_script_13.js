
(function(){
  'use strict';
  window.ADNOR_V86_FULL_RESTORE = true;
  const ADMIN_PHONE_FIXED = '+000000000000000';
  const ADMIN_EMAIL_FIXED = 'adhamdeab2@gmail.com';
  function $(id){return document.getElementById(id)}
  function cleanPhone(p){p=String(p||'').trim().replace(/[^0-9+]/g,''); if(p.startsWith('00'))p='+'+p.slice(2); if(p && p[0]!=='+')p='+'+p; return p;}
  function msg(t){try{toast(t)}catch(e){alert(t)}}
  function patchAdmin(){
    if(window.APP && APP.user){
      const cu=(window.auth&&auth.currentUser)||{};
      if(cu.phoneNumber && (!APP.user.phone || APP.user.phone!==cu.phoneNumber)){
        APP.user.phone=cu.phoneNumber; APP.user.phoneNumber=cu.phoneNumber;
        try{db.ref('users/'+APP.user.uid).update({phone:cu.phoneNumber,phoneNumber:cu.phoneNumber,lastLogin:Date.now()});}catch(e){}
      }
    }
    window.isAdmin=function(){
      const cu=(window.auth&&auth.currentUser)||{}; const u=(window.APP&&APP.user)||{};
      const ph=cleanPhone(u.phone||u.phoneNumber||cu.phoneNumber);
      const em=String(u.email||cu.email||'').toLowerCase();
      return !!(APP && APP.user && (ph===ADMIN_PHONE_FIXED || em===ADMIN_EMAIL_FIXED));
    };
    const b=$('adminSideBtn'); if(b && window.isAdmin) b.classList.toggle('hidden',!isAdmin());
  }
  function patchSplash(){
    try{
      if(!window.APP) return;
      APP.settings=APP.settings||{};
      APP.settings.loginSplash=APP.settings.loginSplash||{};
      if(APP.settings.loginSplash.enabled===undefined) APP.settings.loginSplash.enabled=true;
      if(!APP.settings.loginSplash.duration) APP.settings.loginSplash.duration=3;
      if(!APP.settings.loginSplash.title) APP.settings.loginSplash.title='أهلاً بك في ADNOR';
      if(!APP.settings.loginSplash.text) APP.settings.loginSplash.text='جاهز للسحب والإيداع والألعاب';
    }catch(e){}
  }
  function ensureCoreVisible(){
    try{
      ['page-lottery','page-wallet','page-games','page-support','depForm','witForm','drawTitle','drawPrize','depAmount','witAmount'].forEach(function(id){
        const el=$(id); if(el) el.dataset.adnorV86='ok';
      });
    }catch(e){}
  }
  function boot(){patchAdmin(); patchSplash(); ensureCoreVisible();}
  setTimeout(boot,100); setTimeout(boot,700); setTimeout(boot,1700); setInterval(boot,3000);
})();
