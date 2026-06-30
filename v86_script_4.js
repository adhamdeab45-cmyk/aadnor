
(function(){
  if(window.__ADNOR_SERVER_24H_FRONT_PATCH__)return;
  window.__ADNOR_SERVER_24H_FRONT_PATCH__=true;
  function toast2(msg){try{toast(msg)}catch(e){alert(msg)}}
  function el(id){return document.getElementById(id)}
  async function api(path,body){
    const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
    let j=null;try{j=await r.json()}catch(e){}
    if(!r.ok||!j||j.ok===false)throw new Error((j&&j.error)||'Server error');
    return j;
  }
  function install(){
    try{
      if(window.DRAW){
        DRAW.checkScheduled=function(){return false};
      }
      if(window.TICKETS&&!window.__ADNOR_SERVER_BUY_PATCHED__){
        window.__ADNOR_SERVER_BUY_PATCHED__=true;
        TICKETS.buy=async function(){
          try{
            if(!APP.user)return;
            if(APP.user.frozen)return toast2('الحساب مجمد');
            const num=(String(el('ticketInput')&&el('ticketInput').value||'').replace(/\D/g,'').slice(0,7)).padStart(7,'0');
            if(num.length!==7)return toast2('اكتب رقم 7 خانات');
            if(APP.total&&APP.total()<1)return toast2('رصيدك غير كاف');
            await api('/api/tickets/buy',{uid:APP.user.uid,level:'daily',number:num,price:1});
            toast2('✅ تم شراء التذكرة من السيرفر وحجز الرقم');
            if(TICKETS.clear)TICKETS.clear();
          }catch(e){
            toast2('⚠️ '+e.message);
          }
        };
      }
    }catch(e){}
  }
  function badge(ok){
    let b=el('server24Badge');
    if(!b){b=document.createElement('div');b.id='server24Badge';b.style.cssText='position:fixed;right:10px;bottom:78px;z-index:9999;padding:7px 10px;border-radius:999px;font:800 11px Arial;background:rgba(0,0,0,.65);border:1px solid rgba(255,255,255,.18);color:#fff;box-shadow:0 0 18px rgba(0,0,0,.35)';document.body.appendChild(b)}
    b.innerHTML=ok?'🟢 Server 24H':'🟠 Server?';
  }
  async function health(){try{const r=await fetch('/api/health',{cache:'no-store'});badge(r.ok)}catch(e){badge(false)}}
  setInterval(install,1000);setTimeout(install,500);setTimeout(install,2500);
  window.addEventListener('load',function(){install();health();setInterval(health,30000)});
})();
