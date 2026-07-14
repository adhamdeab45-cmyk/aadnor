(function(){
  'use strict';
  let deferredPrompt=null;
  const listeners=new Set();
  function standalone(){return window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;}
  function notify(){listeners.forEach(fn=>{try{fn({available:!!deferredPrompt,installed:standalone()})}catch(_){}})}
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;notify();});
  window.addEventListener('appinstalled',()=>{deferredPrompt=null;localStorage.setItem('adnorPwaInstalled','1');notify();});
  window.ADNOR_INSTALL={
    isInstalled:standalone,
    onChange(fn){listeners.add(fn);fn({available:!!deferredPrompt,installed:standalone()});return()=>listeners.delete(fn)},
    async prompt(){
      if(standalone()) return {outcome:'installed'};
      if(deferredPrompt){deferredPrompt.prompt();const result=await deferredPrompt.userChoice;deferredPrompt=null;notify();return result;}
      return {outcome:'instructions'};
    },
    instructions(){
      const ios=/iphone|ipad|ipod/i.test(navigator.userAgent);
      return ios?'من زر المشاركة اختر «إضافة إلى الشاشة الرئيسية».':'من قائمة المتصفح اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».';
    }
  };
  if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('/service-worker.js').catch(()=>{}));}
})();
