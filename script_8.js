
(function ADNOR_V5_COMPLETE_PATCH(){
  function $(id){return document.getElementById(id)}
  function boot(){
    try{
      var emailBtn=$('methodEmail'); if(emailBtn){emailBtn.classList.add('hidden'); emailBtn.style.display='none'}
      var secEmail=$('secEmail'); if(secEmail){secEmail.classList.add('hidden'); secEmail.style.display='none'}
      var reset=$('resetPassBtn'); if(reset){reset.classList.add('hidden'); reset.style.display='none'}
      if(window.AUTH && !AUTH.__v5LoginDefault){
        AUTH.__v5LoginDefault=true;
        if(!AUTH.method || AUTH.method==='email') AUTH.method='google';
        setTimeout(function(){ try{ AUTH.setMethod('google'); }catch(e){} },250);
      }
      var topStatus=$('topStatus'); if(topStatus) topStatus.textContent='ADNOR — النسخة الكاملة V6';
      var badge=document.querySelector('.version-badge'); if(badge) badge.remove();
    }catch(e){}
  }
  document.addEventListener('DOMContentLoaded', boot);
  setTimeout(boot,500); setTimeout(boot,1500); setInterval(boot,5000);
})();
